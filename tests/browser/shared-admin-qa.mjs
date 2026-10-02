// Run against shared-admin-preview.mjs. All identities/data are fictional.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'/Users/joojo/Documents/Codex/2026-10-01/task-2/browser-qa-tooling/node_modules/playwright');
const browser=await chromium.launch({headless:true});
const evidence='.superpowers/sdd/collaborative-ride-control/task-6-evidence';
const contexts=[],pages=[],errors=[],external=[];
try{
 for(const [i,[width,height]] of [[390,844],[430,932],[1363,936]].entries()){
  const context=await browser.newContext({viewport:{width,height}});contexts.push(context);const page=await context.newPage();pages.push(page);
  page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',route=>{if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();external.push(route.request().url());return route.abort();});
  await page.goto(`http://127.0.0.1:4176/?actor=${'abc'[i]}`);await page.locator('.admin-control-screen').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('[data-admin-search]').fill('Sample');await page.locator('[data-admin-edit]').first().waitFor();assert.match(await page.locator('[data-admin-riders-results]').innerText(),/Sample Rider/);await page.locator('[data-admin-search]').fill('');
  await page.locator('[data-action="adminMenuOpen"]').click();assert.ok(await page.locator('[data-admin-menu-page]').count());await page.evaluate(()=>{fixtureApp.state.adminMenuOpen=false;fixtureApp.render();});
  await page.locator('[data-admin-tab="drivers"]').click();await page.locator('[data-admin-driver-toggle]').first().waitFor();await page.locator('[data-admin-tab="riders"]').click();
  await page.screenshot({path:`${evidence}/after-${width}.png`,fullPage:true});
  console.log(`PASS viewport ${width}: overflow, search, menu, driver/rider navigation`);
 }
 const [a,b,c]=pages;
 await c.locator('[data-action="adminReviewChanges"]').click();await c.locator('[data-action="adminPublish"]').waitFor();assert.equal(await c.locator('[data-action="adminPublish"]').isEnabled(),true);
 for(const page of [a,b])await page.locator('[data-admin-edit]').first().click();
 const bInput=b.locator('[name="name"]');await bInput.fill('Private unsaved B');await bInput.focus();await bInput.evaluate(el=>el.setSelectionRange(4,9));
 await a.locator('[name="name"]').fill('Saved by Example Admin A');const remoteStart=Date.now();await a.locator('[data-admin-form="rider"] button[type="submit"]').click();
 await b.waitForFunction(()=>fixtureApp.state.adminShared.snapshot.riders.some(r=>r.name==='Saved by Example Admin A'),{},{timeout:5500});
 console.log(`MEASURE remote visibility ${Date.now()-remoteStart}ms (5.5s assertion timeout)`);assert.equal(await bInput.inputValue(),'Private unsaved B');assert.deepEqual(await bInput.evaluate(el=>[document.activeElement===el,el.selectionStart,el.selectionEnd]),[true,4,9]);
 await c.waitForFunction(()=>!fixtureApp.state.adminShared.review,{},{timeout:5500});assert.equal(await c.locator('[data-action="adminPublish"]').isDisabled(),true);
 await b.locator('[data-admin-form="rider"] button[type="submit"]').click();await b.locator('[data-action="adminSharedCompare"]').waitFor();await b.locator('[data-action="adminSharedCompare"]').click();await b.locator('[data-action="adminSharedReapply"]').waitFor();
 assert.match(await b.locator('[data-shared-notices]').innerText(),/Your unsaved values[\s\S]*Private unsaved B[\s\S]*Latest saved values[\s\S]*Saved by Example Admin A/);
 await b.screenshot({path:`${evidence}/conflict-430.png`,fullPage:true});
 await b.locator('[data-action="adminSharedReapply"]').click();await c.waitForFunction(()=>fixtureApp.state.adminShared.snapshot.riders.some(r=>r.name==='Private unsaved B'),{},{timeout:5500});
 console.log('PASS three admin contexts: remote visibility ≤5.5s, private input/focus/selection, stale review, conflict comparison and deliberate reapply');
 // A remote add refreshes existing header counters without rebuilding the focused search control.
 await c.locator('[data-action="adminBack"]').click();const search=c.locator('[data-admin-search]');await search.focus();
 const beforeCount=Number(await c.locator('[data-admin-tab="riders"] strong').innerText());
 await a.locator('[data-action="adminNew"]').click();await a.locator('[name="name"]').fill('Additional Synthetic Rider');await a.locator('[name="driverSlug"]').selectOption('b');await a.locator('[name="address"]').fill('400 Imaginary Lane');await a.locator('[name="pickupTime"]').fill('09:30');await a.locator('[data-admin-form="rider"] button[type="submit"]').click();
 await c.waitForFunction(count=>Number(document.querySelector('[data-admin-tab="riders"] strong').textContent)===count,beforeCount+1,{timeout:5500});
 assert.equal(await search.evaluate(el=>document.activeElement===el),true);console.log('PASS remote rider add updates header count and preserves search focus');
 // Open the current rider and exercise offline input + reconnect without replay.
 await b.evaluate(()=>{fixtureApp.state.view='admin';fixtureApp.render();});await b.locator('[data-admin-edit]').first().click();await b.locator('[name="name"]').fill('Offline personal input');
 await contexts[1].setOffline(true);await b.waitForFunction(()=>fixtureApp.state.adminShared.status!=='saved');
 assert.equal(await b.locator('[name="name"]').inputValue(),'Offline personal input');await contexts[1].setOffline(false);await b.waitForFunction(()=>fixtureApp.state.adminShared.status==='saved');assert.equal(await b.locator('[name="name"]').inputValue(),'Offline personal input');
 console.log('PASS offline/reconnect preserves input and does not replay it');
 // Actual quick move through existing list. The second rider starts in b.
 await a.evaluate(()=>{fixtureApp.state.view='admin';fixtureApp.render();});const move=a.locator('.admin-quick-move').filter({has:a.locator('summary[aria-label*="Sample Rider Two"]')});await move.locator('summary').click();await move.locator('select').selectOption('c');await a.evaluate(()=>fixtureApp.state.adminShared.sync.refresh('manual'));assert.equal(await move.locator('select').inputValue(),'c');assert.equal(await move.getAttribute('open'),'');await move.locator('button').click();
 await c.waitForFunction(()=>fixtureApp.state.adminShared.snapshot.riders.some(r=>r.name==='Sample Rider Two'&&r.driverSlug==='c'),{},{timeout:5500});
 assert.equal(await c.evaluate(()=>fixtureApp.state.adminShared.snapshot.publishedRevision),0);console.log('PASS quick reassignment remains draft-only');
 // Lose the direct save reply after the fixture commits it; status lookup resolves it.
 await a.locator('[data-admin-edit]').first().click();await a.locator('[name="name"]').fill('Confirmed after lost response');let lost=false;
 await a.route('**/rpc',async route=>{const body=route.request().postDataJSON();if(body.name==='ride_admin_shared_mutate'&&!lost){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
 await a.locator('[data-admin-form="rider"] button[type="submit"]').click();await a.waitForFunction(()=>fixtureApp.state.adminShared.snapshot.riders.some(r=>r.name==='Confirmed after lost response')&&!fixtureApp.state.adminShared.pendingOperation,{},{timeout:5500});assert.equal(lost,true);console.log('PASS committed save with lost reply resolves through operation lookup');
 for(const [i,[width]] of [[390,844],[430,932],[1363,936]].entries()){
  const page=await contexts[i].newPage();await page.goto('http://127.0.0.1:4176/?home=1');const cover=page.locator('.home-art img');await cover.waitFor();await cover.evaluate(img=>img.decode());
  const image=await cover.evaluate(img=>{const r=img.getBoundingClientRect(),p=img.parentElement.getBoundingClientRect();return {natural:[img.naturalWidth,img.naturalHeight],ratio:r.width/r.height,fit:getComputedStyle(img).objectFit,unclipped:r.left>=p.left&&r.right<=p.right&&r.top>=p.top&&r.bottom<=p.bottom};});assert.deepEqual(image.natural,[1536,1024]);assert.ok(Math.abs(image.ratio-1.5)<.01);assert.equal(image.fit,'contain');assert.equal(image.unclipped,true);await page.screenshot({path:`${evidence}/opening-${width}.png`,fullPage:true});console.log(`PASS opening ${width}: ${JSON.stringify(image)}`);
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('PASS zero browser page errors and zero external network requests; physical device NOT RUN');
}finally{await browser.close();}
