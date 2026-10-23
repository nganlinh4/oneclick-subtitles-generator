/**
 * Binds a background-prompt request to the active desktop project and its state version, so a
 * prompt generated for project A is never applied after the editor switched to project B.
 */
import { getActiveProjectSnapshot } from '../../platform/projectService';

export const capturePromptProjectAuthority = () => {
  const snapshot = getActiveProjectSnapshot();
  const projectId = snapshot?.metadata?.id;
  const expectedProjectStateVersion = snapshot?.stateVersion;
  if (typeof projectId !== 'string'
      || !Number.isSafeInteger(expectedProjectStateVersion)
      || expectedProjectStateVersion < 0) {
    const error = new Error('Open a media project before generating a background prompt.');
    error.code = 'imageProjectUnavailable';
    throw error;
  }
  return Object.freeze({ projectId, expectedProjectStateVersion });
};

export const assertPromptProjectAuthority = (authority) => {
  const current = getActiveProjectSnapshot();
  if (current?.metadata?.id !== authority.projectId
      || current?.stateVersion !== authority.expectedProjectStateVersion) {
    const error = new Error('The active project changed while the prompt was being generated.');
    error.code = 'imageProjectChanged';
    throw error;
  }
};
