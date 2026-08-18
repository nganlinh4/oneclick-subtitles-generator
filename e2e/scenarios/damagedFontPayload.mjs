import { spawnSync } from 'node:child_process';

import {
  corruptFontResource,
  discardStagedApplication,
  removeFontResource,
  stageApplication,
  stagedBinary,
  stagedFontResources,
} from '../support/stageApplication.js';

/**
 * Run the font journey against installations whose shipped font bytes are damaged.
 *
 * A separate runner because the harness resolves the binary when its configuration loads, so one
 * `wdio` invocation tests one installation. Each case below stages its own copy, breaks it in one
 * specific way, and runs the same journey against it.
 *
 * WHAT IS ASSERTED IS THE GUARANTEE, NOT THE OUTCOME. With a network the delivery fallback repairs
 * a damaged bundle and the font becomes ready; without one it cannot, and the application must say
 * so with a typed cause. Both are correct. What is never correct is waiting forever, and that is
 * what the journey checks, so this is deterministic on a build machine and on an air-gapped one.
 */

const CASES = [
  {
    name: 'a shipped font resource whose bytes are not what its name claims',
    damage: (staged) => {
      const [first] = stagedFontResources(staged);
      if (!first) throw new Error('the staged application ships no font resources to damage');
      // Same length, different bytes: only the digest can tell, which is the point of naming a
      // resource after its own hash.
      const bytes = corruptFontResource(staged, first);
      return `${first} (${bytes} bytes replaced)`;
    },
  },
  {
    name: 'a shipped font resource that is missing entirely',
    damage: (staged) => {
      const [first] = stagedFontResources(staged);
      if (!first) throw new Error('the staged application ships no font resources to damage');
      removeFontResource(staged, first);
      return first;
    },
  },
];

let failures = 0;

for (const testCase of CASES) {
  const staged = stageApplication();
  try {
    const damaged = testCase.damage(staged);
    console.log(`\n=== ${testCase.name}\n    damaged: ${damaged}`);

    const result = spawnSync(
      'npx',
      ['wdio', 'run', 'wdio.conf.js', '--spec', './journeys/damagedFontPayload.journey.js'],
      {
        cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
        env: { ...process.env, OSG_E2E_BINARY: stagedBinary(staged) },
        stdio: 'inherit',
        shell: process.platform === 'win32',
      },
    );
    if (result.status !== 0) {
      failures += 1;
      console.error(`FAILED: ${testCase.name}`);
    }
  } finally {
    discardStagedApplication(staged);
  }
}

if (failures > 0) {
  console.error(`\n${failures} damaged-payload case(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${CASES.length} damaged-payload cases behaved correctly.`);
}
