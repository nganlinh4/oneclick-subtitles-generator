import { validate as validateUuid, version as uuidVersion } from 'uuid';
import { invokeDesktop } from './desktopRuntime';

export const CREDENTIAL_PURPOSES = Object.freeze([
  'geminiApiKey',
  'geniusAccessToken',
  'youtubeApiKey',
  'youtubeOauthClient',
  'youtubeOauthToken',
]);

export const CREDENTIAL_STATES = Object.freeze(['pending', 'ready', 'unavailable']);
export const CREDENTIAL_STORE_STATES = Object.freeze(['available', 'locked', 'unavailable']);

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_CREDENTIAL_STATUSES = 1_024;
const MAX_SAFE_SUFFIX_CHARACTERS = 4;
const credentialPurposes = new Set(CREDENTIAL_PURPOSES);
const credentialStates = new Set(CREDENTIAL_STATES);
const credentialStoreStates = new Set(CREDENTIAL_STORE_STATES);
const credentialCommandCodes = new Set([
  'internal',
  'database',
  'credentialStoreUnavailable',
  'credentialStoreLocked',
  'credentialNotFound',
  'invalidCredential',
  'emptyCredential',
  'credentialVerificationFailed',
  'credentialStoreFailure',
  'credentialPurposeExists',
]);
const providerByPurpose = Object.freeze({
  geminiApiKey: 'gemini',
  geniusAccessToken: 'genius',
  youtubeApiKey: 'youtube',
  youtubeOauthClient: 'youtube',
  youtubeOauthToken: 'youtube',
});

const snapshotDataRecord = (value, expectedKeys, failure) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw failure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== expectedKeys.length
        || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) {
      throw failure();
    }
    const snapshot = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw failure();
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw failure();
  }
};

const snapshotDataArray = (value, maximum, failure) => {
  try {
    if (!Array.isArray(value)) throw failure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
        || lengthDescriptor.value > maximum) {
      throw failure();
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== length + 1) throw failure();
    const snapshot = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw failure();
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    throw failure();
  }
};

const utf8ByteLength = (value) => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
};

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

export class CredentialServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CredentialServiceError';
    this.code = code;
  }
}

const invalidCredentialRequest = () => new CredentialServiceError(
  'invalidCredentialRequest',
  'The credential request is invalid'
);

const invalidCredentialResponse = () => new CredentialServiceError(
  'invalidCredentialResponse',
  'The desktop host returned invalid credential metadata'
);

const normalizeCredentialCommandFailure = (error) => {
  let code = 'credentialCommandFailed';
  try {
    const candidate = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? error.code
      : null;
    if (credentialCommandCodes.has(candidate)) code = candidate;
  } catch {
    // A hostile transport accessor is not authoritative error metadata.
  }
  // Do not retain the original exception or message. A transport implementation must never be
  // able to reflect its secret-bearing request into a rendered error or diagnostic serializer.
  return new CredentialServiceError(code, 'The credential operation could not be completed');
};

const requirePurpose = (purpose) => {
  if (!credentialPurposes.has(purpose)) throw invalidCredentialRequest();
  return purpose;
};

const requireCredentialId = (id) => {
  if (!isUuidV7(id)) throw invalidCredentialRequest();
  return id;
};

const normalizeSafeSuffix = (value) => {
  if (value === null) return null;
  const characters = typeof value === 'string' ? Array.from(value) : null;
  if (typeof value !== 'string'
      || characters.length === 0
      || characters.length > MAX_SAFE_SUFFIX_CHARACTERS
      || characters.some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 31 || codePoint === 127;
      })) {
    throw invalidCredentialResponse();
  }
  return value;
};

export const normalizeCredentialStatus = (status) => {
  const snapshot = snapshotDataRecord(
    status,
    ['id', 'purpose', 'provider', 'state', 'last4'],
    invalidCredentialResponse
  );
  if (!isUuidV7(snapshot.id)
      || !credentialPurposes.has(snapshot.purpose)
      || snapshot.provider !== providerByPurpose[snapshot.purpose]
      || !credentialStates.has(snapshot.state)
      || (snapshot.state === 'ready' && snapshot.last4 === null)
      || (snapshot.state === 'pending' && snapshot.last4 !== null)) {
    throw invalidCredentialResponse();
  }

  // Copy the exact UI-safe Rust response fields into application state.
  return Object.freeze({
    id: snapshot.id,
    purpose: snapshot.purpose,
    provider: snapshot.provider,
    state: snapshot.state,
    last4: normalizeSafeSuffix(snapshot.last4),
  });
};

export const normalizeCredentialStatusReport = (report) => {
  const snapshot = snapshotDataRecord(
    report,
    ['store', 'credentials'],
    invalidCredentialResponse
  );
  const rawCredentials = snapshotDataArray(
    snapshot.credentials,
    MAX_CREDENTIAL_STATUSES,
    invalidCredentialResponse
  );
  if (!credentialStoreStates.has(snapshot.store)) {
    throw invalidCredentialResponse();
  }

  const credentials = rawCredentials.map(normalizeCredentialStatus);
  const ids = new Set();
  const purposes = new Set();
  for (const credential of credentials) {
    if (ids.has(credential.id)
        || (credential.purpose !== 'geminiApiKey' && purposes.has(credential.purpose))) {
      throw invalidCredentialResponse();
    }
    ids.add(credential.id);
    purposes.add(credential.purpose);
  }

  return Object.freeze({
    store: snapshot.store,
    credentials: Object.freeze(credentials),
  });
};

const normalizeSetRequest = (request) => {
  const snapshot = snapshotDataRecord(
    request,
    ['purpose', 'secret'],
    invalidCredentialRequest
  );
  if (typeof snapshot.secret !== 'string') {
    throw invalidCredentialRequest();
  }

  const size = utf8ByteLength(snapshot.secret);
  if (size === 0 || size > MAX_CREDENTIAL_BYTES) throw invalidCredentialRequest();

  return Object.freeze({
    purpose: requirePurpose(snapshot.purpose),
    secret: snapshot.secret,
  });
};

/**
 * Native credential-vault bridge. Credential values are accepted only by `setCredential`, passed
 * directly to the allowlisted Tauri command, and are never retained or returned by this module.
 */
export const createCredentialService = ({ invokeCommand = invokeDesktop } = {}) => {
  const setCredential = async (request) => {
    const normalized = normalizeSetRequest(request);
    let result;
    try {
      result = await invokeCommand('credential_set', { request: normalized });
    } catch (error) {
      throw normalizeCredentialCommandFailure(error);
    }
    return normalizeCredentialStatus(result);
  };

  const upsertCredential = async (request) => {
    const normalized = normalizeSetRequest(request);
    let result;
    try {
      result = await invokeCommand('credential_upsert', { request: normalized });
    } catch (error) {
      throw normalizeCredentialCommandFailure(error);
    }
    return normalizeCredentialStatus(result);
  };

  const replaceCredential = async (id, request) => {
    const credentialId = requireCredentialId(id);
    const normalized = normalizeSetRequest(request);
    let result;
    try {
      result = await invokeCommand('credential_replace', {
        id: credentialId,
        request: normalized,
      });
    } catch (error) {
      throw normalizeCredentialCommandFailure(error);
    }
    return normalizeCredentialStatus(result);
  };

  const deleteCredential = async (id) => {
    const credentialId = requireCredentialId(id);
    let deleted;
    try {
      deleted = await invokeCommand('credential_delete', { id: credentialId });
    } catch (error) {
      throw normalizeCredentialCommandFailure(error);
    }
    if (typeof deleted !== 'boolean') throw invalidCredentialResponse();
    return deleted;
  };

  const getCredentialStatus = async (purpose = null) => {
    const normalizedPurpose = purpose === null ? null : requirePurpose(purpose);
    let report;
    try {
      report = await invokeCommand('credential_status', { purpose: normalizedPurpose });
    } catch (error) {
      throw normalizeCredentialCommandFailure(error);
    }
    return normalizeCredentialStatusReport(report);
  };

  return Object.freeze({
    setCredential,
    upsertCredential,
    replaceCredential,
    deleteCredential,
    getCredentialStatus,
  });
};

const credentialService = createCredentialService();

export const setCredential = credentialService.setCredential;
export const upsertCredential = credentialService.upsertCredential;
export const replaceCredential = credentialService.replaceCredential;
export const deleteCredential = credentialService.deleteCredential;
export const getCredentialStatus = credentialService.getCredentialStatus;
