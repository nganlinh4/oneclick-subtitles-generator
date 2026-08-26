import { waitForAutomationWindowIsolation } from './editor.js';

/**
 * Test-path safety, deliberately separate from WebdriverIO's lifecycle hooks.
 *
 * A rejected WebdriverIO `before` hook was observed being logged while the spec still exited zero.
 * Mocha's root `beforeEach` belongs to the test itself: if native placement is unsafe, that test is
 * red and the isolated runner cannot publish a successful workflow attempt.
 */
export const mochaHooks = {
  beforeEach: async function verifyHiddenRealApp() {
    await waitForAutomationWindowIsolation();
  },
};
