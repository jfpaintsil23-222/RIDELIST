import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as core from '../src/shared-admin-core.js';
import {createAdminSync} from '../src/shared-admin-sync.js';
const settle=async()=>{for(let i=0;i<40;i++) await Promise.resolve();};
const date='2099-01-04';
const snapshot=()=>({ok:true,planDate:date,writeMode:'shared',draftRevision:3,eventCursor:19,publishedRevision:0,baselinePublishedRevision:0,settingsVersion:1,drivers:[{slug:'a',displayName:'Synthetic'}],riders:[{id:'00000000-0000-4000-8000-000000000002',name:'Synthetic rider',address:'Example',driverSlug:'a',entityVersion:2,stopOrder:1}],groupVersions:{a:3},publishedSnapshot:{ok:true,plan:{date},stops:[],drivers:[],people:[]}});
async function appHarness(handler=()=>undefined){
 const elements=new Map(),storage=new Map(),calls=[],listeners={};let seq=10;
 const element=()=>({innerHTML:'',textContent:'',value:'',dataset:{},hidden:false,classList:{add(){},remove(){},contains(){return false;},toggle(){}},setAttribute(){},addEventListener(){},querySelector(){return element();},focus(){}});
 const get=q=>{if(!elements.has(q))elements.set(q,element());return elements.get(q);};
 const document={hidden:false,activeElement:null,querySelector:get,querySelectorAll:()=>[],addEventListener:(name,fn)=>listeners[name]=fn,removeEventListener(){}};
 const context={console:{...console,error(){},warn(){}},URLSearchParams,encodeURIComponent,crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++seq).padStart(12,'0')}`},setTimeout:()=>1,clearTimeout(){},AbortController,
  FormData:class{constructor(form){this.values=form?.values||{};}get(key){return this.values[key];}entries(){return Object.entries(this.values)[Symbol.iterator]();}},
  location:{href:'https://example.test/',search:''},navigator:{onLine:true},document,
  window:{isSecureContext:false,RideShared:{...core,createAdminSync:options=>createAdminSync({...options,clock:{setTimeout:()=>1,clearTimeout(){}}})},addEventListener:(name,fn)=>listeners[name]=fn,removeEventListener(){}},
  localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  fetch:async(url,init)=>{const name=url.split('/').at(-1),args=JSON.parse(init?.body||'{}');if(!name.startsWith('ride_admin_'))return {ok:true,json:async()=>[]};calls.push({name,args});const custom=await handler(name,args);const result=custom ?? (name==='ride_admin_shared_context'?{...snapshot(),actorKey:'profile:a',initialized:true}:name==='ride_admin_shared_snapshot'?snapshot():name==='ride_admin_shared_secondary'?{ok:true,actorKey:'profile:a',planDate:date,people:[],driverPool:[],brandingVersion:1,branding:{}}:name==='ride_admin_shared_operation'?{ok:false,code:'not_found'}:{ok:true});return {ok:true,json:async()=>result};}};
 vm.createContext(context);const html=await readFile(new URL('../index.html',import.meta.url),'utf8');const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
 vm.runInContext(script+`\nglobalThis.app={state,adminView,adminSharedStatusHtml,adminRouteWarnings,adminPublishIssues,activeRideBranding,homeArt,quickMoveAdminShared:typeof quickMoveAdminShared==='function'?quickMoveAdminShared:undefined,compareAdminSharedConflict:typeof compareAdminSharedConflict==='function'?compareAdminSharedConflict:undefined,reapplyAdminSharedConflict:typeof reapplyAdminSharedConflict==='function'?reapplyAdminSharedConflict:undefined,loadAdminSharedRecovery:typeof loadAdminSharedRecovery==='function'?loadAdminSharedRecovery:undefined,importAdminSharedRecovery:typeof importAdminSharedRecovery==='function'?importAdminSharedRecovery:undefined,loadAdminSnapshot,signOutAdmin,saveAdminDraftFromForm,deleteAdminDraftStop,publishAdminDraft,runAdminSharedSecondary,adminEditView,render,applyAdminSharedState:typeof applyAdminSharedState==='function'?applyAdminSharedState:undefined,reviewAdminShared:typeof reviewAdminShared==='function'?reviewAdminShared:undefined,retryAdminSharedPending:typeof retryAdminSharedPending==='function'?retryAdminSharedPending:undefined};`,context);
 const app=context.app;app.state.planDate=date;return {app,calls,elements,storage,context,async start(){await app.loadAdminSnapshot('synthetic-token');await settle();}};
}
test('shared login hydrates protected snapshot/secondary and never selects legacy recovery winner',async()=>{const h=await appHarness();await h.start();assert.equal(h.app.state.adminShared?.actorKey,'profile:a');assert.equal(h.app.state.adminDraftStops[0].name,'Synthetic rider');assert.equal(h.calls.some(c=>c.name==='ride_admin_get_draft'),false);h.app.signOutAdmin();});
test('form_focus_preserved and captured versions survive remote snapshot; only safe route region changes',async()=>{const h=await appHarness();await h.start();assert.equal(typeof h.app.applyAdminSharedState,'function');const c=h.app.state.adminShared;h.app.state.view='adminEdit';const input={value:'private typed text',selectionStart:5};h.context.document.activeElement=input;const form=h.elements.get('#screen');form.innerHTML='existing form';const old=c.snapshot;h.app.applyAdminSharedState(c,{status:'saved',snapshot:{...old,draftRevision:4,riders:[{...old.riders[0],name:'Remote'}]}});assert.equal(form.innerHTML,'existing form');assert.equal(input.value,'private typed text');assert.equal(input.selectionStart,5);assert.equal(h.app.state.adminDraftStops[0].name,'Remote');h.app.signOutAdmin();});
test('shared rider save uses captured versions, records uncertainty, reconciles not_found, retries same body/id',async()=>{let writes=0;const h=await appHarness(name=>{if(name==='ride_admin_shared_mutate'){writes++;throw Error('lost reply');}});await h.start();const c=h.app.state.adminShared;const form={dataset:{sharedSnapshot:JSON.stringify(c.snapshot)},values:{...c.snapshot.riders[0],name:'Personal'}};await h.app.saveAdminDraftFromForm(form);await settle();assert.equal(writes,1);const pending=c.pendingOperation;assert.ok(pending?.operationId);assert.equal(pending.args.p_operation.expectedEntityVersion,2);await h.app.saveAdminDraftFromForm(form);assert.equal(writes,1);assert.equal(typeof h.app.retryAdminSharedPending,'function');await h.app.retryAdminSharedPending();await settle();assert.equal(writes,2);const bodies=h.calls.filter(c=>c.name==='ride_admin_shared_mutate').map(c=>c.args.p_operation);assert.deepEqual(bodies[0],bodies[1]);assert.ok(c.pendingOperation);assert.equal(h.calls.some(c=>c.name==='ride_admin_save_draft'),false);assert.equal([...h.storage.values()].some(v=>v.includes('synthetic-token')),false);h.app.signOutAdmin();});
test('publish requires current online review and captures mandatory revisions',async()=>{const h=await appHarness();await h.start();await h.app.publishAdminDraft();assert.equal(h.calls.some(c=>c.name==='ride_admin_shared_publish'),false);assert.equal(typeof h.app.reviewAdminShared,'function');await h.app.reviewAdminShared();await h.app.publishAdminDraft();const call=h.calls.find(c=>c.name==='ride_admin_shared_publish');assert.ok(call);assert.equal(call.args.p_expected_draft_revision,3);assert.equal(call.args.p_expected_baseline_revision,0);h.app.signOutAdmin();});
test('signout clears private state immediately and delayed login cannot resurrect it',async()=>{let resolve;const wait=new Promise(r=>resolve=r);const h=await appHarness(name=>name==='ride_admin_shared_context'?wait:undefined);const opening=h.app.loadAdminSnapshot('synthetic-token');await settle();await h.app.signOutAdmin();resolve({...snapshot(),actorKey:'profile:a',initialized:true});await opening;assert.equal(h.app.state.admin,null);assert.equal(h.app.state.adminShared,null);assert.equal(h.app.state.adminDraftStops.length,0);});
test('secondary old response cannot roll back newer person projection and invalid auth locks private UI',async()=>{let resolve;const wait=new Promise(r=>resolve=r);const h=await appHarness(name=>name==='ride_admin_shared_save_person'?wait:undefined);await h.start();const c=h.app.state.adminShared;h.app.state.admin.people=[{id:'p',name:'initial',recordVersion:1}];const saving=h.app.runAdminSharedSecondary('person',{id:'p',name:'saved'},{recordVersion:1});h.app.state.admin.people=[{id:'p',name:'newest',recordVersion:3}];resolve({ok:true,value:{person:{id:'p',name:'old reply',recordVersion:2}}});await saving;assert.equal(h.app.state.admin.people[0].name,'newest');h.app.applyAdminSharedState(c,{status:'locked',snapshot:null});assert.equal(h.app.state.admin,null);assert.equal(h.app.state.adminShared,null);assert.equal(h.app.state.adminPersonDraft,null);});
test('shared login keeps protected security and destination, clears prior actor forms',async()=>{const h=await appHarness(name=>name==='ride_admin_shared_snapshot'?{...snapshot(),publishedSnapshot:{...snapshot().publishedSnapshot,security:{actor:{type:'profile',label:'Synthetic Alpha'}},destination:{label:'Synthetic destination'}}}:undefined);h.app.state.adminMergeDraft={private:'old actor'};h.app.state.adminAiResult={private:'old actor'};await h.start();assert.equal(h.app.state.admin?.security?.actor?.label,'Synthetic Alpha');assert.equal(h.app.state.destination?.label,'Synthetic destination');await h.app.signOutAdmin();assert.equal(h.app.state.adminMergeDraft,null);assert.equal(h.app.state.adminAiResult,null);});
test('lost publish response retains original versioned request and blocks another publish',async()=>{let writes=0;const h=await appHarness(name=>{if(name==='ride_admin_shared_publish'){writes++;throw Error('timeout');}});await h.start();await h.app.reviewAdminShared();await h.app.publishAdminDraft();await settle();const pending=h.app.state.adminShared.pendingOperation;assert.equal(pending.kind,'publish');assert.equal(pending.args.p_expected_draft_revision,3);await h.app.publishAdminDraft();assert.equal(writes,1);await h.app.signOutAdmin();});
test('catalog uncertainty recovery never persists driver passcodes or admin tokens',async()=>{const h=await appHarness(name=>{if(name==='ride_admin_shared_add_driver')throw Error('timeout');});await h.start();await h.app.runAdminSharedSecondary('catalog',{name:'Synthetic',passcode:'private-driver-secret'});await settle();assert.equal([...h.storage.values()].some(v=>v.includes('private-driver-secret')||v.includes('synthetic-token')),false);await h.app.signOutAdmin();});
test('secondary success clears saved personal dirty state; offline and remote revisions invalidate review',async()=>{const h=await appHarness();await h.start();const c=h.app.state.adminShared;c.personalDirty=true;await h.app.runAdminSharedSecondary('route',{planTitle:'Synthetic'},{recordVersion:1});assert.equal(c.personalDirty,false);await h.app.reviewAdminShared();h.context.navigator.onLine=false;await h.app.publishAdminDraft();assert.equal(h.calls.some(c=>c.name==='ride_admin_shared_publish'),false);h.context.navigator.onLine=true;h.app.applyAdminSharedState(c,{status:'saved',snapshot:{...c.snapshot,draftRevision:4,eventCursor:31}});assert.equal(c.review,null);await h.app.signOutAdmin();});
test('same actor sign-in retains uncertain operation identity without auto-replaying',async()=>{const h=await appHarness(name=>{if(name==='ride_admin_shared_mutate')throw Error('timeout');});await h.start();const c=h.app.state.adminShared;const form={dataset:{sharedSnapshot:JSON.stringify(c.snapshot)},values:{...c.snapshot.riders[0],name:'Personal'}};await h.app.saveAdminDraftFromForm(form);await settle();const id=c.pendingOperation.operationId;await h.app.signOutAdmin();await h.start();assert.equal(h.app.state.adminShared.pendingOperation?.operationId,id);assert.equal(h.calls.filter(c=>c.name==='ride_admin_shared_mutate').length,1);await h.app.signOutAdmin();});
test('account switch clears old private projections before authentication and on rejection',async()=>{let reject=false;const h=await appHarness(name=>reject && name==='ride_admin_shared_context'?{ok:false,code:'invalid_admin_code'}:undefined);await h.start();h.app.state.adminPersonDraft={name:'old private form'};reject=true;await h.app.loadAdminSnapshot('other-token');assert.equal(h.app.state.admin,null);assert.equal(h.app.state.adminPersonDraft,null);assert.equal(h.app.state.adminDraftStops.length,0);await h.app.signOutAdmin();});
test('shared form data uses the draft capture and survives typing during a pending successful save',async()=>{let resolve;const reply=new Promise(r=>resolve=r);const h=await appHarness(name=>name==='ride_admin_shared_mutate'?reply:undefined);await h.start();const c=h.app.state.adminShared;h.app.state.view='adminEdit';const form={dataset:{sharedSnapshot:JSON.stringify(c.snapshot)},values:{...c.snapshot.riders[0],name:'Saved version'}};const saving=h.app.saveAdminDraftFromForm(form);c.editVersion=1;c.personalDirty=true;resolve({ok:true});await saving;assert.equal(h.app.state.view,'adminEdit');assert.equal(c.personalDirty,true);await h.app.signOutAdmin();});
test('secondary refresh is serialized with metadata polling and does not overlap focus refresh',async()=>{let hold=false,release,contexts=0;const wait=new Promise(r=>release=r);const h=await appHarness(name=>{if(name==='ride_admin_shared_context')contexts++;if(hold && name==='ride_admin_shared_secondary')return wait;});await h.start();h.app.state.adminActiveTab='people';hold=true;const first=h.app.state.adminShared.sync.refresh('poll');await settle();const count=contexts;const next=h.app.state.adminShared.sync.refresh('focus');await settle();assert.equal(contexts,count);release({ok:true,actorKey:'profile:a',planDate:date,people:[],driverPool:[],brandingVersion:1,branding:{}});await first;await next;await h.app.signOutAdmin();});
test('delayed logout response cannot clear a newly signed-in workspace',async()=>{let release;const wait=new Promise(r=>release=r);const h=await appHarness();await h.start();h.app.state.adminSession={access_token:'old-session'};const priorFetch=h.context.fetch;h.context.fetch=(url,init)=>url.includes('/auth/v1/logout')?wait:priorFetch(url,init);const logout=h.app.signOutAdmin();await h.start();const current=h.app.state.adminShared;release({ok:true,json:async()=>({})});await logout;assert.ok(h.app.state.admin);assert.equal(h.app.state.adminShared,current);await h.app.signOutAdmin();});

const pendingReply = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

for (const nextKind of ['rider', 'route']) {
  test(`an old lookup cannot erase the newer ${nextKind} request when its reply is lost`, async () => {
    const retryReply = pendingReply(), oldLookup = pendingReply(), nextReply = pendingReply();
    let writes = 0, lookups = 0, originalId;
    const h = await appHarness((name, args) => {
      if (name === 'ride_admin_shared_mutate') {
        writes++;
        if (writes === 1) { originalId = args.p_operation.operationId; throw Error('original reply lost'); }
        if (writes === 2) return retryReply.promise;
        return nextReply.promise;
      }
      if (name === 'ride_admin_shared_save_settings') return nextReply.promise;
      if (name === 'ride_admin_shared_operation' && args.p_operation_id === originalId) {
        lookups++;
        return lookups === 3 ? oldLookup.promise : {ok:false,code:'not_found'};
      }
    });
    await h.start();
    const context = h.app.state.adminShared;
    const form = {dataset:{sharedSnapshot:JSON.stringify(context.snapshot)},values:{...context.snapshot.riders[0],name:'Original'}};
    await h.app.saveAdminDraftFromForm(form);
    await settle();
    const retry = h.app.retryAdminSharedPending();
    await settle();
    assert.equal(writes, 2);
    const previousRefresh = context.sync.refresh('poll');
    await settle();
    assert.equal(lookups, 3, 'lookup A is in flight before its direct retry succeeds');
    retryReply.resolve({ok:true,operationId:originalId});
    await retry;
    form.values.name = 'Second';
    const saveNext = nextKind === 'rider'
      ? h.app.saveAdminDraftFromForm(form)
      : h.app.runAdminSharedSecondary('route',{planTitle:'Second'},{recordVersion:1});
    await settle();
    const field = nextKind === 'rider' ? 'pendingOperation' : 'pendingSecondary';
    const next = context[field];
    assert.ok(next?.operationId);
    const originalBody = JSON.stringify(next.args);
    oldLookup.resolve({ok:true,operationId:originalId});
    await previousRefresh;
    await settle();
    nextReply.reject(Error('second reply lost'));
    await saveNext;
    await settle();
    assert.equal(context[field]?.operationId, next.operationId);
    assert.equal(JSON.stringify(context[field].args), originalBody);
    assert.ok(h.calls.some(call => call.name === 'ride_admin_shared_operation' && call.args.p_operation_id === next.operationId));
    assert.ok([...h.storage.values()].some(value => value.includes(next.operationId)));
    await h.app.signOutAdmin();
  });
}

for (const kind of ['rider', 'route']) {
  test(`${kind} retry keeps the original edit capture and cannot authorize publishing later unsent input`, async () => {
    let writes = 0;
    const name = kind === 'rider' ? 'ride_admin_shared_mutate' : 'ride_admin_shared_save_settings';
    const h = await appHarness(rpcName => {
      if (rpcName === name && ++writes === 1) throw Error('response lost');
    });
    await h.start();
    const context = h.app.state.adminShared;
    const form = {dataset:{sharedSnapshot:JSON.stringify(context.snapshot)},values:{...context.snapshot.riders[0],name:'Submitted'}};
    if (kind === 'rider') await h.app.saveAdminDraftFromForm(form);
    else await h.app.runAdminSharedSecondary('route',{planTitle:'Submitted'},{recordVersion:1});
    await settle();
    const original = context.pendingOperation || context.pendingSecondary;
    const submittedVersion = original.editVersion;
    context.editVersion = submittedVersion + 1;
    context.personalDirty = true;
    const laterInput = {name:'Typed after submission'};
    context.personalForm = laterInput;
    await h.app.retryAdminSharedPending();
    await settle();
    assert.equal(original.editVersion, submittedVersion);
    assert.equal(context.personalDirty, true);
    assert.equal(context.personalForm, laterInput);
    const bodies = h.calls.filter(call => call.name === name).map(call => call.args);
    assert.deepEqual(bodies[0], bodies[1], 'the original body and operation ID are retried');
    await h.app.reviewAdminShared();
    await h.app.publishAdminDraft();
    assert.equal(h.calls.some(call => call.name === 'ride_admin_shared_publish'), false);
    await h.app.signOutAdmin();
  });
}

test('selected People Bank addressChoice reaches the versioned rider-add payload', async () => {
  const h = await appHarness();
  await h.start();
  const context = h.app.state.adminShared;
  const form = {dataset:{sharedSnapshot:JSON.stringify(context.snapshot)},values:{
    id:'',name:'Synthetic selected person',driverSlug:'a',stopOrder:'1',
    personId:'00000000-0000-4000-8000-000000000009',personVersion:'4',
    addressChoice:' Chosen synthetic campus address '
  }};
  await h.app.saveAdminDraftFromForm(form);
  const operation = h.calls.find(call => call.name === 'ride_admin_shared_mutate').args.p_operation;
  assert.equal(operation.kind, 'rider_add');
  assert.equal(operation.payload.address, 'Chosen synthetic campus address');
  assert.equal(operation.payload.personVersion, 4);
  assert.equal(operation.payload.personId, form.values.personId);
  await h.app.signOutAdmin();
});


test('phone_navigation_retained with compact collaboration controls and desktop_same_actions_and_state',async()=>{
 const h=await appHarness();await h.start();const view=h.app.adminView();
 for(const marker of ['Today','data-action="adminMenuOpen"','data-admin-tab="drivers"','data-admin-tab="riders"','data-admin-tab="changes"','admin-zone-list','admin-review-bar'])assert.ok(view.includes(marker),marker);
 assert.match(h.app.adminSharedStatusHtml(),/shared-status-actions/);
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');assert.match(html,/@media \(min-width: 1000px\)[\s\S]*?\.phone\.admin-workspace/);
 await h.app.signOutAdmin();
});
test('missing phone is advisory, unassigned rider blocks publish, and empty driver is valid',async()=>{
 const h=await appHarness();await h.start();const rider={...h.app.state.adminDraftStops[0],phone:'',pickupTime:'09:00'};
 const warning=h.app.adminRouteWarnings({slug:'a'},[rider]).find(w=>w.key.startsWith('missing-phone'));
 assert.equal(warning.level,'normal');assert.match(warning.detail,/organizer/);
 assert.equal(h.app.adminRouteWarnings({slug:'empty'},[]).length,0);assert.equal(h.app.adminPublishIssues().length,0);
 await h.app.reviewAdminShared();h.app.state.adminDraftStops[0].driverSlug='';assert.ok(h.app.adminPublishIssues().some(i=>i.title.includes('not assigned')));
 await h.app.publishAdminDraft();assert.equal(h.calls.some(c=>c.name==='ride_admin_shared_publish'),false);
 await h.app.signOutAdmin();
});
test('quick reassignment submits only a versioned draft move with both groups',async()=>{
 const h=await appHarness();await h.start();const c=h.app.state.adminShared;c.snapshot.drivers.push({slug:'b'});c.snapshot.groupVersions.b=7;
 assert.equal(typeof h.app.quickMoveAdminShared,'function');await h.app.quickMoveAdminShared(c.snapshot.riders[0].id,'b',c.snapshot);
 const op=h.calls.find(c=>c.name==='ride_admin_shared_mutate').args.p_operation;
 assert.equal(op.kind,'rider_move');assert.deepEqual(JSON.parse(JSON.stringify(op.expectedGroupVersions)),{a:3,b:7});assert.equal(op.expectedEntityVersion,2);assert.equal(op.payload.driverSlug,'b');assert.equal(h.calls.some(c=>c.name==='ride_admin_shared_publish'),false);await h.app.signOutAdmin();
});
test('conflict_compares_both_values and deliberate reapply uses reviewed fresh versions',async()=>{
 let conflict=true;const h=await appHarness(name=>name==='ride_admin_shared_mutate'&&conflict?{ok:false,code:'conflict'}:undefined);await h.start();
 const c=h.app.state.adminShared,form={dataset:{sharedSnapshot:JSON.stringify(c.snapshot)},values:{...c.snapshot.riders[0],name:'My private name'}};
 await h.app.saveAdminDraftFromForm(form);assert.equal(typeof h.app.compareAdminSharedConflict,'function');await h.app.compareAdminSharedConflict();
 let html=h.app.adminSharedStatusHtml();assert.match(html,/Your unsaved values/);assert.match(html,/Latest saved values/);assert.match(html,/My private name/);assert.match(html,/Synthetic rider/);
 conflict=false;await h.app.reapplyAdminSharedConflict();const calls=h.calls.filter(c=>c.name==='ride_admin_shared_mutate');assert.equal(calls.length,2);assert.notEqual(calls[0].args.p_operation.operationId,calls[1].args.p_operation.operationId);assert.equal(calls[1].args.p_operation.payload.name,'My private name');await h.app.signOutAdmin();
});
test('opening image resolves known default only and renders full frame',async()=>{
 const h=await appHarness();h.app.state.appSettings={homeCoverUrl:'assets/home-car.png'};assert.equal(h.app.activeRideBranding().coverSrc,'assets/home-car-2026-10-01.png');
 h.app.state.appSettings={homeCoverUrl:'https://example.test/custom.png'};assert.equal(h.app.activeRideBranding().coverSrc,'https://example.test/custom.png');
 h.app.state.appSettings={};assert.equal(h.app.activeRideBranding().coverSrc,'assets/home-car-2026-10-01.png');
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');assert.match(html,/\.home-art\.event-cover img\s*\{[^}]*object-fit: contain/);
});
test('recovery candidates are explicitly reviewed, baseline fenced and imported draft only',async()=>{
 const candidate={id:'00000000-0000-4000-8000-000000000099',actorKey:'profile:a',planDate:date,baselinePublishedRevision:0,source:'server',candidate:{stops:[{name:'Recovered synthetic'}]}};
 const h=await appHarness(name=>name==='ride_admin_shared_recovery'?{ok:true,candidates:[candidate,{...candidate,id:'unknown',baselinePublishedRevision:null}]}:undefined);await h.start();assert.equal(typeof h.app.loadAdminSharedRecovery,'function');await h.app.loadAdminSharedRecovery();
 assert.match(h.app.adminSharedStatusHtml(),/Recovered synthetic/);await h.app.importAdminSharedRecovery('unknown');assert.equal(h.calls.some(c=>c.name==='ride_admin_shared_import'),false);
 await h.app.importAdminSharedRecovery(candidate.id);const call=h.calls.find(c=>c.name==='ride_admin_shared_import');assert.equal(call.args.p_expected_draft_revision,3);assert.equal(call.args.p_expected_baseline_revision,0);assert.equal(h.calls.some(c=>c.name==='ride_admin_shared_publish'),false);await h.app.signOutAdmin();
});

test('review does not navigate away from personal unsaved input',async()=>{
 const h=await appHarness();await h.start();h.app.state.view='adminEdit';const c=h.app.state.adminShared;c.personalDirty=true;c.personalForm={name:'Private input'};
 await h.app.reviewAdminShared();assert.equal(h.app.state.view,'adminEdit');assert.equal(c.review,null);await h.app.signOutAdmin();
});
test('custom cover retains its natural aspect rather than forcing a cropped frame',async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');assert.match(html,/\.home-art\.event-cover\s*\{[^}]*aspect-ratio: auto/);
});

test('conflict comparison uses readable labels and excludes internal identity/version metadata',async()=>{
 const h=await appHarness(name=>name==='ride_admin_shared_mutate'?{ok:false,code:'conflict'}:undefined);await h.start();const c=h.app.state.adminShared;
 await h.app.saveAdminDraftFromForm({dataset:{sharedSnapshot:JSON.stringify(c.snapshot)},values:{...c.snapshot.riders[0],name:'My reviewed name'}});await h.app.compareAdminSharedConflict();
 const html=h.app.adminSharedStatusHtml();assert.match(html,/Rider name: My reviewed name/);assert.match(html,/Assigned driver: Synthetic/);assert.doesNotMatch(html,/entityVersion|personVersion|driverSlug|00000000-0000-4000-8000-000000000002/);await h.app.signOutAdmin();
});

test('incoming shared state updates existing header counts without replacing the editor',async()=>{
 const h=await appHarness();await h.start();const c=h.app.state.adminShared;h.app.state.view='adminEdit';
 const counters=['drivers','riders','changes'].map(tab=>{const el={textContent:'old'};h.elements.set(`[data-admin-tab="${tab}"] strong`,el);return el;});
 h.app.applyAdminSharedState(c,{status:'saved',snapshot:{...c.snapshot,draftRevision:4,eventCursor:20,riders:[...c.snapshot.riders,{...c.snapshot.riders[0],id:'00000000-0000-4000-8000-000000000003'}]}});
 assert.equal(counters[0].textContent,'1');assert.equal(counters[1].textContent,'2');assert.notEqual(counters[2].textContent,'old');assert.equal(h.app.state.view,'adminEdit');await h.app.signOutAdmin();
});

test('incoming refresh keeps an open quick-move form and its captured destination',async()=>{
 const h=await appHarness();await h.start();const c=h.app.state.adminShared;h.app.state.view='admin';const region={innerHTML:'open move form with chosen destination',querySelector:()=>({open:true})};h.elements.set('[data-shared-route-content]',region);
 h.app.applyAdminSharedState(c,{status:'saved',snapshot:{...c.snapshot,draftRevision:4,eventCursor:20}});
 assert.equal(region.innerHTML,'open move form with chosen destination');await h.app.signOutAdmin();
});

test('stale quick-move keeps captured group versions and exposes conflict',async()=>{
 const h=await appHarness(name=>name==='ride_admin_shared_mutate'?{ok:false,code:'conflict'}:undefined);await h.start();const c=h.app.state.adminShared;const captured={...c.snapshot,groupVersions:{...c.snapshot.groupVersions,b:2}};c.snapshot={...c.snapshot,groupVersions:{a:4,b:3}};
 await h.app.quickMoveAdminShared(captured.riders[0].id,'b',captured);
 const op=h.calls.find(call=>call.name==='ride_admin_shared_mutate').args.p_operation;assert.equal(op.expectedGroupVersions.a,3);assert.equal(op.expectedGroupVersions.b,2);assert.equal(c.secondaryConflict.code,'conflict');assert.ok(c.conflictRequest);await h.app.signOutAdmin();
});
