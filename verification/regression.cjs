const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const root=path.resolve(process.env.FNB_PROJECT_ROOT || path.join(__dirname,'..'));
const ts=require(path.join(root,'node_modules/typescript'));
const results=[];
const copy=value=>value===undefined?undefined:structuredClone(value);
function fixture(initial={},options={}) {
  const rows=new Map(Object.entries(copy(initial))), versions=new Map([...rows.keys()].map(p=>[p,1]));
  let sequence=0; const cache=new Map(); const alerts=[];
  const ref=p=>({path:p,id:p.split('/').at(-1)});
  const snapshot=r=>{const value=copy(rows.get(r.path));return {id:r.id,ref:r,exists:()=>value!==undefined,data:()=>copy(value),version:versions.get(r.path)||0};};
  function apply(target,r,value,merge=false) {
    if(options.failWrite?.(r.path,value))throw Error('Injected write rejection');
    const data=merge?copy(target.get(r.path)||{}):{};
    for(const [k,v]of Object.entries(value)){
      if(v?.__op==='increment')data[k]=(data[k]||0)+v.value;
      else if(v?.__op==='delete')delete data[k];
      else if(v?.__op==='union')data[k]=[...(data[k]||[]),...v.value.filter(n=>!(data[k]||[]).some(x=>JSON.stringify(x)===JSON.stringify(n)))];
      else if(v!==undefined)data[k]=copy(v);
    }
    target.set(r.path,data);
  }
  async function transact(_db,fn){
    for(let attempt=0;attempt<20;attempt++){
      const readVersions=new Map(),writes=[];let writing=false;
      const result=await fn({get:async r=>{assert(!writing,'Firestore transactions must finish all reads before writes');const s=snapshot(r);readVersions.set(r.path,s.version);return s;},set:(r,v,o)=>{writing=true;writes.push(['set',r,v,o?.merge]);},update:(r,v)=>{writing=true;writes.push(['update',r,v,true]);},delete:r=>{writing=true;writes.push(['delete',r]);}});
      if([...readVersions].some(([p,v])=>(versions.get(p)||0)!==v))continue;
      const next=new Map([...rows].map(([k,v])=>[k,copy(v)]));
      for(const [kind,r,v,merge]of writes){if(kind==='delete')next.delete(r.path);else{if(kind==='update')assert(next.has(r.path),`Missing update target ${r.path}`);apply(next,r,v,merge);}}
      rows.clear();for(const[k,v]of next)rows.set(k,v);
      for(const[,r]of writes)versions.set(r.path,(versions.get(r.path)||0)+1);
      return result;
    }
    throw Error('Mock contention exceeded');
  }
  const api={
    doc:(...args)=>args.length===1?ref(`${args[0].path}/auto-${++sequence}`):ref(args.slice(1).join('/')),
    collection:(_db,name)=>({path:name}),
    runTransaction:transact,
    increment:value=>({__op:'increment',value}),deleteField:()=>({__op:'delete'}),arrayUnion:(...value)=>({__op:'union',value}),
    where:(field,op,value)=>({kind:'where',field,op,value}),orderBy:(field,dir='asc')=>({kind:'order',field,dir}),limit:value=>({kind:'limit',value}),
    query:(col,...constraints)=>({col,constraints}),
    getDoc:async r=>snapshot(r),getDocFromServer:async r=>snapshot(r),
    getDocsFromServer:async q=>{
      let list=[...rows].filter(([p])=>p.startsWith(q.col.path+'/'));
      for(const c of q.constraints||[])if(c.kind==='where')list=list.filter(([,d])=>c.op==='=='?d[c.field]===c.value:c.op==='>='?d[c.field]>=c.value:c.op==='<'?d[c.field]<c.value:d[c.field]<=c.value);
      return {docs:list.map(([p])=>snapshot(ref(p))),empty:!list.length};
    }
  };
  api.getDocs=api.getDocsFromServer;
  const adminSnap=s=>({id:s.id,exists:s.exists(),data:s.data,updateTime:{version:s.version,isEqual(other){return this.version===other.version;}}});
  const admin={
    doc:p=>ref(p),
    collection:name=>({where:(field,op,value)=>({get:async()=>{
      const found=await api.getDocsFromServer({col:{path:name},constraints:[{kind:'where',field,op,value}]});
      const snap={docs:found.docs.map(adminSnap),size:found.docs.length,empty:found.empty};
      options.afterAdminRead?.(name,rows,versions);
      return snap;
    }})}),
    runTransaction:fn=>transact({},txn=>fn({get:async r=>adminSnap(await txn.get(r)),set:txn.set,update:txn.update,delete:txn.delete}))
  };
  function load(relative){
    const filename=path.resolve(root,relative);
    if(filename.endsWith('src/lib/firebase.ts'))return {db:{},auth:{}};
    if(filename.endsWith('api/_firebaseAdmin.ts'))return {adminDb:admin};
    if(cache.has(filename))return cache.get(filename).exports;
    const mod={exports:{}};cache.set(filename,mod);
    const source=fs.readFileSync(filename,'utf8');
    const compiled=ts.transpileModule(source,{fileName:filename,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
    const localRequire=name=>{
      if(name==='firebase/firestore')return api;
      if(name.startsWith('.')){let full=path.resolve(path.dirname(filename),name);if(!path.extname(full))full+='.ts';return load(path.relative(root,full));}
      return require(name);
    };
    const context=vm.createContext({require:localRequire,module:mod,exports:mod.exports,console,structuredClone,crypto:globalThis.crypto,Date,Intl,setTimeout,clearTimeout});
    vm.runInContext(compiled,context,{filename});return mod.exports;
  }
  const ops=load('src/services/dataOperations.ts'),pure=load('src/utils/dataIntegrity.ts'),dates=load('src/utils/firestoreDateHelper.ts'),cost=load('src/utils/costHelper.ts');
  function handler(file,name,extra={}){
    const text=fs.readFileSync(path.join(root,file),'utf8');const tree=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let initializer;
    function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(tree)===name)initializer=n.initializer;ts.forEachChild(n,visit);}visit(tree);assert(initializer,name);
    const js=ts.transpileModule('globalThis.testFunction='+initializer.getText(tree),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const context=vm.createContext({...api,...pure,...dates,...cost,db:{},console:{warn(){},error(){}},structuredClone,currentUser:user,menu:[],tables:[],invoices:[],customers:[],activeShift:null,selectedTable:null,systemSettings:{vatPercent:0},checkoutLockRef:{current:new Set()},updateOutOfStockStatus:async()=>{},triggerPrint:()=>{},setMenu:()=>{},setTables:()=>{},setInvoices:()=>{},setCashTransactions:()=>{},setSelectedTable:()=>{},alert:m=>alerts.push(m),prompt:()=> 'test reason',isCashPayment:m=>!m||m==='cash',...extra});
    vm.runInContext(js,context);return {call:context.testFunction,context};
  }
  return {rows,versions,api,ops,pure,dates,cost,load,handler,alerts,ref,transact};
}
const user={id:'u1',name:'User',role:'admin',storeId:'store1'};
const item=()=>({id:'drink',name:'Drink',price:100000,costPrice:40000,type:'goods',stock:10,trackStock:true,unit:'can',storeId:'store1',quantity:1});
const order=(id='s1')=>({id,items:[item()],subtotal:100000,discount:0,vat:0,total:100000,status:'pending',startTime:new Date().toISOString()});
const table=(id='t1',orders=[order()])=>({id,name:id,status:orders.length?'occupied':'empty',orders,storeId:'store1'});
async function test(name,fn){try{await fn();results.push({name,status:'PASS'});}catch(error){results.push({name,status:'FAIL',error:String(error.stack||error)});}}
(async()=>{
await test('Concurrent order increments preserve all portions',async()=>{
 const f=fixture({'tables/t1':table()});await Promise.all([f.ops.addOrderAtomic(user,'t1',[{...item(),quantity:1}],'s1',0,'a'),f.ops.addOrderAtomic(user,'t1',[{...item(),quantity:2}],'s1',0,'b')]);assert.equal(f.rows.get('tables/t1').orders[0].items[0].quantity,4);
});
await test('Order retry with same operation ID does not add twice',async()=>{
 const f=fixture({'tables/t1':table('t1',[])});const a=await f.ops.addOrderAtomic(user,'t1',[item()],undefined,0,'a');const b=await f.ops.addOrderAtomic(user,'t1',[item()],undefined,0,'a');assert.equal(a,b);assert.equal(f.rows.get('tables/t1').orders.length,1);
});
await test('Reusing order operation ID for different content is rejected',async()=>{
 const f=fixture({'tables/t1':table('t1',[])});await f.ops.addOrderAtomic(user,'t1',[item()],undefined,0,'a');await assert.rejects(f.ops.addOrderAtomic(user,'t1',[{...item(),quantity:2}],undefined,0,'a'));
});
await test('Kitchen does not erase a newly added order',async()=>{
 const f=fixture({'tables/t1':table('t1',[order(),order('s2')])});await f.ops.updateOrdersAtomic(user,'t1',[order()],[{...order(),status:'ready'}],true);assert.equal(f.rows.get('tables/t1').orders.length,2);
});
await test('Stale quantity edit conflicts rather than overwrites',async()=>{
 const server=order();server.items[0].quantity=2;server.subtotal=200000;const f=fixture({'tables/t1':table('t1',[server])});await assert.rejects(f.ops.updateOrdersAtomic(user,'t1',[order()],[{...order(),status:'ready'}],true));assert.equal(f.rows.get('tables/t1').orders[0].items[0].quantity,2);
});
await test('Failed merge preserves source and destination atomically',async()=>{
 const f=fixture({'tables/a':table('a',[order('a')]),'tables/b':table('b',[order('b')])},{failWrite:p=>p==='tables/b'});await assert.rejects(f.ops.moveTablesAtomic(user,'b',['a'],false,'op'));assert.equal(f.rows.get('tables/a').orders.length,1);assert.equal(f.rows.get('tables/b').orders.length,1);
});
await test('Merge moves each order once and replay is harmless',async()=>{
 const f=fixture({'tables/a':table('a',[order('a')]),'tables/b':table('b',[order('b')])});await f.ops.moveTablesAtomic(user,'b',['a'],false,'op');await f.ops.moveTablesAtomic(user,'b',['a'],false,'op');assert.equal(f.rows.get('tables/a').orders.length,0);assert.equal(f.rows.get('tables/b').orders.length,2);
});
await test('Transfer rejects a destination occupied on the server',async()=>{
 const f=fixture({'tables/a':table('a',[order('a')]),'tables/b':table('b',[order('b')])});await assert.rejects(f.ops.moveTablesAtomic(user,'b',['a'],true,'op'));assert.equal(f.rows.get('tables/a').orders.length,1);
});
await test('Concurrent imports preserve stock, receipts, and cards',async()=>{
 const f=fixture({'menu/drink':item()});await Promise.all([f.ops.importStockAtomic(user,'drink',5,40000,undefined,'a'),f.ops.importStockAtomic(user,'drink',7,40000,undefined,'b')]);assert.equal(f.rows.get('menu/drink').stock,22);assert.equal([...f.rows.keys()].filter(p=>p.startsWith('cash_transactions/')).length,2);assert.equal([...f.rows.keys()].filter(p=>p.startsWith('stock_card/')).length,2);
});
await test('An import cash-write failure leaves no partial inventory change',async()=>{
 const f=fixture({'menu/drink':item()},{failWrite:p=>p.startsWith('cash_transactions/')});await assert.rejects(f.ops.importStockAtomic(user,'drink',5,40000,undefined,'a'));assert.equal(f.rows.get('menu/drink').stock,10);assert.equal([...f.rows.keys()].filter(p=>p.startsWith('inventory_logs/')).length,0);
});
await test('Import retry is idempotent',async()=>{
 const f=fixture({'menu/drink':item()});await f.ops.importStockAtomic(user,'drink',5,40000,undefined,'a');await f.ops.importStockAtomic(user,'drink',5,40000,undefined,'a');assert.equal(f.rows.get('menu/drink').stock,15);
});
await test('Inventory precision retains 0.95 + 0.1 = 1.05',async()=>{
 const f=fixture({'menu/drink':{...item(),stock:0.95}});await f.ops.importStockAtomic(user,'drink',0.1,40000,undefined,'a');assert.equal(f.rows.get('menu/drink').stock,1.05);
});
await test('Audit refuses stale stock and leaves no audit/card',async()=>{
 const f=fixture({'menu/drink':item()});await assert.rejects(f.ops.auditStockAtomic(user,{id:'audit',date:new Date().toISOString(),items:[{itemId:'drink',itemName:'Drink',systemStock:9,actualStock:8,discrepancy:-1,unit:'can'}],staffId:'u1',staffName:'User'}));assert(!f.rows.has('inventory_audits/audit'));assert.equal(f.rows.get('menu/drink').stock,10);
});
await test('Manual cash replay increments totals only once',async()=>{
 const f=fixture();const tx={date:new Date().toISOString(),amount:100000,type:'income',paymentMethod:'cash',category:'Other',staffId:'u1',staffName:'User'};await f.ops.recordCashAtomic(user,tx,undefined,'a');await f.ops.recordCashAtomic(user,tx,undefined,'a');assert.equal([...f.rows.values()].find(v=>v.totalIncome!==undefined).totalIncome,100000);
});
await test('Manual cash and imports reject a closed shift',async()=>{
 const f=fixture({'menu/drink':item(),'shifts/shift':{storeId:'store1',status:'closed'}});const tx={date:new Date().toISOString(),amount:100000,type:'income',paymentMethod:'cash',category:'Other',staffId:'u1',staffName:'User'};await assert.rejects(f.ops.recordCashAtomic(user,tx,'shift','a'));await assert.rejects(f.ops.importStockAtomic(user,'drink',5,40000,'shift','b'));assert.equal(f.rows.get('menu/drink').stock,10);
});
await test('Cancellation reverses the original shift and exact stock movements',async()=>{
 const inv={id:'i1',storeId:'store1',tableName:'Table',date:'2026-09-10T05:00:00Z',businessDate:'2026-09-10',total:100000,discount:0,totalCost:40000,costVersion:3,statsApplied:true,paymentMethod:'cash',items:[item()],inventoryMovements:[{itemId:'drink',quantity:1}],shiftId:'shift'};
 const f=fixture({'invoices/i1':inv,'menu/drink':{...item(),stock:9,trackStock:false},'cash_transactions/cash_i1':{storeId:'store1',invoiceId:'i1'},'daily_stats/store1_2026-09-10':{totalRevenue:100000,totalCash:100000,totalCost:40000,invoiceCount:1},'shifts/shift':{storeId:'store1',status:'closed',startCash:0,totalCash:100000,totalRevenue:100000,cashIncome:100000,endCash:100000,discrepancy:0}});
 const r=await f.ops.cancelInvoiceAtomic(user,'i1');assert(r.deleted);assert.equal(f.rows.get('menu/drink').stock,10);assert.equal(f.rows.get('shifts/shift').totalRevenue,0);assert.equal(f.rows.get('shifts/shift').totalCash,0);assert.equal(f.rows.get('shifts/shift').discrepancy,100000);assert(!f.rows.has('invoices/i1'));assert(f.rows.has('cancelled_invoices/cancel_i1'));
});
await test('Cancelling an aggregate without invoice coverage creates no negative total',async()=>{
 const f=fixture({'invoices/i1':{storeId:'store1',date:'2026-09-10T05:00:00Z',total:100000,items:[],paymentMethod:'cash'},'daily_stats/store1_2026-09-10':{totalExpense:50000}});await f.ops.cancelInvoiceAtomic(user,'i1');assert.equal(f.rows.get('daily_stats/store1_2026-09-10').totalRevenue,undefined);assert.equal(f.rows.get('daily_stats/store1_2026-09-10').coverageStatus,'partial');
});
await test('Cancellation of an untracked new invoice does not invent stock',async()=>{
 const f=fixture({'invoices/i1':{storeId:'store1',date:'2026-09-10T05:00:00Z',total:100000,items:[item()],paymentMethod:'cash',inventoryMovements:[]},'menu/drink':item()});await f.ops.cancelInvoiceAtomic(user,'i1');assert.equal(f.rows.get('menu/drink').stock,10);
});
await test('Checkout uses the server shift state and preserves the order on rejection',async()=>{
 const t=table(),f=fixture({'tables/t1':t,'menu/drink':item(),'shifts/shift':{storeId:'store1',status:'closed'}});const h=f.handler('src/App.tsx','handleCheckout',{tables:[t],menu:[item()],activeShift:{id:'shift'}});assert.equal(await h.call('t1',[order()],0,'cash'),false);assert.equal([...f.rows.keys()].filter(p=>p.startsWith('invoices/')).length,0);assert.equal(f.rows.get('tables/t1').orders.length,1);
});
await test('Checkout keeps committed success when a post-commit availability update fails',async()=>{
 const t=table(),f=fixture({'tables/t1':t,'menu/drink':{...item(),stock:1}});const h=f.handler('src/App.tsx','handleCheckout',{tables:[t],menu:[{...item(),stock:1}],updateOutOfStockStatus:async()=>{throw Error('auxiliary failure')}});assert.equal(await h.call('t1',[order()],0,'cash'),true);assert.equal([...f.rows.keys()].filter(p=>p.startsWith('invoices/')).length,1);
});
await test('Checkout persists exact stock deltas and a server cost snapshot',async()=>{
 const t=table(),f=fixture({'tables/t1':t,'menu/drink':{...item(),costPrice:45000}});const h=f.handler('src/App.tsx','handleCheckout',{tables:[t],menu:[item()]});assert.equal(await h.call('t1',[order()],0,'cash'),true);const inv=[...f.rows].find(([p])=>p.startsWith('invoices/'))[1];assert.equal(inv.totalCost,45000);assert.equal(inv.costVersion,3);assert.deepEqual(inv.inventoryMovements,[{itemId:'drink',quantity:1}]);
});
await test('Checkout rejects unsaved draft sessions',async()=>{
 const t=table('t1',[]),f=fixture({'tables/t1':t,'menu/drink':item()});const h=f.handler('src/App.tsx','handleCheckout',{tables:[t],menu:[item()]});assert.equal(await h.call('t1',[order('draft-1')],0,'cash'),false);assert.equal([...f.rows.keys()].filter(p=>p.startsWith('invoices/')).length,0);
});
await test('Price, discount, and VAT are computed once from item subtotals',async()=>{
 const o=order();o.items[0].selectedAddOns=[{id:'extra',name:'Extra',price:20000,costPrice:5000}];o.subtotal=120000;o.total=129600;const t=table('t1',[o]),f=fixture({'tables/t1':t,'menu/drink':item()});const h=f.handler('src/App.tsx','handleCheckout',{tables:[t],menu:[item()],systemSettings:{vatPercent:8}});assert.equal(await h.call('t1',[o],10,'cash'),true);const inv=[...f.rows].find(([p])=>p.startsWith('invoices/'))[1];assert.equal(inv.subtotal,120000);assert.equal(inv.discount,12000);assert.equal(inv.vat,8640);assert.equal(inv.total,116640);
});
await test('Estimated invoice costs remain estimated in source aggregates',async()=>{
 const f=fixture(),inv={...order(),id:'inv',total:100000,totalCost:0,costVersion:3,costStatus:'estimated',paymentMethod:'cash'};const stat=f.pure.aggregateDay('store1','2026-09-10',[inv],[],true);assert.equal(stat.costStatus,'estimated');assert.equal(stat.totalCost,0);
});
await test('Daily expense amounts are not divided by 30 in the financial view',async()=>{
 const f=fixture();const source=fs.readFileSync(path.join(root,'src/components/SummaryView.tsx'),'utf8');const a=source.indexOf('  // 1. Nhân sự (Labor Cost)'),b=source.indexOf('  // Alias để tương thích giao diện hiển thị',a);const js=ts.transpileModule(source.slice(a,b)+'\nObject.assign(globalThis,{laborCost,rentCost});',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;const ctx=vm.createContext({financialCostBasis:'cash',periodPayrolls:[],payrollRecords:[],statsAggregates:{expenseSalary:300000,expenseRent:600000,expenseOther:0},filteredCash:[],filterType:'day',dateFilter:'2026-10-30'});vm.runInContext(js,ctx);assert.equal(ctx.laborCost,300000);assert.equal(ctx.rentCost,600000);
});
await test('Multiple attendance sessions count one workday and only actual hours',async()=>{
 const f=fixture();const r=f.pure.attendanceTotals([{date:'2026-10-01',status:'present',checkInTime:'2026-10-01T01:00:00Z',checkOutTime:'2026-10-01T05:00:00Z'},{date:'2026-10-01',status:'present',checkInTime:'2026-10-01T06:00:00Z',checkOutTime:'2026-10-01T10:00:00Z'}]);assert.equal(r.presentDays,1);assert.equal(r.totalHours,8);assert.equal(r.hasOpenSession,false);const open=f.pure.attendanceTotals([{date:'2026-10-01',status:'present',checkInTime:'2026-10-01T01:00:00Z'}]);assert.equal(open.totalHours,0);assert.equal(open.hasOpenSession,true);
});
await test('Complete source calculations retain more than 100/300 documents',async()=>{
 const f=fixture();const invoices=Array.from({length:350},(_,i)=>({id:`i${i}`,date:'2026-09-10T05:00:00Z',total:1000,totalCost:100,costStatus:'complete',costVersion:3,paymentMethod:'cash',items:[]}));assert.equal(f.pure.aggregateDay('store1','2026-09-10',invoices,[],true).totalRevenue,350000);
});
await test('Source recomputation removes a cancelled cached invoice and its cost',async()=>{
 const f=fixture();const invoice={id:'i1',date:'2026-09-10T05:00:00Z',total:100000,totalCost:40000,costStatus:'complete',costVersion:3,paymentMethod:'cash',items:[]};assert.equal(f.pure.dailyStatsFromSources('store1',['2026-09-10'],[invoice],[],true)[0].totalCost,40000);const next=f.pure.dailyStatsFromSources('store1',['2026-09-10'],[],[],true)[0];assert.equal(next.totalRevenue,0);assert.equal(next.totalCost,0);assert.equal(next.coverageStatus,'zero_activity');
});
await test('Cached/offline source data is not marked reconciled',async()=>{const f=fixture();assert.equal(f.pure.aggregateDay('store1','2026-09-10',[],[],false).coverageStatus,'partial');});
await test('Cash form keeps entered data after a rejected server write',async()=>{
 const f=fixture(),changes=[];const h=f.handler('src/components/SummaryView.tsx','handleAddCash',{showAddCashModal:'expense',isSavingCash:false,newCash:{amount:100000,paymentMethod:'cash',category:'Other',note:'Test'},cashOperationRef:{current:null},setIsSavingCash:()=>{},onAddCashTransaction:async()=>{throw Error('server rejection')},setShowAddCashModal:v=>changes.push(v),setNewCash:v=>changes.push(v)});await h.call();assert.equal(changes.length,0);assert(f.alerts.length>0);
});
await test('Vietnam date boundaries retain invoices around UTC midnight',async()=>{const f=fixture();assert.equal(f.pure.businessDateOf({date:'2026-10-29T18:00:00Z'}),'2026-10-30');assert.equal(f.dates.getVietnamDayBoundariesIso('2026-10-30').startIso,'2026-10-29T17:00:00.000Z');});
await test('Recipe versions are not merged by a shared dish ID',async()=>{const f=fixture();const a={...item(),type:'dish',recipe:[{ingredientId:'milk',quantity:0.1,unit:'l'}]},b={...a,recipe:[{ingredientId:'milk',quantity:0.2,unit:'l'}]};assert.notEqual(f.pure.itemKey(a),f.pure.itemKey(b));});
await test('Backfill skips a day changed by a concurrent historical cancellation',async()=>{
 let injected=false;
 const f=fixture({'invoices/i1':{storeId:'store1',date:'2026-09-10T05:00:00Z',total:100000,totalCost:40000,costStatus:'complete',costVersion:3,paymentMethod:'cash',items:[item()]},'daily_stats/store1_2026-09-10':{storeId:'store1',date:'2026-09-10',totalRevenue:100000,invoiceCount:1,sourceRevision:1}}, {afterAdminRead:(name,rows,versions)=>{
   if(name==='cash_transactions'&&!injected){injected=true;rows.delete('invoices/i1');rows.set('daily_stats/store1_2026-09-10',{storeId:'store1',date:'2026-09-10',totalRevenue:0,invoiceCount:0,sourceRevision:2});versions.set('daily_stats/store1_2026-09-10',2);}
 }});
 const r=await f.load('scripts/backfill_daily_stats.ts').backfillStoreDailyStats('store1');assert.equal(r.updatedStatsDocs,0);assert.equal(r.skippedChangedDays[0],'2026-09-10');assert.equal(f.rows.get('daily_stats/store1_2026-09-10').totalRevenue,0);
});
await test('Backfill resets an empty historical day rather than preserving stale revenue',async()=>{
 const f=fixture({'daily_stats/store1_2026-09-10':{storeId:'store1',date:'2026-09-10',totalRevenue:100000,invoiceCount:1}});const r=await f.load('scripts/backfill_daily_stats.ts').backfillStoreDailyStats('store1');assert.equal(r.updatedStatsDocs,1);assert.equal(f.rows.get('daily_stats/store1_2026-09-10').totalRevenue,0);assert.equal(f.rows.get('daily_stats/store1_2026-09-10').coverageStatus,'zero_activity');
});
await test('Backfill dry-run does not write any aggregates',async()=>{
 const f=fixture({'invoices/i1':{storeId:'store1',date:'2026-09-10T05:00:00Z',total:100000,totalCost:40000,costStatus:'estimated',costVersion:1,paymentMethod:'cash',items:[item()]}});const r=await f.load('scripts/backfill_daily_stats.ts').backfillStoreDailyStats('store1',{dryRun:true});assert.equal(r.updatedStatsDocs,0);assert.equal(r.daysWithEstimatedCost,1);assert(!f.rows.has('daily_stats/store1_2026-09-10'));
});
await test('Migration job lock has one owner and cannot be released by another job',async()=>{
 const f=fixture(),m=f.load('scripts/migrate_legacy_data.ts');const [a,b]=await Promise.all([m.acquireStoreLock('store1'),m.acquireStoreLock('store1')]);assert.equal([a,b].filter(Boolean).length,1);const token=a||b;await m.releaseStoreLock('store1','wrong-token');assert(f.rows.has('migration_locks/store1'));await m.releaseStoreLock('store1',token);assert(!f.rows.has('migration_locks/store1'));
});
await test('Date-range subscription includes old/new schemas, without display limits',async()=>{
 const f=fixture(),listeners=[],data=[];f.api.onSnapshot=(q,opts,onData,onError)=>{listeners.push({q,onData,onError});return()=>{};};const source=f.load('src/utils/completeDataSource.ts');const stop=source.subscribeDateRange('invoices','store1','2026-09-10','2026-09-10',(rows,ready)=>data.push({rows,ready}),e=>{throw e;});assert(!listeners[0].q.constraints.some(c=>c.kind==='limit'));
 const docs=Array.from({length:350},(_,i)=>({id:`i${i}`,data:()=>({date:'2026-09-10T05:00:00Z',...(i%2?{businessDate:'2026-09-10'}:{})})}));listeners[0].onData({docs,metadata:{fromCache:true,hasPendingWrites:false}});assert.equal(data[0].rows.length,350);assert.equal(data[0].ready,false);listeners[0].onData({docs,metadata:{fromCache:false,hasPendingWrites:false}});assert.equal(data[1].ready,true);stop();
});
await test('Missing-index fallback has no truncation and unsubscribe ignores late responses',async()=>{
 const f=fixture(),listeners=[],data=[];f.api.onSnapshot=(q,opts,onData,onError)=>{listeners.push({q,onData,onError});return()=>{};};const source=f.load('src/utils/completeDataSource.ts');const stop=source.subscribeDateRange('invoices','store1','2026-09-10','2026-09-10',(rows,ready)=>data.push({rows,ready}),e=>{throw e;});listeners[0].onError({code:'failed-precondition'});assert.equal(listeners.length,2);assert.equal(listeners[1].q.constraints.length,1);stop();listeners[1].onData({docs:[],metadata:{fromCache:false,hasPendingWrites:false}});assert.equal(data.length,0);
});
await test('Receipt reconciliation detects duplicate and missing sale receipts',async()=>{
 const f=fixture(),invoice={id:'i1',total:100000,paymentMethod:'cash'};assert(f.pure.receiptMismatch([invoice],[]));const receipts=[{id:'c1',type:'income',category:'Bán Hàng',amount:100000,paymentMethod:'cash',invoiceId:'i1'}];assert.equal(f.pure.receiptMismatch([invoice],receipts),'');assert(f.pure.receiptMismatch([invoice],[...receipts,{...receipts[0],id:'c2'}]));
});
await test('Cross-store operations are rejected before changing inventory',async()=>{const f=fixture({'menu/drink':{...item(),storeId:'other'}});await assert.rejects(f.ops.importStockAtomic(user,'drink',5,40000,undefined,'a'));assert.equal(f.rows.get('menu/drink').stock,10);});
await test('Two kitchen devices completing different lines preserve both changes',async()=>{
 const a={...item(),lineId:'line-a'},b={...item(),id:'food',lineId:'line-b',name:'Food'},base={...order(),items:[a,b],subtotal:200000,total:200000};const f=fixture({'tables/t1':table('t1',[base])});
 const one={...base,items:[{...a,isCompleted:true},b]},two={...base,items:[a,{...b,isCompleted:true}]};await Promise.all([f.ops.updateOrdersAtomic(user,'t1',[base],[one],true),f.ops.updateOrdersAtomic(user,'t1',[base],[two],true)]);const stored=f.rows.get('tables/t1').orders[0];assert(stored.items.every(i=>i.isCompleted));assert.equal(stored.status,'ready');
});
await test('Adding portions to a completed line creates a new pending line',async()=>{
 const ready={...order(),status:'ready',items:[{...item(),lineId:'old',isCompleted:true}]};const f=fixture({'tables/t1':table('t1',[ready])});await f.ops.addOrderAtomic(user,'t1',[item()],'s1',0,'new');const stored=f.rows.get('tables/t1').orders[0];assert.equal(stored.items.length,2);assert.equal(stored.items[0].isCompleted,true);assert.equal(stored.items[1].isCompleted,false);assert.equal(stored.subtotal,200000);
});
await test('Cancellation replay never restores stock twice',async()=>{
 const f=fixture({'invoices/i1':{storeId:'store1',date:'2026-09-10T05:00:00Z',total:100000,items:[item()],paymentMethod:'cash',inventoryMovements:[{itemId:'drink',quantity:1}]},'menu/drink':{...item(),stock:9}});await f.ops.cancelInvoiceAtomic(user,'i1');const again=await f.ops.cancelInvoiceAtomic(user,'i1');assert(again.deleted);assert.equal(f.rows.get('menu/drink').stock,10);
});
await test('Concurrent attendance scans open only one session',async()=>{const f=fixture();const r=await Promise.all([f.ops.recordAttendanceAtomic(user,{}),f.ops.recordAttendanceAtomic(user,{})]);assert.equal([...f.rows.keys()].filter(p=>p.startsWith('attendance_records/')).length,1);assert.equal(r[0].type,'check_in');assert.equal(r[1].type,'check_in');});
await test('Explicit check-out closes an overnight open session without creating another day',async()=>{const f=fixture({'attendance_records/night':{storeId:'store1',userId:'u1',date:'2026-10-29',checkInTime:'2026-10-29T15:00:00Z',status:'present'}});const r=await f.ops.recordAttendanceAtomic(user,{checkOutTime:new Date().toISOString()});assert.equal(r.type,'check_out');assert.equal(f.rows.get('attendance_records/night').date,'2026-10-29');assert(f.rows.get('attendance_records/night').checkOutTime);assert.equal([...f.rows.keys()].filter(p=>p.startsWith('attendance_records/')).length,1);});
await test('Explicit check-out without a check-in cannot invent a work session',async()=>{const f=fixture();await assert.rejects(f.ops.recordAttendanceAtomic(user,{checkOutTime:new Date().toISOString()}));assert.equal([...f.rows.keys()].filter(p=>p.startsWith('attendance_records/')).length,0);});
await test('Per-item revenue includes add-ons and allocates whole-dong discounts exactly',async()=>{const f=fixture();const inv={subtotal:300001,discount:100000,total:200001,vat:0,items:[{...item(),price:100000,selectedAddOns:[{id:'extra',price:50000}]},{...item(),price:150001}]};const allocated=f.pure.allocatedItemRevenue(inv);assert.equal(allocated.reduce((s,n)=>s+n,0),200001);assert(allocated.every(Number.isInteger));});
await test('Free inventory imports still update weighted average cost',async()=>{const f=fixture({'menu/drink':item()});await f.ops.importStockAtomic(user,'drink',10,0,undefined,'free');assert.equal(f.rows.get('menu/drink').stock,20);assert.equal(f.rows.get('menu/drink').costPrice,20000);});
await test('Unavailable source costs remain estimated even if an old order has a price',async()=>{const f=fixture();const result=f.cost.calculateInvoiceCostSnapshot([item()],()=>undefined);assert.equal(result.totalCost,40000);assert.equal(result.isComplete,false);});
await test('Two devices opening a shift share one guarded open shift',async()=>{const f=fixture(),h=f.handler('src/App.tsx','handleOpenShift',{fetchStoreRows:f.load('src/utils/completeDataSource.ts').fetchStoreRows});await Promise.all([h.call(100000),h.call(100000)]);assert.equal([...f.rows.keys()].filter(p=>p.startsWith('shifts/')).length,1);});
await test('Order cloning supports the existing iOS 15 target without structuredClone',async()=>{const f=fixture(),original={orders:[{items:[{quantity:1,note:undefined}]}]};const cloned=f.pure.cloneData(original);cloned.orders[0].items[0].quantity=2;assert.equal(original.orders[0].items[0].quantity,1);assert.equal(cloned.orders[0].items[0].note,undefined);});
const failed=results.filter(r=>r.status==='FAIL');const report={passed:results.length-failed.length,total:results.length,failed:failed.length,method:'Actual source functions transpiled by the locked project TypeScript compiler. In-memory Firestore mock enforces all reads before writes, atomic commit, and optimistic contention retries. No production Firebase access.',results};fs.writeFileSync(path.join(__dirname,'test-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(failed.length)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
