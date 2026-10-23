// Shared fixtures for the split project render-scene suites: project ids, scene responses, a
// dependency-injected authority, and the dead-face repair the font-admission tests drive.
import { FONT_READINESS_SCHEMA, FONT_READINESS_STATE } from '../services/fontCapability';

import {
  createProjectRenderSceneAuthority,
  defaultProjectRenderSceneValues,
} from './projectRenderScene';

export const PROJECT_A = '01890f39-7b62-7c4e-8c9a-000000000001';
export const PROJECT_B = '01890f39-7b62-7c4e-8c9a-000000000002';

export const project = (id) => ({ metadata: { id } });
export const values = (overrides = {}) => ({
  ...defaultProjectRenderSceneValues(),
  ...overrides,
});
export const response = (projectId, sceneRevision = 0, scene = values()) => ({
  schemaVersion: 1,
  projectId,
  sceneRevision,
  ...scene,
});
export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

export const authority = (invoke, extras = {}) => createProjectRenderSceneAuthority({
  invoke,
  subscribeProject: () => () => undefined,
  getProject: () => null,
  consumeLegacy: () => null,
  ...(extras.inspectFontAdmission ? { inspectFontAdmission: extras.inspectFontAdmission } : {}),
  ...(extras.subscribeFontCapability
    ? { subscribeFontCapability: extras.subscribeFontCapability }
    : {}),
  schedule: extras.schedule ?? (() => 1),
  cancel: extras.cancel ?? (() => undefined),
  debounceMs: 0,
});

export const deadFontRepair = Object.freeze({
  from: Object.freeze({ fontFamily: "'Dead Face', fantasy", fontWeight: 800 }),
  to: Object.freeze({ fontFamily: "'Google Sans', sans-serif", fontWeight: 400 }),
  reason: 'managedDefault',
});
export const inspectDeadFont = (scene) => (
  scene.customization.fontFamily === deadFontRepair.from.fontFamily
    ? { status: 'repairing', repair: deadFontRepair, resolution: { status: 'unavailable' } }
    : { status: 'ready', repair: null, resolution: { status: 'exact' } }
);

export const fontRecord = (state, extra = {}) => ({
  schema: FONT_READINESS_SCHEMA,
  epoch: 1,
  state,
  family: 'Google Sans',
  version: state === FONT_READINESS_STATE.ready ? 'v22-ui4' : null,
  reason: null,
  retryable: false,
  ...extra,
});
