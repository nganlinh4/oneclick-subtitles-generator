import * as keyManager from './keyManager';

vi.mock('../../platform/credentialStateController', () => ({
  initializeCredentialState: vi.fn().mockResolvedValue(undefined),
}));

test('the compatibility facade never accepts or returns provider secrets', () => {
  expect(keyManager.getAllKeys()).toEqual([]);
  expect(keyManager.getCurrentKey()).toBeNull();
  expect(keyManager.getNextAvailableKey()).toBeNull();
  expect(keyManager.addKey('must-not-be-retained')).toBe(false);
  expect(keyManager.removeKey('must-not-be-retained')).toBe(false);
  expect(keyManager.saveAllKeys(['must-not-be-retained'])).toBe(false);
  expect(keyManager.blacklistKey('must-not-be-retained')).toBe(false);
  expect(keyManager.rotateToNextKey()).toBeNull();
  expect(keyManager.setActiveKeyIndex(1)).toBe(false);
});
