import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

/**
 * @typedef {Object} TimedWord
 * @property {string} id
 * @property {string} revisionId
 * @property {number} ordinal
 * @property {string} text
 * @property {number} startMs
 * @property {number} endMs
 * @property {string|null} speakerId
 * @property {number|null} confidence
 * @property {string} provenance
 * @property {string} alignmentStatus
 */

/**
 * @typedef {Object} TranscriptTurn
 * @property {string} id
 * @property {string} revisionId
 * @property {number} ordinal
 * @property {string} speakerId
 * @property {number} startMs
 * @property {number} endMs
 * @property {string} text
 * @property {number} startWordOrdinal
 * @property {number} endWordOrdinal
 */

/**
 * @typedef {Object} ProjectTranscript
 * @property {string} [projectId]
 * @property {string} revisionId
 * @property {TimedWord[]} words
 * @property {TranscriptTurn[]} turns
 */

let activeTranscript = null;
const listeners = new Set();

export const createTranscriptData = ({ projectId, revisionId, words = [], turns = [] } = {}) => Object.freeze({
  projectId: projectId || null,
  revisionId: revisionId || null,
  words: Array.isArray(words) ? Object.freeze([...words]) : Object.freeze([]),
  turns: Array.isArray(turns) ? Object.freeze([...turns]) : Object.freeze([]),
});

export const getActiveTranscript = () => activeTranscript;

export const setActiveTranscript = (transcript) => {
  if (!transcript) {
    activeTranscript = null;
  } else {
    activeTranscript = createTranscriptData(transcript);
  }
  listeners.forEach((listener) => {
    try {
      listener(activeTranscript);
    } catch (err) {
      console.error('[transcriptStore] Listener error:', err);
    }
  });
  return activeTranscript;
};

export const clearActiveTranscript = () => {
  setActiveTranscript(null);
};

export const subscribeActiveTranscript = (listener) => {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Durably hydrates the active project's word-native transcript from SQLite.
 *
 * @param {string} projectId
 * @returns {Promise<ProjectTranscript|null>}
 */
export const loadProjectTranscript = async (projectId) => {
  if (!projectId || typeof projectId !== 'string' || !isDesktopRuntime()) {
    return null;
  }
  try {
    const record = await invokeDesktop('project_load_transcript', { id: projectId });
    if (!record) {
      return null;
    }
    const transcript = createTranscriptData({
      projectId: record.projectId || projectId,
      revisionId: record.revisionId,
      words: record.words || [],
      turns: record.turns || [],
    });
    return setActiveTranscript(transcript);
  } catch (err) {
    console.warn('[transcriptStore] Failed to load project transcript:', err);
    return null;
  }
};
