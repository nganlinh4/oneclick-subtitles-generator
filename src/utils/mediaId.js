/**
 * @deprecated Media identity is asynchronous on desktop because it must intersect the active
 * project revision, durable alias owner, and native playback session. Callers that need authority
 * must await `resolveActiveNativeMedia`; a synchronous browser-storage guess deliberately returns
 * no identity instead of crossing projects.
 */
export const getCurrentMediaId = () => null;
