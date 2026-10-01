import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryKey, compareRecovery, reconcileSnapshot } from '../src/shared-admin-core.js';
import { recoveryCandidates } from '../src/admin-draft-core.js';

test('recovery key scopes identity, plan and published baseline', () => {
  assert.notEqual(recoveryKey({ actorId:'profile:alpha', planDate:'2099-01-04', baselinePublishedRevision:0 }),
    recoveryKey({ actorId:'profile:beta', planDate:'2099-01-04', baselinePublishedRevision:0 }));
  assert.notEqual(recoveryKey({ actorId:'profile:alpha', planDate:'2099-01-04', baselinePublishedRevision:0 }),
    recoveryKey({ actorId:'profile:alpha', planDate:'2099-01-11', baselinePublishedRevision:0 }));
  assert.notEqual(recoveryKey({ actorId:'profile:alpha', planDate:'2099-01-04', baselinePublishedRevision:0 }),
    recoveryKey({ actorId:'profile:alpha', planDate:'2099-01-04', baselinePublishedRevision:1 }));
});

test('unknown_baseline_is_visible', () => {
  const result = compareRecovery({ actorKey:'profile:alpha', baselinePublishedRevision:null, savedAt:'2099-01-05T00:00:00Z' },
    { planDate:'2099-01-04', actorKey:'profile:alpha', baselinePublishedRevision:0, draftRevision:2 });
  assert.equal(result.status,'unknown_baseline');
  assert.equal(result.canImport,false);
});

test('newest_timestamp_does_not_win', () => {
  const result = compareRecovery({ planDate:'2099-01-04', actorKey:'profile:alpha', baselinePublishedRevision:0,
    savedAt:'2099-01-05T00:00:00Z' }, { planDate:'2099-01-04', actorKey:'profile:alpha', baselinePublishedRevision:1, draftRevision:4 });
  assert.equal(result.status,'baseline_conflict');
  assert.equal(result.canImport,false);
});

test('candidate from another actor cannot be offered for import', () => {
  const result = compareRecovery({ planDate:'2099-01-04', actorKey:'profile:beta', baselinePublishedRevision:0 },
    { planDate:'2099-01-04', actorKey:'profile:alpha', baselinePublishedRevision:0, draftRevision:0 });
  assert.deepEqual(result,{status:'ownership_review',canImport:false});
});

test('candidate needs a verified snapshot actor before import comparison', () => {
  assert.deepEqual(compareRecovery({planDate:'2099-01-04',actorKey:'profile:alpha',baselinePublishedRevision:0},
    {planDate:'2099-01-04',baselinePublishedRevision:0,draftRevision:0}),
  {status:'ownership_review',canImport:false});
});

test('local recovery candidates compose with comparison without leaking ambiguous owners', () => {
  const snapshot={actorKey:'profile:alpha',planDate:'2099-01-04',baselinePublishedRevision:0,draftRevision:2};
  const candidates=recoveryCandidates([
    {actorId:'profile:alpha',planDate:snapshot.planDate,baselinePublishedRevision:0,stops:[{name:'Owned'}]},
    {actorKey:'profile:alpha',planDate:snapshot.planDate,stops:[{name:'Unknown baseline'}]},
    {actorId:'profile:beta',planDate:snapshot.planDate,stops:[{name:'Other secret'}]},
    {actorId:'profile:alpha',actorKey:'profile:beta',planDate:snapshot.planDate,stops:[{name:'Conflicting secret'}]},
    {planDate:snapshot.planDate,stops:[{name:'Unclaimed secret'}]},
  ],{actorId:'profile:alpha',planDate:snapshot.planDate});
  assert.equal(candidates.length,3);
  assert.deepEqual(candidates.map(c=>compareRecovery(c,snapshot).status),
    ['review_required','unknown_baseline','ownership_review']);
  assert.equal(JSON.stringify(candidates).includes('Other secret'),false);
  assert.equal(JSON.stringify(candidates).includes('Conflicting secret'),false);
  assert.equal(JSON.stringify(candidates).includes('Unclaimed secret'),false);
  assert.deepEqual(compareRecovery({actorId:'profile:alpha',actorKey:'profile:beta',planDate:snapshot.planDate,baselinePublishedRevision:0},snapshot),
    {status:'ownership_review',canImport:false});
  assert.deepEqual(compareRecovery(candidates[0],{...snapshot,actorId:'profile:beta'}),
    {status:'ownership_review',canImport:false});
});

test('delayed_previous_plan_response_ignored', () => {
  const current = { planDate:'2099-01-11', actorId:'profile:beta', requestGeneration:7, draftRevision:2,
    personalForms:{ name:'Unsaved synthetic rider' } };
  const previous = reconcileSnapshot(current,{ planDate:'2099-01-04', draftRevision:99 },
    { actorId:'profile:beta', planDate:'2099-01-11', requestGeneration:7, personalForms:current.personalForms });
  assert.equal(previous,current);
  const stale = reconcileSnapshot(current,{ planDate:'2099-01-11', draftRevision:99 },
    { actorId:'profile:beta', planDate:'2099-01-11', requestGeneration:6, personalForms:current.personalForms });
  assert.equal(stale,current);
});

test('reconcile preserves personal form and rejects older revision', () => {
  const form = { name:'Private local text' };
  const current = { actorId:'profile:alpha', planDate:'2099-01-04', requestGeneration:3, draftRevision:4, personalForms:form };
  assert.equal(reconcileSnapshot(current,{planDate:'2099-01-04',draftRevision:3},
    {actorId:'profile:alpha',planDate:'2099-01-04',requestGeneration:3,personalForms:form}),current);
  const result = reconcileSnapshot(current,{planDate:'2099-01-04',draftRevision:5,riders:[]},
    {actorId:'profile:alpha',planDate:'2099-01-04',requestGeneration:3,personalForms:form});
  assert.equal(result.personalForms,form);
  assert.equal(result.draftRevision,5);
});

test('reconcile rejects a previous actor response even on the same plan and generation', () => {
  const current={actorId:'profile:alpha',planDate:'2099-01-04',requestGeneration:3,draftRevision:0,personalForms:{name:'Keep'}};
  assert.equal(reconcileSnapshot(current,{planDate:'2099-01-04',actorKey:'profile:beta',draftRevision:1,riders:[{name:'Private beta'}]},
    {actorId:'profile:alpha',planDate:'2099-01-04',requestGeneration:3,personalForms:current.personalForms}),current);
});

test('reconcile initializes the first matching snapshot with private form intact', () => {
  const form={name:'Unsaved rider'};
  const result=reconcileSnapshot(null,{planDate:'2099-01-04',draftRevision:0,riders:[]},
    {actorId:'profile:alpha',planDate:'2099-01-04',requestGeneration:8,personalForms:form});
  assert.equal(result.actorId,'profile:alpha');
  assert.equal(result.requestGeneration,8);
  assert.equal(result.personalForms,form);
});

test('explicit person dependency never infers a master from name alone', async () => {
  const core=await import('../src/shared-admin-core.js');
  assert.equal(typeof core.personDependency,'function');
  assert.deepEqual(core.personDependency({name:'Same Name'}),{personId:null,personVersion:null});
  assert.deepEqual(core.personDependency({id:'00000000-0000-0000-0000-000000000001',recordVersion:4}),{personId:'00000000-0000-0000-0000-000000000001',personVersion:4});
  assert.throws(()=>core.personDependency({id:'00000000-0000-0000-0000-000000000001'}),/version/);
});

test('rider operation uses captured versions and group dependencies; rejects combined move/edit', async()=>{
  const core=await import('../src/shared-admin-core.js'); assert.equal(typeof core.riderOperation,'function');
  const base={planDate:'2099-01-04',baselinePublishedRevision:3,groupVersions:{a:4,b:2},riders:[{id:'r',entityVersion:7,driverSlug:'a',name:'Before',stopOrder:1}]};
  const op=core.riderOperation(base,{...base.riders[0],name:'After'},'save','operation');
  assert.equal(op.kind,'rider_update');assert.equal(op.expectedEntityVersion,7);assert.deepEqual(op.expectedGroupVersions,{a:4});
  const move=core.riderOperation(base,{...base.riders[0],driverSlug:'b'},'save','move');assert.equal(move.kind,'rider_move');assert.deepEqual(move.expectedGroupVersions,{a:4,b:2});
  assert.throws(()=>core.riderOperation(base,{...base.riders[0],driverSlug:'b',name:'After'},'save','bad'),/separately/);
  const remove=core.riderOperation(base,base.riders[0],'remove','rm');assert.deepEqual(remove.payload,{});
});
test('secondary hydration never rolls back a newer person or branding version', async()=>{
  const core=await import('../src/shared-admin-core.js');assert.equal(typeof core.mergeSecondary,'function');
  const merged=core.mergeSecondary({people:[{id:'a',recordVersion:4,name:'new'}],brandingVersion:8,branding:{homeTitle:'new'}},{people:[{id:'a',recordVersion:3,name:'old'},{id:'b',recordVersion:1}],brandingVersion:7,branding:{homeTitle:'old'}});
  assert.equal(merged.people[0].name,'new');assert.equal(merged.people.length,2);assert.equal(merged.branding.homeTitle,'new');
});
