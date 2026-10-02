import test from 'node:test';
import assert from 'node:assert/strict';
const mod = await import('../src/shared-admin-sync.js').catch(() => ({}));
const settle = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; };
function harness(overrides={}) {
  assert.equal(typeof mod.createAdminSync,'function','sync controller must exist');
  let now=0, next=0; const timers=new Map(), states=[], calls=[];
  const source = key => ({ value:true, isVisible(){return this.value;}, isOnline(){return this.value;}, subscribe(fn){this.listener=fn;return ()=>this.listener=null;}, set(value){this.value=value;this.listener?.(key);} });
  const visibility=source('visibility'), network=source('network');
  const snapshot={ok:true,planDate:'2026-10-04',draftRevision:1,eventCursor:7,publishedRevision:0,baselinePublishedRevision:0,settingsVersion:1,writeMode:'shared',riders:[]};
  const clock={setTimeout(fn,delay){timers.set(++next,{fn,at:now+delay});return next;},clearTimeout(id){timers.delete(id);}};
  const ctrl=mod.createAdminSync({clock,random:()=>0,visibility,network,onState:s=>states.push(s),
    fetchContext:async()=>{calls.push('context');return {...snapshot,actorKey:'a'};},fetchSnapshot:async()=>{calls.push('snapshot');return snapshot;},getOperationResult:async()=>({ok:false,code:'not_found'}),...overrides});
  return {ctrl,states,calls,visibility,network,snapshot,timers, async tick(ms){now+=ms;for(const [id,t] of [...timers]) if(t.at<=now){timers.delete(id);t.fn();}await settle();}, async start(){ctrl.start({actorId:'a',planDate:snapshot.planDate});await settle();}, delay(){return [...timers.values()][0]?.at-now;}};
}
test('polls_after_3000ms; metadata_unchanged_skips_details',async()=>{const h=harness();await h.start();assert.deepEqual(h.calls,['context','snapshot']);await h.tick(2999);assert.equal(h.calls.length,2);await h.tick(1);assert.deepEqual(h.calls,['context','snapshot','context']);});
test('single_inflight; completion based delay and immediate coalescing',async()=>{const d=deferred();let count=0;const h=harness({fetchContext:async()=>{count++;return d.promise;}});h.ctrl.start({actorId:'a',planDate:h.snapshot.planDate});await h.tick(9000);h.ctrl.refresh('focus');h.ctrl.refresh('reconnect');assert.equal(count,1);d.resolve({...h.snapshot,actorKey:'a'});await settle();assert.equal(count,2);assert.equal(h.delay(),3000);});
test('hidden_offline_pause; focus_reconnect_refresh',async()=>{const h=harness();await h.start();h.visibility.set(false);await h.tick(10000);assert.equal(h.calls.length,2);h.visibility.set(true);await settle();assert.equal(h.calls.length,3);h.network.set(false);await h.tick(10000);assert.equal(h.calls.length,3);h.network.set(true);await settle();assert.equal(h.calls.length,4);});
test('backoff_6000_12000_24000_30000_with_jitter; success_resets_interval',async()=>{let fail=true;const h=harness({random:()=>1,fetchContext:async()=>{if(fail)throw Error('offline');return {...h.snapshot,actorKey:'a'};}});await h.start();for(const delay of [7200,14400,28800,30000,30000]){assert.equal(h.delay(),delay);await h.tick(delay);}fail=false;await h.tick(30000);assert.equal(h.delay(),3000);});
test('expired_auth_stops and removes private snapshot',async()=>{let valid=true;const h=harness({fetchContext:async()=>valid?{...h.snapshot,actorKey:'a'}:{ok:false,code:'invalid_admin_code'}});await h.start();valid=false;await h.tick(3000);assert.equal(h.states.at(-1).status,'locked');assert.equal(h.states.at(-1).snapshot,null);assert.equal(h.timers.size,0);});
test('stale_request_ignored across actor/plan changes, still only one in flight',async()=>{const d=deferred();let count=0;const h=harness({fetchContext:async(scope)=>{count++;return count===1?d.promise:{...h.snapshot,actorKey:scope.actorId,planDate:scope.planDate};},fetchSnapshot:async scope=>({...h.snapshot,planDate:scope.planDate})});h.ctrl.start({actorId:'a',planDate:h.snapshot.planDate});h.ctrl.start({actorId:'b',planDate:'2026-10-11'});assert.equal(count,1);d.resolve({...h.snapshot,actorKey:'a'});await settle();assert.equal(count,2);assert.equal(h.states.at(-1).actorId,'b');assert.equal(h.states.at(-1).snapshot.planDate,'2026-10-11');});
test('missed events fetch full detail; noncontiguous event IDs are normal',async()=>{let rev=1,cursor=7;const h=harness({fetchContext:async()=>({...h.snapshot,actorKey:'a',draftRevision:rev,eventCursor:cursor,events:[]}),fetchSnapshot:async()=>{h.calls.push('detail');return {...h.snapshot,draftRevision:rev,eventCursor:cursor};}});await h.start();rev=3;cursor=99;await h.tick(3000);assert.equal(h.states.at(-1).snapshot.draftRevision,3);assert.equal(h.calls.length,2);});
test('uncertain lookup not_found retains original ID/body; old successful result never patches current snapshot',async()=>{let result={ok:false,code:'not_found'};const pending={operationId:'id',args:{body:'original'}};const h=harness({getOperationResult:async()=>result});await h.start();h.ctrl.trackOperation(pending);await settle();assert.equal(h.states.at(-1).pendingOperation,pending);assert.equal(h.states.at(-1).operationResult.code,'not_found');result={ok:true,draftRevision:0};await h.tick(3000);assert.equal(h.states.at(-1).snapshot.draftRevision,1);assert.equal(h.states.at(-1).pendingOperation,null);});
test('coalesced refresh promise resolves only after its queued refresh finishes',async()=>{const first=deferred(),second=deferred();let count=0,done=false;const h=harness({fetchContext:async()=>++count===1?first.promise:second.promise});h.ctrl.start({actorId:'a',planDate:h.snapshot.planDate});const review=h.ctrl.refresh('review').then(()=>done=true);await settle();assert.equal(done,false);first.resolve({...h.snapshot,actorKey:'a'});await settle();assert.equal(done,false);second.resolve({...h.snapshot,actorKey:'a'});await review;assert.equal(done,true);});
test('legacy to shared transition reconciles full snapshot',async()=>{let shared=false;const h=harness({fetchContext:async()=>({...h.snapshot,actorKey:'a',initialized:shared,writeMode:shared?'shared':'legacy'})});await h.start();shared=true;await h.tick(3000);assert.equal(h.states.at(-1).snapshot.writeMode,'shared');assert.deepEqual(h.states.at(-1).snapshot.riders,[]);});
test('lookup completion carries the captured operation ID and cannot settle a newer tracked request', async () => {
  const responseA=deferred(), operationA={operationId:'A'}, operationB={operationId:'B'};
  const h=harness({getOperationResult:async({operationId})=>operationId==='A'?responseA.promise:{ok:false,code:'not_found'}});
  await h.start();
  const first=h.ctrl.trackOperation(operationA);
  await settle();
  const second=h.ctrl.trackOperation(operationB);
  responseA.resolve({ok:true,operationId:'A'});
  await first;await second;
  assert.equal(h.states.at(-1).pendingOperation,operationB);
  assert.equal(h.states.at(-1).operationResultId,'B');
  assert.equal(h.states.at(-1).operationResult.code,'not_found');
});

test('pause and resume refresh write mode without revision changes or replaying a pending operation',async()=>{
  let mode='shared',lookups=0;
  const h=harness({fetchContext:async()=>({...h.snapshot,actorKey:'a',writeMode:mode}),fetchSnapshot:async()=>({...h.snapshot,writeMode:mode}),getOperationResult:async()=>{lookups++;return {ok:false,code:'not_found'};}});
  await h.start();const pending={operationId:'uncertain',args:{name:'Private synthetic input'}};
  await h.ctrl.trackOperation(pending);mode='paused';await h.tick(3000);
  assert.equal(h.states.at(-1).snapshot.writeMode,'paused');assert.equal(h.states.at(-1).pendingOperation,pending);
  mode='shared';await h.ctrl.refresh('focus');assert.equal(h.states.at(-1).snapshot.writeMode,'shared');
  assert.equal(h.states.at(-1).pendingOperation,pending);assert.equal(lookups,3);
});
test('revocation during uncertain operation lookup clears private snapshot and stops all subsequent reads',async()=>{
  let valid=true,contexts=0;
  const h=harness({fetchContext:async()=>{contexts++;return {...h.snapshot,actorKey:'a'};},getOperationResult:async()=>valid?{ok:false,code:'not_found'}:{ok:false,code:'invalid_admin_code'}});
  await h.start();await h.ctrl.trackOperation({operationId:'private-op'});valid=false;
  await h.tick(3000);const locked=h.states.at(-1);assert.equal(locked.status,'locked');assert.equal(locked.snapshot,null);assert.equal(locked.pendingOperation,null);
  const count=contexts;await h.tick(60000);await h.ctrl.refresh('focus');h.network.set(false);h.network.set(true);await settle();
  assert.equal(contexts,count);assert.equal(h.timers.size,0);
});
