import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { createDevFreshnessPlugin } from './vite-dev-freshness.mjs';

// Real Vite + real HTTP. Disabling the watcher deterministically reproduces a lost change event;
// it does not fake the module cache or its invalidation. No application state/provider is involved.
for (const guarded of [false, true]) {
  test(`document reload ${guarded ? 'repairs' : 'demonstrates'} stale dev transforms`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'osg-vite-freshness-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'index.html'), '<html><body>Development document</body></html>');
    await writeFile(join(root, 'metadata.js'), 'export const read = () => removedMetadata();');
    const server = await createServer({
      configFile: false, root, logLevel: 'silent',
      plugins: guarded ? [createDevFreshnessPlugin()] : [],
      server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    context.after(() => server.close());
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    const readModule = async (etag) => {
      const response = await fetch(`${origin}metadata.js`, {
        headers: etag ? { 'If-None-Match': etag } : {},
      });
      return { status: response.status, etag: response.headers.get('etag'), text: await response.text() };
    };
    const initial = await readModule();
    assert.equal(initial.status, 200);
    assert.match(initial.text, /removedMetadata/u);
    await writeFile(join(root, 'metadata.js'), 'export const read = () => "current metadata";');
    // Source is now correct, but the same dev URL still returns the intermediate edit.
    assert.match((await readModule()).text, /removedMetadata/u);
    await fetch(origin).then(response => response.text());
    const reloaded = await readModule(initial.etag);
    if (!guarded) {
      assert.equal(reloaded.status, 304, 'without the repair, Vite validates obsolete browser code');
      assert.match((await readModule()).text, /removedMetadata/u);
      return;
    }
    assert.equal(reloaded.status, 200);
    assert.doesNotMatch(reloaded.text, /removedMetadata/u);
    assert.match(reloaded.text, /current metadata/u);
    assert.notEqual(reloaded.etag, initial.etag);
    assert.equal((await readModule(reloaded.etag)).status, 304, 'ordinary module caching is preserved');

    await writeFile(join(root, 'metadata.js'), 'export const read = () => "newer metadata";');
    await fetch(`${origin}index.html?reload=1`).then(response => response.text());
    assert.match((await readModule()).text, /newer metadata/u, 'explicit document URLs refresh too');
  });
}
