// Fresh synthetic-only preview required. Normal UI navigation with transport fault injection.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'/Users/joojo/Documents/Codex/2026-10-01/task-2/browser-qa-tooling/node_modules/playwright');
const browser=await chromium.launch({headless:true});
const errors=[],external=[],requests=[];
try {
 const contexts=await Promise.all([browser.newContext({viewport:{width:390,height:844}}),browser.newContext({viewport:{width:430,height:932}})]);
 for(const context of contexts)await context.route('**/*',route=>{if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();external.push('blocked');return route.abort();});
 const [a,b]=await Promise.all(contexts.map(c=>c.newPage()));for(const page of [a,b])page.on('pageerror',e=>errors.push(e.message));
 const rider='00000000-0000-4000-8000-000000000001';
 await a.goto('http://127.0.0.1:4176/?actor=a');await a.locator(`[data-admin-edit="${rider}"]`).click();
 await a.locator('[name="name"]').fill('Synthetic discarded edit');await a.getByRole('button',{name:'Cancel',exact:true}).click();
 await a.locator('.shared-status > details > summary').click();await a.locator('[data-action="adminSharedReview"]').click();
 await a.waitForFunction(()=>fixtureApp.state.view==='adminReview');
 assert.equal(await a.evaluate(()=>Boolean(fixtureApp.state.adminShared.personalDirty)),false);
 console.log('PASS normal rider input → Cancel → Review succeeds without an unreachable dirty edit');
 await a.locator('[data-action="adminBack"]').first().click();await a.locator(`[data-admin-edit="${rider}"]`).click();
 let lost=false,allowLookup=false;
 await a.route('**/rpc',async route=>{
  const {name,args}=route.request().postDataJSON();requests.push({name,id:args.p_operation_id||args.p_operation?.operationId});
  if(name==='ride_admin_shared_mutate'&&!lost){lost=true;await route.fetch();return route.abort();}
  if(name==='ride_admin_shared_operation'&&!allowLookup)return route.fulfill({json:{ok:false,code:'not_found'}});
  return route.continue();
 });
 await a.locator('[name="name"]').fill('Synthetic private recovery');await a.locator('[data-admin-form="rider"] button[type="submit"]').click();
 await a.waitForFunction(()=>fixtureApp.state.adminShared.pendingOperation&&!fixtureApp.state.adminShared.saving);
 const old=await a.evaluate(()=>({id:fixtureApp.state.adminShared.pendingOperation.operationId,baseline:fixtureApp.state.adminShared.snapshot.baselinePublishedRevision}));
 // Cancel explicitly discards the active form; retain the uncertain request itself.
 await a.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await a.evaluate(id=>fixtureApp.state.adminShared.pendingOperation?.operationId===id,old.id),true);
 // Reopen and enter later personal input, without resending the uncertain request.
 await a.locator(`[data-admin-edit="${rider}"]`).click();await a.locator('[name="name"]').fill('Synthetic later private recovery');
 await b.goto('http://127.0.0.1:4176/?actor=b');await b.locator('.shared-status > details > summary').click();await b.locator('[data-action="adminSharedReview"]').click();
 await b.waitForFunction(()=>fixtureApp.state.view==='adminReview');await b.locator('[data-action="adminPublish"]').click();
 await b.waitForFunction(()=>fixtureApp.state.adminShared.snapshot.baselinePublishedRevision===1);
 const writes=requests.filter(r=>r.name==='ride_admin_shared_mutate').length,lookups=requests.filter(r=>r.name==='ride_admin_shared_operation').length;
 allowLookup=true;await a.reload();await a.waitForFunction(()=>fixtureApp.state.adminShared?.snapshot?.baselinePublishedRevision===1&&!fixtureApp.state.adminShared.pendingOperation);
 assert.equal(requests.filter(r=>r.name==='ride_admin_shared_mutate').length,writes);
 assert.equal(requests.filter(r=>r.name==='ride_admin_shared_operation').length>lookups,true);
 assert.equal(requests.some(r=>r.name==='ride_admin_shared_operation'&&r.id===old.id),true);
 await a.locator('.shared-status > details > summary').click();await a.locator('[data-action="adminSharedRecovery"]').click();
 const recovery=a.locator('[data-shared-notices] details').filter({hasText:'Unsaved values on this device'});await recovery.locator('summary').click();
 assert.match(await recovery.innerText(),/baseline 0/);assert.match(await recovery.innerText(),/Current baseline: 1/);assert.match(await recovery.innerText(),/Synthetic later private recovery/);
 assert.equal(await a.evaluate(()=>fixtureApp.state.adminShared.snapshot.riders[0].name),'Synthetic private recovery');
 assert.equal(requests.some(r=>r.name==='ride_admin_shared_publish'),false);
 await recovery.locator('[data-action="adminSharedRestoreForm"]').click();
 assert.equal(await a.locator('[name="name"]').inputValue(),'Synthetic later private recovery');
 assert.equal(await a.evaluate(()=>fixtureApp.state.adminShared.personalDirty),true);
 await a.locator('.shared-status > details > summary').click();
 await a.locator('[data-action="adminSharedReview"]').click();assert.equal(await a.evaluate(()=>fixtureApp.state.view),'adminEdit');
 await a.screenshot({path:'.superpowers/sdd/collaborative-ride-control/core-final-recovery.png',fullPage:true});
 console.log('PASS lost committed reply → Cancel retains ID → later input → B publishes → A reloads: original lookup, no replay/publication, baseline-0 values explicitly recoverable against baseline 1');
 await a.getByRole('button',{name:'Cancel',exact:true}).click();
 await a.goto('http://127.0.0.1:4176/?actor=c');await a.locator('.shared-status > details > summary').click();await a.locator('[data-action="adminSharedRecovery"]').click();
 await a.waitForFunction(()=>Array.isArray(fixtureApp.state.adminShared.recoveryCandidates));
 assert.equal(await a.locator('[data-shared-notices]').innerText().then(t=>t.includes('Synthetic later private recovery')),false);
 assert.equal(await a.evaluate(()=>fixtureApp.state.adminShared.deviceRecoveries.length),0);
 console.log('PASS actor switch exposes no prior actor recovery; zero page errors or external requests');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 await Promise.all(contexts.map(c=>c.close()));
}finally{await browser.close();}
