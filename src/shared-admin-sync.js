import { reconcileSnapshot } from './shared-admin-core.js';

// A refresh is a serial authenticated read transaction from the browser's perspective.
// Event IDs are global sequences: revisions/cursors, never cursor+1, detect changes.
export function createAdminSync({ fetchContext, fetchSnapshot, getOperationResult, onState,
  clock = globalThis, random = Math.random, visibility = { isVisible: () => true },
  network = { isOnline: () => true } }) {
  let generation=0, scope=null, timer=null, running=false, inFlight=false, immediate=false;
  let failures=0, snapshot=null, pendingOperation=null, operationResult=null, unsubs=[], waiters=[], queuedReason=null;
  const available = () => visibility.isVisible() && network.isOnline();
  const clearTimer = () => { if(timer!==null) clock.clearTimeout(timer); timer=null; };
  const emit = (status, extra={}) => onState({ ...scope, generation, status, snapshot, pendingOperation, operationResult, ...extra });
  function stop() {
    running=false; generation++; clearTimer(); immediate=false;queuedReason=null;
    waiters.splice(0).forEach(resolve=>resolve());
    unsubs.forEach(fn=>fn?.()); unsubs=[]; snapshot=null; pendingOperation=null; operationResult=null;
  }
  function validate(result) {
    if (!result?.ok) throw Object.assign(new Error(result?.code || 'read_failed'), {code:result?.code});
    if (result.actorKey && result.actorKey!==scope.actorId) throw Object.assign(new Error('invalid_admin_code'),{code:'invalid_admin_code'});
    if (result.planDate && result.planDate!==scope.planDate) throw Error('stale_plan');
    return result;
  }
  async function refresh(reason='manual') {
    if(!running) return;
    clearTimer();
    if(!available()) { emit('reconnecting'); return; }
    if(inFlight) { immediate=true;if(reason==='review' || !queuedReason) queuedReason=reason;return new Promise(resolve=>waiters.push(resolve)); }
    inFlight=true; immediate=false;
    const completedWaiters=waiters.splice(0);
    const requestGeneration=generation, requestScope={...scope};
    const current=()=>running && generation===requestGeneration;
    try {
      if(pendingOperation) {
        const result=await getOperationResult({...requestScope,operationId:pendingOperation.operationId});
        if(!current()) return;
        if(result?.code==='invalid_admin_code') validate(result);
        operationResult=result;
        // not_found can mean the original request is still committing. Retain it.
        if(result && result.code!=='not_found') pendingOperation=null;
      }
      const metadata=await fetchContext({...requestScope,eventCursor:snapshot?.eventCursor || 0});
      if(!current()) return;
      validate(metadata);
      if(metadata.writeMode==='legacy' && !metadata.initialized) snapshot=reconcileSnapshot(null,metadata,{...requestScope,requestGeneration});
      else if(!snapshot || ['draftRevision','publishedRevision','baselinePublishedRevision','eventCursor','settingsVersion','writeMode']
        .some(key=>metadata[key]!==snapshot[key]) || pendingOperation || operationResult || reason==='review') {
        const incoming=await fetchSnapshot(requestScope);
        if(!current()) return;
        validate(incoming);
        snapshot=reconcileSnapshot(snapshot, incoming,{...requestScope,requestGeneration});
      }
      failures=0; emit(available() ? 'saved' : 'reconnecting',{metadata,reason});
      operationResult=null;
    } catch(error) {
      if(!current()) return;
      if(error.code==='invalid_admin_code' || error.status===401 || error.status===403) {
        stop(); emit('locked',{error});
      } else { failures++; emit('reconnecting',{error}); }
    } finally {
      inFlight=false;completedWaiters.forEach(resolve=>resolve());
      if(running) {
        if(immediate || generation!==requestGeneration) { immediate=false;const nextReason=queuedReason || 'coalesced';queuedReason=null;void refresh(nextReason); }
        else if(available()) {
          const base=failures ? Math.min(30000,6000 * 2**Math.min(failures-1,3)) : 3000;
          const delay=failures ? Math.min(30000,base*(1+0.2*Math.max(0,Math.min(1,random())))) : base;
          timer=clock.setTimeout(()=>{timer=null;void refresh('poll');},delay);
        }
      }
    }
  }
  return { stop, refresh,
    start(next) {
      stop(); scope={actorId:next.actorId,planDate:next.planDate}; failures=0; running=true;
      for(const source of [visibility,network]) if(source.subscribe) unsubs.push(source.subscribe(()=>void refresh('resume')));
      return refresh('start');
    },
    trackOperation(operation) { pendingOperation=operation; operationResult=null; return refresh('operation'); }
  };
}
