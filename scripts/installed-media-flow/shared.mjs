// The reviewed fixture, identities, and timeouts of the installed URL media-flow smoke.

// Public video sites reject shared GitHub-runner addresses unpredictably. This repository-owned,
// content-hash-named 4-second MP4 is hosted beside the managed development bundles so the clean
// installed-EXE smoke exercises the same all-sites yt-dlp/FFmpeg publication path deterministically.
// YouTube and other site-specific extractors remain separate real-network acceptance items.
const MEDIA_URL = 'https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4';
const SUBTITLE_MARKER = 'OSG installed media smoke';
const EXPECTED_FIXTURE_BYTES = 366_888;
const EXPECTED_FIXTURE_SHA256 = 'aecf6c8ef3977cd4525261ccadb4086581bd911cb17cc97128cfd8640c6055db';
const EXPECTED_NATIVE_TOOL_IDS = Object.freeze(['deno', 'media-tools', 'yt-dlp']);
const EXPECTED_NATIVE_TOOL_LABELS = Object.freeze({
  deno: 'Deno',
  'media-tools': 'FFmpeg and FFprobe',
  'yt-dlp': 'yt-dlp',
});
const CAPABILITY_READ_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const REVIEWED_TIMEOUT_FAILURE_CODES = Object.freeze([
  'url-tab-timeout',
  'url-stage-timeout',
  'srt-readiness-timeout',
  'download-start-timeout',
  'terminal-state-timeout',
]);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAYBACK_URL = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/asset\/([0-9a-f-]{36})\?token=([0-9a-f]{64})$/i;

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const hasExactKeys = (value, keys) => value && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

export {
  CAPABILITY_READ_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  EXPECTED_FIXTURE_BYTES,
  EXPECTED_FIXTURE_SHA256,
  EXPECTED_NATIVE_TOOL_IDS,
  EXPECTED_NATIVE_TOOL_LABELS,
  MEDIA_URL,
  PLAYBACK_URL,
  REVIEWED_TIMEOUT_FAILURE_CODES,
  SUBTITLE_MARKER,
  UUID_V4,
  UUID_V7,
  hasExactKeys,
  invariant,
};
