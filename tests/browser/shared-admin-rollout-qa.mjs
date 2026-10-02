// Additional Task 7 coverage. Run on a freshly started synthetic preview only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'/Users/joojo/Documents/Codex/2026-10-01/task-2/browser-qa-tooling/node_modules/playwright');
const browser=await chromium.launch({headless:true}),contexts=[],pages=[],errors=[],external=[];
const origin='http://127.0.0.1:4176';
try {
 for(const [i,width] of [390,430,1363].entries()) {
  const context=await browser.newContext({viewport:{width,height:900}});contexts.push(context);
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
  const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/?actor=${'abc'[i]}`);await page.locator('.admin-control-screen').waitFor();
  assert.equal(await page.evaluate(()=>fixtureApp.state.adminShared.actorKey),`profile:${'abc'[i]}`);
 }
 const [a,b,c]=pages;
 // Review recovery on all three identities through ordinary disclosure/buttons.
 for(const [i,page] of pages.entries()) {
  await page.locator('.shared-status > details > summary').click();
  await page.locator('[data-action="adminSharedRecovery"]').click();
  await page.locator(`[data-shared-import="${'abc'[i]}-candidate-0"]`).waitFor({state:'attached'});
  assert.equal(await page.locator('[data-shared-import]').count(),2);
  assert.equal(await page.locator(`[data-shared-import="${'abc'[i]}-candidate-1"]`).isDisabled(),true);
  assert.match(await page.locator('[data-shared-notices]').innerText(),/Recovery candidates/);
 }
 const importButton=a.locator('[data-shared-import="a-candidate-0"]');
 await importButton.locator('..').locator('summary').click();await importButton.click();
 await b.waitForFunction(()=>fixtureApp.state.adminShared.snapshot.riders[0].name==='Recovery from a',{},{timeout:5500});
 assert.equal(await b.evaluate(()=>fixtureApp.state.adminShared.snapshot.publishedRevision),0);
 console.log('PASS three actor-scoped recovery lists; unknown baseline disabled; explicit import synchronizes and remains unpublished');
 // Publish through the real review UI. The fixture records driver-visible state separately.
 await a.locator('[data-action="adminReviewChanges"]').click();await a.locator('[data-action="adminPublish"]').click();
 await c.waitForFunction(()=>fixtureApp.state.adminShared.snapshot.publishedRevision===1,{},{timeout:5500});
 const latest=await c.evaluate(()=>JSON.stringify(fixtureApp.state.adminShared.snapshot.publishedSnapshot));
 await c.locator('[data-admin-edit]').first().click();await c.locator('[name="name"]').fill('Private C during operator pause');
 await a.request.post(`${origin}/fixture-control`,{data:{mode:'paused'}});
 for(const page of pages)await page.waitForFunction(()=>fixtureApp.state.adminShared.snapshot.writeMode==='paused',{},{timeout:5500});
 assert.equal(await c.locator('[name="name"]').inputValue(),'Private C during operator pause');
 assert.equal(await b.evaluate(()=>JSON.stringify(fixtureApp.state.adminShared.snapshot.publishedSnapshot)),latest);
 await c.locator('[data-admin-form="rider"] button[type="submit"]').click();
 assert.equal(await c.evaluate(()=>fixtureApp.state.adminShared.snapshot.riders[0].name),'Recovery from a');
 console.log('PASS operator pause preserves latest publication and personal editor; paused save cannot alter shared riders');
 await a.request.post(`${origin}/fixture-control`,{data:{mode:'shared'}});
 await c.waitForFunction(()=>fixtureApp.state.adminShared.snapshot.writeMode==='shared',{},{timeout:5500});
 assert.equal(await c.locator('[name="name"]').inputValue(),'Private C during operator pause');
 assert.equal(await c.evaluate(()=>fixtureApp.state.adminShared.snapshot.baselinePublishedRevision),1);
 // Revocation during personal input: DOM/private state clears, actor-scoped bytes survive.
 await a.request.post(`${origin}/fixture-control`,{data:{revoke:'c'}});
 await c.waitForFunction(()=>!fixtureApp.state.adminShared,{},{timeout:5500});
 assert.equal(await c.evaluate(()=>fixtureApp.state.admin),null);assert.equal(await c.locator('[name="name"]').count(),0);
 const recovery=await c.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('ride-recovery-v2:')).map(([k,v])=>[k,JSON.parse(v)]));
 assert.ok(JSON.stringify(recovery).includes('Private C during operator pause'));
 await b.locator('[data-action="adminSharedRecovery"]').click();
 assert.equal(await b.locator('[data-shared-notices]').innerText().then(t=>t.includes('Private C')),false);
 console.log('PASS revocation clears private DOM/state and stops refresh; scoped local recovery retained and absent from another actor');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log('PASS zero browser errors/external requests. Physical phone and installed PWA NOT RUN.');
} finally {await browser.close();}
