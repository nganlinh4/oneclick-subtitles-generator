// Shared tool catalog/status fixtures and a service factory for the nativeDownloadPreflight suites.
import { v7 as uuidv7 } from 'uuid';
import { vi } from 'vitest';

import { createNativeDownloadPreflight } from './nativeDownloadPreflight';

export const catalog = () => ({
  schemaVersion: 1,
  tools: [
    { id: 'media-tools', label: 'FFmpeg and FFprobe', license: 'GPL-3.0-or-later' },
    { id: 'yt-dlp', label: 'yt-dlp', license: 'GPL-3.0-or-later' },
    { id: 'deno', label: 'Deno', license: 'MIT' },
  ],
});

const statusEntry = (id, overrides = {}) => ({
  id,
  label: id === 'deno' ? 'Deno' : id,
  deliveryAvailable: true,
  installed: false,
  state: 'missing',
  version: null,
  availableVersion: id === 'yt-dlp'
    ? '2026.07.04'
    : id === 'deno' ? '2.9.5' : '8.1.2',
  installedBytes: 0,
  activeRuntime: false,
  pendingRemoval: false,
  restartRequired: false,
  operation: null,
  ...overrides,
});

export const status = (overrides = {}) => ({
  schemaVersion: 1,
  tools: [
    statusEntry('media-tools', overrides['media-tools']),
    statusEntry('yt-dlp', overrides['yt-dlp']),
    statusEntry('deno', overrides.deno),
  ],
});

export const readyStatus = () => status({
  'media-tools': {
    installed: true, state: 'installed', version: '8.1.2', installedBytes: 10,
    activeRuntime: true,
  },
  'yt-dlp': {
    installed: true, state: 'installed', version: '2026.07.04', installedBytes: 10,
    activeRuntime: true,
  },
  deno: {
    installed: true, state: 'installed', version: '2.9.5', installedBytes: 10,
    activeRuntime: true,
  },
});

export const runningJob = () => ({
  id: uuidv7(),
  kind: 'installEngine',
  state: 'running',
  progress: { basisPoints: 0 },
  sequence: 1,
});

export const completedEvent = (tool, id, overrides = {}) => ({
  event: 'completed',
  job: {
    id,
    kind: 'installEngine',
    state: 'succeeded',
    progress: { basisPoints: 10_000 },
    sequence: 2,
  },
  tool,
  action: 'install',
  restartRequired: false,
  deferred: false,
  ...overrides,
});

export const presentation = () => ({
  notify: vi.fn(),
  dismiss: vi.fn(),
});

export const translate = (key, values = {}) => [key, values.tools, values.tool, values.percent]
  .filter((value) => value !== undefined)
  .join('|');

export const service = (overrides = {}) => createNativeDownloadPreflight({
  readCatalog: vi.fn(async () => catalog()),
  readStatus: vi.fn(async () => status()),
  install: vi.fn(),
  presentation: presentation(),
  t: translate,
  ...overrides,
});
