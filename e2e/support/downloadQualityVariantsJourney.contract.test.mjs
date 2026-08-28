import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (...segments) => readFileSync(join(import.meta.dirname, ...segments), 'utf8');

const journeyPath = join(import.meta.dirname, '..', 'journeys', 'downloadQualityVariants.journey.js');
const journey = readFileSync(journeyPath, 'utf8');
const downloadOnlyModal = read('..', '..', 'src', 'components', 'DownloadOnlyModal.js');
const qualityScanner = read('..', '..', 'src', 'utils', 'qualityScanner.js');
const dialogPaths = read('..', '..', 'apps', 'desktop', 'src-tauri', 'src', 'dialog_paths.rs');
const plan = read('..', '..', 'crates', 'osg-download', 'src', 'plan.rs');
const downloadSupport = read('..', 'support', 'download.js');
const urlToPreviewJourney = read('..', 'journeys', 'urlToPreview.journey.js');
const downloadQualityVariantsOracle = read('..', 'support', 'downloadQualityVariantsOracle.js');

const assertJourneyContract = (source) => {
  // The journey drives the real Type radio and real quality pills DownloadOnlyModal.js renders,
  // never a fabricated quality list.
  assert.match(source, /'\.download-only-modal input\[name="download-type"\]\[value="video"\]'/u);
  assert.match(source, /'\.quality-pill-label'/u);
  assert.match(source, /chooseQualityRounds\(scannedQualities\)/u);
  assert.match(source, /rounds\.length >= 2 && rounds\.length <= 3/u);

  // Every round is driven through the ONE shared confirm helper, extended with its own picker rather
  // than a duplicated scan/confirm sequence.
  assert.equal(
    (source.match(/await confirmDownloadOnly\(\{/gu) ?? []).length, 1,
    'the journey must drive every round through one shared confirmDownloadOnly call site',
  );
  assert.match(source, /pickQuality: \(qualities\) => \{/u);
  assert.match(source, /parseQualityHeight\(label\) === round\.height/u);

  // The independent oracle proves the request reached the download: bounded, distinct decoded
  // geometry, never merely claimed in prose.
  assert.match(source, /verifyQualityRound\(\{ round, probe \}\)/u);
  assert.match(source, /assertRoundsAreDistinct\(verified\)/u);
  assert.match(source, /approximateBitrateKbps\(probe\)/u);

  // Durable-ledger shape: one new succeeded job per round, and no surviving artifact/media/scratch.
  assert.match(source, /beforeJobCount \+ verified\.length/u);
  assert.match(source, /after\.artifacts\.length, 0/u);
  assert.match(source, /after\.media\.length, 0/u);
  assert.match(source, /managedArtifactFiles\(root\)/u);
  assert.match(source, /downloadScratchFiles\(root\)/u);

  // The destination is cleared between rounds by MOVING the file, never by re-entering a native
  // dialog or touching product code.
  assert.match(source, /renameSync\(savedPath, keptPath\)/u);
  assert.doesNotMatch(source, /unlinkSync|rmSync/u);

  for (const [label, forbidden] of [
    ['browser storage mutation', /\b(?:localStorage|sessionStorage|indexedDB)\b/u],
    ['private IPC', /__TAURI__|invokeDesktop|invokeCommand/u],
    ['native picker', /showOpen|showSave|input\s*\[\s*type\s*=\s*["']file/u],
    ['raw SQL mutation', /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|app_settings|projects|jobs)\b/iu],
    ['fullscreen request', /requestFullscreen|exitFullscreen/u],
    ['credential/provider reference', /gemini|api[_-]?key|oauth|client[_-]?secret|bearer/iu],
  ]) {
    assert.doesNotMatch(source, forbidden, `journey contains forbidden ${label}`);
  }
};

test('the journey drives every quality round through one reviewed confirm call site', () => {
  assertJourneyContract(journey);
});

test('the contract fails when any one load-bearing assertion is removed', () => {
  for (const needle of [
    'verifyQualityRound({ round, probe })',
    'assertRoundsAreDistinct(verified)',
    'managedArtifactFiles(root)',
    'downloadScratchFiles(root)',
  ]) {
    const weakened = journey.replace(needle, '/* removed */');
    assert.notEqual(weakened, journey, `mutation needle is stale: ${needle}`);
    assert.throws(() => assertJourneyContract(weakened), undefined, needle);
  }
});

test('the two quality controls the journey drives still exist in DownloadOnlyModal.js', () => {
  assert.match(downloadOnlyModal, /name="download-type"/u);
  assert.match(downloadOnlyModal, /value="video"/u);
  assert.match(downloadOnlyModal, /className="quality-pill-label"/u);
  assert.match(downloadOnlyModal, /htmlFor=\{`quality-\$\{index\}`\}/u);
  assert.match(downloadOnlyModal, /quality: \{ mode: 'atMost', height: selectedQuality\.height \}/u);
  // The journey deliberately does not touch Audio: it is out of scope (video geometry only).
  assert.doesNotMatch(journey, /value="audio"/u);
});

test('qualityScanner.js still sorts real qualities tallest-first, which the journey and oracle assume', () => {
  assert.match(qualityScanner, /\.sort\(\(left, right\) => right\.height - left\.height\)/u);
  assert.match(qualityScanner, /quality: `\$\{format\.height\}p`/u);
});

test('the staged destination really has no overwrite/uniquify fallback, which is why rounds are moved aside', () => {
  assert.match(dialogPaths, /destination\.exists\(\)/u);
  assert.doesNotMatch(dialogPaths, /uniquify|overwrite_existing|auto[_-]?rename/iu);
});

test('AtMost video quality really is refused for a direct single-format source', () => {
  assert.match(plan, /direct media has no bounded video height/u);
  assert.match(plan, /VideoQuality::AtMost\(_\)/u);
});

test('the shared confirmDownloadOnly helper exposes the pickQuality seam this journey needs', () => {
  assert.match(downloadSupport, /pickQuality = \(qualities\) => qualities\.length - 1/u);
  assert.match(downloadSupport, /const chosen = pickQuality\(state\.qualities\)/u);
  // urlToPreview keeps using the DEFAULT (lowest) picker; this journey is additive, not a rewrite.
  assert.doesNotMatch(urlToPreviewJourney, /pickQuality/u);
});

test('the oracle module documents why no SQLite/log observable exists for the requested height', () => {
  assert.match(downloadQualityVariantsOracle, /media_assets` carries only/u);
  assert.match(downloadQualityVariantsOracle, /format_selector/u);
});
