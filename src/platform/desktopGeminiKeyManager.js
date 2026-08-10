import { initializeCredentialState } from './credentialStateController';

// The desktop renderer never receives provider secrets. These compatibility
// exports preserve synchronous UI call shapes while all real credential work
// goes through credentialStateController and opaque vault IDs.
export const initKeyManager = () => undefined;
export const getAllKeys = () => [];
export const saveAllKeys = () => false;
export const addKey = () => false;
export const removeKey = () => false;
export const getActiveKeyIndex = () => 0;
export const setActiveKeyIndex = () => false;
export const getCurrentKey = () => null;
export const blacklistKey = () => false;
export const isKeyBlacklisted = () => false;
export const rotateToNextKey = () => null;
export const getNextAvailableKey = () => null;

initializeCredentialState().catch(() => undefined);
