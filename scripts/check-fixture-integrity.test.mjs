import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditFixtureIntegrity } from './check-fixture-integrity.mjs';

/**
 * A miniature repository shaped like the real one in every way this scan looks at: an e2e fixture
 * directory, a journey that reads one fixture through `join(FIXTURE_ROOT, '<name>')`, a support
 * module declaring a `..._FIXTURE` constant, a benchmark manifest naming its fixtures by path, and
 * one crate's `tests/fixtures` directory.
 */
function fixture(root) {
  const e2eFixtures = path.join(root, 'e2e', 'fixtures', 'subtitles');
  const e2eJourneys = path.join(root, 'e2e', 'journeys');
  const e2eSupport = path.join(root, 'e2e', 'support');
  const benchmarkDir = path.join(root, 'tests', 'subtitle-benchmark');
  const benchmarkFixtures = path.join(benchmarkDir, 'fixtures');
  const crateFixtures = path.join(root, 'crates', 'demo-crate', 'tests', 'fixtures');

  for (const directory of [e2eFixtures, e2eJourneys, e2eSupport, benchmarkFixtures, crateFixtures]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  fs.writeFileSync(path.join(e2eFixtures, 'cues-a.srt'), 'tracked, referenced by a literal call');
  fs.writeFileSync(path.join(e2eFixtures, 'cues-orphan.srt'), 'present on disk but never committed');

  fs.writeFileSync(
    path.join(e2eJourneys, 'demo.journey.js'),
    [
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "import { FIXTURE_ROOT } from '../support/environment.js';",
      '',
      "readFileSync(join(FIXTURE_ROOT, 'cues-a.srt'), 'utf8');",
      "readFileSync(join(FIXTURE_ROOT, 'cues-missing.srt'), 'utf8');",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(e2eSupport, 'workflow.js'),
    "export const SUBTITLE_FIXTURE = 'cues-a.srt';\n",
  );
  // A test file's own fixture-shaped strings must not be scanned as real references.
  fs.writeFileSync(
    path.join(e2eSupport, 'workflow.test.mjs'),
    "const NOT_A_REAL_FIXTURE = 'cues-should-be-ignored.srt';\n",
  );

  fs.writeFileSync(path.join(benchmarkFixtures, 'en-a.flac'), 'tracked benchmark fixture');
  fs.writeFileSync(
    path.join(benchmarkDir, 'manifest.json'),
    JSON.stringify({
      transcription_cases: [
        { id: 'a', fixture: 'fixtures/en-a.flac' },
        { id: 'b', fixture: 'fixtures/en-missing.flac' },
      ],
    }),
  );

  fs.writeFileSync(path.join(crateFixtures, 'demo.bin'), 'tracked crate fixture');

  return {
    tracked: new Set([
      'e2e/fixtures/subtitles/cues-a.srt',
      'e2e/journeys/demo.journey.js',
      'e2e/support/workflow.js',
      'e2e/support/workflow.test.mjs',
      'tests/subtitle-benchmark/manifest.json',
      'tests/subtitle-benchmark/fixtures/en-a.flac',
      'crates/demo-crate/tests/fixtures/demo.bin',
      // Deliberately omitted: cues-orphan.srt, cues-missing.srt, en-missing.flac.
    ]),
  };
}

const withFixtureRoot = (callback) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-fixture-integrity-'));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test('reports no violations when every present and referenced fixture is tracked', () => {
  withFixtureRoot((root) => {
    const { tracked } = fixture(root);
    // Complete the tracked set so nothing is missing, proving the pass direction.
    tracked.add('e2e/fixtures/subtitles/cues-orphan.srt');
    tracked.add('tests/subtitle-benchmark/fixtures/en-missing.flac');
    fs.writeFileSync(
      path.join(root, 'e2e', 'journeys', 'demo.journey.js'),
      [
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "import { FIXTURE_ROOT } from '../support/environment.js';",
        '',
        "readFileSync(join(FIXTURE_ROOT, 'cues-a.srt'), 'utf8');",
        '',
      ].join('\n'),
    );

    const report = auditFixtureIntegrity({ rootDirectory: root, trackedFiles: tracked });

    assert.deepEqual(report.violations, []);
    assert.ok(report.filesChecked > 0);
    assert.ok(report.referencesChecked > 0);
  });
});

test('flags a fixture file present on disk but not tracked by git', () => {
  withFixtureRoot((root) => {
    const { tracked } = fixture(root);
    tracked.add('tests/subtitle-benchmark/fixtures/en-missing.flac');
    // Remove the only reference-shaped violation so the file-membership case is isolated.
    fs.writeFileSync(
      path.join(root, 'e2e', 'journeys', 'demo.journey.js'),
      "readFileSync(join(FIXTURE_ROOT, 'cues-a.srt'), 'utf8');\n",
    );

    const report = auditFixtureIntegrity({ rootDirectory: root, trackedFiles: tracked });

    assert.equal(
      report.violations.some((violation) => (
        violation.kind === 'untracked-fixture-file'
        && violation.path === 'e2e/fixtures/subtitles/cues-orphan.srt'
      )),
      true,
    );
  });
});

test('flags a journey and a manifest each referencing a fixture git does not track', () => {
  withFixtureRoot((root) => {
    const { tracked } = fixture(root);

    const report = auditFixtureIntegrity({ rootDirectory: root, trackedFiles: tracked });

    assert.equal(
      report.violations.some((violation) => (
        violation.kind === 'untracked-fixture-reference'
        && violation.path === 'e2e/fixtures/subtitles/cues-missing.srt'
      )),
      true,
      'a literal join(FIXTURE_ROOT, ...) reference to a missing fixture must be flagged',
    );
    assert.equal(
      report.violations.some((violation) => (
        violation.kind === 'untracked-fixture-reference'
        && violation.path === 'tests/subtitle-benchmark/fixtures/en-missing.flac'
      )),
      true,
      'a manifest.json "fixture" entry for a missing fixture must be flagged',
    );
    assert.equal(
      report.violations.some((violation) => violation.path.includes('should-be-ignored')),
      false,
      'a *.test.mjs file is not scanned as a real reference source',
    );
  });
});

test('discovers a new crate fixtures directory without being told about it by name', () => {
  withFixtureRoot((root) => {
    const { tracked } = fixture(root);
    const otherCrateFixtures = path.join(root, 'crates', 'another-crate', 'tests', 'fixtures');
    fs.mkdirSync(otherCrateFixtures, { recursive: true });
    fs.writeFileSync(path.join(otherCrateFixtures, 'untracked.bin'), 'never committed');

    const report = auditFixtureIntegrity({ rootDirectory: root, trackedFiles: tracked });

    assert.equal(
      report.violations.some((violation) => (
        violation.path === 'crates/another-crate/tests/fixtures/untracked.bin'
      )),
      true,
    );
  });
});
