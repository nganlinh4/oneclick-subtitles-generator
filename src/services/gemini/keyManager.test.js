import * as keyManager from './keyManager';

vi.mock('../../platform/credentialStateController', () => ({
  initializeCredentialState: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  localStorage.clear();
  window.isTauri = true;
});

afterAll(() => {
  delete window.isTauri;
});

test('the desktop compatibility facade never accepts or returns provider secrets', () => {
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

test('the browser compatibility facade preserves the legacy local key manager', () => {
  window.isTauri = false;
  expect(keyManager.addKey('browser-key-one')).toBe(true);
  expect(keyManager.addKey('browser-key-two')).toBe(true);
  expect(keyManager.getAllKeys()).toEqual(['browser-key-one', 'browser-key-two']);
  expect(keyManager.setActiveKeyIndex(1)).toBe(true);
  expect(keyManager.getCurrentKey()).toBe('browser-key-two');
  expect(keyManager.removeKey('browser-key-two')).toBe(true);
  expect(keyManager.getCurrentKey()).toBe('browser-key-one');
});
