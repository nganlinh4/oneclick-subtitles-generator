// The WebView expression that drives the installed media pipeline through typed native commands.

import { MAX_OPERATION_EVENTS } from './shared.mjs';

export const PIPELINE_EXPRESSION = `
(async () => {
  const internals = window.__TAURI_INTERNALS__;
  const invoke = internals?.invoke;
  if (typeof invoke !== 'function'
      || typeof internals.transformCallback !== 'function'
      || typeof internals.unregisterCallback !== 'function') {
    throw new Error('The installed desktop IPC channel is unavailable');
  }
  const session = await invoke('get_session_snapshot');
  if (!session?.media?.id || !session?.playback?.playbackUrl) {
    throw new Error('The installed media pipeline has no selected native source');
  }
  const sourceId = session.media.id;
  const maxChannelPackets = ${MAX_OPERATION_EVENTS};

  const createChannel = (onMessage, onEnd, onProtocolError) => {
    let nextIndex = 0;
    let endIndex = null;
    const pending = new Map();
    let callbackId = null;
    const cleanup = () => {
      if (callbackId !== null) internals.unregisterCallback(callbackId);
    };
    const drain = () => {
      while (pending.has(nextIndex)) {
        const message = pending.get(nextIndex);
        pending.delete(nextIndex);
        nextIndex += 1;
        onMessage(message);
      }
      if (endIndex === nextIndex) {
        cleanup();
        onEnd();
      }
    };
    callbackId = internals.transformCallback((packet) => {
      if (!packet
          || !Number.isSafeInteger(packet.index)
          || packet.index < nextIndex
          || packet.index > maxChannelPackets) {
        cleanup();
        onProtocolError();
        return;
      }
      if (Object.prototype.hasOwnProperty.call(packet, 'end')) {
        endIndex = packet.index;
        drain();
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(packet, 'message')
          || pending.has(packet.index)
          || pending.size >= maxChannelPackets) {
        cleanup();
        onProtocolError();
        return;
      }
      pending.set(packet.index, packet.message);
      drain();
    }, false);
    return '__CHANNEL__:' + callbackId;
  };

  const runOperation = async (request) => {
    let initial = null;
    let terminalEvent = null;
    let channelEnded = false;
    let settled = false;
    let resolveTerminal;
    let rejectTerminal;
    const events = [];
    const terminal = new Promise((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    const succeedIfReady = () => {
      if (!settled && initial !== null && terminalEvent !== null && channelEnded) {
        settled = true;
        resolveTerminal();
      }
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      rejectTerminal(new Error(message));
    };
    const channel = createChannel((event) => {
      if (terminalEvent !== null) {
        fail('The installed media channel emitted data after completion');
        return;
      }
      if (events.length >= maxChannelPackets) {
        fail('The installed media channel exceeded its event bound');
        return;
      }
      events.push(event);
      if (event?.event === 'failed' || event?.event === 'cancelled') {
        fail('The installed ' + request.operation + ' operation did not succeed');
        return;
      }
      if (event?.event === 'completed') {
        terminalEvent = event;
        succeedIfReady();
      }
    }, () => {
      if (terminalEvent === null) {
        fail('The installed media channel ended before completion');
        return;
      }
      channelEnded = true;
      succeedIfReady();
    }, () => fail('The installed media channel returned an invalid packet'));
    const timer = setTimeout(() => {
      if (initial?.id) void invoke('media_pipeline_cancel', { jobId: initial.id });
      fail('The installed ' + request.operation + ' operation timed out');
    }, 120000);
    try {
      initial = await invoke('media_pipeline_start', { request, onEvent: channel });
      succeedIfReady();
      await terminal;
      return { events, initial, playbackProbe: null };
    } finally {
      clearTimeout(timer);
    }
  };

  const probePlayback = async (operation) => {
    const result = operation.events.at(-1)?.result;
    const playback = result?.media?.playback;
    if (!playback?.playbackUrl) throw new Error('A derived playback capability is missing');
    const kind = playback.mimeType?.startsWith('video/') ? 'video'
      : playback.mimeType?.startsWith('audio/') ? 'audio' : null;
    if (kind === null) throw new Error('A derived playback MIME kind is invalid');
    const media = document.createElement(kind);
    media.preload = 'auto';
    media.muted = true;
    let metadataLoaded = false;
    let canPlay = false;
    const observed = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('A derived playback capability did not become playable')),
        30000,
      );
      const finish = () => {
        if (!metadataLoaded || !canPlay) return;
        clearTimeout(timeout);
        resolve({
          canPlay,
          duration: media.duration,
          height: kind === 'video' ? media.videoHeight : null,
          kind,
          metadataLoaded,
          readyState: media.readyState,
          width: kind === 'video' ? media.videoWidth : null,
        });
      };
      media.addEventListener('loadedmetadata', () => {
        metadataLoaded = true;
        finish();
      }, { once: true });
      media.addEventListener('canplay', () => {
        canPlay = true;
        finish();
      }, { once: true });
      media.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('A derived playback capability could not be decoded'));
      }, { once: true });
      media.src = playback.playbackUrl;
      media.load();
    }).finally(() => {
      media.pause();
      media.removeAttribute('src');
      media.load();
      media.remove();
    });
    operation.playbackProbe = observed;
    return operation;
  };

  const sourceInspection = await invoke('media_pipeline_inspect', { assetId: sourceId });
  const preparePlayback = await probePlayback(await runOperation({
    operation: 'preparePlayback',
    assetId: sourceId,
  }));
  const analysisClip = await probePlayback(await runOperation({
    operation: 'analysisClip',
    assetId: sourceId,
    startUs: 750000,
    endUs: 2250000,
  }));
  const extractAudio = await probePlayback(await runOperation({
    operation: 'extractAudio',
    assetId: sourceId,
    format: 'wav',
    startUs: 500000,
    endUs: 2500000,
  }));
  const generateWaveform = await runOperation({
    operation: 'generateWaveform',
    assetId: sourceId,
    pointsPerSecond: 100,
    maxPoints: 1000,
    startUs: 0,
    endUs: null,
  });

  return {
    analysisClip,
    errorToastMessages: [...document.querySelectorAll('.toast-error p')]
      .slice(0, 4)
      .map((element) => (element.textContent ?? '').trim().slice(0, 1024)),
    extractAudio,
    generateWaveform,
    preparePlayback,
    source: { asset: session.media, playback: session.playback },
    sourceInspection,
  };
})()`;
