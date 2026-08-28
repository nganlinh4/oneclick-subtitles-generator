import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (...segments) => readFileSync(join(import.meta.dirname, ...segments), 'utf8');

const journeyPath = join(import.meta.dirname, '..', 'journeys', 'youtubeSearchAndHistory.journey.js');
const journey = readFileSync(journeyPath, 'utf8');
const searchInput = read('..', '..', 'src', 'components', 'inputs', 'YoutubeSearchInput.js');
const unifiedUrlInput = read('..', '..', 'src', 'components', 'inputs', 'UnifiedUrlInput.js');
const inputMethods = read('..', '..', 'src', 'components', 'InputMethods.js');
const appState = read('..', '..', 'src', 'components', 'app', 'AppState.js');
const providerService = read('..', '..', 'src', 'platform', 'providerService.js');
const historyUtils = read('..', '..', 'src', 'utils', 'historyUtils.js');
const mediaUrl = read('..', '..', 'src', 'utils', 'mediaUrl.js');
const urlHistory = read('..', '..', 'src', 'components', 'inputs', 'urlHistory.js');
const otherSettingsJourney = read('..', 'journeys', 'settingsVideoProcessingAndPrompts.journey.js');
const urlToPreviewJourney = read('..', 'journeys', 'urlToPreview.journey.js');
const oracle = read('..', 'support', 'youtubeSearchAndHistoryOracle.js');

const assertJourneyContract = (source) => {
  // The setting is turned on through the real Settings control, not fabricated.
  assert.match(source, /toggleSwitch\('#enable-youtube-search'\)/u);
  assert.match(source, /youtubeSearch\.after, true/u);

  // The credential-free refusal is proven BEFORE any search-history write or result publication.
  assert.match(source, /errorToasts\.length > 0/u);
  assert.match(source, /API key/iu);
  assert.match(source, /resultCount, 0/u);
  assert.match(source, /searching, false/u);
  assert.match(source, /readHistory\('youtube_search_history'\), null/u);

  // The acquisition path is the SAME one urlToPreview proves: video id and download-only-btn.
  assert.match(source, /downloadOnlyVisible/u);
  assert.match(source, /REAL_VIDEO\.id/u);

  // History reselect (not a fabricated fresh URL entry) reaches that same path.
  assert.match(source, /'\.history-item:first-child'/u);
  assert.match(source, /reselected\.videoId\.includes\(REAL_VIDEO\.id\) && reselected\.downloadOnlyVisible/u);

  // Dedupe uses the independent oracle rather than a hand-rolled duplicate of upsert arithmetic.
  assert.match(source, /expectedAfterDedupePush\(\[REAL_VIDEO\.id\], REAL_VIDEO\.id\)/u);

  // Navigation survival is checked against a REAL tab switch, not merely re-reading storage in place.
  assert.match(source, /clickControl\(FILE_UPLOAD_TAB\)/u);
  assert.match(source, /clickControl\(UNIFIED_URL_TAB\)/u);

  // Bounded eviction is checked against the independent oracle, at the product's real cap.
  assert.match(source, /expectedSurvivors\(pushedUrls, HISTORY_CAP\)/u);
  assert.match(source, /expectedEvicted\(pushedUrls, HISTORY_CAP\)/u);
  assert.match(source, /HISTORY_CAP = 10/u);
  assert.match(source, /ALL_SITES_ROUNDS = HISTORY_CAP \+ 1/u);

  // No silent resurrection is proven with BOTH a negative control and an explicit positive re-entry.
  assert.match(source, /an unrelated action silently resurrected the evicted entry/u);
  assert.match(source, /allSites\[0\]\?\.url === evictedUrl/u);

  for (const [label, forbidden] of [
    ['private IPC', /__TAURI__|invokeDesktop|invokeCommand/u],
    ['native picker', /showOpen|showSave|input\s*\[\s*type\s*=\s*["']file/u],
    ['raw SQL', /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|app_settings|projects|jobs)\b/iu],
    ['fullscreen request', /requestFullscreen|exitFullscreen/u],
    ['a real provider credential value', /AIza|ya29\.|client_secret['"]?\s*:\s*['"][^'"]{10,}/u],
  ]) {
    assert.doesNotMatch(source, forbidden, `journey contains forbidden ${label}`);
  }
};

test('the journey proves the credential-free refusal boundary and the shared acquisition path', () => {
  assertJourneyContract(journey);
});

test('the contract fails when any one load-bearing assertion is removed', () => {
  for (const needle of [
    "assert.equal(refusal.resultCount, 0",
    'expectedAfterDedupePush(',
    'expectedSurvivors(pushedUrls, HISTORY_CAP)',
  ]) {
    const weakened = journey.replace(needle, '/* removed */');
    assert.notEqual(weakened, journey, `mutation needle is stale: ${needle}`);
    assert.throws(() => assertJourneyContract(weakened), undefined, needle);
  }
  // This exact defense-in-depth check appears twice (the clean-profile baseline and the post-refusal
  // proof); removing both is the only way to actually weaken the invariant, so this one uses
  // replaceAll rather than the single-replace loop above.
  const bothOccurrencesRemoved = journey.replaceAll(
    "readHistory('youtube_search_history'), null", '/* removed */',
  );
  assert.notEqual(bothOccurrencesRemoved, journey, 'mutation needle is stale: youtube_search_history null checks');
  assert.throws(() => assertJourneyContract(bothOccurrencesRemoved));
});

test('search really has no credential-free path: the guard fires before the native command', () => {
  assert.match(searchInput, /!isOAuthEnabled\(\) && !apiKeysSet\.youtube/u);
  assert.match(searchInput, /youtube\.noApiKey/u);
  // The guard's own `return` precedes both the history write and the search call in source order.
  const guardIndex = searchInput.indexOf('!isOAuthEnabled() && !apiKeysSet.youtube');
  const historyWriteIndex = searchInput.indexOf('addSearchQueryToHistory(debouncedSearchQuery)');
  const searchCallIndex = searchInput.indexOf('searchYouTube(debouncedSearchQuery)');
  assert.ok(guardIndex >= 0 && historyWriteIndex > guardIndex && searchCallIndex > historyWriteIndex);
  assert.match(providerService, /requireReadyCredential\(current, 'youtubeApiKey'\)/u);
  assert.match(providerService, /'YouTube API key not found'/u);
});

test('the search tab really is gated off by default and unlocked by the exact setting the journey toggles', () => {
  assert.match(appState, /enable_youtube_search.*===\s*'true'/u);
  assert.match(inputMethods, /\{enableYoutubeSearch && \(/u);
  assert.doesNotMatch(inputMethods, /data-input-tab="youtube-search"/u);
});

test('selecting a search result and reselecting from URL history both call the one lifted setSelectedVideo', () => {
  assert.match(searchInput, /setSelectedVideo\(\{\s*\.\.\.video\s*\}\)/mu);
  assert.match(urlHistory, /setSelectedVideo\(\{/u);
});

test('the all-sites lane really does not dedupe (a fresh id every push), which is why eviction uses it', () => {
  assert.match(mediaUrl, /site_\$\{normalized\}_\$\{Date\.now\(\)\}/u);
});

test('historyUtils.js really has no per-item delete for URL history, and the cap the oracle assumes is real', () => {
  assert.match(historyUtils, /MAX_HISTORY_ITEMS = 10/u);
  assert.doesNotMatch(unifiedUrlInput, /clear-history-btn|removeHistoryItem|deleteHistoryItem/u);
});

test('this journey targets its own ground: it does not duplicate the settings round-trip journey', () => {
  assert.doesNotMatch(journey, /activateTab\('prompts'\)/u);
  assert.doesNotMatch(journey, /transcription-prompt/u);
  assert.match(otherSettingsJourney, /enable-youtube-search/u);
});

test('this journey does not duplicate urlToPreview\'s own download/quality-scan proof', () => {
  // The journey checks .download-only-btn's PRESENCE as proof of reaching the shared preview -- it
  // never CLICKS it, scans qualities, or confirms a download the way urlToPreview already does.
  assert.doesNotMatch(journey, /clickControl\('\.download-only-btn'\)|confirmDownloadOnly|quality-pill-label/u);
  assert.match(journey, /document\.querySelector\('\.unified-url-input \.download-only-btn'\)/u);
  assert.match(urlToPreviewJourney, /clickControl\('\.download-only-btn'\)/u);
});

test('the eviction oracle documents the same list arithmetic historyUtils.js implements', () => {
  assert.match(oracle, /upsertHistoryItem/u);
  assert.match(oracle, /MAX_HISTORY_ITEMS/u);
});
