// Normal UI regression for cross-rider navigation around a conflict comparison.
// Start with a freshly restarted shared-admin-preview.mjs; no production transport.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'/Users/joojo/Documents/Codex/2026-10-01/task-2/browser-qa-tooling/node_modules/playwright');
const browser=await chromium.launch({headless:true});
const x='00000000-0000-4000-8000-000000000001',y='00000000-0000-4000-8000-000000000002';
const errors=[],external=[];
try {
 for(const compareBeforeCancel of [false,true]) {
  const contexts=await Promise.all([browser.newContext({viewport:{width:390,height:844}}),browser.newContext({viewport:{width:430,height:932}})]);
  for(const context of contexts)await context.route('**/*',route=>{if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();external.push(route.request().url());return route.abort();});
  const [a,b]=await Promise.all(contexts.map(context=>context.newPage()));for(const page of [a,b])page.on('pageerror',error=>errors.push(error.message));
  await a.goto('http://127.0.0.1:4176/?actor=a');await a.locator(`[data-admin-edit="${x}"]`).waitFor();
  if(!compareBeforeCancel) {
   const move=a.locator('.admin-quick-move').filter({has:a.locator('summary[aria-label*="Sample Rider Two"]')});await move.locator('summary').click();await move.locator('select').selectOption('a');await move.locator('button').click();await a.waitForFunction(()=>fixtureApp.state.adminShared.snapshot.riders.every(r=>r.driverSlug==='a'));
  }
  await b.goto('http://127.0.0.1:4176/?actor=b');await b.locator(`[data-admin-edit="${x}"]`).waitFor();
  for(const page of [a,b])await page.locator(`[data-admin-edit="${x}"]`).click();
  const savedName=`Saved X ${compareBeforeCancel?'after':'before'} comparison`;
  await b.locator('[name="name"]').fill('B unsaved X');await a.locator('[name="name"]').fill(savedName);await a.locator('[data-admin-form="rider"] button[type="submit"]').click();
  await b.waitForFunction(name=>fixtureApp.state.adminShared.snapshot.riders.find(r=>r.id==='00000000-0000-4000-8000-000000000001').name===name,savedName,{timeout:5500});
  await b.locator('[data-admin-form="rider"] button[type="submit"]').click();await b.locator('[data-action="adminSharedCompare"]').waitFor();
  if(compareBeforeCancel){await b.locator('[data-action="adminSharedCompare"]').click();await b.locator('[data-action="adminSharedReapply"]').waitFor();}
  await b.getByRole('button',{name:'Cancel',exact:true}).click();await b.locator(`[data-admin-edit="${y}"]`).click();
  assert.equal(await b.locator('[name="name"]').inputValue(),'Sample Rider Two');assert.equal(await b.locator('[data-action="adminSharedCompare"]').count(),0);assert.equal(await b.locator('[data-action="adminSharedReapply"]').count(),0);
  const records=await b.evaluate(()=>fixtureApp.state.adminShared.snapshot.riders.map(r=>({id:r.id,name:r.name,address:r.address})));
  assert.equal(records.find(r=>r.id===x).name,savedName);assert.equal(records.find(r=>r.id===x).address,'100 Example Street');assert.equal(records.find(r=>r.id===y).address,'200 Fictional Avenue');
  await b.screenshot({path:`.superpowers/sdd/collaborative-ride-control/task-6-evidence/fix1-navigation-${compareBeforeCancel?'after':'before'}-comparison.png`,fullPage:true});
  await b.getByRole('button',{name:'Cancel',exact:true}).click();await b.locator(`[data-admin-edit="${x}"]`).click();assert.equal(await b.locator('[data-action="adminSharedReapply"]').count(),0);assert.equal(await b.locator('[name="name"]').inputValue(),savedName);
  console.log(`PASS normal UI X conflict → ${compareBeforeCancel?'Compare → ':''}Cancel → Y → Cancel → X: no inherited comparison or wrong-rider write`);
  await Promise.all(contexts.map(context=>context.close()));
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('PASS zero page errors/external requests; existing phone controls unchanged');
}finally{await browser.close();}
