// WebView expressions the installed media flow evaluates over CDP. Each one drives or reads the
// real product UI; none touches native capabilities directly.

import { MEDIA_URL, SUBTITLE_MARKER } from './shared.mjs';

const CONFIGURE_MEDIA_PHASE_EXPRESSION = (preferences) => `
(() => {
  localStorage.setItem('auto_import_site_subtitles', ${JSON.stringify(preferences.autoImport)});
  localStorage.setItem('preferred_subtitle_langs', ${JSON.stringify(preferences.preferredLanguages)});
  return localStorage.getItem('auto_import_site_subtitles')
      === ${JSON.stringify(preferences.autoImport)}
    && localStorage.getItem('preferred_subtitle_langs')
      === ${JSON.stringify(preferences.preferredLanguages)};
})()`;

const SET_URL_EXPRESSION = `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  if (containers.length !== 1) return false;
  const container = containers[0];
  const tabList = container.querySelector(':scope > .input-header > .input-tabs');
  if (!(tabList instanceof HTMLDivElement)) return false;
  const tabs = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement && child.classList.contains('tab-btn')
  );
  const urlTabs = tabs.filter((tab) => tab.dataset.inputTab === 'unified-url');
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  if (tabs.length < 2 || tabs.length > 3 || urlTabs.length !== 1
      || activeTabs.length !== 1 || activeTabs[0] !== urlTabs[0]) return false;
  const inputs = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper input.url-field'
  )];
  if (inputs.length !== 1) return false;
  const input = inputs[0];
  if (!(input instanceof HTMLInputElement)) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (typeof setter !== 'function') return false;
  setter.call(input, ${JSON.stringify(MEDIA_URL)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

const ACTIVATE_URL_TAB_EXPRESSION = `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  if (containers.length !== 1) return null;
  const tabList = containers[0].querySelector(':scope > .input-header > .input-tabs');
  if (!(tabList instanceof HTMLDivElement)) return null;
  const tabs = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement && child.classList.contains('tab-btn')
  );
  const urlTabs = tabs.filter((tab) => tab.dataset.inputTab === 'unified-url');
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  if (tabs.length < 2 || tabs.length > 3 || urlTabs.length !== 1
      || activeTabs.length !== 1) return null;
  if (activeTabs[0] === urlTabs[0]) return 'already-active';
  urlTabs[0].click();
  return 'activated';
})()`;

const URL_CONTROL_READY_EXPRESSION = `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  if (containers.length !== 1) return false;
  const container = containers[0];
  const tabList = container.querySelector(':scope > .input-header > .input-tabs');
  if (!(tabList instanceof HTMLDivElement)) return false;
  const tabs = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement && child.classList.contains('tab-btn')
  );
  const urlTabs = tabs.filter((tab) => tab.dataset.inputTab === 'unified-url');
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  const inputs = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper input.url-field'
  )];
  return tabs.length >= 2 && tabs.length <= 3
    && urlTabs.length === 1
    && activeTabs.length === 1 && activeTabs[0] === urlTabs[0]
    && inputs.length === 1 && inputs[0] instanceof HTMLInputElement;
})()`;

const URL_STAGED_EXPRESSION = `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  if (containers.length !== 1) return false;
  const container = containers[0];
  const tabList = container.querySelector(':scope > .input-header > .input-tabs');
  if (!(tabList instanceof HTMLDivElement)) return false;
  const tabs = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement && child.classList.contains('tab-btn')
  );
  const urlTabs = tabs.filter((tab) => tab.dataset.inputTab === 'unified-url');
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  const inputs = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper input.url-field'
  )];
  const previews = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper .selected-video-preview .video-url-value'
  )];
  return tabs.length >= 2 && tabs.length <= 3
    && urlTabs.length === 1
    && activeTabs.length === 1 && activeTabs[0] === urlTabs[0]
    && inputs.length === 1 && inputs[0] instanceof HTMLInputElement
    && inputs[0].value === ${JSON.stringify(MEDIA_URL)}
    && previews.length === 1
    && (previews[0].textContent ?? '').trim() === ${JSON.stringify(MEDIA_URL)};
})()`;

const SRT_READY_EXPRESSION = (preferences, expectedCacheId) => `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  const groups = [...document.querySelectorAll(
    '.buttons-container .srt-upload-buttons-group'
  )];
  if (containers.length !== 1 || groups.length !== 1) return false;
  const container = containers[0];
  const tabList = container.querySelector(':scope > .input-header > .input-tabs');
  if (!(tabList instanceof HTMLDivElement)) return false;
  const tabs = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement && child.classList.contains('tab-btn')
  );
  const urlTabs = tabs.filter((tab) => tab.dataset.inputTab === 'unified-url');
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  const inputs = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper input.url-field'
  )];
  const previews = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper .selected-video-preview .video-url-value'
  )];
  const group = groups[0];
  const uploadButtons = [...group.querySelectorAll(':scope .srt-upload-button')];
  const clearButtons = [...group.children].filter(
    (child) => child instanceof HTMLButtonElement
      && child.classList.contains('clear-subtitles-button')
  );
  const buttonContainers = [...document.querySelectorAll('.buttons-container')];
  if (buttonContainers.length !== 1) return false;
  const startButtons = [...buttonContainers[0].querySelectorAll(
    ':scope .generate-btn.semi-auto'
  )];
  let info = null;
  try { info = JSON.parse(localStorage.getItem('uploaded_srt_info')); } catch {}
  return tabs.length >= 2 && tabs.length <= 3
    && urlTabs.length === 1
    && activeTabs.length === 1 && activeTabs[0] === urlTabs[0]
    && inputs.length === 1 && inputs[0] instanceof HTMLInputElement
    && inputs[0].value === ${JSON.stringify(MEDIA_URL)}
    && previews.length === 1
    && (previews[0].textContent ?? '').trim() === ${JSON.stringify(MEDIA_URL)}
    && localStorage.getItem('auto_import_site_subtitles')
      === ${JSON.stringify(preferences.autoImport)}
    && localStorage.getItem('preferred_subtitle_langs')
      === ${JSON.stringify(preferences.preferredLanguages)}
    && uploadButtons.length === 1
    && uploadButtons[0].classList.contains('has-srt-uploaded')
    && !uploadButtons[0].classList.contains('processing')
    && !uploadButtons[0].disabled
    && clearButtons.length === 1 && !clearButtons[0].disabled
    && info && typeof info === 'object' && !Array.isArray(info)
    && Object.keys(info).sort().join(',') === 'cacheId,fileName,v'
    && info.v === 2
    && (${JSON.stringify(expectedCacheId)} === null
      ? /^subtitle-document:[0-9a-f-]{36}$/.test(info.cacheId)
      : info.cacheId === ${JSON.stringify(expectedCacheId)})
    && info.fileName === 'osg-installed-media-smoke.srt'
    && document.body.innerText.includes(${JSON.stringify(SUBTITLE_MARKER)})
    && startButtons.length === 1
    && startButtons[0] instanceof HTMLButtonElement
    && !startButtons[0].disabled
    && startButtons[0].dataset.generationMode === ${JSON.stringify(expectedCacheId === null ? 'url-with-srt' : 'other')};
})()`;

const START_EXPRESSION = (preferences, expectedCacheId) => `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  const buttonContainers = [...document.querySelectorAll('.buttons-container')];
  if (containers.length !== 1 || buttonContainers.length !== 1) return false;
  const container = containers[0];
  const tabList = container.querySelector(':scope > .input-header > .input-tabs');
  if (!(tabList instanceof HTMLDivElement)) return false;
  const tabs = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement && child.classList.contains('tab-btn')
  );
  const urlTabs = tabs.filter((tab) => tab.dataset.inputTab === 'unified-url');
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  const inputs = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper input.url-field'
  )];
  const previews = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper .selected-video-preview .video-url-value'
  )];
  const groups = [...buttonContainers[0].querySelectorAll(
    ':scope .srt-upload-buttons-group'
  )];
  if (groups.length !== 1) return false;
  const uploadButtons = [...groups[0].querySelectorAll(':scope .srt-upload-button')];
  const clearButtons = [...groups[0].children].filter(
    (child) => child instanceof HTMLButtonElement
      && child.classList.contains('clear-subtitles-button')
  );
  const buttons = [...buttonContainers[0].querySelectorAll(
    ':scope .generate-btn.semi-auto'
  )];
  let info = null;
  try { info = JSON.parse(localStorage.getItem('uploaded_srt_info')); } catch {}
  if (tabs.length < 2 || tabs.length > 3
      || urlTabs.length !== 1
      || activeTabs.length !== 1 || activeTabs[0] !== urlTabs[0]
      || inputs.length !== 1 || !(inputs[0] instanceof HTMLInputElement)
      || inputs[0].value !== ${JSON.stringify(MEDIA_URL)}
      || previews.length !== 1
      || (previews[0].textContent ?? '').trim() !== ${JSON.stringify(MEDIA_URL)}
      || localStorage.getItem('auto_import_site_subtitles')
        !== ${JSON.stringify(preferences.autoImport)}
      || localStorage.getItem('preferred_subtitle_langs')
        !== ${JSON.stringify(preferences.preferredLanguages)}
      || uploadButtons.length !== 1
      || !uploadButtons[0].classList.contains('has-srt-uploaded')
      || uploadButtons[0].classList.contains('processing')
      || uploadButtons[0].disabled
      || clearButtons.length !== 1 || clearButtons[0].disabled
      || !info || typeof info !== 'object' || Array.isArray(info)
      || Object.keys(info).sort().join(',') !== 'cacheId,fileName,v'
      || info.v !== 2
      || (${JSON.stringify(expectedCacheId)} === null
        ? !/^subtitle-document:[0-9a-f-]{36}$/.test(info.cacheId)
        : info.cacheId !== ${JSON.stringify(expectedCacheId)})
      || info.fileName !== 'osg-installed-media-smoke.srt'
      || !document.body.innerText.includes(${JSON.stringify(SUBTITLE_MARKER)})
      || buttons.length !== 1 || !(buttons[0] instanceof HTMLButtonElement)
      || buttons[0].disabled
      || buttons[0].dataset.generationMode !== ${JSON.stringify(expectedCacheId === null ? 'url-with-srt' : 'other')}) return false;
  buttons[0].click();
  return true;
})()`;

export const MEDIA_RESULT_EXPRESSION = `
(async () => {
  const videoElement = document.querySelector('video.video-player');
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  let tools = null;
  let jobs = null;
  let session = null;
  let workspaceState = null;
  if (typeof invoke === 'function') {
    [tools, jobs, session, workspaceState] = await Promise.all([
      invoke('native_tools_status'),
      invoke('jobs_list'),
      invoke('get_session_snapshot'),
      invoke('active_workspace_get'),
    ]);
  }
  const assetId = session?.media?.id ?? null;
  const currentFileUrl = videoElement?.currentSrc ?? null;
  const currentFileName = session?.media?.displayName ?? null;
  let uploadedSrtInfo = null;
  try { uploadedSrtInfo = JSON.parse(localStorage.getItem('uploaded_srt_info')); } catch {}
  return {
    assetId,
    currentFileName,
    currentFileUrl,
    errorToastMessages: [...document.querySelectorAll('.toast-error p')]
      .slice(0, 4)
      .map((element) => (element.textContent ?? '').trim().slice(0, 1024)),
    jobs,
    session,
    workspace: workspaceState?.initialized === true ? workspaceState.workspace : null,
    subtitleMarkerVisible: document.body.innerText.includes(${JSON.stringify(SUBTITLE_MARKER)}),
    tools,
    uploadedSrtInfo,
    video: videoElement ? {
      currentSrc: videoElement.currentSrc,
      duration: videoElement.duration,
      height: videoElement.videoHeight,
      paused: videoElement.paused,
      readyState: videoElement.readyState,
      width: videoElement.videoWidth,
    } : null,
  };
})()`;

export {
  ACTIVATE_URL_TAB_EXPRESSION,
  CONFIGURE_MEDIA_PHASE_EXPRESSION,
  SET_URL_EXPRESSION,
  SRT_READY_EXPRESSION,
  START_EXPRESSION,
  URL_CONTROL_READY_EXPRESSION,
  URL_STAGED_EXPRESSION,
};
