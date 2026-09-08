// Ephemeral text only: never fed to project persistence, playback, undo, or export.
const listeners = new Set();
const sessions = new Map();
let snapshot = [];
let timer;

const endsSentence = (word) => /[.!?…。！？][\]})"'»”’]*$/u.test(word);

// The provider sends one growing hypothesis. Project it into ordinary readable rows without
// inventing timestamps or persisting speculative text.
export const groupLiveDraftText = (text, { maxWords = 12, maxCharacters = 84 } = {}) => {
  if (typeof text !== 'string') return [];
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const groups = [];
  let current = [];
  for (const word of words) {
    const candidateLength = current.reduce((sum, item) => sum + [...item].length, 0)
      + Math.max(0, current.length - 1) + (current.length ? 1 : 0) + [...word].length;
    if (current.length && (current.length >= maxWords || candidateLength > maxCharacters)) {
      groups.push(current.join(' '));
      current = [];
    }
    current.push(word);
    if (current.length >= 2 && endsSentence(word)) {
      groups.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) groups.push(current.join(' '));
  return groups;
};
const publish = () => {
  clearTimeout(timer); timer = undefined;
  snapshot = [...sessions.values()].flatMap((session) => [...session.windows.entries()]
    .sort(([a], [b]) => a - b).map(([windowIndex, text]) => ({ projectId: session.projectId, windowIndex, text })));
  listeners.forEach((listener) => listener());
};
export const subscribeLiveDrafts = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
export const getLiveDrafts = () => snapshot;
export function beginLiveDrafts(projectId) {
  const token = Symbol();
  const session = { projectId, windows: new Map(), finalized: new Set() };
  sessions.set(token, session);
  return {
    update(index, text) {
      if (!sessions.has(token) || session.finalized.has(index) || !Number.isSafeInteger(index) || index < 0 || index > 10000) return;
      if (typeof text !== 'string' || text.length > 262144) return;
      session.windows.set(index, text);
      if (!timer) timer = setTimeout(publish, 150);
    },
    finalize(index) { session.finalized.add(index); session.windows.delete(index); publish(); },
    dispose() { sessions.delete(token); publish(); },
  };
}
