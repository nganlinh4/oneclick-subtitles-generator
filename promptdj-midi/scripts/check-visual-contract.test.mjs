import assert from 'node:assert/strict';
import test from 'node:test';

import {
  comparePromptDjManifests,
  createPromptDjManifest,
} from './check-visual-contract.mjs';

function provider(files) {
  return {
    listFiles: () => Object.keys(files).sort(),
    readFile: (file) => Buffer.from(files[file]),
  };
}

test('separates exact, React, Lit render, and Lit style drift', () => {
  const baseline = createPromptDjManifest(provider({
    'index.css': '.app { color: red; }',
    'React.tsx': 'export const View = () => <button>Play</button>',
    'Lit.ts': 'const styles = css`.app { color: red; }`; const view = html`<button>Play</button>`;',
  }), 'a'.repeat(40));
  const actual = createPromptDjManifest(provider({
    'index.css': '.app { color: blue; }',
    'React.tsx': 'export const View = () => <button>Pause</button>',
    'Lit.ts': 'const styles = css`.app { color: blue; }`; const view = html`<button>Pause</button>`;',
  }));
  const changes = comparePromptDjManifests(baseline, actual);
  assert.deepEqual(changes.exactFiles.changed, ['index.css']);
  assert.deepEqual(changes.reactSurfaces.changed, ['React.tsx']);
  assert.deepEqual(changes.litRenderSurfaces.changed, ['Lit.ts']);
  assert.deepEqual(changes.litStyleSurfaces.changed, ['Lit.ts']);
});

test('fails the surface set when a Lit template is added or removed', () => {
  const baseline = createPromptDjManifest(provider({
    'Old.ts': 'const view = html`<p>Old</p>`;',
  }), 'a'.repeat(40));
  const actual = createPromptDjManifest(provider({
    'New.ts': 'const view = html`<p>New</p>`;',
  }));
  const changes = comparePromptDjManifests(baseline, actual);
  assert.deepEqual(changes.litRenderSurfaces.added, ['New.ts']);
  assert.deepEqual(changes.litRenderSurfaces.removed, ['Old.ts']);
});
