import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import { nativeNarrationAlignmentService } from './narrationAlignmentService';
import { getNativeRenderResult, releaseNativeRenderPlayback } from './renderService';
import { getSpeechJobResults } from './speechService';
import {
  acknowledgeJobResult,
  claimJobResult,
  listPendingJobResults,
} from './jobResultDeliveryService';
import {
  ACTIVE_JOB_STATES,
  GEMINI_TASK_JOB_KIND,
  MAX_ASR_DISCARD_PASSES,
  MAX_GEMINI_DISCOVERY_PASSES,
  MAX_PENDING_RESULT_PAGE,
  MAX_RECOVERY_CANDIDATES,
  NativeJobRecoveryUnavailableError,
  isUuidV7,
  matchesPendingDelivery,
  normalizeJob,
  normalizeJobList,
  readRememberedIds,
  recoverableKinds,
  recoveredGeminiMatches,
  responseJob,
  sameOrNewerJob,
  scrubLegacyPayloads,
  storageOrNull,
  unavailableResult,
  writeRememberedIds,
} from './jobRecoverySnapshots';

export {
  LEGACY_NATIVE_JOB_STORAGE_KEYS,
  NATIVE_JOB_IDS_STORAGE_KEY,
} from './jobRecoverySnapshots';

const defaultAdapters = Object.freeze({
  alignNarration: nativeNarrationAlignmentService.getAlignmentResult,
  renderVideo: getNativeRenderResult,
  synthesizeNarration: getSpeechJobResults,
  transcribe: claimJobResult,
  translate: claimJobResult,
  analyzeSubtitles: claimJobResult,
});

export const createNativeJobRecoveryCoordinator = ({
  invokeCommand = invokeDesktop,
  isNativeRuntime = isDesktopRuntime,
  adapters = defaultAdapters,
  releaseRenderPlayback = releaseNativeRenderPlayback,
  pendingResults = (kind = null, afterDeliveryId = null) => listPendingJobResults({
    invokeCommand,
    kind,
    afterDeliveryId,
  }),
  discardAsrResult = (jobId, deliveryId) => acknowledgeJobResult(
    jobId,
    deliveryId,
    { invokeCommand },
  ),
  abandonTranscribe = (jobId) => invokeCommand('job_recovery_abandon_transcribe', { id: jobId }),
  storage: providedStorage,
} = {}) => {
  const storage = storageOrNull(providedStorage);
  const recovered = new Map();
  let started = null;
  let pendingGeminiCursor = null;

  const remember = (jobId) => {
    if (!isUuidV7(jobId)) return false;
    writeRememberedIds(storage, [...readRememberedIds(storage), jobId]);
    return true;
  };

  const forget = (jobId) => {
    if (!isUuidV7(jobId)) return false;
    writeRememberedIds(
      storage,
      readRememberedIds(storage).filter((candidate) => candidate !== jobId),
    );
    return true;
  };

  const releaseEntry = (entry) => {
    if (entry?.job.kind !== 'renderVideo') return;
    const playbackId = entry.value?.result?.playback?.id;
    if (typeof playbackId === 'string') {
      Promise.resolve(releaseRenderPlayback(playbackId)).catch(() => undefined);
    }
  };

  const discard = (jobId) => {
    if (!isUuidV7(jobId)) return false;
    const entry = recovered.get(jobId);
    recovered.delete(jobId);
    forget(jobId);
    releaseEntry(entry);
    return entry !== undefined;
  };

  const claim = (jobId) => {
    if (!isUuidV7(jobId)) return null;
    const entry = recovered.get(jobId) ?? null;
    if (entry === null) return null;
    recovered.delete(jobId);
    forget(jobId);
    return entry;
  };

  const list = (kind = null) => {
    if (kind !== null && !recoverableKinds.has(kind)) return Object.freeze([]);
    return Object.freeze([...recovered.values()]
      .filter((entry) => kind === null || entry.job.kind === kind)
      .sort((left, right) => right.job.id.localeCompare(left.job.id)));
  };

  /**
   * ASR windows form one frontend-owned aggregate, but no durable aggregate journal exists. A
   * process restart therefore destroys the only range-revision capability that could authorize
   * their merge. Replaying even a complete set would be a stale overwrite; retaining them forever
   * would eventually exhaust the bounded pending-result page. Release only exact typed ASR
   * deliveries, in bounded pages, and require the customer to restart inference against a fresh
   * native revision. Other result kinds remain available to their feature-specific consumers.
   */
  const discardOrphanedAsrResults = async () => {
    let discarded = 0;
    const asrJobIds = new Set();
    for (let pass = 0; pass < MAX_ASR_DISCARD_PASSES; pass += 1) {
      let pending;
      try {
        pending = await pendingResults('asrTranscription');
      } catch {
        return { discarded, asrJobIds, unavailable: true };
      }
      if (pending.some(({ kind }) => kind !== 'asrTranscription')) {
        return { discarded, asrJobIds, unavailable: true };
      }
      pending.forEach(({ jobId }) => asrJobIds.add(jobId));
      if (pending.length === 0) return { discarded, asrJobIds, unavailable: false };
      let unavailable = false;
      for (const { jobId, deliveryId } of pending) {
        try {
          await discardAsrResult(jobId, deliveryId);
          forget(jobId);
          discarded += 1;
        } catch {
          // The native row remains the authority and will be rediscovered. Never claim or expose a
          // payload whose exact acknowledgement did not complete.
          remember(jobId);
          unavailable = true;
        }
      }
      if (unavailable) return { discarded, asrJobIds, unavailable: true };
      if (pending.length < MAX_PENDING_RESULT_PAGE) {
        return { discarded, asrJobIds, unavailable: false };
      }
    }
    // A hostile or very old database may contain more than sixteen full pages. Yield after bounded
    // work; `start()` deliberately becomes retryable and the next attempt continues draining.
    return { discarded, asrJobIds, unavailable: true };
  };

  const recoverOne = async (jobId, listedJob, wasRemembered, pendingDelivery) => {
    let rawCurrent;
    try {
      rawCurrent = await invokeCommand('job_get', { id: jobId });
    } catch (error) {
      if (error?.code === 'jobNotFound') {
        forget(jobId);
        return 'discarded';
      }
      if (wasRemembered || pendingDelivery !== undefined) remember(jobId);
      return 'unavailable';
    }
    let current;
    try {
      current = normalizeJob(rawCurrent);
      if (current.id !== jobId
          || (listedJob !== undefined && !sameOrNewerJob(listedJob, current))) {
        throw new Error('mismatched job');
      }
    } catch {
      forget(jobId);
      return 'discarded';
    }
    if (!recoverableKinds.has(current.kind)) {
      forget(current.id);
      return 'discarded';
    }
    if (current.kind === 'transcribe' && pendingDelivery?.kind !== 'geminiText') {
      // An active transcribe has already been terminalized before candidates are built. Without a
      // typed Gemini delivery, this ID cannot be distinguished from local ASR and cannot authorize
      // any replay.
      forget(current.id);
      return 'discarded';
    }
    if (!wasRemembered && pendingDelivery === undefined
        && !ACTIVE_JOB_STATES.has(current.state)) return 'ignored';
    if (['failed', 'cancelled'].includes(current.state)) {
      forget(current.id);
      return 'discarded';
    }

    const adapter = adapters[current.kind];
    if (typeof adapter !== 'function') {
      remember(current.id);
      return 'unavailable';
    }
    let value;
    try {
      value = await adapter(current.id);
    } catch (error) {
      if (error?.code === 'jobNotFound') {
        forget(current.id);
        return 'discarded';
      }
      remember(current.id);
      return 'unavailable';
    }
    let latest;
    try {
      latest = responseJob(value, current);
      if (pendingDelivery !== undefined && !matchesPendingDelivery(value, pendingDelivery)) {
        throw new Error('mismatched delivery');
      }
      if (['failed', 'cancelled'].includes(latest.state)) {
        forget(latest.id);
        return 'discarded';
      }
    } catch {
      forget(current.id);
      return 'discarded';
    }
    // A Gemini delivery is paid provider output. Its native payload carries a request digest and
    // exact project revision, but only the product consumer can parse it and commit the resulting
    // domain change. Retain that capability until the exact request performs its revision-safe
    // commit and acknowledges it.
    const entry = Object.freeze({ job: latest, value, wasRemembered });
    recovered.set(latest.id, entry);
    remember(latest.id);
    return 'recovered';
  };

  const settleOrphanedTranscribes = async (jobs) => {
    const settled = new Map(jobs.map((snapshot) => [snapshot.id, snapshot]));
    const active = jobs.filter((snapshot) => (
      snapshot.kind === 'transcribe' && ACTIVE_JOB_STATES.has(snapshot.state)
    ));
    let discarded = 0;
    let unavailable = false;
    for (const snapshot of active) {
      try {
        const terminal = normalizeJob(await abandonTranscribe(snapshot.id));
        if (terminal.id !== snapshot.id || terminal.kind !== 'transcribe'
            || terminal.sequence < snapshot.sequence) {
          throw new Error('invalid transcription recovery state');
        }
        settled.set(terminal.id, terminal);
        if (terminal.state === 'cancelling') {
          remember(terminal.id);
          unavailable = true;
        } else if (terminal.state !== 'succeeded') {
          forget(terminal.id);
          discarded += 1;
        }
      } catch {
        remember(snapshot.id);
        unavailable = true;
      }
    }
    return {
      jobs: Object.freeze([...settled.values()].sort((left, right) => left.id.localeCompare(right.id))),
      activeCount: active.length,
      discarded,
      unavailable,
      unsettledIds: new Set(active
        .filter(({ id }) => ACTIVE_JOB_STATES.has(settled.get(id)?.state ?? 'running'))
        .map(({ id }) => id)),
    };
  };

  const discoverPendingGeminiResults = async () => {
    const pending = [];
    let afterDeliveryId = pendingGeminiCursor;
    for (let pass = 0; pass < MAX_GEMINI_DISCOVERY_PASSES; pass += 1) {
      let page;
      try {
        page = await pendingResults('geminiText', afterDeliveryId);
      } catch {
        pendingGeminiCursor = afterDeliveryId;
        return { pending: Object.freeze(pending), unavailable: true };
      }
      if (page.some(({ kind }) => kind !== 'geminiText')) {
        return { pending: Object.freeze(pending), unavailable: true };
      }
      pending.push(...page);
      if (page.length < MAX_PENDING_RESULT_PAGE) {
        pendingGeminiCursor = null;
        return { pending: Object.freeze(pending), unavailable: false };
      }
      const next = page.at(-1)?.deliveryId;
      if (!isUuidV7(next) || next === afterDeliveryId) {
        return { pending: Object.freeze(pending), unavailable: true };
      }
      afterDeliveryId = next;
      pendingGeminiCursor = next;
    }
    // Do not memoize recovery while a further page may exist. A later attempt is allowed to retry;
    // ordinary databases never approach this hostile bound.
    return { pending: Object.freeze(pending), unavailable: true };
  };

  const runStartAttempt = async () => {
    scrubLegacyPayloads(storage);
    const initialRemembered = new Set(readRememberedIds(storage));
    if (!isNativeRuntime()) {
      writeRememberedIds(storage, []);
      return unavailableResult(initialRemembered.size);
    }
    const firstCleanup = await discardOrphanedAsrResults();
    let jobs;
    try {
      jobs = await invokeCommand('jobs_list', {}).then(normalizeJobList);
    } catch {
      return unavailableResult(firstCleanup.discarded);
    }
    const settled = await settleOrphanedTranscribes(jobs);
    jobs = settled.jobs;
    const secondCleanup = settled.activeCount > 0
      ? await discardOrphanedAsrResults()
      : { discarded: 0, asrJobIds: new Set(), unavailable: false };
    const geminiDiscovery = await discoverPendingGeminiResults();
    const pending = geminiDiscovery.pending;
    const remembered = new Set(readRememberedIds(storage));
    const byId = new Map(jobs.map((job) => [job.id, job]));
    const pendingById = new Map(pending
      .filter(({ kind }) => kind === 'geminiText')
      .map((header) => [header.jobId, header]));
    const candidateIds = new Set([
      ...remembered,
      ...pendingById.keys(),
      ...jobs.filter((job) => (
        recoverableKinds.has(job.kind) && job.kind !== 'transcribe'
        && ACTIVE_JOB_STATES.has(job.state)
      )).map((job) => job.id),
    ].filter((jobId) => (
      !firstCleanup.asrJobIds.has(jobId)
      && !secondCleanup.asrJobIds.has(jobId)
      && !settled.unsettledIds.has(jobId)
      && !recovered.has(jobId)
    )));
    const nonDeliveryCandidateCount = [...candidateIds]
      .filter((jobId) => !pendingById.has(jobId)).length;
    if (nonDeliveryCandidateCount > MAX_RECOVERY_CANDIDATES) {
      return unavailableResult(
        firstCleanup.discarded + settled.discarded + secondCleanup.discarded,
      );
    }
    let recoveredCount = 0;
    let discardedCount = firstCleanup.discarded + settled.discarded + secondCleanup.discarded;
    let unavailable = firstCleanup.unavailable || settled.unavailable || secondCleanup.unavailable
      || geminiDiscovery.unavailable;
    for (const jobId of [...candidateIds].sort()) {
      const listedJob = byId.get(jobId);
      const outcome = await recoverOne(
        jobId,
        listedJob,
        remembered.has(jobId),
        pendingById.get(jobId),
      );
      if (outcome === 'recovered') recoveredCount += 1;
      if (outcome === 'discarded') discardedCount += 1;
      if (outcome === 'unavailable') unavailable = true;
    }
    return Object.freeze({ recovered: recoveredCount, discarded: discardedCount, unavailable });
  };

  const start = () => {
    if (started !== null) return started;
    const attempt = runStartAttempt().catch(() => unavailableResult());
    started = attempt;
    void attempt.then((result) => {
      if (result.unavailable && started === attempt) started = null;
    }, () => {
      if (started === attempt) started = null;
    });
    return attempt;
  };

  const ensureReady = async () => {
    const result = await start();
    if (result.unavailable) throw new NativeJobRecoveryUnavailableError(result);
    return result;
  };

  const claimGemini = (request) => {
    const jobKind = GEMINI_TASK_JOB_KIND[request?.task];
    if (jobKind === undefined || typeof request?.recoveryKey !== 'string') return null;
    return list(jobKind).find((entry) => recoveredGeminiMatches(entry, request)) ?? null;
  };

  return Object.freeze({
    start,
    ensureReady,
    remember,
    forget,
    list,
    claim,
    claimGemini,
    discard,
  });
};

const nativeJobRecovery = createNativeJobRecoveryCoordinator();

export const startNativeJobRecovery = nativeJobRecovery.start;
export const ensureNativeJobRecoveryReady = nativeJobRecovery.ensureReady;
export const rememberNativeJobId = nativeJobRecovery.remember;
export const forgetNativeJobId = nativeJobRecovery.forget;
export const listRecoveredNativeJobs = nativeJobRecovery.list;
export const claimRecoveredNativeJob = nativeJobRecovery.claim;
export const discardRecoveredNativeJob = nativeJobRecovery.discard;

export const acknowledgeRecoveredNativeJob = async (entry) => {
  const delivery = entry?.value?.delivery;
  if (!entry?.job || !delivery || entry.job.id !== delivery.jobId) {
    throw new Error('The recovered durable job result is invalid');
  }
  await acknowledgeJobResult(entry.job.id, delivery.deliveryId);
  nativeJobRecovery.discard(entry.job.id);
};

/**
 * Transfers an exact paid Gemini result back to the same product request after WebView reload.
 * A changed project revision/request never receives or acknowledges the old provider output.
 */
export const claimRecoveredGeminiJob = (request) => {
  return nativeJobRecovery.claimGemini(request);
};
