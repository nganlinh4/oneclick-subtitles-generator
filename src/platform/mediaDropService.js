import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';
import { invokeDesktop } from './desktopRuntime';

const SUBSCRIPTION_KEYS = Object.freeze(['id']);
const POSITION_KEYS = Object.freeze(['x', 'y']);
const EVENT_KEYS = Object.freeze({
  enter: ['dragId', 'position', 'sequence', 'type'],
  over: ['dragId', 'position', 'sequence', 'type'],
  leave: ['dragId', 'sequence', 'type'],
  drop: ['dragId', 'offerId', 'position', 'sequence', 'type'],
  rejected: ['dragId', 'position', 'reason', 'sequence', 'type'],
});
const REJECTION_REASONS = new Set(['multipleFiles', 'noFiles']);

const isRecord = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const hasExactKeys = (value, expectedKeys) => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
};

const isUuidV4 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 4;
  } catch {
    return false;
  }
};

const invalidDropResponse = () => {
  const error = new Error('The desktop host returned an invalid native drop event');
  error.name = 'MediaDropServiceError';
  error.code = 'invalidMediaDropResponse';
  return error;
};

const invalidDropRequest = () => {
  const error = new Error('The native media drop request is invalid');
  error.name = 'MediaDropServiceError';
  error.code = 'invalidMediaDropRequest';
  return error;
};

const validateUuidV4 = (value) => {
  if (!isUuidV4(value)) throw invalidDropRequest();
  return value;
};

const normalizePosition = (value) => {
  if (!hasExactKeys(value, POSITION_KEYS)
      || !Number.isFinite(value.x)
      || !Number.isFinite(value.y)
      || value.x < 0
      || value.y < 0) {
    throw invalidDropResponse();
  }
  return Object.freeze({ x: value.x, y: value.y });
};

export const normalizeNativeMediaDropEvent = (value) => {
  try {
    const expectedKeys = isRecord(value) ? EVENT_KEYS[value.type] : null;
    if (!expectedKeys
        || !hasExactKeys(value, expectedKeys)
        || !isUuidV4(value.dragId)
        || !Number.isSafeInteger(value.sequence)
        || value.sequence < 1) {
      throw invalidDropResponse();
    }

    const normalized = {
      dragId: value.dragId,
      sequence: value.sequence,
      type: value.type,
    };
    if (value.type !== 'leave') normalized.position = normalizePosition(value.position);
    if (value.type === 'drop') {
      if (!isUuidV4(value.offerId)) throw invalidDropResponse();
      normalized.offerId = value.offerId;
    }
    if (value.type === 'rejected') {
      if (!REJECTION_REASONS.has(value.reason)) throw invalidDropResponse();
      normalized.reason = value.reason;
    }
    return Object.freeze(normalized);
  } catch (error) {
    if (error?.code === 'invalidMediaDropResponse') throw error;
    throw invalidDropResponse();
  }
};

const normalizeSubscription = (value) => {
  if (!hasExactKeys(value, SUBSCRIPTION_KEYS) || !isUuidV4(value.id)) {
    throw invalidDropResponse();
  }
  return Object.freeze({ id: value.id });
};

export const createNativeMediaDropService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor,
} = {}) => {
  const channelType = ChannelConstructor || Channel;

  return Object.freeze({
    subscribe: async (onEvent, onProtocolError = () => {}) => {
      if (typeof onEvent !== 'function' || typeof onProtocolError !== 'function') {
        throw invalidDropRequest();
      }
      const channel = new channelType();
      channel.onmessage = (rawEvent) => {
        try {
          onEvent(normalizeNativeMediaDropEvent(rawEvent));
        } catch (error) {
          try { onProtocolError(error); } catch { /* isolate consumer callback failures */ }
        }
      };
      const subscription = normalizeSubscription(await invokeCommand('media_drop_subscribe', {
        onEvent: channel,
      }));
      let active = true;
      return Object.freeze({
        id: subscription.id,
        unsubscribe: async () => {
          if (!active) return;
          active = false;
          await invokeCommand('media_drop_unsubscribe', { subscriptionId: subscription.id });
        },
      });
    },
    discard: async (offerId) => {
      await invokeCommand('media_drop_discard', { offerId: validateUuidV4(offerId) });
    },
  });
};

export const nativeMediaDropService = createNativeMediaDropService();
