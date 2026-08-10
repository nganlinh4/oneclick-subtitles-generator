import { v7 as uuidv7 } from 'uuid';
import {
  CredentialServiceError,
  createCredentialService,
  normalizeCredentialStatus,
  normalizeCredentialStatusReport,
} from './credentialService';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

const readyGeminiCredential = (overrides = {}) => ({
  id: uuidv7(),
  purpose: 'geminiApiKey',
  provider: 'gemini',
  state: 'ready',
  last4: '1234',
  ...overrides,
});

it('sends a credential value only to the native set command and returns safe metadata', async () => {
  const secret = 'private-gemini-key';
  const response = readyGeminiCredential({ secret: 'must-not-cross-back' });
  const invokeCommand = vi.fn().mockResolvedValue(response);
  const service = createCredentialService({ invokeCommand });

  const result = await service.setCredential({ purpose: 'geminiApiKey', secret });

  expect(invokeCommand).toHaveBeenCalledWith('credential_set', {
    request: { purpose: 'geminiApiKey', secret },
  });
  expect(result).toEqual({
    id: response.id,
    purpose: 'geminiApiKey',
    provider: 'gemini',
    state: 'ready',
    last4: '1234',
  });
  expect(result).not.toHaveProperty('secret');
  expect(JSON.stringify(result)).not.toContain(secret);
});

it('rejects invalid and oversized secrets without invoking native code', async () => {
  const invokeCommand = vi.fn();
  const service = createCredentialService({ invokeCommand });

  await expect(service.setCredential({ purpose: 'geminiApiKey', secret: '' }))
    .rejects.toBeInstanceOf(CredentialServiceError);
  await expect(service.setCredential({
    purpose: 'geminiApiKey',
    secret: '한'.repeat((16 * 1024) / 3 + 1),
  })).rejects.toMatchObject({ code: 'invalidCredentialRequest' });
  await expect(service.setCredential({
    purpose: 'geminiApiKey',
    secret: 'secret',
    label: 'unsupported',
  })).rejects.toMatchObject({ code: 'invalidCredentialRequest' });
  expect(invokeCommand).not.toHaveBeenCalled();
});

it('validates UUIDv7 deletion IDs before crossing IPC', async () => {
  const invokeCommand = vi.fn().mockResolvedValue(true);
  const service = createCredentialService({ invokeCommand });

  await expect(service.deleteCredential('550e8400-e29b-41d4-a716-446655440000'))
    .rejects.toMatchObject({ code: 'invalidCredentialRequest' });
  expect(invokeCommand).not.toHaveBeenCalled();

  const id = uuidv7();
  await expect(service.deleteCredential(id)).resolves.toBe(true);
  expect(invokeCommand).toHaveBeenCalledWith('credential_delete', { id });
});

it('requests all or purpose-filtered safe credential statuses', async () => {
  const gemini = readyGeminiCredential();
  const invokeCommand = vi.fn()
    .mockResolvedValueOnce({ store: 'available', credentials: [gemini] })
    .mockResolvedValueOnce({ store: 'locked', credentials: [] });
  const service = createCredentialService({ invokeCommand });

  await expect(service.getCredentialStatus()).resolves.toEqual({
    store: 'available',
    credentials: [expect.objectContaining({ id: gemini.id })],
  });
  await expect(service.getCredentialStatus('geminiApiKey')).resolves.toEqual({
    store: 'locked',
    credentials: [],
  });
  expect(invokeCommand.mock.calls).toEqual([
    ['credential_status', { purpose: null }],
    ['credential_status', { purpose: 'geminiApiKey' }],
  ]);
});

it('rejects inconsistent provider metadata and duplicate IDs', () => {
  const status = readyGeminiCredential();
  expect(() => normalizeCredentialStatus({ ...status, provider: 'youtube' }))
    .toThrow(CredentialServiceError);
  expect(() => normalizeCredentialStatus({ ...status, last4: '12345' }))
    .toThrow(CredentialServiceError);
  expect(() => normalizeCredentialStatusReport({
    store: 'available',
    credentials: [status, status],
  })).toThrow(CredentialServiceError);
});

it('does not retain a credential value on validation errors', async () => {
  const secret = 'value-that-must-not-appear-in-errors';
  const service = createCredentialService({ invokeCommand: vi.fn() });

  let caught;
  try {
    await service.setCredential({ purpose: 'unknown', secret });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(CredentialServiceError);
  expect(String(caught)).not.toContain(secret);
  expect(JSON.stringify(caught)).not.toContain(secret);
});

it('never reflects a secret-bearing transport failure into the surfaced error', async () => {
  const secret = 'value-that-a-broken-transport-reflected';
  const service = createCredentialService({
    invokeCommand: vi.fn().mockRejectedValue({
      code: 'credentialStoreLocked',
      message: `Could not store ${secret}`,
      request: { secret },
    }),
  });

  let caught;
  try {
    await service.setCredential({ purpose: 'geminiApiKey', secret });
  } catch (error) {
    caught = error;
  }

  expect(caught).toMatchObject({
    code: 'credentialStoreLocked',
    message: 'The credential operation could not be completed',
  });
  expect(caught).not.toHaveProperty('cause');
  expect(String(caught)).not.toContain(secret);
  expect(JSON.stringify(caught)).not.toContain(secret);
});
