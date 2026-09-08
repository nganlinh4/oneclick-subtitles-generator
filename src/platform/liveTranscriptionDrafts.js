// Ephemeral text only: never fed to project persistence, playback, undo, or export.
const listeners = new Set();
const sessions = new Map();
let snapshot = [];
let timer;
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
