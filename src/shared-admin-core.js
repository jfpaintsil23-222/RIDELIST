// Pure client contracts. The server remains authoritative for every revision.
export function recoveryKey({ actorId, planDate, baselinePublishedRevision }) {
  if (!actorId || !planDate || !Number.isSafeInteger(baselinePublishedRevision) || baselinePublishedRevision < 0) {
    throw new TypeError('Verified actor, plan date, and known baseline are required');
  }
  return ['ride-recovery-v2', actorId, planDate, baselinePublishedRevision]
    .map(part => encodeURIComponent(String(part))).join(':');
}

export function compareRecovery(candidate, snapshot) {
  if (!candidate || candidate.ownerReviewRequired
    || (candidate.actorId && candidate.actorKey && candidate.actorId !== candidate.actorKey)
    || !((candidate.actorKey || candidate.actorId))) {
    return { status: 'ownership_review', canImport: false };
  }
  if (!snapshot || (snapshot.actorKey && snapshot.actorId && snapshot.actorKey !== snapshot.actorId)
    || (candidate.actorKey || candidate.actorId) !== (snapshot.actorKey || snapshot.actorId)) {
    return { status: 'ownership_review', canImport: false };
  }
  if (candidate.planDate && candidate.planDate !== snapshot?.planDate) return { status: 'plan_conflict', canImport: false };
  if (candidate.baselinePublishedRevision == null) return { status: 'unknown_baseline', canImport: false };
  if (candidate.baselinePublishedRevision !== snapshot.baselinePublishedRevision) {
    return { status: 'baseline_conflict', canImport: false };
  }
  return { status: 'review_required', canImport: true, expectedDraftRevision: snapshot.draftRevision,
    expectedBaselinePublishedRevision: snapshot.baselinePublishedRevision };
}

export function reconcileSnapshot(current, incoming, { actorId, planDate, requestGeneration, personalForms } = {}) {
  if (!incoming || !actorId || !planDate || incoming.planDate !== planDate
    || (incoming.actorKey && incoming.actorKey !== actorId)
    || (incoming.actorId && incoming.actorId !== actorId)
    || incoming.ok === false) return current;
  if (!current) return { ...incoming, actorId, planDate, requestGeneration, personalForms };
  if (current.actorId !== actorId || current.planDate !== planDate
    || current.requestGeneration !== requestGeneration
    || (Number.isSafeInteger(current.draftRevision)
      && Number.isSafeInteger(incoming.draftRevision) && incoming.draftRevision < current.draftRevision)
    || (Number.isSafeInteger(current.eventCursor) && Number.isSafeInteger(incoming.eventCursor)
      && incoming.eventCursor < current.eventCursor)) return current;
  return { ...current, ...incoming, actorId, planDate, requestGeneration, personalForms };
}

// Only a selected protected People Bank record can establish a master dependency.
// Unknown legacy links remain unknown; names/phones are never identity evidence.
export function personDependency(person) {
  if (!person?.id) return { personId: null, personVersion: null };
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(person.id)) throw new TypeError('Stable person UUID required');
  if (!Number.isSafeInteger(person.recordVersion) || person.recordVersion < 1) throw new TypeError('Known person record version required');
  return { personId: person.id, personVersion: person.recordVersion };
}

export function mergeSecondary(current={}, incoming={}) {
  const records=new Map((current.people || []).map(person=>[person.id,person]));
  for(const person of incoming.people || []) {
    if(!records.has(person.id) || person.recordVersion >= records.get(person.id).recordVersion) records.set(person.id,person);
  }
  const branding=(incoming.brandingVersion || 0) >= (current.brandingVersion || 0) ? incoming : current;
  return {...current,...incoming,people:[...records.values()],brandingVersion:branding.brandingVersion,branding:branding.branding};
}

export function riderOperation(snapshot, rider, action, operationId, newEntityId) {
  if(!snapshot || !operationId) throw new TypeError('Captured workspace and operation ID required');
  const before=snapshot.riders.find(item=>item.id===rider.id);
  let kind=action==='remove'?'rider_remove':before?'rider_update':'rider_add';
  const fields=['personId','personVersion','driverSlug','stopOrder','name','phone','address','area','pickupTime','readyBy','routeLabel','notes'];
  let payload=Object.fromEntries(fields.filter(key=>rider[key]!==undefined).map(key=>[key,rider[key]]));
  const groups=new Set([before?.driverSlug || rider.driverSlug || '']);
  if(action==='remove') payload={};
  else if(before && before.driverSlug!==rider.driverSlug) {
    if(fields.filter(key=>!['driverSlug','stopOrder'].includes(key)).some(key=>(before[key]??'')!==(rider[key]??''))) {
      throw new TypeError('Save contact edits and driver moves separately. Your input is preserved.');
    }
    kind='rider_move'; payload={driverSlug:rider.driverSlug,stopOrder:rider.stopOrder};groups.add(rider.driverSlug || '');
  } else if(before) {
    // Ordinary field edits depend on this rider, not unrelated riders' route order.
    delete payload.driverSlug;
    if(payload.stopOrder===undefined || Number(payload.stopOrder)===Number(before.stopOrder)) {
      delete payload.stopOrder;
      groups.clear();
    }
  }
  return {operationId,planDate:snapshot.planDate,kind,entityId:before?.id || newEntityId,
    expectedEntityVersion:before?.entityVersion || 0,expectedBaselinePublishedRevision:snapshot.baselinePublishedRevision,
    expectedGroupVersions:Object.fromEntries([...groups].map(key=>[key,snapshot.groupVersions[key] || 0])),payload};
}
