// Bounded, capability-free failure text and out-of-WebView verification of the opaque playback
// capability's bytes. Shared by every installed-application inspector.

import crypto from 'node:crypto';

import {
  CAPABILITY_READ_TIMEOUT_MS,
  EXPECTED_FIXTURE_BYTES,
  PLAYBACK_URL,
  invariant,
} from './shared.mjs';

export function sanitizeInspectorError(error, fallback = 'Installed media flow failed') {
  const raw = error instanceof Error && typeof error.message === 'string'
    ? error.message
    : fallback;
  const sanitized = raw
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, '<redacted-url>')
    .replace(/(['"])(?:[A-Za-z]:[\\/]|\\\\|file:(?:\/\/)?|\/(?:Users|home|tmp|var|private|mnt|opt|Volumes)(?:\/|$))[^'"]*\1/giu,
      '<redacted-path>')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|file:(?:\/\/)?)[^\s"'<>]+/giu, '<redacted-path>')
    .replace(/\/(?:Users|home|tmp|var|private|mnt|opt|Volumes)(?:\/[^\s"'<>]*)?/gu,
      '<redacted-path>')
    .replace(/\b(?:127\.0\.0\.1|localhost)\b/giu, '<redacted-host>')
    .replace(/\b(?:currentFileUrl|playbackUrl|token)\b/giu, 'capability')
    .replace(/\b[0-9a-f]{64}\b/giu, '<redacted-capability>')
    .slice(0, 2_048);
  return sanitized.length > 0 ? sanitized : fallback;
}

export async function readPlaybackCapability(playbackUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = CAPABILITY_READ_TIMEOUT_MS,
} = {}) {
  const playback = typeof playbackUrl === 'string' ? PLAYBACK_URL.exec(playbackUrl) : null;
  invariant(playback !== null && Number(playback[1]) >= 1 && Number(playback[1]) <= 65_535,
    'Installed playback capability is invalid');
  invariant(typeof fetchImpl === 'function'
    && Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= CAPABILITY_READ_TIMEOUT_MS,
  'Installed playback capability reader is invalid');

  try {
    const response = await fetchImpl(playbackUrl, {
      cache: 'no-store',
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response?.ok !== true || response.status !== 200
        || response.headers?.get?.('content-type')?.split(';', 1)[0] !== 'video/mp4') {
      throw new Error('response');
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && declaredLength !== String(EXPECTED_FIXTURE_BYTES)) {
      throw new Error('length');
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
      throw new Error('body');
    }

    const hash = crypto.createHash('sha256');
    const reader = response.body.getReader();
    let byteLength = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error('chunk');
      byteLength += chunk.value.byteLength;
      if (byteLength > EXPECTED_FIXTURE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('oversize');
      }
      hash.update(chunk.value);
    }
    if (byteLength !== EXPECTED_FIXTURE_BYTES) throw new Error('truncated');
    return Object.freeze({ byteLength, sha256: hash.digest('hex') });
  } catch {
    throw new Error('Installed playback capability could not be verified');
  }
}
