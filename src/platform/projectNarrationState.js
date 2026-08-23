import { useSyncExternalStore } from 'react';

import {
  getActiveProjectSnapshot,
  subscribeToActiveProject,
} from './projectService';

const SOURCES = Object.freeze(['original', 'translated', 'grouped']);
const SOURCE_SET = new Set(SOURCES);
const EMPTY_RESULTS = Object.freeze([]);

const emptyResultsBySource = () => Object.freeze({
  original: EMPTY_RESULTS,
  translated: EMPTY_RESULTS,
  grouped: EMPTY_RESULTS,
});

const authorityFrom = (value) => {
  const projectId = value?.projectId ?? value?.metadata?.id;
  const projectStateVersion = value?.projectStateVersion ?? value?.stateVersion;
  if (typeof projectId !== 'string'
      || !Number.isSafeInteger(projectStateVersion)
      || projectStateVersion < 0) return null;
  return Object.freeze({ projectId, projectStateVersion });
};

const createState = (authority = null, overrides = {}) => Object.freeze({
  projectId: authority?.projectId ?? null,
  projectStateVersion: authority?.projectStateVersion ?? null,
  activeSource: 'original',
  resultsBySource: emptyResultsBySource(),
  groupedCues: null,
  ...overrides,
});

let state = createState();
let revision = 0;
let visibleCache = null;
const listeners = new Set();

const invalidateVisible = () => { visibleCache = null; };

const publish = (next) => {
  if (next === state) return false;
  state = next;
  revision += 1;
  invalidateVisible();
  [...listeners].forEach((listener) => listener());
  return true;
};

const activeAuthority = () => authorityFrom(getActiveProjectSnapshot());

const authorityMatches = (left, right) => (
  left !== null
  && right !== null
  && left.projectId === right.projectId
  && left.projectStateVersion === right.projectStateVersion
);

const visibleState = () => {
  const active = activeAuthority();
  const key = `${active?.projectId ?? ''}:${active?.projectStateVersion ?? ''}:${revision}`;
  if (visibleCache?.key === key) return visibleCache.value;
  const stored = authorityFrom(state);
  const value = authorityMatches(active, stored) ? state : createState(active);
  visibleCache = Object.freeze({ key, value });
  return value;
};

const freezeResults = (results) => {
  if (!Array.isArray(results)) throw new TypeError('Narration results must be an array');
  return Object.freeze([...results]);
};

const stateForAuthority = (authority) => {
  const active = activeAuthority();
  if (!authorityMatches(active, authority)) return null;
  return authorityMatches(authorityFrom(state), authority) ? state : createState(authority);
};

export const publishProjectNarrationResults = ({
  projectId,
  projectStateVersion,
  source,
  results,
  activate = true,
}) => {
  const authority = authorityFrom({ projectId, projectStateVersion });
  if (authority === null || !SOURCE_SET.has(source)) {
    throw new TypeError('Exact project narration authority and source are required');
  }
  const base = stateForAuthority(authority);
  if (base === null) return false;
  const nextResults = freezeResults(results);
  return publish(createState(authority, {
    ...base,
    activeSource: activate ? source : base.activeSource,
    resultsBySource: Object.freeze({
      ...base.resultsBySource,
      [source]: nextResults,
    }),
  }));
};

export const publishProjectNarrationGrouping = ({
  projectId,
  projectStateVersion,
  enabled,
  groupedCues,
  baseSource = 'original',
}) => {
  const authority = authorityFrom({ projectId, projectStateVersion });
  if (authority === null || !['original', 'translated'].includes(baseSource)) {
    throw new TypeError('Exact project narration grouping authority is required');
  }
  const base = stateForAuthority(authority);
  if (base === null) return false;
  const cues = enabled === true && Array.isArray(groupedCues)
    ? Object.freeze([...groupedCues])
    : null;
  return publish(createState(authority, {
    ...base,
    activeSource: cues && cues.length > 0 ? 'grouped' : baseSource,
    groupedCues: cues,
  }));
};

export const adoptProjectNarrationAuthority = (project) => {
  const authority = authorityFrom(project);
  if (authorityMatches(authorityFrom(state), authority)) return false;
  return publish(createState(authority));
};

export const clearCurrentProjectNarrationState = () => (
  publish(createState(activeAuthority()))
);

export const getCurrentProjectNarrationState = visibleState;

export const getCurrentProjectNarrationResults = (source = null) => {
  const current = visibleState();
  const selected = source ?? current.activeSource;
  return SOURCE_SET.has(selected) ? current.resultsBySource[selected] : EMPTY_RESULTS;
};

export const getAllCurrentProjectNarrationResults = () => {
  const current = visibleState();
  return Object.freeze(SOURCES.flatMap((source) => current.resultsBySource[source]));
};

export const subscribeToProjectNarrationState = (listener) => {
  if (typeof listener !== 'function') throw new TypeError('A narration subscriber is required');
  listeners.add(listener);
  const unsubscribeProject = subscribeToActiveProject(() => {
    invalidateVisible();
    listener();
  });
  return () => {
    listeners.delete(listener);
    unsubscribeProject();
  };
};

export const useProjectNarrationState = () => useSyncExternalStore(
  subscribeToProjectNarrationState,
  visibleState,
  visibleState,
);
