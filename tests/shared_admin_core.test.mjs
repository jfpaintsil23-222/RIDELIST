import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryKey, compareRecovery, reconcileSnapshot } from '../src/shared-admin-core.js';

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
