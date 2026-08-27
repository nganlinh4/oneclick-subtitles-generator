// Reads every byte of the shared engine/tool asset store so the OS file cache and the
// antivirus's per-file verdict cache are warm before engine journeys launch. The application's
// first status probe per process content-verifies every published engine tree — over 41,000
// files for one engine's Python runtime — and on a cold cache that walk is antivirus-bound at
// tens of minutes. Warming first keeps suite timing claims about the product, not the antivirus;
// the customer-facing cold-start cost itself stays recorded as an open ledger finding.
import { createReadStream, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ASSET_ROOTS = [
  join(
    process.env.LOCALAPPDATA ?? '',
    'OSG-Development', 'cache', 'assets', 'e2e', 'engine-packages',
  ),
  join(
    process.env.LOCALAPPDATA ?? '',
    'OSG-Development', 'cache', 'assets', 'e2e', 'native-tools',
  ),
];

const drain = (path) => new Promise((resolve) => {
  const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 });
  stream.on('data', () => undefined);
  stream.on('error', () => resolve(false));
  stream.on('end', () => resolve(true));
});

let files = 0;
const startedMs = Date.now();
for (const root of ASSET_ROOTS) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        // eslint-disable-next-line no-await-in-loop
        await drain(path);
        files += 1;
      }
    }
  }
}
process.stdout.write(
  `warmed ${files} store file(s) in ${((Date.now() - startedMs) / 1_000).toFixed(1)}s\n`,
);
