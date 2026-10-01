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
