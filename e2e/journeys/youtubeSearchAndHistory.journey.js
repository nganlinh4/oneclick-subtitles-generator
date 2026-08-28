// AUTHORED, NOT EXECUTED in this pass -- see e2e/inventory.json's "youtubeSearchAndHistory" note.
//
// GROUND TRUTH READ FROM SOURCE BEFORE WRITING ANY STEP.
//
// SEARCH REQUIRES A CREDENTIAL; THERE IS NO PUBLIC NO-CREDENTIAL PATH. src/components/inputs/
// YoutubeSearchInput.js checks `!isOAuthEnabled() && !apiKeysSet.youtube` and shows
// `youtube.noApiKey` ("Please set your YouTube API key in the settings first.") BEFORE it ever calls
// `searchYouTubeVideos`. Even if that guard were bypassed, src/platform/providerService.js's
// `requireReadyCredential` throws `credentialNotFound` ("YouTube API key not found") before invoking
// the native `youtube_search` command at all -- the credential-free case never crosses the IPC
// boundary. This journey therefore proves the credential-free REFUSAL boundary honestly, exactly as
// geminiCredentialBoundary already does for Gemini, instead of pretending to prove search results.
//
// SEARCH IS GATED BEHIND A SETTING THAT DEFAULTS OFF. src/components/app/AppState.js:62 reads
// `enable_youtube_search` from localStorage, defaulting to FALSE on a clean profile, and
// src/components/InputMethods.js only renders the "Search YouTube" tab button when it is true (and
// redirects away from that tab otherwise). This journey turns the setting on through the real
// Settings > Video Processing toggle (`#enable-youtube-search`), the same public control
// settingsVideoProcessingAndPrompts.journey.js already proves persists -- this journey is the one
// that then actually opens the tab that setting unlocks.
//
// HISTORY IS BROWSER LOCALSTORAGE, NOT SQLITE, AND HAS NO PER-ITEM DELETE CONTROL.
// src/utils/historyUtils.js keeps four independent bounded (MAX_HISTORY_ITEMS = 10) most-recently-
// used lists in localStorage -- `youtube_url_history`, `douyin_url_history`, `all_sites_url_history`,
// `youtube_search_history` -- entirely separate from the SQLite project/media/alias durability this
// harness's download journeys use. Only the YouTube/Douyin lanes dedupe by a stable extracted video
// id; the "all-sites" lane's id is `site_<slug>_<Date.now()>` (src/utils/mediaUrl.js's
// `generateAllSitesVideoId`), so re-entering the SAME all-sites URL does NOT dedupe -- a genuine,
// source-grounded finding, not an assumption, and why this journey's dedupe proof uses only the
// YouTube lane. src/components/inputs/UnifiedUrlInput.js's combined "Recent Videos" dropdown has NO
// clear/delete-one control in its shipped JSX (unlike YoutubeSearchInput's search-QUERY history,
// which does have one) -- so "never resurrects a deleted entry" is proven at the only real boundary
// that exists: the bounded-list EVICTION `historyUtils.js`'s own `upsertHistoryItem`/`writeHistory`
// implement (see support/youtubeSearchAndHistoryOracle.js), never a delete button that does not ship.
//
// SELECTING A RESULT REUSES THE SAME LIFTED STATE URL ENTRY DOES. `selectedVideo`/`setSelectedVideo`
// is owned above InputMethods (src/components/app/AppState.js) and threaded into BOTH
// UnifiedUrlInput and YoutubeSearchInput; YoutubeSearchInput's `handleVideoSelect` and
// UnifiedUrlInput's own history-reselect (support/urlHistory.js's `handleSelectFromHistory`) call the
// exact same `setSelectedVideo(...)`. Because search cannot run without a credential this harness
// does not have, this journey proves "(b) selecting a result reaches the same acquisition path" at
// the only credential-free instance of that identical call: reselecting an entry from URL history,
// which is mechanically the same `setSelectedVideo` call a search result's click would make, and
// which lands on the exact `.video-id-value`/`.download-only-btn` preview urlToPreview already
// proves end to end.
//
// WHY THE EVICTION LANE USES SYNTHETIC "ALL-SITES" URLS INSTEAD OF ELEVEN REAL YOUTUBE FETCHES.
// UnifiedUrlInput's all-sites branch (`isValidUrl` true, `isValidYoutubeUrl`/`isValidDouyinUrl` both
// false) sets `selectedVideo` SYNCHRONOUSLY with no native call at all -- no network, no credential,
// no yt-dlp inspection. Eleven real YouTube resolutions would each hit the native `youtube_thumbnail`
// command and add real network latency/flakiness for a proof that is about bounded-list ARITHMETIC,
// not acquisition. The one real YouTube URL this journey does use (the pinned REAL_VIDEO) still
// covers the network-touching id-dedupe lane exactly once, matching the credential-free network
// contract every other real-media journey here follows.

/* global $, browser, describe, document, getComputedStyle, it, localStorage */

import { strict as assert } from 'node:assert';

import { clickControl, openEditor } from '../support/editor.js';
import { REAL_VIDEO } from '../support/realMedia.js';
import { clickSettingsControl } from '../support/settingsControls.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';
import {
  expectedAfterDedupePush, expectedEvicted, expectedSurvivors,
} from '../support/youtubeSearchAndHistoryOracle.js';

const WORKFLOW = 'youtube-search-and-history';
const UNIFIED_URL_TAB = '[data-input-tab="unified-url"]';
const FILE_UPLOAD_TAB = '[data-input-tab="file-upload"]';
const SEARCH_TAB = '.input-tabs .tab-btn:nth-of-type(2)';
const HISTORY_CAP = 10;
const ALL_SITES_ROUNDS = HISTORY_CAP + 1;

const openSettings = async () => {
  await clickControl('[data-app-action="open-settings"]');
  const modal = await $('.settings-modal');
  await modal.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'Settings did not open' });
};

const activateTab = async (tab) => {
  const selector = `[data-settings-tab="${tab}"]`;
  await clickControl(selector);
  await browser.waitUntil(async () => (await $(selector).getAttribute('class')).includes('active'), {
    timeout: 10_000,
    interval: 100,
    timeoutMsg: `Settings tab did not activate: ${tab}`,
  });
};

const switchSelected = (selector) => browser.execute(
  (target) => document.querySelector(target)?.selected ?? null, selector,
);

const toggleSwitch = async (selector) => {
  const before = await switchSelected(selector);
  assert.equal(typeof before, 'boolean', `${selector} switch is unavailable`);
  const desired = !before;
  // One click can land during a settings-panel re-render and be dropped; a customer clicks again
  // when a switch visibly did not take (idiom: exportAnimationParityMatrix.journey.js's setSwitch).
  // clickSettingsControl also tolerates the sticky settings footer landing on top of a control near
  // the bottom of a scrolled tab -- this is the exact real failure observed for #enable-youtube-search
  // (e2e/support/settingsControls.js).
  for (let attempt = 0; attempt < 3 && (await switchSelected(selector)) !== desired; attempt += 1) {
    await clickSettingsControl(selector);
    try {
      await browser.waitUntil(async () => (await switchSelected(selector)) === desired, {
        timeout: 2_500,
        interval: 50,
      });
    } catch { /* the bounded re-click and final assertion own the outcome */ }
  }
  const after = await switchSelected(selector);
  assert.equal(after, desired, `${selector} did not toggle`);
  return { before, after };
};

const readHistory = (key) => browser.execute((storageKey) => {
  const raw = localStorage.getItem(storageKey);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return 'malformed';
  }
}, key);

const searchState = () => browser.execute(() => {
  const text = (selector) => [...document.querySelectorAll(selector)]
    .map((node) => (node.innerText || '').trim()).filter(Boolean);
  return {
    errorToasts: text('.toast-item.live .toast.toast-error'),
    resultCount: document.querySelectorAll('.search-result-item').length,
    searching: document.querySelector('.searching-indicator') !== null,
  };
});

const previewState = () => browser.execute(() => {
  const text = (selector) => [...document.querySelectorAll(selector)]
    .map((node) => (node.innerText || '').trim()).filter(Boolean);
  return {
    videoId: text('.video-id-value'),
    downloadOnlyVisible: document.querySelector('.unified-url-input .download-only-btn') !== null,
    errorToasts: text('.toast-item.live .toast.toast-error'),
  };
});

const waitUntilWithFreshDiagnostic = async (predicate, { diagnostic, ...options }) => {
  try {
    return await browser.waitUntil(predicate, { ...options, timeoutMsg: 'condition did not settle before its timeout' });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
};

describe('a customer searches YouTube, then acquires and revisits videos through real history', () => {
  it('proves the credential-free refusal, the shared acquisition path, and bounded no-resurrection history', async () => {
    await openEditor();
    assert.equal(await readHistory('youtube_url_history'), null, 'a clean profile must start with no URL history');
    assert.equal(await readHistory('youtube_search_history'), null, 'a clean profile must start with no search history');

    // --- Setup: turn on the real, off-by-default setting that unlocks the search tab. ---
    await openSettings();
    await activateTab('video-processing');
    const youtubeSearch = await toggleSwitch('#enable-youtube-search');
    assert.equal(youtubeSearch.after, true, 'enable_youtube_search must go from its off-by-default state to on');
    const save = await $('.save-btn');
    await browser.waitUntil(async () => !(await save.getAttribute('disabled')), {
      timeout: 10_000, interval: 100, timeoutMsg: 'Settings never marked the edit as saveable',
    });
    await clickControl('.save-btn');
    await $('.settings-modal').waitForExist({ reverse: true, timeout: 30_000 });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-search-enabled',
      description: 'The real "Enable YouTube Search" setting was turned on and saved, unlocking the tab.',
      details: { enableYoutubeSearch: youtubeSearch.after },
    });

    // --- Part A: credential-free search is refused before any provider side effect. ---
    await clickControl(SEARCH_TAB);
    const field = await $('#youtube-search-input');
    await field.waitForDisplayed({ timeout: 30_000 });
    // The pinned real video's own id: a stable, credential-free query that would be meaningful the
    // moment a credential is ever supplied, without depending on any volatile search result content.
    await field.setValue(REAL_VIDEO.id);
    let refusal = null;
    await waitUntilWithFreshDiagnostic(async () => {
      refusal = await searchState();
      return refusal.errorToasts.length > 0;
    }, {
      timeout: 10_000,
      interval: 200,
      diagnostic: () => `no credential-free refusal toast appeared: ${JSON.stringify(refusal)}`,
    });
    assert.match(refusal.errorToasts[0], /API key/iu, 'the refusal toast does not name the missing API key');
    assert.equal(refusal.searching, false, 'a credential-free query must never enter the searching state');
    assert.equal(refusal.resultCount, 0, 'a credential-free query must never publish search results');
    assert.equal(
      await readHistory('youtube_search_history'), null,
      'the credential guard returns before the query is ever recorded to search history',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-search-refused-credential-free',
      description: 'A stable query on a credential-free profile is refused before any provider request, search state, or history write.',
      details: { toast: refusal.errorToasts[0] },
    });

    // --- Part B: a URL entry reaches the same acquisition path urlToPreview proves, records to
    // history, and reselecting that history entry reaches the identical path a search result's
    // click would (setSelectedVideo), all credential-free and network-light. ---
    await clickControl(UNIFIED_URL_TAB);
    const urlField = await $('.url-field');
    await urlField.waitForDisplayed({ timeout: 30_000 });
    await urlField.setValue(REAL_VIDEO.url);
    let resolved = null;
    await waitUntilWithFreshDiagnostic(async () => {
      resolved = await previewState();
      return resolved.videoId.includes(REAL_VIDEO.id) && resolved.downloadOnlyVisible;
    }, {
      timeout: 120_000,
      interval: 2_000,
      diagnostic: () => `the URL never resolved to the same acquisition-path preview: ${JSON.stringify(resolved)}`,
    });
    let urlHistory = await readHistory('youtube_url_history');
    assert.equal(urlHistory.length, 1, 'exactly one YouTube URL history entry must exist after one resolution');
    assert.equal(urlHistory[0].id, REAL_VIDEO.id, 'the recorded history entry names the wrong video');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-url-resolved-and-recorded',
      description: 'The real URL reached the same acquisition-path preview urlToPreview proves, and was durably recorded to history.',
      details: { videoId: REAL_VIDEO.id, historyLength: urlHistory.length },
    });

    await clickControl('.clear-url-btn');
    await waitUntilWithFreshDiagnostic(async () => !(await previewState()).downloadOnlyVisible, {
      timeout: 10_000,
      interval: 200,
      diagnostic: () => 'clearing the field did not withdraw the acquisition-path preview',
    });
    assert.equal(
      (await readHistory('youtube_url_history')).length, 1,
      'clearing the active selection must not touch durable history',
    );

    await clickControl('.history-button');
    await browser.waitUntil(async () => browser.execute(() => {
      const dropdown = document.querySelector('.unified-url-input .history-dropdown');
      return dropdown !== null && getComputedStyle(dropdown).pointerEvents !== 'none';
    }), {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'the history dropdown never became interactive',
    });
    await clickControl('.history-item:first-child');
    let reselected = null;
    await waitUntilWithFreshDiagnostic(async () => {
      reselected = await previewState();
      return reselected.videoId.includes(REAL_VIDEO.id) && reselected.downloadOnlyVisible;
    }, {
      timeout: 30_000,
      interval: 200,
      diagnostic: () => `reselecting the history entry did not reach the same acquisition path: ${JSON.stringify(reselected)}`,
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-history-reselect-same-path',
      description: 'Reselecting the history entry -- the same setSelectedVideo call a search result click would make -- reached the identical acquisition-path preview without retyping the URL.',
      details: { videoId: REAL_VIDEO.id },
    });

    // Dedupe: re-entering the SAME URL must not grow the YouTube lane.
    await urlField.clearValue();
    await urlField.setValue(REAL_VIDEO.url);
    // Wait on the write itself settling rather than a bare pause: the dedupe path re-resolves the
    // URL and rewrites history, and a fixed pause is either a flaky race or padding, never both.
    let dedupedHistory = null;
    await waitUntilWithFreshDiagnostic(async () => {
      dedupedHistory = await readHistory('youtube_url_history');
      return Array.isArray(dedupedHistory) && dedupedHistory.length === 1;
    }, {
      timeout: 15_000,
      interval: 200,
      diagnostic: () => `re-entering the same URL did not settle into a deduped single entry: ${JSON.stringify(dedupedHistory)}`,
    });
    urlHistory = dedupedHistory;
    assert.deepEqual(
      urlHistory.map(({ id }) => id),
      expectedAfterDedupePush([REAL_VIDEO.id], REAL_VIDEO.id),
      'the YouTube history lane must dedupe by video id rather than growing',
    );

    // --- Part C: history survives an in-process navigation away and back. ---
    await clickControl(FILE_UPLOAD_TAB);
    await clickControl(UNIFIED_URL_TAB);
    await waitUntilWithFreshDiagnostic(async () => (await previewState()).videoId.includes(REAL_VIDEO.id), {
      timeout: 15_000,
      interval: 200,
      diagnostic: () => 'the acquisition-path preview did not survive navigating away and back',
    });
    assert.deepEqual(
      (await readHistory('youtube_url_history')).map(({ id }) => id), [REAL_VIDEO.id],
      'URL history did not survive an in-process tab navigation',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-history-survives-navigation',
      description: 'History and the resolved preview both survive switching to another tab and back.',
      details: { historyIds: [REAL_VIDEO.id] },
    });

    // --- Part D: the bounded eviction/no-resurrection boundary this journey can actually prove. ---
    // No delete-one control ships for URL history (see the file header), so "never resurrects a
    // deleted entry" is proven at the real bounded-list eviction boundary instead: MAX_HISTORY_ITEMS.
    // The all-sites lane is used because it never dedupes (generateAllSitesVideoId mints a fresh id
    // every push) and never touches the network, isolating pure push/evict arithmetic.
    const allSitesUrl = (n) => `https://example.com/video-${n}`;
    for (let round = 1; round <= ALL_SITES_ROUNDS; round += 1) {
      await urlField.clearValue();
      await urlField.setValue(allSitesUrl(round));
      const expectedLength = Math.min(round, HISTORY_CAP);
      let allSites = null;
      await waitUntilWithFreshDiagnostic(async () => {
        allSites = await readHistory('all_sites_url_history');
        return Array.isArray(allSites) && allSites.length === expectedLength;
      }, {
        timeout: 10_000,
        interval: 100,
        diagnostic: () => `round ${round}: all-sites history never reached length ${expectedLength}: ${JSON.stringify(allSites)}`,
      });
    }
    let allSites = await readHistory('all_sites_url_history');
    const pushedUrls = Array.from({ length: ALL_SITES_ROUNDS }, (_, index) => allSitesUrl(index + 1));
    const survivorUrls = expectedSurvivors(pushedUrls, HISTORY_CAP);
    const evictedUrls = expectedEvicted(pushedUrls, HISTORY_CAP);
    assert.equal(allSites.length, HISTORY_CAP, `all-sites history must stay bounded at ${HISTORY_CAP}`);
    assert.deepEqual(
      allSites.map(({ url }) => url), survivorUrls,
      'the surviving all-sites entries are not exactly the most recent pushes, newest first',
    );
    assert.equal(evictedUrls.length, 1, 'exactly one entry must have been evicted by this push sequence');
    const [evictedUrl] = evictedUrls;
    assert.equal(
      allSites.some(({ url }) => url === evictedUrl), false,
      'the evicted entry is still present in bounded history',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '06-history-bounded-eviction',
      description: `Pushing ${ALL_SITES_ROUNDS} distinct entries evicted exactly the oldest one and kept the list bounded at ${HISTORY_CAP}.`,
      details: { survivorCount: allSites.length, evictedUrl },
    });

    // Control action: one more, entirely unrelated push must not silently resurrect the evicted URL.
    await urlField.clearValue();
    await urlField.setValue(allSitesUrl(ALL_SITES_ROUNDS + 1));
    await waitUntilWithFreshDiagnostic(async () => {
      allSites = await readHistory('all_sites_url_history');
      return Array.isArray(allSites) && allSites.length === HISTORY_CAP;
    }, {
      timeout: 10_000,
      interval: 100,
      diagnostic: () => `an unrelated push did not keep history bounded at ${HISTORY_CAP}: ${JSON.stringify(allSites)}`,
    });
    assert.equal(
      allSites.some(({ url }) => url === evictedUrl), false,
      'an unrelated action silently resurrected the evicted entry',
    );

    // The evicted URL returns ONLY through genuine, explicit re-entry -- never silently.
    await urlField.clearValue();
    await urlField.setValue(evictedUrl);
    await waitUntilWithFreshDiagnostic(async () => {
      allSites = await readHistory('all_sites_url_history');
      return Array.isArray(allSites) && allSites[0]?.url === evictedUrl;
    }, {
      timeout: 10_000,
      interval: 100,
      diagnostic: () => `explicitly re-entering the evicted URL never re-added it: ${JSON.stringify(allSites)}`,
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '07-eviction-not-silent-resurrection',
      description: 'An unrelated push never resurrected the evicted entry; only an explicit, fresh re-entry of the exact same URL brought it back.',
      details: { evictedUrl, resurrectedByExplicitReentry: true },
    });
  });
});
