// Accessor-free envelopes of native job Channel messages, read before full normalization.

const JOB_ENVELOPE_KEYS = Object.freeze(['id', 'kind', 'state', 'progress', 'sequence']);

/**
 * Snapshot helpers for one job Channel. The identity (`id` + `state`) is recovered even from an
 * otherwise invalid envelope, so the service can still cancel the job it owns after a protocol
 * fault; `valid` says whether the full envelope may proceed to normalization.
 */
export const createChannelEnvelopeSnapshots = ({ eventKeys, isJobId, jobKind, jobStates }) => {
  const snapshotJobEnvelope = (value) => {
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      const id = descriptors.id;
      const kind = descriptors.kind;
      const state = descriptors.state;
      const identity = !id || !kind || !state
          || !Object.hasOwn(id, 'value') || !Object.hasOwn(kind, 'value')
          || !Object.hasOwn(state, 'value')
          || id.enumerable !== true || kind.enumerable !== true || state.enumerable !== true
          || !isJobId(id.value)
          || kind.value !== jobKind
          || !jobStates.has(state.value)
        ? null
        : Object.freeze({ id: id.value, state: state.value });
      const valid = keys.length === JOB_ENVELOPE_KEYS.length
        && keys.every((key) => typeof key === 'string' && JOB_ENVELOPE_KEYS.includes(key))
        && JOB_ENVELOPE_KEYS.every((key) => {
          const descriptor = descriptors[key];
          return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
        });
      const snapshot = {};
      for (const key of JOB_ENVELOPE_KEYS) {
        const descriptor = descriptors[key];
        if (descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true) {
          snapshot[key] = descriptor.value;
        }
      }
      return Object.freeze({ value: Object.freeze(snapshot), identity, valid });
    } catch {
      return null;
    }
  };

  const snapshotEventEnvelope = (value) => {
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      let valid = keys.every((key) => typeof key === 'string'
        && eventKeys.includes(key));
      const snapshot = {};
      for (const key of eventKeys) {
        const descriptor = descriptors[key];
        if (descriptor === undefined) continue;
        if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
          valid = false;
          continue;
        }
        snapshot[key] = descriptor.value;
      }
      const jobEnvelope = Object.hasOwn(snapshot, 'job') && snapshot.job !== null
        ? snapshotJobEnvelope(snapshot.job)
        : null;
      if (jobEnvelope !== null) snapshot.job = jobEnvelope.value;
      if (Object.hasOwn(snapshot, 'job') && snapshot.job !== null
          && (jobEnvelope === null || !jobEnvelope.valid)) {
        valid = false;
      }
      return Object.freeze({
        value: Object.freeze(snapshot),
        identity: jobEnvelope?.identity ?? null,
        valid,
      });
    } catch {
      return null;
    }
  };

  return Object.freeze({ snapshotEventEnvelope, snapshotJobEnvelope });
};
