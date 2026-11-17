const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { initializeApp, deleteApp } = require('firebase/app');
const firestore = require('firebase/firestore');
const adminApp = require('firebase-admin/app');
const adminFirestore = require('firebase-admin/firestore');

const host = process.env.FIRESTORE_EMULATOR_HOST || '';
const projectId = process.env.FNB_EMULATOR_PROJECT || 'demo-fnb-055506';
if (!/^127\.0\.0\.1:\d+$/.test(host) || !/^demo-[a-z\d-]+$/.test(projectId)) {
  throw new Error('Run with a local emulator and a demo-* project ID.');
}
const root = path.resolve(__dirname, '..');
const [hostname, port] = host.split(':');
const seedApp = adminApp.initializeApp({ projectId });
const admin = adminFirestore.getFirestore(seedApp);
const apps = [];
const checks = [];
const profiles = [
  { id: 'owner-a', role: 'admin', storeId: 'store-a' },
  { id: 'manager-a', role: 'manager', storeId: 'store-a' },
  { id: 'cashier-a', role: 'cashier', storeId: 'store-a' },
  { id: 'combined-a', role: 'order_cashier', storeId: 'store-a' },
  { id: 'order-a', role: 'order', storeId: 'store-a' },
  { id: 'kitchen-a', role: 'kitchen', storeId: 'store-a' },
  { id: 'owner-b', role: 'admin', storeId: 'store-b' },
].map(user => ({ ...user, name: user.id, tokenVersion: 1, status: 'active' }));
const profile = id => profiles.find(user => user.id === id);

function client(user, claims = {}) {
  const app = initializeApp({ projectId, apiKey: 'demo-key', appId: 'demo-app' }, `rules-${apps.length}`);
  apps.push(app);
  const db = firestore.initializeFirestore(app, { ignoreUndefinedProperties: true });
  firestore.connectFirestoreEmulator(db, hostname, Number(port), user ? {
    mockUserToken: { sub: user.id, storeId: user.storeId, role: user.role, tokenVersion: user.tokenVersion, ...claims },
  } : {});
  return db;
}
function source(db) {
  const modules = new Map();
  function load(file) {
    const filename = path.resolve(root, file);
    if (filename === path.join(root, 'src/lib/firebase.ts')) return { db };
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = name => name.startsWith('.')
      ? load(path.resolve(path.dirname(filename), name.endsWith('.js') ? name.slice(0, -3) + '.ts' : name + '.ts'))
      : require(name);
    const execute = vm.runInThisContext(`(function (module, exports, require) {\n${js}\n})`, { filename });
    execute(module, module.exports, localRequire);
    return module.exports;
  }
  function handler(file, name, values) {
    const filename = path.resolve(root, file);
    const tree = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let fn;
    const visit = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) fn = node.initializer;
      ts.forEachChild(node, visit);
    };
    visit(tree);
    assert(fn, name);
    const js = ts.transpileModule(`globalThis.handler = ${fn.getText(tree)};`, {
      fileName: 'handler.ts', compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const sandbox = {
      db, ...firestore, ...load('src/utils/dataIntegrity.ts'), ...load('src/utils/firestoreDateHelper.ts'), ...load('src/utils/costHelper.ts'),
      isCashPayment: method => !method || method === 'cash', console, Date, Intl,
      checkoutLockRef: { current: new Set() }, customers: [], invoices: [],
      selectedTable: null, systemSettings: { vatPercent: 8 },
      setMenu() {}, setTables() {}, setInvoices() {}, setCashTransactions() {}, setSelectedTable() {},
      async updateOutOfStockStatus() {}, triggerPrint() {}, alert(message) { throw new Error(message); }, ...values,
    };
    const keys = Object.keys(sandbox);
    const makeHandler = vm.runInThisContext(`(function (${keys.join(',')}) {\nlet handler;\n${js.replace('globalThis.handler =', 'handler =')}\nreturn handler;\n})`, { filename });
    return makeHandler(...keys.map(key => sandbox[key]));
  }
  return { load, handler };
}

const get = (db, document) => firestore.getDocFromServer(firestore.doc(db, document));
const update = (db, document, values) => firestore.updateDoc(firestore.doc(db, document), values);
const set = (db, document, values) => firestore.setDoc(firestore.doc(db, document), values);
const query = (db, name, storeId, ...constraints) => firestore.getDocsFromServer(firestore.query(
  firestore.collection(db, name), firestore.where('storeId', '==', storeId), ...constraints,
));
const denied = fn => assert.rejects(fn, error => error.code === 'permission-denied');
async function check(name, run) {
  try { await run(); checks.push({ name, status: 'PASS' }); }
  catch (error) { checks.push({ name, status: 'FAIL', error: error.stack || String(error) }); }
}

(async () => {
  const date = new Date().toISOString();
  const drink = { id: 'drink-a', storeId: 'store-a', type: 'goods', name: 'Drink', stock: 5,
    price: 100000, costPrice: 35000, trackStock: true, unit: 'chai' };
  const batch = admin.batch();
  for (const user of profiles) batch.set(admin.doc(`users/${user.id}`), user);
  for (const storeId of ['store-a', 'store-b']) batch.set(admin.doc(`stores/${storeId}`), { credentialStorageVersion: 1 });
  for (const [document, data] of Object.entries({
    'tables/t-a': { storeId: 'store-a', name: 'Bàn A', orders: [], status: 'empty' },
    'tables/t-b': { storeId: 'store-b', name: 'Bàn B', orders: [], status: 'empty' },
    'menu/drink-a': drink,
    'settings/config-a': { storeId: 'store-a', outOfStockAddOnIds: [] },
    'customers/customer-a': { storeId: 'store-a', name: 'Customer', points: 2 },
    'app_settings/ios_version': { version: '1.0.3' },
    'app_settings/android_version': { version: '1.0.3' },
    'system/config': { label: 'Demo bank' },
    'system/user_secret_order-a': { marker: 'private' },
    'user_secrets/owner-a': { marker: 'private' },
    'attendance_records/other-a': { storeId: 'store-a', userId: 'cashier-a', date: '2026-09-10' },
  })) batch.set(admin.doc(document), data);
  await batch.commit();

  const anonymous = client();
  const owner = client(profile('owner-a'));
  const manager = client(profile('manager-a'));
  const cashier = client(profile('cashier-a'));
  const order = client(profile('order-a'));
  const kitchen = client(profile('kitchen-a'));
  const combined = client(profile('combined-a'));
  const platform = client({ id: 'superadmin', role: 'superadmin', storeId: 'superadmin', tokenVersion: 1 }, { isSuperAdmin: true });

  await check('Only public app metadata is readable before sign-in', async () => {
    assert((await get(anonymous, 'app_settings/ios_version')).exists());
    assert((await get(anonymous, 'app_settings/android_version')).exists());
    await denied(() => get(anonymous, 'tables/t-a'));
    await denied(() => set(anonymous, 'invoices/anonymous', { storeId: 'store-a', staffId: 'owner-a' }));
    await denied(() => update(anonymous, 'app_settings/ios_version', { version: '9.0.0' }));
  });
  await check('Queries are scoped to the authenticated store', async () => {
    assert.equal((await query(owner, 'tables', 'store-a')).size, 1);
    await denied(() => query(owner, 'tables', 'store-b'));
    await denied(() => firestore.getDocsFromServer(firestore.collection(owner, 'tables')));
    await denied(() => update(owner, 'tables/t-b', { status: 'occupied' }));
    await denied(() => update(owner, 'tables/t-a', { storeId: 'store-b' }));
  });
  await check('Role, version and active account are enforced by the stored profile', async () => {
    const forged = client(profile('cashier-a'), { role: 'admin' });
    const revoked = client(profile('cashier-a'), { tokenVersion: 0 });
    await denied(() => get(forged, 'tables/t-a'));
    await denied(() => get(revoked, 'tables/t-a'));
    await admin.doc('users/combined-a').update({ isActive: false });
    await denied(() => get(combined, 'tables/t-a'));
    await admin.doc('users/combined-a').update({ isActive: true });
  });
  await check('Protected credentials are readable only by the server', async () => {
    await denied(() => get(owner, 'user_secrets/owner-a'));
    await denied(() => get(order, 'system/user_secret_order-a'));
    await denied(() => get(platform, 'user_secrets/owner-a'));
    assert((await get(order, 'system/config')).exists());
    assert.equal((await query(manager, 'users', 'store-a')).size, 6);
    await denied(() => query(cashier, 'users', 'store-a'));
    await denied(() => update(cashier, 'users/cashier-a', { role: 'admin' }));
    await denied(() => update(owner, 'stores/store-a', { credentialStorageVersion: 1, 'subscription.status': 'active' }));
  });
  await check('Unmigrated staff directory and settings remain private', async () => {
    await admin.doc('stores/store-a').update({ credentialStorageVersion: 0 });
    try {
      await denied(() => query(manager, 'users', 'store-a'));
      await denied(() => query(order, 'settings', 'store-a'));
      assert((await get(order, 'users/order-a')).exists());
    } finally { await admin.doc('stores/store-a').update({ credentialStorageVersion: 1 }); }
    assert.equal((await query(order, 'settings', 'store-a')).size, 1);
    await denied(() => update(owner, 'settings/config-a', { adminPassword: 'demo-only' }));
  });
  await check('Actual order and kitchen transactions run in their allowed roles', async () => {
    const orderOps = source(order).load('src/services/dataOperations.ts');
    const session = await orderOps.addOrderAtomic(profile('order-a'), 't-a', [{ ...drink, quantity: 1 }], undefined, 8, 'demo-order');
    const stored = (await get(kitchen, 'tables/t-a')).data().orders;
    assert.equal(stored[0].id, session);
    const kitchenOps = source(kitchen).load('src/services/dataOperations.ts');
    await kitchenOps.updateOrdersAtomic(profile('kitchen-a'), 't-a', stored, [{ ...stored[0], status: 'ready', items: stored[0].items.map(item => ({ ...item, isCompleted: true })) }], true);
    assert.equal((await get(order, 'tables/t-a')).data().orders[0].items[0].isCompleted, true);
    await denied(() => update(kitchen, 'tables/t-a', { discount: 50 }));
    await denied(() => query(kitchen, 'invoices', 'store-a'));
  });
  await check('Actual attendance transaction opens and closes a personal record', async () => {
    const ops = source(kitchen).load('src/services/dataOperations.ts');
    const first = await ops.recordAttendanceAtomic(profile('kitchen-a'), { checkInTime: date });
    assert.equal(first.type, 'check_in');
    const mine = await query(kitchen, 'attendance_records', 'store-a', firestore.where('userId', '==', 'kitchen-a'));
    assert.equal(mine.size, 1);
    await admin.doc('checkout_locks/attendance_store-a_kitchen-a').update({ lastActionAt: '2000-01-01T00:00:00.000Z' });
    const second = await ops.recordAttendanceAtomic(profile('kitchen-a'), { checkOutTime: date });
    assert.equal(second.type, 'check_out');
    await denied(() => get(kitchen, 'attendance_records/other-a'));
  });
  await check('Actual shift guard and concurrent opens preserve a single shift', async () => {
    const ops = source(cashier).load('src/services/dataOperations.ts');
    await Promise.all([ops.openShiftAtomic(profile('cashier-a'), 100000), ops.openShiftAtomic(profile('cashier-a'), 100000)]);
    const rows = await query(cashier, 'shifts', 'store-a', firestore.where('staffId', '==', 'cashier-a'), firestore.where('status', '==', 'open'));
    assert.equal(rows.size, 1);
    await denied(() => set(cashier, 'shifts/without-lock', { storeId: 'store-a', staffId: 'cashier-a', status: 'open' }));
    await denied(() => set(cashier, 'checkout_locks/shift_open_store-a_order-a', { storeId: 'store-a', staffId: 'order-a', type: 'shift_guard', shiftId: rows.docs[0].id }));
  });
  await check('Actual cashier checkout and admin cancellation preserve money, stock and audit', async () => {
    const table = { ...(await get(cashier, 'tables/t-a')).data(), id: 't-a' };
    const shifts = await query(cashier, 'shifts', 'store-a', firestore.where('staffId', '==', 'cashier-a'), firestore.where('status', '==', 'open'));
    const checkout = source(cashier).handler('src/App.tsx', 'handleCheckout', {
      currentUser: profile('cashier-a'), tables: [table], menu: [drink], activeShift: { id: shifts.docs[0].id },
    });
    assert.equal(await checkout('t-a', table.orders, 10, 'cash', false, 'customer-a'), true);
    const invoices = await query(owner, 'invoices', 'store-a');
    assert.equal(invoices.size, 1);
    const invoiceId = invoices.docs[0].id;
    assert.equal(invoices.docs[0].data().total, 97200);
    assert.equal((await get(owner, 'menu/drink-a')).data().stock, 4);
    await denied(() => firestore.deleteDoc(firestore.doc(cashier, `invoices/${invoiceId}`)));
    const ops = source(owner).load('src/services/dataOperations.ts');
    const cancelled = await ops.cancelInvoiceAtomic(profile('owner-a'), invoiceId);
    assert(cancelled.deleted);
    assert.equal((await get(owner, 'menu/drink-a')).data().stock, 5);
    assert.equal((await get(owner, `cancelled_invoices/cancel_${invoiceId}`)).data().originalCashReceipt.amount, 97200);
    await denied(() => update(owner, `cancelled_invoices/cancel_${invoiceId}`, { total: 0 }));
  });
  await check('Manual cash and stock import use allowed roles and exact quantities', async () => {
    const cashierOps = source(cashier).load('src/services/dataOperations.ts');
    await cashierOps.recordCashAtomic(profile('cashier-a'), {
      date, amount: 20000, type: 'income', paymentMethod: 'cash', category: 'Khác', staffId: 'cashier-a', staffName: 'Cashier',
    }, undefined, 'demo-cash');
    await denied(() => update(cashier, 'menu/drink-a', { price: 1 }));
    await denied(() => set(cashier, 'daily_stats/fake', { storeId: 'store-a', coverageStatus: 'reconciled', receiptReconciliationVersion: 1 }));
    await source(manager).load('src/services/dataOperations.ts').importStockAtomic(profile('manager-a'), 'drink-a', 0.25, 30000, undefined, 'demo-import');
    assert.equal((await get(owner, 'menu/drink-a')).data().stock, 5.25);
  });

  await check('Checkout with 24 stock items stays within Rules access limits', async () => {
    const goods = Array.from({ length: 24 }, (_, index) => ({ ...drink, id: `many-${index}`, price: 1000, costPrice: 200, quantity: 1 }));
    const batch = admin.batch();
    for (const item of goods) batch.set(admin.doc(`menu/${item.id}`), item);
    const table = { id: 'many-table', storeId: 'store-a', name: 'Bàn lớn', status: 'occupied', orders: [{
      id: 'many-session', items: goods, subtotal: 24000, vat: 8, discount: 0, total: 25920, status: 'ready', startTime: date,
    }] };
    batch.set(admin.doc('tables/many-table'), table);
    await batch.commit();
    const user = profile('combined-a');
    const checkout = source(combined).handler('src/App.tsx', 'handleCheckout', { currentUser: user, tables: [table], menu: goods, activeShift: null });
    assert.equal(await checkout(table.id, table.orders, 0, 'transfer'), true);
    assert.equal((await get(owner, 'menu/many-23')).data().stock, 4);
    assert.equal((await get(owner, 'tables/many-table')).data().status, 'empty');
  });

  const failed = checks.filter(result => result.status === 'FAIL');
  console.log(JSON.stringify({ passed: checks.length - failed.length, total: checks.length, failed: failed.length, results: checks }, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await Promise.allSettled(apps.map(app => deleteApp(app)));
  await adminApp.deleteApp(seedApp);
});
