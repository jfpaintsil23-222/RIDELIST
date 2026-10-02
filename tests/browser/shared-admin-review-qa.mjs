// Fresh synthetic preview; normal UI actions plus transport faults and an archived recovery fixture.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'/Users/joojo/Documents/Codex/2026-10-01/task-2/browser-qa-tooling/node_modules/playwright');
const browser=await chromium.launch({headless:true}),errors=[],external=[],writes=[];
const x='00000000-0000-4000-8000-000000000001',y='00000000-0000-4000-8000-000000000002';
try {
 const contexts=await Promise.all([browser.newContext({viewport:{width:390,height:844}}),browser.newContext({viewport:{width:430,height:932}})]);
 for(const c of contexts)await c.route('**/*',route=>{if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();external.push('blocked');return route.abort();});
 const [a,b]=await Promise.all(contexts.map(c=>c.newPage()));
 for(const page of [a,b]){page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));}
 await a.goto('http://127.0.0.1:4176/?actor=a');
 const move=a.locator('.admin-quick-move').filter({has:a.locator('summary[aria-label*="Sample Rider Two"]')});
 await move.locator('summary').click();await move.locator('select').selectOption('a');await move.locator('button').click();
 await a.waitForFunction(()=>fixtureApp.state.adminShared.snapshot.riders.every(r=>r.driverSlug==='a'));
 await b.goto('http://127.0.0.1:4176/?actor=b');await b.locator(`[data-admin-edit="${y}"]`).click();
 await a.locator(`[data-admin-edit="${x}"]`).click();
 const before=await a.evaluate(()=>({groups:fixtureApp.state.adminShared.snapshot.groupVersions,published:fixtureApp.state.adminShared.snapshot.publishedRevision}));
 for(const page of [a,b])page.on('request',request=>{if(request.url().endsWith('/rpc')){const body=request.postDataJSON();if(body.name==='ride_admin_shared_mutate')writes.push(body.args.p_operation);}});
 await a.locator('[name="name"]').fill('Independent rider A');await b.locator('[name="name"]').fill('Independent rider B');
 await a.locator('[data-admin-form="rider"] button[type="submit"]').click();await a.waitForFunction(()=>fixtureApp.state.view==='admin');
 await b.locator('[data-admin-form="rider"] button[type="submit"]').click();await b.waitForFunction(()=>fixtureApp.state.view==='admin');
 const after=await b.evaluate(()=>fixtureApp.state.adminShared.snapshot);
 assert.equal(after.riders.filter(r=>r.name.startsWith('Independent rider')).length,2);assert.deepEqual(after.groupVersions,before.groups);assert.equal(after.publishedRevision,before.published);
 for(const op of writes){assert.deepEqual(op.expectedGroupVersions,{});assert.equal('stopOrder' in op.payload,false);assert.equal('driverSlug' in op.payload,false);}
 console.log('PASS two captured ordinary edits on different riders in one route both save; ordering, group versions and publication unchanged');

 let lost=false,newerId='00000000-0000-4000-8000-000000009101';
 await a.addInitScript(()=>document.addEventListener('click',e=>{if(e.target.closest('[data-action="adminSharedRetry"]'))window.fixtureRetryClicked=true;},true));
 await a.route('**/rpc',async route=>{
  const {name,args}=route.request().postDataJSON();
  if(name==='ride_admin_shared_mutate'&&!lost){lost=true;await route.fetch();return route.abort();}
  if(name==='ride_admin_shared_operation'){
   const retryClicked=await a.evaluate(()=>Boolean(window.fixtureRetryClicked));
   return route.fulfill({json:retryClicked&&args.p_operation_id===newerId?{ok:true,operationId:newerId}:{ok:false,code:'not_found',operationId:args.p_operation_id}});
  }
  return route.continue();
 });
 await a.locator(`[data-admin-edit="${x}"]`).click();await a.locator('[name="name"]').fill('Synthetic uncertain rider');
 await a.locator('[data-admin-form="rider"] button[type="submit"]').click();await a.waitForFunction(()=>fixtureApp.state.adminShared.pendingOperation&&!fixtureApp.state.adminShared.saving);
 const oldId=await a.evaluate(()=>fixtureApp.state.adminShared.pendingOperation.operationId);
 await a.getByRole('button',{name:'Cancel',exact:true}).click();
 // Seed a second valid historical record to exercise the intended recovery queue.
 await a.evaluate(({oldId,newerId})=>{
  const key=Object.keys(localStorage).find(key=>key.startsWith('ride-recovery-v2:')&&JSON.parse(localStorage.getItem(key)).pending?.operationId===oldId);
  const original=JSON.parse(localStorage.getItem(key));
  const newer={...original,baselinePublishedRevision:1,pending:{...original.pending,operationId:newerId,recoveryBaseline:1,args:{...original.pending.args,p_operation:{...original.pending.args.p_operation,operationId:newerId,expectedBaselinePublishedRevision:1}}}};
  localStorage.setItem(key.slice(0,key.lastIndexOf(':')+1)+'1',JSON.stringify(newer));
 },{oldId,newerId});
 await a.reload();await a.waitForFunction(id=>fixtureApp.state.adminShared?.pendingOperation?.operationId===id,newerId);
 assert.equal(await a.evaluate(id=>fixtureApp.state.adminShared.recoveryPending.some(p=>p.operationId===id),oldId),true);
 const priorWrites=writes.length;
 await a.locator('.shared-status > details > summary').click();await a.locator('[data-action="adminSharedRetry"]').click();
 await a.waitForFunction(id=>fixtureApp.state.adminShared.pendingOperation?.operationId===id,oldId);
 await a.locator('[data-action="adminSharedReview"]').click();
 assert.equal(await a.evaluate(()=>fixtureApp.state.view),'admin');assert.equal(writes.length,priorWrites);
 assert.equal(await a.evaluate(id=>fixtureApp.state.adminShared.pendingOperation?.operationId===id,oldId),true);
 assert.equal(await a.evaluate(()=>fixtureApp.state.adminShared.snapshot.publishedRevision),before.published);
 console.log('PASS explicit Retry settles A, retains queued B without replay, and keeps Review/publication blocked while B is unknown');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('PASS zero browser page errors and external requests');
 await Promise.all(contexts.map(c=>c.close()));
}finally{await browser.close();}
