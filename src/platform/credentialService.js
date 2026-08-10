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
const MAX_SAFE_SUFFIX_CHARACTERS = 4;
const credentialPurposes = new Set(CREDENTIAL_PURPOSES);
const credentialStates = new Set(CREDENTIAL_STATES);
const credentialStoreStates = new Set(CREDENTIAL_STORE_STATES);
const providerByPurpose = Object.freeze({
  geminiApiKey: 'gemini',
  geniusAccessToken: 'genius',
  youtubeApiKey: 'youtube',
  youtubeOauthClient: 'youtube',
  youtubeOauthToken: 'youtube',
});

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

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
  const code = typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(error.code)
    ? error.code
    : 'credentialCommandFailed';
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
  if (typeof value !== 'string'
      || Array.from(value).length > MAX_SAFE_SUFFIX_CHARACTERS
      || Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 31 || codePoint === 127;
      })) {
    throw invalidCredentialResponse();
  }
  return value;
};

export const normalizeCredentialStatus = (status) => {
  if (!isRecord(status)
      || !isUuidV7(status.id)
      || !credentialPurposes.has(status.purpose)
      || status.provider !== providerByPurpose[status.purpose]
      || !credentialStates.has(status.state)) {
    throw invalidCredentialResponse();
  }

  // Copy only the UI-safe Rust response fields. Unknown fields can never smuggle a secret into
  // application state, error reports, or a later serialization boundary.
  return Object.freeze({
    id: status.id,
    purpose: status.purpose,
    provider: status.provider,
    state: status.state,
    last4: normalizeSafeSuffix(status.last4),
  });
};

export const normalizeCredentialStatusReport = (report) => {
  if (!isRecord(report)
      || !credentialStoreStates.has(report.store)
      || !Array.isArray(report.credentials)) {
    throw invalidCredentialResponse();
  }

  const credentials = report.credentials.map(normalizeCredentialStatus);
  const ids = new Set();
  for (const credential of credentials) {
    if (ids.has(credential.id)) throw invalidCredentialResponse();
    ids.add(credential.id);
  }

  return Object.freeze({
    store: report.store,
    credentials: Object.freeze(credentials),
  });
};

const normalizeSetRequest = (request) => {
  if (!isRecord(request)
      || Object.keys(request).some((key) => key !== 'purpose' && key !== 'secret')
      || typeof request.secret !== 'string') {
    throw invalidCredentialRequest();
  }

  const size = utf8ByteLength(request.secret);
  if (size === 0 || size > MAX_CREDENTIAL_BYTES) throw invalidCredentialRequest();

  return {
    purpose: requirePurpose(request.purpose),
    secret: request.secret,
  };
};

/**
 * Native credential-vault bridge. Credential values are accepted only by `setCredential`, passed
 * directly to the allowlisted Tauri command, and are never retained or returned by this module.
 */
export const createCredentialService = ({ invokeCommand = invokeDesktop } = {}) => {
  const setCredential = async (request) => {
    const normalized = normalizeSetRequest(request);
    try {
      const result = await invokeCommand('credential_set', { request: normalized });
      return normalizeCredentialStatus(result);
    } catch (error) {
      if (error instanceof CredentialServiceError) throw error;
      throw normalizeCredentialCommandFailure(error);
    }
  };

  const upsertCredential = async (request) => {
    const normalized = normalizeSetRequest(request);
    try {
      const result = await invokeCommand('credential_upsert', { request: normalized });
      return normalizeCredentialStatus(result);
    } catch (error) {
      if (error instanceof CredentialServiceError) throw error;
      throw normalizeCredentialCommandFailure(error);
    }
  };

  const deleteCredential = async (id) => {
    const credentialId = requireCredentialId(id);
    try {
      const deleted = await invokeCommand('credential_delete', { id: credentialId });
      if (typeof deleted !== 'boolean') throw invalidCredentialResponse();
      return deleted;
    } catch (error) {
      if (error instanceof CredentialServiceError) throw error;
      throw normalizeCredentialCommandFailure(error);
    }
  };

  const getCredentialStatus = async (purpose = null) => {
    const normalizedPurpose = purpose === null ? null : requirePurpose(purpose);
    try {
      const report = await invokeCommand('credential_status', { purpose: normalizedPurpose });
      return normalizeCredentialStatusReport(report);
    } catch (error) {
      if (error instanceof CredentialServiceError) throw error;
      throw normalizeCredentialCommandFailure(error);
    }
  };

  return Object.freeze({
    setCredential,
    upsertCredential,
    deleteCredential,
    getCredentialStatus,
  });
};

const credentialService = createCredentialService();

export const setCredential = credentialService.setCredential;
export const upsertCredential = credentialService.upsertCredential;
export const deleteCredential = credentialService.deleteCredential;
export const getCredentialStatus = credentialService.getCredentialStatus;
