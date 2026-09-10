import { Channel } from '@tauri-apps/api/core';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

const ids = new Set([
  'f5tts-spanish', 'f5tts-russian', 'f5tts-portuguese-br', 'f5tts-italian',
  'f5tts-vietnamese-vivoice', 'f5tts-german', 'f5tts-finnish', 'f5tts-polish',
]);

const requireDesktop = () => {
  if (!isDesktopRuntime()) throw new Error('desktopF5ModelsRequired');
};
const requireId = (id) => {
  if (!ids.has(id)) throw new Error('invalidF5ModelRequest');
  return id;
};

export const getF5ModelsStatus = async () => {
  requireDesktop();
  const value = await invokeDesktop('f5_models_status', {});
  if (!Array.isArray(value) || value.length !== ids.size) throw new Error('invalidF5ModelResponse');
  return Object.freeze(value.map((entry) => Object.freeze({ ...entry, languages: Object.freeze([entry.language]) })));
};

export const installF5Model = async (model, onEvent = () => {}) => {
  requireDesktop(); requireId(model);
  const channel = new Channel();
  channel.onmessage = onEvent;
  return invokeDesktop('f5_model_install', { model, onEvent: channel });
};

export const cancelF5Model = async (model) => {
  requireDesktop(); requireId(model);
  return invokeDesktop('f5_model_cancel', { model });
};

export const removeF5Model = async (model) => {
  requireDesktop(); requireId(model);
  return invokeDesktop('f5_model_remove', { model });
};
