// Shared IDs, snapshot builders and a native alias-command emulator for subtitleProjectStore tests.

import { vi } from 'vitest';
import { createSubtitleProjectStore, MAX_SUBTITLE_PROJECT_ALIASES, SUBTITLE_CACHE_TRACK_LABEL } from './subtitleProjectStore';
import { replaceLegacySubtitleTrack } from './projectSnapshotAdapter';

export const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000201';
export const TRACK_ID = '01890f39-7b62-7c4e-8c9a-000000000202';
export const CUE_ID = '01890f39-7b62-7c4e-8c9a-000000000203';

export const snapshot = (stateVersion = 0, tracks = []) => ({
  metadata: { id: PROJECT_ID, name: 'cache-id' },
  stateVersion,
  media: [],
  tracks,
});

export const track = () => ({
  id: TRACK_ID,
  label: SUBTITLE_CACHE_TRACK_LABEL,
  origin: 'legacyJson',
  cues: [{
    id: CUE_ID,
    ordinal: 1,
    startMs: 1_250,
    endMs: 2_500,
    text: 'Stored',
    sourceId: null,
  }],
});

export const existingIndex = () => ({
  schemaVersion: 1,
  activeCacheId: 'cache-id',
  entries: [{ cacheId: 'cache-id', projectId: PROJECT_ID, lastOpenedAt: 100 }],
});

export const snapshotWithRows = (stateVersion, rows) => replaceLegacySubtitleTrack(
  snapshot(stateVersion),
  rows,
  { label: SUBTITLE_CACHE_TRACK_LABEL }
);

const emulateNativeAliasCommands = (legacyInvoke) => {
  let current = null;
  const ensureCurrent = async () => {
    if (current !== null) return current;
    const raw = await legacyInvoke('subtitle_project_index_get', {});
    if (typeof raw === 'string') {
      try { current = JSON.parse(raw); } catch { current = null; }
    } else current = raw;
    if (!current?.entries) current = { schemaVersion: 1, activeCacheId: null, entries: [] };
    current = structuredClone(current);
    return current;
  };
  return vi.fn(async (command, payload) => {
    if (command === 'subtitle_project_index_get') return ensureCurrent();
    if (command === 'subtitle_project_alias_activate') {
      const index = await ensureCurrent();
      const { entry } = payload;
      index.entries = index.entries.filter(candidate => (
        candidate.cacheId !== entry.cacheId && candidate.projectId !== entry.projectId
      ));
      index.entries.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
      index.entries = index.entries.slice(0, MAX_SUBTITLE_PROJECT_ALIASES - 1);
      index.entries.push({ ...entry });
      index.entries.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
      index.activeCacheId = entry.cacheId;
      await legacyInvoke('subtitle_project_index_set', { index: structuredClone(index) });
      return structuredClone(index);
    }
    if (command === 'subtitle_project_alias_remove') {
      const index = await ensureCurrent();
      const before = index.entries.length;
      index.entries = index.entries.filter(entry => (
        entry.cacheId !== payload.cacheId || entry.projectId !== payload.expectedProjectId
      ));
      const changed = index.entries.length !== before;
      if (changed && index.activeCacheId === payload.cacheId) index.activeCacheId = null;
      if (changed) {
        await legacyInvoke('subtitle_project_index_set', { index: structuredClone(index) });
      }
      return { changed, index: structuredClone(index) };
    }
    return legacyInvoke(command, payload);
  });
};

export const createTestStore = (options) => createSubtitleProjectStore({
  ...options,
  invokeCommand: emulateNativeAliasCommands(options.invokeCommand),
});
