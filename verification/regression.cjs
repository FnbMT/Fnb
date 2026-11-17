const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(process.env.FNB_PROJECT_ROOT || path.join(__dirname, '..'));
const ts = require(path.join(root, 'node_modules/typescript'));
const results = [];
const copy = value => value === undefined ? undefined : structuredClone(value);
function fixture(initial = {}, options = {}) {
  const rows = new Map(Object.entries(copy(initial))), versions = new Map([...rows.keys()].map(p => [p, 1]));
  let sequence = 0; const cache = new Map(); const alerts = [];
  const ref = p => ({ path: p, id: p.split('/').at(-1) });
  const snapshot = r => { const value = copy(rows.get(r.path)); return { id: r.id, ref: r, exists: () => value !== undefined, data: () => copy(value), version: versions.get(r.path) || 0, metadata: { fromCache: false, hasPendingWrites: false } }; };
  function apply(target, r, value, merge = false) {
    if (options.failWrite?.(r.path, value)) throw Error('Injected write rejection');
    const data = merge ? copy(target.get(r.path) || {}) : {};
    for (const [k, v] of Object.entries(value)) {
      if (v?.__op === 'increment') data[k] = (data[k] || 0) + v.value;
      else if (v?.__op === 'delete') delete data[k];
      else if (v?.__op === 'union') data[k] = [...(data[k] || []), ...v.value.filter(n => !(data[k] || []).some(x => JSON.stringify(x) === JSON.stringify(n)))];
      else if (v !== undefined) data[k] = copy(v);
    }
    target.set(r.path, data);
  }
  async function transact(_db, fn) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const readVersions = new Map(), writes = []; let writing = false;
      const result = await fn({ get: async r => { assert(!writing, 'Firestore transactions must finish all reads before writes'); const s = snapshot(r); readVersions.set(r.path, s.version); return s; }, set: (r, v, o) => { writing = true; writes.push(['set', r, v, o?.merge]); }, update: (r, v) => { writing = true; writes.push(['update', r, v, true]); }, delete: r => { writing = true; writes.push(['delete', r]); } });
      if ([...readVersions].some(([p, v]) => (versions.get(p) || 0) !== v)) continue;
      const next = new Map([...rows].map(([k, v]) => [k, copy(v)]));
      for (const [kind, r, v, merge] of writes) { if (kind === 'delete') next.delete(r.path); else { if (kind === 'update') assert(next.has(r.path), `Missing update target ${r.path}`); apply(next, r, v, merge); } }
      rows.clear(); for (const [k, v] of next) rows.set(k, v);
      for (const [, r] of writes) versions.set(r.path, (versions.get(r.path) || 0) + 1);
      return result;
    }
    throw Error('Mock contention exceeded');
  }
  const api = {
    doc: (...args) => args.length === 1 ? ref(`${args[0].path}/auto-${++sequence}`) : ref(args.slice(1).join('/')),
    collection: (_db, name) => ({ path: name }),
    runTransaction: transact,
    increment: value => ({ __op: 'increment', value }), deleteField: () => ({ __op: 'delete' }), arrayUnion: (...value) => ({ __op: 'union', value }),
    startAfter: value => ({ kind: 'cursor', value }), where: (field, op, value) => ({ kind: 'where', field, op, value }), orderBy: (field, dir = 'asc') => ({ kind: 'order', field, dir }), limit: value => ({ kind: 'limit', value }),
    query: (col, ...constraints) => ({ col, constraints }),
    updateDoc: async (r, value) => apply(rows, r, value, true),
    setDoc: async (r, value, opt) => apply(rows, r, value, Boolean(opt?.merge)),
    deleteDoc: async r => rows.delete(r.path),
    getDoc: async r => snapshot(r), getDocFromServer: async r => snapshot(r),
    getDocsFromServer: async q => {
      if (options.failQuery?.(q)) throw Error('Injected query failure');
      let list = [...rows].filter(([p]) => p.startsWith(q.col.path + '/'));
      const value = ([p, d], field) => field === '__name__' ? p.split('/').at(-1) : d[field];
      for (const c of q.constraints || []) if (c.kind === 'where') list = list.filter(row => {
        const v = value(row, c.field); return c.op === '==' ? v === c.value : c.op === '>=' ? v >= c.value : c.op === '>' ? v > c.value : c.op === '<' ? v < c.value : v <= c.value;
      });
      const orders = (q.constraints || []).filter(c => c.kind === 'order');
      for (const c of orders) list = list.filter(row => value(row, c.field) !== undefined);
      list.sort((a, b) => { for (const c of orders) { const x = value(a, c.field), y = value(b, c.field); if (x !== y) return (x < y ? -1 : 1) * (c.dir === 'desc' ? -1 : 1); } return a[0].localeCompare(b[0]) * (orders.at(-1)?.dir === 'desc' ? -1 : 1); });
      const cursor = q.constraints?.find(c => c.kind === 'cursor')?.value;
      if (cursor) { const index = list.findIndex(([p]) => p === (cursor.ref?.path || cursor.path)); if (index >= 0) list = list.slice(index + 1); }
      const max = q.constraints?.find(c => c.kind === 'limit')?.value; if (max) list = list.slice(0, max);
      const result = { docs: list.map(([p]) => snapshot(ref(p))), empty: !list.length, size: list.length, metadata: options.queryMetadata || { fromCache: false, hasPendingWrites: false } };
      options.afterQuery?.(q, rows, versions);
      return result;
    }
  };
  api.getDocs = api.getDocsFromServer;
  const adminSnap = s => ({ id: s.id, exists: s.exists(), data: s.data, updateTime: { version: s.version, isEqual(other) { return this.version === other.version; } } });
  const adminRef = (name) => {
    const target = ref(name);
    return {
      ...target,
      get: async () => adminSnap(snapshot(target)),
      update: async value => transact({}, async txn => { await txn.get(target); txn.update(target, value); }),
    };
  };
  const admin = {
    doc: adminRef,
    collection: name => {
      const make = (constraints = []) => ({
        doc: id => adminRef(name + '/' + id), where: (field, op, value) => make([...constraints, { kind: 'where', field, op, value }]),
        orderBy: (field, dir = 'asc') => make([...constraints, { kind: 'order', field, dir }]),
        limit: value => make([...constraints, { kind: 'limit', value }]),
        startAfter: cursor => make([...constraints, { kind: 'cursor', value: typeof cursor === 'string' ? ref(name + '/' + cursor) : cursor }]),
        get: async () => {
          const found = await api.getDocsFromServer({ col: { path: name }, constraints });
          const snap = { docs: found.docs.map(adminSnap), size: found.docs.length, empty: found.empty }; options.afterAdminRead?.(name, rows, versions); return snap;
        }
      });
      return make();
    },
    runTransaction: fn => transact({}, txn => fn({ get: async r => adminSnap(await txn.get(r)), set: txn.set, update: txn.update, delete: txn.delete }))
  };
  function load(relative) {
    const filename = path.resolve(root, relative);
    const norm = filename.replace(/\\/g, '/');
    if (norm.endsWith('src/lib/firebase.ts')) return { db: {}, auth: {} };
    if (norm.endsWith('api/_firebaseAdmin.ts')) return { adminDb: admin, hasAdminCredential: true, safeDeleteSentinel: api.deleteField, ...options.adminMocks };
    if (norm.endsWith('api/_token.ts') && options.caller !== undefined) return { getAuthenticatedCaller: async () => options.caller };
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} }; cache.set(filename, mod);
    const source = fs.readFileSync(filename, 'utf8');
    const compiled = ts.transpileModule(source, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const localRequire = name => {
      if (name === 'firebase/firestore') return api;
      if (name.startsWith('.')) { let full = path.resolve(path.dirname(filename), name); if (!path.extname(full)) full += '.ts'; else if (full.endsWith('.js') && !fs.existsSync(full)) full = full.slice(0, -3) + '.ts'; return load(path.relative(root, full)); }
      return require(name);
    };
    const context = vm.createContext({ require: localRequire, module: mod, exports: mod.exports, console, structuredClone, Buffer, process: { env: { DATA_ENCRYPTION_KEY: 'verification-only-key' } }, crypto: globalThis.crypto, Date, Intl, setTimeout, clearTimeout });
    vm.runInContext(compiled, context, { filename }); return mod.exports;
  }
  const ops = load('src/services/dataOperations.ts'), pure = load('src/utils/dataIntegrity.ts'), dates = load('src/utils/firestoreDateHelper.ts'), cost = load('src/utils/costHelper.ts');
  function handler(file, name, extra = {}) {
    const text = fs.readFileSync(path.join(root, file), 'utf8'); const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let initializer;
    function visit(n) { if (ts.isVariableDeclaration(n) && n.name.getText(tree) === name) initializer = n.initializer; ts.forEachChild(n, visit); } visit(tree); assert(initializer, name);
    return evaluate(initializer.getText(tree), extra);
  }
  function evaluate(source, extra = {}) {
    const js = ts.transpileModule('globalThis.testFunction=' + source, { fileName: 'fixture.tsx', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const context = vm.createContext({ require, exports: {}, ...api, ...pure, ...dates, ...cost, ...load("src/utils/reportSources.ts"), ...load("src/utils/sharedFirestoreQuery.ts"), isViewingTodayOnly: false, db: {}, console: { warn() { }, error() { } }, structuredClone, currentUser: user, menu: [], tables: [], invoices: [], customers: [], activeShift: null, selectedTable: null, systemSettings: { vatPercent: 0 }, checkoutLockRef: { current: new Set() }, updateOutOfStockStatus: async () => { }, triggerPrint: () => { }, setMenu: () => { }, setTables: () => { }, setInvoices: () => { }, setCashTransactions: () => { }, setSelectedTable: () => { }, alert: m => alerts.push(m), prompt: () => 'test reason', isCashPayment: m => !m || m === 'cash', ...extra });
    vm.runInContext(js, context); return { call: context.testFunction, context };
  }
  function callback(file, name, extra = {}) {
    const filename = path.join(root, file), text = fs.readFileSync(filename, 'utf8'), tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let fn;
    function visit(n) { if (ts.isVariableDeclaration(n) && (n.name.getText(tree) === name || (ts.isObjectBindingPattern(n.name) && n.name.elements.some(e => e.name.getText(tree) === name)))) fn = n.initializer.arguments[0]; ts.forEachChild(n, visit); } visit(tree); assert(fn, name); return evaluate(fn.getText(tree), extra);
  }
  function effect(file, needle, extra = {}) {
    const text = fs.readFileSync(path.join(root, file), 'utf8'), tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let fn;
    function visit(n) { if (ts.isCallExpression(n) && n.expression.getText(tree) === 'useEffect' && n.arguments[0]?.getText(tree).includes(needle)) fn = n.arguments[0]; ts.forEachChild(n, visit); } visit(tree); assert(fn, needle); return evaluate(fn.getText(tree), extra);
  }
  return { rows, versions, api, ops, pure, dates, cost, load, handler, evaluate, callback, effect, alerts, ref, transact };
}
const user = { id: 'u1', name: 'User', role: 'admin', storeId: 'store1' };
const receiptFor = (invoiceId, amount = 100000, options = {}) => ({
  id: `cash_${invoiceId}`, storeId: 'store1', invoiceId, amount,
  date: '2026-09-10T05:00:00Z', type: 'income', category: 'Bán Hàng', paymentMethod: 'cash', ...options,
});

const item = () => ({ id: 'drink', name: 'Drink', price: 100000, costPrice: 40000, type: 'goods', stock: 10, trackStock: true, unit: 'can', storeId: 'store1', quantity: 1 });
const order = (id = 's1') => ({ id, items: [item()], subtotal: 100000, discount: 0, vat: 0, total: 100000, status: 'pending', startTime: new Date().toISOString() });
const table = (id = 't1', orders = [order()]) => ({ id, name: id, status: orders.length ? 'occupied' : 'empty', orders, storeId: 'store1' });
async function test(name, fn) { try { await fn(); results.push({ name, status: 'PASS' }); } catch (error) { results.push({ name, status: 'FAIL', error: String(error.stack || error) }); } }
(async () => {
  await test('Concurrent order increments preserve all portions', async () => {
    const f = fixture({ 'tables/t1': table() }); await Promise.all([f.ops.addOrderAtomic(user, 't1', [{ ...item(), quantity: 1 }], 's1', 0, 'a'), f.ops.addOrderAtomic(user, 't1', [{ ...item(), quantity: 2 }], 's1', 0, 'b')]); assert.equal(f.rows.get('tables/t1').orders[0].items[0].quantity, 4);
  });
  await test('Order retry with same operation ID does not add twice', async () => {
    const f = fixture({ 'tables/t1': table('t1', []) }); const a = await f.ops.addOrderAtomic(user, 't1', [item()], undefined, 0, 'a'); const b = await f.ops.addOrderAtomic(user, 't1', [item()], undefined, 0, 'a'); assert.equal(a, b); assert.equal(f.rows.get('tables/t1').orders.length, 1);
  });
  await test('Reusing order operation ID for different content is rejected', async () => {
    const f = fixture({ 'tables/t1': table('t1', []) }); await f.ops.addOrderAtomic(user, 't1', [item()], undefined, 0, 'a'); await assert.rejects(f.ops.addOrderAtomic(user, 't1', [{ ...item(), quantity: 2 }], undefined, 0, 'a'));
  });
  await test('Kitchen does not erase a newly added order', async () => {
    const f = fixture({ 'tables/t1': table('t1', [order(), order('s2')]) }); await f.ops.updateOrdersAtomic(user, 't1', [order()], [{ ...order(), status: 'ready' }], true); assert.equal(f.rows.get('tables/t1').orders.length, 2);
  });
  await test('Stale quantity edit conflicts rather than overwrites', async () => {
    const server = order(); server.items[0].quantity = 2; server.subtotal = 200000; const f = fixture({ 'tables/t1': table('t1', [server]) }); await assert.rejects(f.ops.updateOrdersAtomic(user, 't1', [order()], [{ ...order(), status: 'ready' }], true)); assert.equal(f.rows.get('tables/t1').orders[0].items[0].quantity, 2);
  });
  await test('Failed merge preserves source and destination atomically', async () => {
    const f = fixture({ 'tables/a': table('a', [order('a')]), 'tables/b': table('b', [order('b')]) }, { failWrite: p => p === 'tables/b' }); await assert.rejects(f.ops.moveTablesAtomic(user, 'b', ['a'], false, 'op')); assert.equal(f.rows.get('tables/a').orders.length, 1); assert.equal(f.rows.get('tables/b').orders.length, 1);
  });
  await test('Merge moves each order once and replay is harmless', async () => {
    const f = fixture({ 'tables/a': table('a', [order('a')]), 'tables/b': table('b', [order('b')]) }); await f.ops.moveTablesAtomic(user, 'b', ['a'], false, 'op'); await f.ops.moveTablesAtomic(user, 'b', ['a'], false, 'op'); assert.equal(f.rows.get('tables/a').orders.length, 0); assert.equal(f.rows.get('tables/b').orders.length, 2);
  });
  await test('Transfer rejects a destination occupied on the server', async () => {
    const f = fixture({ 'tables/a': table('a', [order('a')]), 'tables/b': table('b', [order('b')]) }); await assert.rejects(f.ops.moveTablesAtomic(user, 'b', ['a'], true, 'op')); assert.equal(f.rows.get('tables/a').orders.length, 1);
  });
  await test('Concurrent imports preserve stock, receipts, and cards', async () => {
    const f = fixture({ 'menu/drink': item() }); await Promise.all([f.ops.importStockAtomic(user, 'drink', 5, 40000, undefined, 'a'), f.ops.importStockAtomic(user, 'drink', 7, 40000, undefined, 'b')]); assert.equal(f.rows.get('menu/drink').stock, 22); assert.equal([...f.rows.keys()].filter(p => p.startsWith('cash_transactions/')).length, 2); assert.equal([...f.rows.keys()].filter(p => p.startsWith('stock_card/')).length, 2);
  });
  await test('An import cash-write failure leaves no partial inventory change', async () => {
    const f = fixture({ 'menu/drink': item() }, { failWrite: p => p.startsWith('cash_transactions/') }); await assert.rejects(f.ops.importStockAtomic(user, 'drink', 5, 40000, undefined, 'a')); assert.equal(f.rows.get('menu/drink').stock, 10); assert.equal([...f.rows.keys()].filter(p => p.startsWith('inventory_logs/')).length, 0);
  });
  await test('Import retry is idempotent', async () => {
    const f = fixture({ 'menu/drink': item() }); await f.ops.importStockAtomic(user, 'drink', 5, 40000, undefined, 'a'); await f.ops.importStockAtomic(user, 'drink', 5, 40000, undefined, 'a'); assert.equal(f.rows.get('menu/drink').stock, 15);
  });
  await test('Inventory precision retains 0.95 + 0.1 = 1.05', async () => {
    const f = fixture({ 'menu/drink': { ...item(), stock: 0.95 } }); await f.ops.importStockAtomic(user, 'drink', 0.1, 40000, undefined, 'a'); assert.equal(f.rows.get('menu/drink').stock, 1.05);
  });
  await test('Audit refuses stale stock and leaves no audit/card', async () => {
    const f = fixture({ 'menu/drink': item() }); await assert.rejects(f.ops.auditStockAtomic(user, { id: 'audit', date: new Date().toISOString(), items: [{ itemId: 'drink', itemName: 'Drink', systemStock: 9, actualStock: 8, discrepancy: -1, unit: 'can' }], staffId: 'u1', staffName: 'User' })); assert(!f.rows.has('inventory_audits/audit')); assert.equal(f.rows.get('menu/drink').stock, 10);
  });
  await test('Manual cash replay increments totals only once', async () => {
    const f = fixture(); const tx = { date: new Date().toISOString(), amount: 100000, type: 'income', paymentMethod: 'cash', category: 'Other', staffId: 'u1', staffName: 'User' }; await f.ops.recordCashAtomic(user, tx, undefined, 'a'); await f.ops.recordCashAtomic(user, tx, undefined, 'a'); assert.equal([...f.rows.values()].find(v => v.totalIncome !== undefined).totalIncome, 100000);
  });
  await test('Manual cash and imports reject a closed shift', async () => {
    const f = fixture({ 'menu/drink': item(), 'shifts/shift': { storeId: 'store1', status: 'closed' } }); const tx = { date: new Date().toISOString(), amount: 100000, type: 'income', paymentMethod: 'cash', category: 'Other', staffId: 'u1', staffName: 'User' }; await assert.rejects(f.ops.recordCashAtomic(user, tx, 'shift', 'a')); await assert.rejects(f.ops.importStockAtomic(user, 'drink', 5, 40000, 'shift', 'b')); assert.equal(f.rows.get('menu/drink').stock, 10);
  });
  await test('Cancellation reverses the original shift and exact stock movements', async () => {
    const inv = { id: 'i1', storeId: 'store1', tableName: 'Table', date: '2026-09-10T05:00:00Z', businessDate: '2026-09-10', total: 100000, discount: 0, totalCost: 40000, costVersion: 3, statsApplied: true, paymentMethod: 'cash', items: [item()], inventoryMovements: [{ itemId: 'drink', quantity: 1 }], shiftId: 'shift' };
    const f = fixture({ 'invoices/i1': inv, 'menu/drink': { ...item(), stock: 9, trackStock: false }, 'cash_transactions/cash_i1': receiptFor('i1'), 'daily_stats/store1_2026-09-10': { totalRevenue: 100000, totalCash: 100000, totalCost: 40000, invoiceCount: 1 }, 'shifts/shift': { storeId: 'store1', status: 'closed', startCash: 0, totalCash: 100000, totalRevenue: 100000, cashIncome: 100000, endCash: 100000, discrepancy: 0 } });
    const r = await f.ops.cancelInvoiceAtomic(user, 'i1'); assert(r.deleted); assert.equal(f.rows.get('menu/drink').stock, 10); assert.equal(f.rows.get('shifts/shift').totalRevenue, 0); assert.equal(f.rows.get('shifts/shift').totalCash, 0); assert.equal(f.rows.get('shifts/shift').discrepancy, 100000); assert(!f.rows.has('invoices/i1')); assert(f.rows.has('cancelled_invoices/cancel_i1'));
  });
  await test('Cancelling an aggregate without invoice coverage creates no negative total', async () => {
    const f = fixture({ 'cash_transactions/cash_i1': receiptFor('i1'), 'invoices/i1': { storeId: 'store1', date: '2026-09-10T05:00:00Z', total: 100000, items: [], paymentMethod: 'cash' }, 'daily_stats/store1_2026-09-10': { totalExpense: 50000 } }); await f.ops.cancelInvoiceAtomic(user, 'i1'); assert.equal(f.rows.get('daily_stats/store1_2026-09-10').totalRevenue, undefined); assert.equal(f.rows.get('daily_stats/store1_2026-09-10').coverageStatus, 'partial');
  });
  await test('Cancellation of an untracked new invoice does not invent stock', async () => {
    const f = fixture({ 'cash_transactions/cash_i1': receiptFor('i1'), 'invoices/i1': { storeId: 'store1', date: '2026-09-10T05:00:00Z', total: 100000, items: [item()], paymentMethod: 'cash', inventoryMovements: [] }, 'menu/drink': item() }); await f.ops.cancelInvoiceAtomic(user, 'i1'); assert.equal(f.rows.get('menu/drink').stock, 10);
  });
  await test('Checkout uses the server shift state and preserves the order on rejection', async () => {
    const t = table(), f = fixture({ 'tables/t1': t, 'menu/drink': item(), 'shifts/shift': { storeId: 'store1', status: 'closed' } }); const h = f.handler('src/App.tsx', 'handleCheckout', { tables: [t], menu: [item()], activeShift: { id: 'shift' } }); assert.equal(await h.call('t1', [order()], 0, 'cash'), false); assert.equal([...f.rows.keys()].filter(p => p.startsWith('invoices/')).length, 0); assert.equal(f.rows.get('tables/t1').orders.length, 1);
  });
  await test('Checkout keeps committed success when a post-commit availability update fails', async () => {
    const t = table(), f = fixture({ 'tables/t1': t, 'menu/drink': { ...item(), stock: 1 } }); const h = f.handler('src/App.tsx', 'handleCheckout', { tables: [t], menu: [{ ...item(), stock: 1 }], updateOutOfStockStatus: async () => { throw Error('auxiliary failure') } }); assert.equal(await h.call('t1', [order()], 0, 'cash'), true); assert.equal([...f.rows.keys()].filter(p => p.startsWith('invoices/')).length, 1);
  });
  await test('Checkout persists exact stock deltas and a server cost snapshot', async () => {
    const t = table(), f = fixture({ 'tables/t1': t, 'menu/drink': { ...item(), costPrice: 45000 } }); const h = f.handler('src/App.tsx', 'handleCheckout', { tables: [t], menu: [item()] }); assert.equal(await h.call('t1', [order()], 0, 'cash'), true); const inv = [...f.rows].find(([p]) => p.startsWith('invoices/'))[1]; assert.equal(inv.totalCost, 45000); assert.equal(inv.costVersion, 3); assert.deepEqual(inv.inventoryMovements, [{ itemId: 'drink', quantity: 1 }]);
  });
  await test('Checkout rejects unsaved draft sessions', async () => {
    const t = table('t1', []), f = fixture({ 'tables/t1': t, 'menu/drink': item() }); const h = f.handler('src/App.tsx', 'handleCheckout', { tables: [t], menu: [item()] }); assert.equal(await h.call('t1', [order('draft-1')], 0, 'cash'), false); assert.equal([...f.rows.keys()].filter(p => p.startsWith('invoices/')).length, 0);
  });
  await test('Price, discount, and VAT are computed once from item subtotals', async () => {
    const o = order(); o.items[0].selectedAddOns = [{ id: 'extra', name: 'Extra', price: 20000, costPrice: 5000 }]; o.subtotal = 120000; o.total = 129600; const t = table('t1', [o]), f = fixture({ 'tables/t1': t, 'menu/drink': item() }); const h = f.handler('src/App.tsx', 'handleCheckout', { tables: [t], menu: [item()], systemSettings: { vatPercent: 8 } }); assert.equal(await h.call('t1', [o], 10, 'cash'), true); const inv = [...f.rows].find(([p]) => p.startsWith('invoices/'))[1]; assert.equal(inv.subtotal, 120000); assert.equal(inv.discount, 12000); assert.equal(inv.vat, 8640); assert.equal(inv.total, 116640);
  });
  await test('Estimated invoice costs remain estimated in source aggregates', async () => {
    const f = fixture(), inv = { ...order(), id: 'inv', total: 100000, totalCost: 0, costVersion: 3, costStatus: 'estimated', paymentMethod: 'cash' }; const stat = f.pure.aggregateDay('store1', '2026-09-10', [inv], [], true); assert.equal(stat.costStatus, 'estimated'); assert.equal(stat.totalCost, 0);
  });
  await test('Daily expense amounts are not divided by 30 in the financial view', async () => {
    const f = fixture(); const source = fs.readFileSync(path.join(root, 'src/components/SummaryView.tsx'), 'utf8'); const a = source.indexOf('  // 1. Nhân sự (Labor Cost)'), b = source.indexOf('  // Alias để tương thích giao diện hiển thị', a); const js = ts.transpileModule(source.slice(a, b) + '\nObject.assign(globalThis,{laborCost,rentCost});', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText; const ctx = vm.createContext({ financialCostBasis: 'cash', periodPayrolls: [], payrollRecords: [], statsAggregates: { expenseSalary: 300000, expenseRent: 600000, expenseOther: 0 }, filteredCash: [], filterType: 'day', dateFilter: '2026-10-30' }); vm.runInContext(js, ctx); assert.equal(ctx.laborCost, 300000); assert.equal(ctx.rentCost, 600000);
  });
  await test('Multiple attendance sessions count one workday and only actual hours', async () => {
    const f = fixture(); const r = f.pure.attendanceTotals([{ date: '2026-10-01', status: 'present', checkInTime: '2026-10-01T01:00:00Z', checkOutTime: '2026-10-01T05:00:00Z' }, { date: '2026-10-01', status: 'present', checkInTime: '2026-10-01T06:00:00Z', checkOutTime: '2026-10-01T10:00:00Z' }]); assert.equal(r.presentDays, 1); assert.equal(r.totalHours, 8); assert.equal(r.hasOpenSession, false); const open = f.pure.attendanceTotals([{ date: '2026-10-01', status: 'present', checkInTime: '2026-10-01T01:00:00Z' }]); assert.equal(open.totalHours, 0); assert.equal(open.hasOpenSession, true);
  });
  await test('Complete source calculations retain more than 100/300 documents', async () => {
    const f = fixture(); const invoices = Array.from({ length: 350 }, (_, i) => ({ id: `i${i}`, date: '2026-09-10T05:00:00Z', total: 1000, totalCost: 100, costStatus: 'complete', costVersion: 3, paymentMethod: 'cash', items: [] })); assert.equal(f.pure.aggregateDay('store1', '2026-09-10', invoices, [], true).totalRevenue, 350000);
  });
  await test('Source recomputation removes a cancelled cached invoice and its cost', async () => {
    const f = fixture(); const invoice = { id: 'i1', date: '2026-09-10T05:00:00Z', total: 100000, totalCost: 40000, costStatus: 'complete', costVersion: 3, paymentMethod: 'cash', items: [] }; assert.equal(f.pure.dailyStatsFromSources('store1', ['2026-09-10'], [invoice], [], true)[0].totalCost, 40000); const next = f.pure.dailyStatsFromSources('store1', ['2026-09-10'], [], [], true)[0]; assert.equal(next.totalRevenue, 0); assert.equal(next.totalCost, 0); assert.equal(next.coverageStatus, 'zero_activity');
  });
  await test('Cached/offline source data is not marked reconciled', async () => { const f = fixture(); assert.equal(f.pure.aggregateDay('store1', '2026-09-10', [], [], false).coverageStatus, 'partial'); });
  await test('Cash form keeps entered data after a rejected server write', async () => {
    const f = fixture(), changes = []; const h = f.handler('src/components/SummaryView.tsx', 'handleAddCash', { showAddCashModal: 'expense', isSavingCash: false, newCash: { amount: 100000, paymentMethod: 'cash', category: 'Other', note: 'Test' }, cashOperationRef: { current: null }, setIsSavingCash: () => { }, onAddCashTransaction: async () => { throw Error('server rejection') }, setShowAddCashModal: v => changes.push(v), setNewCash: v => changes.push(v) }); await h.call(); assert.equal(changes.length, 0); assert(f.alerts.length > 0);
  });
  await test('Vietnam date boundaries retain invoices around UTC midnight', async () => { const f = fixture(); assert.equal(f.pure.businessDateOf({ date: '2026-10-29T18:00:00Z' }), '2026-10-30'); assert.equal(f.dates.getVietnamDayBoundariesIso('2026-10-30').startIso, '2026-10-29T17:00:00.000Z'); });
  await test('Recipe versions are not merged by a shared dish ID', async () => { const f = fixture(); const a = { ...item(), type: 'dish', recipe: [{ ingredientId: 'milk', quantity: 0.1, unit: 'l' }] }, b = { ...a, recipe: [{ ingredientId: 'milk', quantity: 0.2, unit: 'l' }] }; assert.notEqual(f.pure.itemKey(a), f.pure.itemKey(b)); });
  await test('Backfill skips a day changed by a concurrent historical cancellation', async () => {
    let injected = false;
    const f = fixture({ 'cash_transactions/cash_i1': receiptFor('i1'), 'invoices/i1': { storeId: 'store1', date: '2026-09-10T05:00:00Z', total: 100000, totalCost: 40000, costStatus: 'complete', costVersion: 3, paymentMethod: 'cash', items: [item()] }, 'daily_stats/store1_2026-09-10': { storeId: 'store1', date: '2026-09-10', totalRevenue: 100000, invoiceCount: 1, sourceRevision: 1 } }, {
      afterAdminRead: (name, rows, versions) => {
        if (name === 'cash_transactions' && !injected) { injected = true; rows.delete('invoices/i1'); rows.set('daily_stats/store1_2026-09-10', { storeId: 'store1', date: '2026-09-10', totalRevenue: 0, invoiceCount: 0, sourceRevision: 2 }); versions.set('daily_stats/store1_2026-09-10', 2); }
      }
    });
    const r = await f.load('scripts/backfill_daily_stats.ts').backfillStoreDailyStats('store1'); assert.equal(r.updatedStatsDocs, 0); assert.equal(r.skippedChangedDays[0], '2026-09-10'); assert.equal(f.rows.get('daily_stats/store1_2026-09-10').totalRevenue, 0);
  });
  await test('Backfill resets an empty historical day rather than preserving stale revenue', async () => {
    const f = fixture({ 'daily_stats/store1_2026-09-10': { storeId: 'store1', date: '2026-09-10', totalRevenue: 100000, invoiceCount: 1 } }); const r = await f.load('scripts/backfill_daily_stats.ts').backfillStoreDailyStats('store1'); assert.equal(r.updatedStatsDocs, 1); assert.equal(f.rows.get('daily_stats/store1_2026-09-10').totalRevenue, 0); assert.equal(f.rows.get('daily_stats/store1_2026-09-10').coverageStatus, 'zero_activity');
  });
  await test('Backfill dry-run does not write any aggregates', async () => {
    const f = fixture({ 'cash_transactions/cash_i1': receiptFor('i1'), 'invoices/i1': { storeId: 'store1', date: '2026-09-10T05:00:00Z', total: 100000, totalCost: 40000, costStatus: 'estimated', costVersion: 1, paymentMethod: 'cash', items: [item()] } }); const r = await f.load('scripts/backfill_daily_stats.ts').backfillStoreDailyStats('store1', { dryRun: true }); assert.equal(r.updatedStatsDocs, 0); assert.equal(r.daysWithEstimatedCost, 1); assert(!f.rows.has('daily_stats/store1_2026-09-10'));
  });
  await test('Migration job lock has one owner and cannot be released by another job', async () => {
    const f = fixture(), m = f.load('scripts/migrate_legacy_data.ts'); const [a, b] = await Promise.all([m.acquireStoreLock('store1'), m.acquireStoreLock('store1')]); assert.equal([a, b].filter(Boolean).length, 1); const token = a || b; await m.releaseStoreLock('store1', 'wrong-token'); assert(f.rows.has('migration_locks/store1')); await m.releaseStoreLock('store1', token); assert(!f.rows.has('migration_locks/store1'));
  });
  await test('Date-range subscription includes old/new schemas, without display limits', async () => {
    const f = fixture(), listeners = [], data = []; f.api.onSnapshot = (q, opts, onData, onError) => { listeners.push({ q, onData, onError }); return () => { }; }; const source = f.load('src/utils/completeDataSource.ts'); const stop = source.subscribeDateRange('invoices', 'store1', '2026-09-10', '2026-09-10', (rows, ready) => data.push({ rows, ready }), e => { throw e; }); assert(!listeners[0].q.constraints.some(c => c.kind === 'limit'));
    const docs = Array.from({ length: 350 }, (_, i) => ({ id: `i${i}`, data: () => ({ storeId: 'store1', date: '2026-09-10T05:00:00Z', ...(i % 2 ? { businessDate: '2026-09-10' } : {}) }) })); listeners[0].onData({ docs, metadata: { fromCache: true, hasPendingWrites: false } }); assert.equal(data[0].rows.length, 350); assert.equal(data[0].ready, false); listeners[0].onData({ docs, metadata: { fromCache: false, hasPendingWrites: false } }); assert.equal(data[1].ready, true); stop();
  });
  await test('Missing-index fallback has no truncation and unsubscribe ignores late responses', async () => {
    const f = fixture(), listeners = [], data = []; f.api.onSnapshot = (q, opts, onData, onError) => { listeners.push({ q, onData, onError }); return () => { }; }; const source = f.load('src/utils/completeDataSource.ts'); const stop = source.subscribeDateRange('invoices', 'store1', '2026-09-10', '2026-09-10', (rows, ready) => data.push({ rows, ready }), e => { throw e; }); listeners[0].onError({ code: 'failed-precondition' }); assert.equal(listeners.length, 2); assert.equal(listeners[1].q.constraints.length, 1); stop(); listeners[1].onData({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } }); assert.equal(data.length, 0);
  });
  await test('Receipt reconciliation detects duplicate and missing sale receipts', async () => {
    const f = fixture();
    const invoice = { id: 'i1', storeId: 'store1', date: '2026-09-10T05:00:00Z', total: 100000, paymentMethod: 'cash' };
    const receipt = receiptFor('i1');
    assert(f.pure.receiptMismatch([invoice], []));
    assert.equal(f.pure.receiptMismatch([invoice], [receipt]), '');
    assert(f.pure.receiptMismatch([invoice], [receipt, { ...receipt, id: 'second' }]));
  });
  await test('Cross-store operations are rejected before changing inventory', async () => { const f = fixture({ 'menu/drink': { ...item(), storeId: 'other' } }); await assert.rejects(f.ops.importStockAtomic(user, 'drink', 5, 40000, undefined, 'a')); assert.equal(f.rows.get('menu/drink').stock, 10); });
  await test('Two kitchen devices completing different lines preserve both changes', async () => {
    const a = { ...item(), lineId: 'line-a' }, b = { ...item(), id: 'food', lineId: 'line-b', name: 'Food' }, base = { ...order(), items: [a, b], subtotal: 200000, total: 200000 }; const f = fixture({ 'tables/t1': table('t1', [base]) });
    const one = { ...base, items: [{ ...a, isCompleted: true }, b] }, two = { ...base, items: [a, { ...b, isCompleted: true }] }; await Promise.all([f.ops.updateOrdersAtomic(user, 't1', [base], [one], true), f.ops.updateOrdersAtomic(user, 't1', [base], [two], true)]); const stored = f.rows.get('tables/t1').orders[0]; assert(stored.items.every(i => i.isCompleted)); assert.equal(stored.status, 'ready');
  });
  await test('Adding portions to a completed line creates a new pending line', async () => {
    const ready = { ...order(), status: 'ready', items: [{ ...item(), lineId: 'old', isCompleted: true }] }; const f = fixture({ 'tables/t1': table('t1', [ready]) }); await f.ops.addOrderAtomic(user, 't1', [item()], 's1', 0, 'new'); const stored = f.rows.get('tables/t1').orders[0]; assert.equal(stored.items.length, 2); assert.equal(stored.items[0].isCompleted, true); assert.equal(stored.items[1].isCompleted, false); assert.equal(stored.subtotal, 200000);
  });
  await test('Cancellation replay never restores stock twice', async () => {
    const f = fixture({ 'cash_transactions/cash_i1': receiptFor('i1'), 'invoices/i1': { storeId: 'store1', date: '2026-09-10T05:00:00Z', total: 100000, items: [item()], paymentMethod: 'cash', inventoryMovements: [{ itemId: 'drink', quantity: 1 }] }, 'menu/drink': { ...item(), stock: 9 } }); await f.ops.cancelInvoiceAtomic(user, 'i1'); const again = await f.ops.cancelInvoiceAtomic(user, 'i1'); assert(again.deleted); assert.equal(f.rows.get('menu/drink').stock, 10);
  });
  await test('Concurrent attendance scans open only one session', async () => { const f = fixture(); const r = await Promise.all([f.ops.recordAttendanceAtomic(user, {}), f.ops.recordAttendanceAtomic(user, {})]); assert.equal([...f.rows.keys()].filter(p => p.startsWith('attendance_records/')).length, 1); assert.equal(r[0].type, 'check_in'); assert.equal(r[1].type, 'check_in'); });
  await test('Explicit check-out closes an overnight open session without creating another day', async () => { const nightTime = new Date(Date.now() - 11 * 3600 * 1000).toISOString(); const nightDate = dates.getVietnamBusinessDate(nightTime); const f = fixture({ 'attendance_records/night': { storeId: 'store1', userId: 'u1', date: nightDate, checkInTime: nightTime, status: 'present' } }); const r = await f.ops.recordAttendanceAtomic(user, { checkOutTime: new Date().toISOString() }); assert.equal(r.type, 'check_out'); assert.equal(f.rows.get('attendance_records/night').date, nightDate); assert(f.rows.get('attendance_records/night').checkOutTime); assert.equal([...f.rows.keys()].filter(p => p.startsWith('attendance_records/')).length, 1); });
  await test('Explicit check-out without a check-in cannot invent a work session', async () => { const f = fixture(); await assert.rejects(f.ops.recordAttendanceAtomic(user, { checkOutTime: new Date().toISOString() })); assert.equal([...f.rows.keys()].filter(p => p.startsWith('attendance_records/')).length, 0); });
  await test('Per-item revenue includes add-ons and allocates whole-dong discounts exactly', async () => { const f = fixture(); const inv = { subtotal: 300001, discount: 100000, total: 200001, vat: 0, items: [{ ...item(), price: 100000, selectedAddOns: [{ id: 'extra', price: 50000 }] }, { ...item(), price: 150001 }] }; const allocated = f.pure.allocatedItemRevenue(inv); assert.equal(allocated.reduce((s, n) => s + n, 0), 200001); assert(allocated.every(Number.isInteger)); });
  await test('Free inventory imports still update weighted average cost', async () => { const f = fixture({ 'menu/drink': item() }); await f.ops.importStockAtomic(user, 'drink', 10, 0, undefined, 'free'); assert.equal(f.rows.get('menu/drink').stock, 20); assert.equal(f.rows.get('menu/drink').costPrice, 20000); });
  await test('Unavailable source costs remain estimated even if an old order has a price', async () => { const f = fixture(); const result = f.cost.calculateInvoiceCostSnapshot([item()], () => undefined); assert.equal(result.totalCost, 40000); assert.equal(result.isComplete, false); });
  await test('Two devices opening a shift share one guarded open shift', async () => { const f = fixture(), h = f.handler('src/App.tsx', 'handleOpenShift', { openShiftAtomic: f.ops.openShiftAtomic }); await Promise.all([h.call(100000), h.call(100000)]); assert.equal([...f.rows.keys()].filter(p => p.startsWith('shifts/')).length, 1); });
  await test('Order cloning supports the existing iOS 15 target without structuredClone', async () => { const f = fixture(), original = { orders: [{ items: [{ quantity: 1, note: undefined }] }] }; const cloned = f.pure.cloneData(original); cloned.orders[0].items[0].quantity = 2; assert.equal(original.orders[0].items[0].quantity, 1); assert.equal(cloned.orders[0].items[0].note, undefined); });
  await test('Customer checkout succeeds with an empty customer list after atomic commit', async () => {
    const t = table(), f = fixture({ 'tables/t1': t, 'menu/drink': item(), 'customers/c1': { storeId: 'store1', name: 'Customer', points: 3 } });
    const h = f.handler('src/App.tsx', 'handleCheckout', { tables: [t], menu: [item()], customers: [] });
    assert.equal(await h.call('t1', [order()], 0, 'cash', false, 'c1'), true);
    assert.equal([...f.rows.keys()].filter(p => p.startsWith('invoices/')).length, 1);
    assert.equal([...f.rows.keys()].filter(p => p.startsWith('cash_transactions/')).length, 1);
    assert.equal(f.rows.get('customers/c1').points, 4); assert.equal(f.rows.get('tables/t1').status, 'empty'); assert.equal(f.alerts.length, 0);
  });
  await test('Deleted or foreign customer cannot commit a checkout', async () => {
    const t = table(), f = fixture({ 'tables/t1': t, 'menu/drink': item(), 'customers/c1': { storeId: 'other', points: 0 } });
    const h = f.handler('src/App.tsx', 'handleCheckout', { tables: [t], menu: [item()] }); assert.equal(await h.call('t1', [order()], 0, 'cash', false, 'c1'), false);
    assert.equal([...f.rows.keys()].filter(p => p.startsWith('invoices/')).length, 0); assert.equal(f.rows.get('tables/t1').orders.length, 1);
  });
  await test('A rendering failure after committed checkout never invites a second payment', async () => {
    const t = table(), f = fixture({ 'tables/t1': t, 'menu/drink': item() }); const h = f.handler('src/App.tsx', 'handleCheckout', { tables: [t], menu: [item()], setTables: () => { throw Error('render failed'); } });
    assert.equal(await h.call('t1', [order()], 0, 'cash'), true); assert.equal([...f.rows.keys()].filter(p => p.startsWith('invoices/')).length, 1); assert.equal(f.alerts.length, 0);
  });
  await test('Checkout cost snapshot clones the order and preserves exact recipe and topping quantities', async () => {
    const f = fixture(), base = { ...item(), id: 'dish', type: 'dish', quantity: 2, costPrice: 1, recipe: [{ ingredientId: 'milk', quantity: 0.1 }], selectedAddOns: [{ id: 'extra', inventoryItemId: 'syrup', price: 10000, costPrice: 1, quantity: 0.05 }] };
    const before = JSON.stringify(base); Object.freeze(base); Object.freeze(base.recipe[0]); Object.freeze(base.selectedAddOns[0]);
    const sources = { dish: { price: 100000 }, milk: { costPrice: 20000 }, syrup: { costPrice: 100000 } };
    const r = f.cost.calculateInvoiceCostSnapshot([base], id => sources[id]); assert.equal(r.totalCost, 14000); assert.equal(r.isComplete, true); assert.equal(r.items[0].costPrice, 2000); assert.equal(r.items[0].selectedAddOns[0].costPrice, 100000); assert.equal(JSON.stringify(base), before); assert.notEqual(r.items[0], base);
  });
  await test('Verified zero cost and configured topping cost retain their original meaning', async () => {
    const f = fixture(), a = { ...item(), costPrice: 0, selectedAddOns: [{ id: 'extra', name: 'Extra', price: 10000, costPrice: 5000 }] };
    const r = f.cost.calculateInvoiceCostSnapshot([a], id => id === 'drink' ? { costPrice: 0, costVerified: true, addOns: [{ id: 'extra', costPrice: 4000 }] } : undefined);
    assert.equal(r.totalCost, 4000); assert.equal(r.isComplete, true); assert.equal(r.items[0].costPrice, 0); assert.equal(a.selectedAddOns[0].costPrice, 5000);
  });
  await test('Historical cost is never repriced from the current menu or upgraded from estimated', async () => {
    const f = fixture(), inv = { id: 'old', date: '2026-09-10T05:00:00Z', total: 100000, totalCost: 40000, costStatus: 'estimated', costVersion: 1, items: [item()] };
    const before = JSON.stringify(inv), h = f.callback('src/components/SummaryView.tsx', 'recomputedInvoices', { periodInvoices: [inv], menu: [{ ...item(), costPrice: 60000 }], inventoryItems: [] });
    const r = h.call(); assert.equal(r.totalRecomputedCost, 40000); assert.equal(r.hasAnyIncompleteInvoice, true); assert.equal(r.recomputedInvoices[0].isCostComplete, false); assert.equal(JSON.stringify(inv), before);
    const zero = f.callback('src/components/SummaryView.tsx', 'recomputedInvoices', { periodInvoices: [{ ...inv, totalCost: 0, costStatus: 'complete', costVersion: 3, items: [{ ...item(), costPrice: 0, costVerified: true }] }] }).call(); assert.equal(zero.totalRecomputedCost, 0); assert.equal(zero.hasAnyIncompleteInvoice, false);
  });
  await test('Cash totals use the whole period and do not count sales receipts twice', async () => {
    const f = fixture(), r = f.load('src/utils/reportSources.ts').cashBookTotals([{ type: 'income', category: 'Bán Hàng', amount: 200000, paymentMethod: 'cash' }], { isRevenueComplete: true, isExpenseComplete: true, salesCashIncome: 300000, salesTransferIncome: 200000, cashIncome: 30000, transferIncome: 20000, cashExpense: 40000, transferExpense: 10000 });
    assert.equal(r.salesReceipts, 500000); assert.equal(r.totalIncome, 550000); assert.equal(r.totalExpense, 50000); assert.equal(r.closingBalance, 500000); assert.equal(r.cashBalance, 290000); assert.equal(r.bankBalance, 210000);
  });
  await test('Cash-only source merge preserves invoice cash, transfer, and historical estimated cost', async () => {
    const f = fixture(), r = f.load('src/utils/reportSources.ts'); const raw = f.pure.dailyStatsFromSources('store1', ['2026-09-10'], [], [{ date: '2026-09-10T05:00:00Z', type: 'expense', category: 'Other', amount: 10000, paymentMethod: 'cash' }], false)[0];
    const server = { ...raw, totalRevenue: 100000, totalCash: 100000, totalTransfer: 0, invoiceCount: 1, totalCost: 40000, costStatus: 'estimated' }; const merged = r.mergeDaySources(raw, server, false, true);
    assert.equal(merged.totalCash, 100000); assert.equal(merged.totalRevenue, 100000); assert.equal(merged.totalCost, 40000); assert.equal(merged.costStatus, 'estimated'); assert.equal(merged.totalExpense, 10000);
    assert.equal(r.reconciledSource({ ...server, coverageStatus: 'reconciled', totalCash: undefined }, 'invoices'), false); assert.equal(r.verifiedDayCost({ ...server, totalCost: 0, costStatus: 'complete' }), true);
  });
  function sourceFunction(f, file, name, extra = {}) {
    const text = fs.readFileSync(path.join(root, file), 'utf8'), tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let found; const visit = n => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n; ts.forEachChild(n, visit); }; visit(tree); assert(found, name); return f.evaluate('(' + found.getText(tree) + ')', extra).call;
  }
  await test('Full raw invoices preserve estimated cost even when an old complete aggregate has the same total', async () => {
    const f = fixture(), day = '2026-09-10', inv = { id: 'i1', storeId: 'store1', date: day + 'T05:00:00Z', total: 100000, totalCost: 40000, costStatus: 'estimated', costVersion: 1, items: [item()], paymentMethod: 'cash' };
    const cash = { id: 'cash_i1', storeId: 'store1', date: inv.date, invoiceId: 'i1', type: 'income', category: 'Bán Hàng', amount: 100000, paymentMethod: 'cash' };
    const raw = f.pure.dailyStatsFromSources('store1', [day], [inv], [cash], true)[0];
    const coverage = { invoiceDays: new Set([day]), cashDays: new Set([day]) };
    const rawReport = f.load('src/utils/reportSources.ts').aggregateReportDays('store1', [day], [inv], [cash], coverage);
    const h = f.callback('src/components/SummaryView.tsx', 'statsAggregates', { rawReport, statsPeriodKey: day, periodKey: day, dateFilter: day, filterType: 'day', todayVietnam: '2026-11-05', dailyStats: [{ ...raw, costStatus: 'complete' }], dailyStatsReady: true, sourceCoverage: { invoiceDays: new Set([day]), cashDays: new Set([day]) }, periodInvoices: [inv], sourcePeriodCash: [cash], getExpectedPeriodDates: () => [day], sourceMismatch: '', reportDataReady: true, hasMoreInvoices: false, hasAnyIncompleteInvoice: true, missingCostItems: [], totalRecomputedCost: 40000, activeTab: 'financial', isInvoicesReady: true });
    const r = h.call(); assert.equal(r.totalCost, 40000); assert.equal(r.costStatus, 'estimated'); assert.equal(r.isProfitComplete, false); assert.equal(r.totalCash, 100000);
  });
  await test('Date-ordered pagination includes legacy and current invoices across all pages', async () => {
    const day = '2026-09-10', rows = {}; for (let n = 0; n < 65; n++)rows['invoices/' + String(100 - n).padStart(3, '0')] = { storeId: 'store1', date: day + 'T05:' + String(n % 60).padStart(2, '0') + ':00.000Z', total: n, ...(n % 2 ? { businessMonth: '2026-09', businessDate: day } : {}) };
    const f = fixture(rows), build = f.handler('src/components/SummaryView.tsx', 'buildInvoiceQuery').call; let cursor = null, all = [];
    for (let n = 0; n < 4; n++) { const q = build('store1', 'month', '2026-09-01', '2026-08-31T17:00:00.000Z', '2026-09-30T17:00:00.000Z', 'modern', false, cursor, 30); assert(!q.constraints.some(c => c.field === 'businessMonth')); const s = await f.api.getDocsFromServer(q); all.push(...s.docs); if (s.docs.length < 30) break; cursor = s.docs.at(-1); }
    assert.equal(all.length, 65); assert.equal(new Set(all.map(d => d.id)).size, 65); assert(all.every((d, i) => !i || all[i - 1].data().date >= d.data().date));
  });
  await test('Full source fetch retains 401 mixed-schema rows with Vietnam day boundaries', async () => {
    const rows = {}; for (let n = 0; n < 401; n++)rows['invoices/i' + n] = { storeId: 'store1', date: '2026-09-09T17:00:00.000Z', total: 1, ...(n % 2 ? { businessDate: '2026-09-10' } : {}) }; rows['invoices/out'] = { storeId: 'store1', date: '2026-09-10T17:00:00.000Z', total: 1 }; rows['invoices/foreign'] = { storeId: 'other', date: '2026-09-10T05:00:00Z', total: 1 };
    const f = fixture(rows), r = await f.load('src/utils/completeDataSource.ts').fetchDateRangeRows('invoices', 'store1', '2026-09-10', '2026-09-10'); assert.equal(r.length, 401);
  });
  await test('Subscription errors never certify an incomplete source and pending writes remain unconfirmed', async () => {
    const f = fixture(), listeners = [], emitted = [], errors = []; f.api.onSnapshot = (q, o, onData, onError) => { listeners.push({ q, onData, onError }); return () => { } };
    f.load('src/utils/completeDataSource.ts').subscribeDateRange('invoices', 'store1', '2026-09-10', '2026-09-10', (rows, ready) => emitted.push(ready), e => errors.push(e)); assert.equal(listeners.length, 1);
    listeners[0].onData({ docs: [], metadata: { fromCache: false, hasPendingWrites: true } }); listeners[0].onError({ code: 'permission-denied', message: 'denied' }); assert.deepEqual(emitted, [false]); assert.equal(errors.length, 1); assert.equal(listeners.length, 1);
  });
  await test('Complete export source refuses pending writes and concurrent revision changes', async () => {
    const pending = fixture({}, { queryMetadata: { fromCache: false, hasPendingWrites: true } }); await assert.rejects(pending.load('src/utils/completeDataSource.ts').fetchFinancialPeriodSources('store1', '2026-09-10', '2026-09-10'));
    let changed = false; const f = fixture({ 'daily_stats/store1_2026-09-10': { storeId: 'store1', date: '2026-09-10', sourceRevision: 1 } }, { afterQuery: (q, rows) => { if (q.col.path === 'cash_transactions' && !changed) { changed = true; rows.set('daily_stats/store1_2026-09-10', { storeId: 'store1', date: '2026-09-10', sourceRevision: 2 }); } } });
    await assert.rejects(f.load('src/utils/completeDataSource.ts').fetchFinancialPeriodSources('store1', '2026-09-10', '2026-09-10'), /thay đổi/);
  });
  function excelFixture(f, overrides = {}) {
    let exported = [], clicked = 0; const key = 'store1_2026-09-01_month', financial = f.load('src/utils/completeDataSource.ts');
    const h = f.handler('src/components/SummaryView.tsx', 'exportToExcel', { periodKey: key, currentPeriodRef: { current: key }, activeRequestId: { current: 1 }, exportLock: { current: false }, setIsExporting: () => { }, dateFilter: '2026-09-01', filterType: 'month', todayVietnam: '2026-11-05', activeTab: 'sales', getExpectedPeriodDates: () => ['2026-09-01', '2026-09-30'], ...financial, invoiceSearch: '', cashFilterType: 'all', cashMethodFilter: 'all', isAdminOrManager: true, filteredInvoices: [{ id: 'partial' }], format: () => '', parseISO: s => s, paymentMethodMap: { cash: 'Tiền mặt', transfer: 'Chuyển khoản' }, XLSX: { utils: { json_to_sheet: rows => { exported = rows; return {} }, book_new: () => ({}), book_append_sheet: () => { } }, write: () => new Uint8Array() }, Blob, URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => { } }, document: { createElement: () => ({ click: () => clicked++ }) }, ...overrides });
    return { ...h, exported: () => exported, clicked: () => clicked };
  }
  function invoiceCashRows(count) {
    const rows = {}; for (let n = 0; n < count; n++) { const date = '2026-09-10T05:00:00Z', id = 'i' + n; rows['invoices/' + id] = { storeId: 'store1', date, total: 100000, tableName: 'Table ' + n, staffName: 'User', paymentMethod: 'cash', items: [item()] }; rows['cash_transactions/cash_' + id] = { storeId: 'store1', date, invoiceId: id, type: 'income', category: 'Bán Hàng', amount: 100000, paymentMethod: 'cash', staffId: 'u1' }; } return rows;
  }
  await test('Invoice Excel exports all 65 records directly instead of a partial render array', async () => {
    const f = fixture(invoiceCashRows(65)), h = excelFixture(f); await h.call(); assert.equal(h.exported().length, 65); assert.equal(h.exported().reduce((s, r) => s + r['Tổng tiền'], 0), 6500000); assert.equal(h.clicked(), 1); assert.equal(f.alerts.length, 0);
  });
  await test('Cash Excel has a working full-period loader and treats a legacy empty method as cash', async () => {
    const rows = invoiceCashRows(65); delete rows['cash_transactions/cash_i1'].paymentMethod; const f = fixture(rows), h = excelFixture(f, { activeTab: 'cash', cashMethodFilter: 'cash' }); await h.call(); assert.equal(h.exported().length, 65); assert.equal(h.clicked(), 1); assert.equal(f.alerts.length, 0);
  });
  await test('Export validates receipts after full fetch and preserves the invoice search', async () => {
    const f = fixture(invoiceCashRows(65)), h = excelFixture(f, { sourceMismatch: 'stale partial-page mismatch', invoiceSearch: 'Table 64' }); await h.call(); assert.equal(h.exported().length, 1); assert.equal(h.exported()[0]['Bàn'], 'Table 64'); assert.equal(f.alerts.length, 0);
    const badRows = invoiceCashRows(3); delete badRows['cash_transactions/cash_i2']; const b = fixture(badRows), blocked = excelFixture(b); await blocked.call(); assert.equal(blocked.clicked(), 0); assert.equal(b.alerts.length, 1);
  });
  await test('Switching report period disposes stale queries and keeps loading until the first page arrives', async () => {
    const f = fixture(), jobs = [], state = { rows: [], loading: false }, noop = () => { }; const key = 'store1_2026-09-01_month';
    const h = f.effect('src/components/SummaryView.tsx', 'const requestId = ++activeRequestId.current', { activeRequestId: { current: 0 }, periodKey: key, currentPeriodRef: { current: key }, pageLocks: { current: new Set() }, dateFilter: '2026-09-01', filterType: 'month', activeTab: 'sales', todayVietnam: '2026-11-05', getExpectedPeriodDates: () => ['2026-09-01', '2026-09-30'], buildInvoiceQuery: () => ({}), getDocsFromServer: () => new Promise(resolve => jobs.push(resolve)), setIsLoadingMoreInvoices: noop, setIsLoadingMoreCash: noop, setIsLoadingMoreLogs: noop, setHistoricalInvoices: v => state.rows = v, setHistoricalCash: noop, setHasMoreInvoices: noop, setHasMoreCash: noop, setLastInvoiceDoc: noop, setLastCashDoc: noop, setRawScope: noop, setReportError: noop, setIsLoadingHistorical: v => state.loading = v });
    const stop1 = h.call(); assert.equal(typeof stop1, 'function'); assert.equal(state.loading, true); stop1(); h.context.periodKey = 'store1_2026-10-01_month'; h.context.currentPeriodRef.current = h.context.periodKey; h.context.dateFilter = '2026-10-01'; const stop2 = h.call();
    const snap = id => ({ docs: [{ id, data: () => ({ storeId: 'store1', date: '2026-10-10T05:00:00Z' }) }], size: 1, metadata: { hasPendingWrites: false } }); jobs[1](snap('new')); await Promise.resolve(); await Promise.resolve(); jobs[0](snap('old')); await Promise.resolve(); await Promise.resolve(); assert.equal(state.rows[0].id, 'new'); assert.equal(state.loading, false); stop2();
  });
  await test('Attendance scan failure stops before creating a duplicate open session', async () => {
    const f = fixture({ 'attendance_records/old': { storeId: 'store1', userId: 'u1', date: '2026-09-10', checkInTime: '2026-09-10T05:00:00Z', status: 'present' } }, { failQuery: q => q.col.path === 'attendance_records' });
    await assert.rejects(f.ops.recordAttendanceAtomic(user, {})); assert.equal([...f.rows.keys()].filter(p => p.startsWith('attendance_records/')).length, 1); assert(!f.rows.get('attendance_records/old').checkOutTime);
  });
  await test('Customer subscription clears a deleted profile, resets discount, and ignores late updates', async () => {
    const f = fixture(), listeners = [], state = { selected: { id: 'old' }, discount: 10, ready: true, error: '' }; f.api.onSnapshot = (q, o, onData, onError) => { listeners.push({ onData, onError }); return () => { } };
    const h = f.effect('src/App.tsx', 'setSelectedCustomerReady(false)', { selectedCustomerId: 'c1', activeTable: { discount: 2 }, customerTypes: [{ id: 'vip', discountPercent: 10 }], setSelectedCustomer: v => state.selected = v, setSelectedCustomerReady: v => state.ready = v, setSelectedCustomerError: v => state.error = v, setDiscount: v => state.discount = v }); const stop = h.call(); assert.equal(state.selected, null); assert.equal(state.ready, false);
    const snap = (exists, cache = false) => ({ id: 'c1', exists: () => exists, data: () => ({ storeId: 'store1', name: 'Customer', typeId: 'vip' }), metadata: { fromCache: cache, hasPendingWrites: false } });
    listeners[0].onData(snap(true, true)); assert.equal(state.discount, 10); assert.equal(state.ready, false); listeners[0].onData(snap(true)); assert.equal(state.ready, true); listeners[0].onData(snap(false)); assert.equal(state.selected, null); assert.equal(state.discount, 2); assert.equal(state.ready, false); assert(state.error); stop(); listeners[0].onData(snap(true)); assert.equal(state.selected, null);
  });
  await test('Payment waits for the matching customer before saving drafts or calling checkout', async () => {
    const f = fixture(), h = f.handler('src/App.tsx', 'handlePayment', { isProcessing: false, selectedCustomerId: 'new', selectedCustomerReady: true, selectedCustomer: { id: 'old' }, selectedCustomerError: '', onUpdateOrder: () => { throw Error('must not save') }, onCheckout: () => { throw Error('must not charge') } }); await h.call(); assert.equal(f.alerts.length, 1);
  });
  await test('Tax report fills missing days when some daily stats already exist and writes no data', async () => {
    const f = fixture(), listeners = [], ranges = [], state = {}, noop = () => { }; f.api.onSnapshot = (q, o, onData, onError) => { listeners.push({ onData, onError }); return () => { } };
    const dates = require(path.join(root, 'node_modules/date-fns')), group = sourceFunction(f, 'src/components/TaxReportView.tsx', 'groupContiguousDays', dates);
    const h = f.effect('src/components/TaxReportView.tsx', "setLoadingStatusText('Đang xác nhận dữ liệu thống kê...')", { ...dates, selectedYear: 2026, todayVn: '2026-01-03', groupContiguousDays: group, subscribeDateRange: (name, store, start, end, onData, onError) => { ranges.push({ start, end, onData, onError }); return () => { } }, setTaxDataReady: v => state.ready = v, setTaxError: v => state.error = v, setIsLoadingYear: noop, setLoadingStatusText: noop, setDailyStats: v => state.stats = v, setYearInvoices: noop, setCoveredDays: v => state.covered = v, setConfirmedZeroDays: v => state.zero = v }); const stop = h.call();
    listeners[0].onData({ docs: [{ id: 's1', data: () => ({ storeId: 'store1', date: '2026-01-01', totalRevenue: 100000, invoiceCount: 1, coverageStatus: 'reconciled', receiptReconciliationVersion: 1 }) }], metadata: { fromCache: false, hasPendingWrites: false } });
    assert.equal(ranges.length, 1); assert.equal(ranges[0].start, '2026-01-02'); assert.equal(ranges[0].end, '2026-01-03'); assert.equal(state.ready, false);
    ranges[0].onData([{ id: 'i2', storeId: 'store1', date: '2026-01-02T05:00:00Z', total: 50000, items: [], paymentMethod: 'cash' }], true); assert.equal(state.stats.reduce((s, r) => s + r.totalRevenue, 0), 150000); assert.equal(state.ready, true); assert.equal(state.covered.size, 3); assert(state.zero.has('2026-01-03')); assert.equal(f.rows.size, 0); ranges[0].onError(Error('offline')); assert.equal(state.ready, false); assert(!state.covered.has('2026-01-02')); stop();
  });
  await test('Tax quarter completeness uses server-confirmed coverage rather than a cached status label', async () => {
    const f = fixture(), dates = require(path.join(root, 'node_modules/date-fns')), h = f.callback('src/components/TaxReportView.tsx', 'getQuarterInfo', { ...dates, selectedYear: 2026, mergedDailyStats: [{ date: '2026-01-01', totalRevenue: 100000, coverageStatus: 'reconciled' }], effectiveInvoices: [], coveredDays: new Set(), confirmedZeroDays: new Set(), getVietnamBusinessDate: () => '2026-01-01' }); const r = h.call(1, 3); assert.equal(r.revenue, 100000); assert.equal(r.isComplete, false); assert.equal(r.missingDaysCount, 1);
  });
  await test('Menu ordering renders an occupied table without a temporal-dead-zone exception', async () => {
    const f = fixture(), React = require(path.join(root, 'node_modules/react')), icons = require(path.join(root, 'node_modules/lucide-react')), dates = require(path.join(root, 'node_modules/date-fns')), motion = require(path.join(root, 'node_modules/motion/react'));
    const h = f.handler('src/App.tsx', 'MenuOrdering', { React, ...React, ...icons, ...dates, ...motion, cn: (...a) => a.filter(Boolean).join(' '), safeStorage: { getItem: () => null, setItem: () => { }, removeItem: () => { } }, UserIcon: icons.User, LiveTimer: () => null, getMenuItemImage: f.load('src/utils/foodImageHelper.ts').getMenuItemImage, formatCurrency: n => String(n) });
    const noop = () => { }, props = { selectedTable: table(), tables: [table()], menu: [item()], categories: [], vatPercent: 8, currentUser: user, customers: [], customerTypes: [], systemSettings: {}, activeShift: null, staffName: 'User', onClose: noop, onUpdateOrder: noop, onCheckout: noop, onMergeTables: noop, onTransferTable: noop, onPrint: noop, onUpdateTable: noop, onLogVoid: noop };
    const html = require(path.join(root, 'node_modules/react-dom/server')).renderToString(React.createElement(h.call, props)); assert(html.includes('100')); assert(html.includes('t1'));
  });

  await test('Bad cash document leaves good invoice revenue and good receipts visible', async () => {
    const f = fixture(), day = '2026-09-10', good = receiptFor('i1');
    const invoices = [{ id: 'i1', storeId: 'store1', date: good.date, total: 100000, totalCost: 40000, costStatus: 'complete', costVersion: 3, paymentMethod: 'cash', items: [item()] }];
    const cash = [good, { ...good, id: 'bad-expense', type: 'expense', category: 'Other', amount: '10000' }];
    const coverage = { invoiceDays: new Set([day]), cashDays: new Set([day]) };
    const report = f.load('src/utils/reportSources.ts');
    const rawReport = report.aggregateReportDays('store1', [day], invoices, cash, coverage);
    const stats = f.callback('src/components/SummaryView.tsx', 'statsAggregates', {
      dateFilter: day, filterType: 'day', todayVietnam: day, dailyStats: [], dailyStatsReady: true,
      periodInvoices: invoices, sourcePeriodCash: cash, sourceCoverage: coverage, rawReport,
      statsPeriodKey: day, periodKey: day, getExpectedPeriodDates: () => [day], sourceMismatch: '', reportDataReady: true,
      hasMoreInvoices: false, hasAnyIncompleteInvoice: false, missingCostItems: [], totalRecomputedCost: 40000, activeTab: 'sales',
    }).call();
    assert.equal(stats.totalRevenue, 100000);
    assert.equal(stats.isRevenueComplete, true);
    assert.equal(stats.isExpenseComplete, false);
    assert.equal(stats.isProfitComplete, false);
    assert.match(rawReport.issues[0], /bad-expense/);
    assert.equal(report.cashBookTotals(cash, stats).totalIncome, 100000);
  });
  await test('Unpaid or missing receipt is not counted as collected cash', async () => {
    const f = fixture(), day = '2026-09-10', invoice = { id: 'i1', storeId: 'store1', date: `${day}T05:00:00Z`, total: 100000, paymentMethod: 'cash', items: [] };
    const report = f.load('src/utils/reportSources.ts');
    const raw = report.aggregateReportDays('store1', [day], [invoice], [], { invoiceDays: new Set([day]), cashDays: new Set([day]) });
    assert.equal(raw.stats.get(day).totalRevenue, 100000);
    assert.equal(report.cashBookTotals([], raw.stats.get(day)).totalIncome, 0);
    assert.match(raw.receiptIssues.get(day), /thiếu phiếu/);
    assert.throws(() => f.pure.reconcileDay('store1', day, [invoice], []), /thiếu phiếu/);
  });
  await test('Receipt reconciliation checks each link, amount, payment method and business day', async () => {
    const f = fixture(), day = '2026-09-10', first = receiptFor('i1'), second = receiptFor('i2', 200000);
    const invoices = [first, second].map(row => ({ id: row.invoiceId, storeId: 'store1', date: row.date, total: row.amount, paymentMethod: 'cash', items: [] }));
    assert(f.pure.receiptMismatch(invoices, [{ ...first, amount: 200000 }, { ...second, amount: 100000 }]));
    assert(f.pure.receiptMismatch(invoices, [{ ...first, paymentMethod: 'transfer' }, second]));
    assert(f.pure.receiptMismatch(invoices, [{ ...first, date: '2026-09-09T05:00:00Z' }, second]));
    assert(f.pure.receiptMismatch(invoices, [{ ...first, id: 'legacy', invoiceId: undefined }, second]));
    const stats = f.pure.reconcileDay('store1', day, invoices, [first, second]);
    const report = f.load('src/utils/reportSources.ts');
    assert.equal(stats.salesCashIncome, 300000);
    assert(report.reconciledSource(stats, 'cash'));
    assert.equal(report.reconciledSource({ ...stats, receiptReconciliationVersion: undefined }, 'cash'), false);
  });
  await test('Backfill skips an unmatched day while saving the correctly paired day', async () => {
    const matching = receiptFor('i1');
    const valid = { storeId: 'store1', date: matching.date, total: 100000, paymentMethod: 'cash', items: [] };
    const f = fixture({
      'invoices/i1': valid, 'cash_transactions/cash_i1': matching,
      'invoices/i2': { ...valid, date: '2026-09-11T05:00:00Z' }, 'daily_stats/store1_2026-09-11': { storeId: 'store1', date: '2026-09-11', totalRevenue: 100000 }
    });
    const result = await f.load('scripts/backfill_daily_stats.ts').backfillStoreDailyStats('store1');
    assert.equal(result.updatedStatsDocs, 1);
    assert.equal(result.skippedUnreconciledDays[0].date, '2026-09-11');
    assert.equal(f.rows.get('daily_stats/store1_2026-09-10').receiptReconciliationVersion, 1);
    assert.equal(f.rows.get('daily_stats/store1_2026-09-11').receiptReconciliationVersion, undefined);
    assert(f.rows.has('invoices/i2'));
  });
  await test('A legacy cancellation requires a manually verified receipt and archives both documents', async () => {
    const receipt = receiptFor('i1', 100000, { id: 'legacy-row', invoiceId: undefined });
    const invoice = { id: 'i1', storeId: 'store1', date: receipt.date, total: 100000, items: [], inventoryMovements: [], paymentMethod: 'cash' };
    const f = fixture({ 'invoices/i1': invoice, 'cash_transactions/legacy-row': receipt });
    const before = JSON.stringify([...f.rows]);
    await assert.rejects(f.ops.cancelInvoiceAtomic(user, 'i1'), /chưa có phiếu/);
    assert.equal(JSON.stringify([...f.rows]), before);
    const candidates = await f.ops.legacyReceiptCandidates(user, invoice);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, 'legacy-row');
    const result = await f.ops.cancelInvoiceAtomic(user, 'i1', 'legacy-row');
    assert.equal(result.receiptId, 'legacy-row');
    assert(!f.rows.has('invoices/i1'));
    assert(!f.rows.has('cash_transactions/legacy-row'));
    assert.equal(f.rows.get('cancelled_invoices/cancel_i1').originalCashReceipt.amount, 100000);
    assert.equal(f.rows.get('cancelled_invoices/cancel_i1').receiptMatch, 'verified_by_admin');
  });
  await test('A changed or differently linked receipt cannot be deleted with a legacy invoice', async () => {
    const first = receiptFor('other', 100000, { id: 'legacy-row' });
    const inv = { storeId: 'store1', date: first.date, total: 100000, items: [], paymentMethod: 'cash' };
    const f = fixture({ 'invoices/i1': inv, 'cash_transactions/legacy-row': first });
    await assert.rejects(f.ops.cancelInvoiceAtomic(user, 'i1', 'legacy-row'), /không khớp/);
    assert(f.rows.has('invoices/i1'));
    assert(f.rows.has('cash_transactions/legacy-row'));
    assert(!f.rows.has('cancelled_invoices/cancel_i1'));
  });
  await test('Opening a shift cannot fall through after an unreadable server query', async () => {
    const f = fixture({ 'shifts/z-old': { storeId: 'store1', staffId: 'u1', status: 'open' } },
      { failQuery: query => query.col.path === 'shifts' });
    await assert.rejects(f.ops.openShiftAtomic(user, 100000));
    assert.equal(f.rows.size, 1);
    assert(!f.rows.has('checkout_locks/shift_open_store1_u1'));
  });
  await test('Legacy shift beyond ten other shifts is adopted by the guard', async () => {
    const rows = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`shifts/a${i}`, { storeId: 'store1', staffId: `other${i}`, status: 'open' }]));
    rows['shifts/z-old'] = { storeId: 'store1', staffId: 'u1', status: 'open', startCash: 20000 };
    const f = fixture(rows);
    await f.ops.openShiftAtomic(user, 100000);
    assert.equal(f.rows.get('checkout_locks/shift_open_store1_u1').shiftId, 'z-old');
    assert.equal([...f.rows.keys()].filter(key => key.startsWith('shifts/')).length, 12);
    assert.equal(f.rows.get('shifts/z-old').startCash, 20000);
  });
  await test('Cached or pending shift results cannot authorize a new shift', async () => {
    for (const queryMetadata of [{ fromCache: true, hasPendingWrites: false }, { fromCache: false, hasPendingWrites: true }]) {
      const f = fixture({}, { queryMetadata });
      await assert.rejects(f.ops.openShiftAtomic(user, 100000));
      assert.equal(f.rows.size, 0);
    }
  });
  await test('Login requires Firebase token and verifies the session claims', async () => {
    const f = fixture(), errors = [], logged = [], noop = () => { };
    const execute = (customToken, claims) => f.handler('src/components/LoginView.tsx', 'handleLogin', {
      setLoading: noop, setError: value => errors.push(value), storeCode: 'store1', username: 'user', password: 'demo-only', apiUrl: value => value,
      fetch: async () => ({ ok: true, json: async () => ({ success: true, user, customToken }) }), onLogin: value => logged.push(value),
      auth: { async signOut() { } }, signInWithCustomToken: async () => ({ user: { uid: user.id, getIdTokenResult: async () => ({ claims }) } }),
    }).call({ preventDefault: noop });
    await execute(null, { storeId: 'store1', role: 'admin' });
    await execute('test-token', { storeId: 'wrong-store', role: 'admin' });
    assert.equal(logged.length, 0);
    assert(errors.filter(Boolean).length >= 2);
    await execute('test-token', { storeId: 'store1', role: 'admin' });
    assert.equal(logged.length, 1);
  });
  await test('Strong credentials take precedence over stale legacy hashes', async () => {
    const f = fixture(), crypt = f.load('api/_crypto.ts'), auth = f.load('api/_legacyCredentials.ts');
    const oldHash = require('node:crypto').createHash('sha256').update('old-demo').digest('hex');
    const stored = { passwordHash: crypt.hashPassword('new-demo'), clientHash: oldHash };
    assert(auth.verifyStoredCredential('new-demo', stored));
    assert.equal(auth.verifyStoredCredential('old-demo', stored), false);
  });

  await test('Legacy credential migration denies old keys and keeps dry runs read-only', async () => {
    const records = {
      'stores/store1': { name: 'Test store' },
      'users/u1': { ...user, username: 'test-owner', tokenVersion: 1, password: 'only-a-fixture' },
      'settings/s1': { storeId: 'store1', adminUsername: 'test-owner', adminPassword: 'only-a-fixture', vatPercent: 8 },
    };
    const reply = () => ({ code: 0, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, setHeader() { return this; } });
    const denied = fixture(records, { caller: null }), forbidden = reply();
    await denied.load('api/sync-legacy-users.ts').default({ method: 'POST', body: { storeId: 'store1', key: 'obsolete-key', dryRun: false } }, forbidden);
    assert.equal(forbidden.code, 403);
    assert.equal(denied.rows.get('users/u1').password, records['users/u1'].password);
    const f = fixture(records, { caller: { uid: 'superadmin', role: 'superadmin', isSuperAdmin: true } });
    const migrate = f.load('api/sync-legacy-users.ts').default, dry = reply();
    await migrate({ method: 'POST', body: { storeId: 'store1' } }, dry);
    assert.equal(dry.code, 200);
    assert.equal(dry.body.eligible, 1);
    assert.equal(dry.body.updated, 0);
    assert.equal(f.rows.size, 3);
    const applied = reply();
    await migrate({ method: 'POST', body: { storeId: 'store1', dryRun: false } }, applied);
    assert.equal(applied.code, 200);
    assert.equal(applied.body.ready, true);
    assert.equal(f.rows.get('users/u1').password, undefined);
    assert.equal(f.rows.get('settings/s1').adminPassword, undefined);
    assert.equal(f.rows.get('settings/s1').vatPercent, 8);
    assert.equal(f.rows.get('stores/store1').credentialStorageVersion, 1);
    assert(f.load('api/_legacyCredentials.ts').verifyStoredCredential(records['users/u1'].password, f.rows.get('user_secrets/u1')));
  });
  await test('Credential migration preserves conflicting sources and does not certify the store', async () => {
    const f = fixture({ 'stores/store1': {}, 'users/u1': { ...user, password: 'legacy-fixture' } },
      { caller: { uid: 'superadmin', role: 'superadmin', isSuperAdmin: true } });
    const hash = f.load('api/_crypto.ts').hashPassword('current-fixture');
    f.rows.set('user_secrets/u1', { passwordHash: hash, tokenVersion: 1 });
    const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; }, setHeader() { return this; } };
    await f.load('api/sync-legacy-users.ts').default({ method: 'POST', body: { storeId: 'store1', dryRun: false } }, response);
    assert.equal(response.code, 200);
    assert.equal(response.body.ready, false);
    assert.equal(response.body.skipped.length, 1);
    assert.equal(f.rows.get('user_secrets/u1').passwordHash, hash);
    assert.equal(f.rows.get('users/u1').password, 'legacy-fixture');
    assert.equal(f.rows.get('stores/store1').credentialStorageVersion, undefined);
  });

  await test('Payroll finalization rejects stale attendance count (1 day on client vs 2 days on server) and requires recalculation', async () => {
    const staff = { id: 'staff1', storeId: 'store1', name: 'Nhân viên 1', role: 'staff', salaryType: 'daily', salaryAmount: 200000 };
    const records = {
      'users/staff1': staff,
      'attendance_records/att1': { id: 'att1', storeId: 'store1', userId: 'staff1', date: '2026-11-01', checkInTime: '2026-11-01T08:00:00Z', checkOutTime: '2026-11-01T17:00:00Z', status: 'present' },
      'attendance_records/att2': { id: 'att2', storeId: 'store1', userId: 'staff1', date: '2026-11-02', checkInTime: '2026-11-02T08:00:00Z', checkOutTime: '2026-11-02T17:00:00Z', status: 'present' },
    };
    const f = fixture(records);
    const dataOps = f.load('src/services/dataOperations.ts');
    const adminCaller = { id: 'admin1', storeId: 'store1', role: 'admin' };

    // Client only computed with 1 day (att1)
    const stalePayroll = {
      id: '',
      userId: 'staff1',
      storeId: 'store1',
      month: '2026-11',
      presentDays: 1,
      baseSalaryAmount: 200000,
      baseSalaryType: 'daily',
      calculatedSalary: 200000,
      bonus: 0,
      deduction: 0,
      totalSalary: 200000,
      status: 'finalized'
    };

    // Must reject because server has 2 days!
    await assert.rejects(
      async () => {
        await dataOps.finalizePayrollAtomic(adminCaller, stalePayroll);
      },
      /Dữ liệu chấm công của nhân viên đã thay đổi trên máy chủ/
    );

    // Assert nothing was written to payroll_records
    assert.equal(f.rows.has('payroll_records/store1_staff1_2026-11'), false);

    // Now client recalculates with 2 days
    const updatedPayroll = {
      ...stalePayroll,
      presentDays: 2,
      calculatedSalary: 400000,
      totalSalary: 400000
    };

    const res = await dataOps.finalizePayrollAtomic(adminCaller, updatedPayroll);
    assert.equal(res.finalRecord.presentDays, 2);
    assert.equal(res.finalRecord.calculatedSalary, 400000);
    assert.equal(res.finalRecord.totalSalary, 400000);
    assert.equal(f.rows.has('payroll_records/store1_staff1_2026-11'), true);
    assert.equal(f.rows.get('payroll_records/store1_staff1_2026-11').presentDays, 2);
  });

  await test('Payroll finalization rejects changed server salary configuration and requires recalculation', async () => {
    const staff = { id: 'staff2', storeId: 'store1', name: 'Nhân viên 2', role: 'staff', salaryType: 'daily', salaryAmount: 250000 };
    const records = {
      'users/staff2': staff,
      'attendance_records/att1': { id: 'att1', storeId: 'store1', userId: 'staff2', date: '2026-11-01', checkInTime: '2026-11-01T08:00:00Z', checkOutTime: '2026-11-01T17:00:00Z', status: 'present' },
    };
    const f = fixture(records);
    const dataOps = f.load('src/services/dataOperations.ts');
    const adminCaller = { id: 'admin1', storeId: 'store1', role: 'admin' };

    // Client computed with old salary of 200,000
    const staleSalaryPayroll = {
      id: '',
      userId: 'staff2',
      storeId: 'store1',
      month: '2026-11',
      presentDays: 1,
      baseSalaryAmount: 200000,
      baseSalaryType: 'daily',
      calculatedSalary: 200000,
      bonus: 0,
      deduction: 0,
      totalSalary: 200000,
      status: 'finalized'
    };

    await assert.rejects(
      async () => {
        await dataOps.finalizePayrollAtomic(adminCaller, staleSalaryPayroll);
      },
      /Cấu hình lương của nhân viên đã thay đổi trên máy chủ/
    );

    assert.equal(f.rows.has('payroll_records/store1_staff2_2026-11'), false);
  });

  await test('Overnight attendance check-in at 22:00 and check-out at 09:00 next day is accepted and not treated as stale', async () => {
    const staff = { id: 'staff_night', storeId: 'store1', name: 'Nhân viên Ca Đêm', role: 'staff' };
    const inTime = new Date(Date.now() - 11 * 3600 * 1000).toISOString();
    const inDate = new Date(Date.now() - 11 * 3600 * 1000 + 7 * 3600 * 1000).toISOString().slice(0, 10);
    const outTime = new Date().toISOString();

    const records = {
      'users/staff_night': staff,
      'checkout_locks/attendance_store1_staff_night': {
        storeId: 'store1',
        userId: 'staff_night',
        openRecordId: 'att_overnight',
        recordId: 'att_overnight',
        lastAction: 'check_in',
        lastActionAt: inTime
      },
      'attendance_records/att_overnight': {
        id: 'att_overnight',
        storeId: 'store1',
        userId: 'staff_night',
        staffName: 'Nhân viên Ca Đêm',
        date: inDate,
        checkInTime: inTime,
        status: 'present'
      }
    };

    const f = fixture(records);
    const dataOps = f.load('src/services/dataOperations.ts');

    // Employee checks out at 09:00 the next day
    const result = await dataOps.recordAttendanceAtomic(staff, { checkOutTime: outTime });
    assert.equal(result.type, 'check_out');

    const saved = f.rows.get('attendance_records/att_overnight');
    assert.equal(saved.checkOutTime, result.time);
    assert.equal(saved.autoClosed, undefined);
    assert.equal(saved.date, inDate);

    // Guard must now have openRecordId = null
    const guard = f.rows.get('checkout_locks/attendance_store1_staff_night');
    assert.equal(guard.openRecordId, null);
    assert.equal(guard.lastAction, 'check_out');
  });

  await test('Payroll unfinalize atomic operation allows store admin to unlock payroll and recalculate/refinalize', async () => {
    const staff = { id: 'staff_u', storeId: 'store1', name: 'Nhân viên Mở Chốt', role: 'staff', salaryType: 'daily', salaryAmount: 300000 };
    const records = {
      'users/staff_u': staff,
      'attendance_records/att_u1': { id: 'att_u1', storeId: 'store1', userId: 'staff_u', date: '2026-11-05', checkInTime: '2026-11-05T08:00:00Z', checkOutTime: '2026-11-05T17:00:00Z', status: 'present' },
    };
    const f = fixture(records);
    const dataOps = f.load('src/services/dataOperations.ts');
    const adminCaller = { id: 'admin1', storeId: 'store1', role: 'admin' };
    const staffCaller = { id: 'staff_other', storeId: 'store1', role: 'staff' };

    // 1. Chốt lương lần 1
    const payroll = {
      id: '',
      userId: 'staff_u',
      storeId: 'store1',
      month: '2026-11',
      presentDays: 1,
      baseSalaryAmount: 300000,
      baseSalaryType: 'daily',
      calculatedSalary: 300000,
      bonus: 0,
      deduction: 0,
      totalSalary: 300000,
      status: 'finalized'
    };

    const finResult = await dataOps.finalizePayrollAtomic(adminCaller, payroll);
    const payrollId = finResult.finalRecord.id;
    assert.equal(f.rows.has(`payroll_records/${payrollId}`), true);

    // 2. Nhân viên không có quyền mở chốt phải bị từ chối
    await assert.rejects(
      async () => {
        await dataOps.unfinalizePayrollAtomic(staffCaller, payrollId);
      },
      /Chỉ Quản trị viên hoặc Quản lý cửa hàng mới có quyền mở chốt bảng lương/
    );

    // 3. Admin mở chốt lương thành công
    const unfinResult = await dataOps.unfinalizePayrollAtomic(adminCaller, payrollId);
    assert.equal(unfinResult.success, true);
    assert.equal(f.rows.has(`payroll_records/${payrollId}`), false);

    // 4. Mở chốt xong có thể tính lại (ví dụ thêm thưởng 50.000đ) và chốt lại thành công
    const rePayroll = {
      ...payroll,
      bonus: 50000,
      totalSalary: 350000
    };
    const reResult = await dataOps.finalizePayrollAtomic(adminCaller, rePayroll);
    assert.equal(reResult.finalRecord.bonus, 50000);
    assert.equal(reResult.finalRecord.totalSalary, 350000);
    assert.equal(f.rows.has(`payroll_records/${payrollId}`), true);
    assert.equal(f.rows.get(`payroll_records/${payrollId}`).totalSalary, 350000);
  });

  const failed = results.filter(r => r.status === 'FAIL'); const report = { passed: results.length - failed.length, total: results.length, failed: failed.length, method: 'Actual source functions transpiled by the locked project TypeScript compiler. In-memory Firestore mock enforces all reads before writes, atomic commit, and optimistic contention retries. No production Firebase access.', results }; fs.writeFileSync(path.join(__dirname, 'test-results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
