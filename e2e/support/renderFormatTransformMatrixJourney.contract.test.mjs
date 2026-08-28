import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  FRAME_RATE_DROPDOWN_OPTIONS, RESOLUTION_DROPDOWN_OPTIONS,
} from './renderFormatTransformMatrixOracle.js';

const journeyPath = join(
  import.meta.dirname, '..', 'journeys', 'renderFormatTransformMatrix.journey.js',
);
const renderSettingsRowPath = join(
  import.meta.dirname, '..', '..', 'src', 'components', 'VideoRenderingSection', 'RenderSettingsRow.js',
);
const cropControlsPath = join(
  import.meta.dirname, '..', '..', 'src', 'components', 'VideoCropControls.js',
);

const count = (source, needle) => source.split(needle).length - 1;

const assertJourneyContract = (source) => {
  // One render call SITE, driven by the shared matrix loop -- five renders at runtime from one
  // reviewed click path, rather than five hand-written near-duplicate render blocks.
  assert.equal(count(source, 'await clickControl(RENDER_BUTTON);'), 1, (
    'the journey must drive every matrix case through one shared render call site'
  ));
  assert.match(source, /for \(const matrixCase of RENDER_TRANSFORM_MATRIX_CASES\)/u);
  assert.match(source, /verifyRenderMatrixCase\(\{/u);

  // The crop transform is applied only for the one case that opts into it, and is click-only.
  assert.match(source, /matrixCase\.crop === '1:1' \? await applySquareCrop\(root\) : null/u);
  assert.match(source, /await \$\('\.crop-toggle-btn'\)/u);
  assert.match(source, /await \$\('\.crop-aspect-buttons button\[title="1:1"\]'\)/u);
  assert.match(source, /await \$\('\.crop-action-btn\.apply'\)/u);

  // The crop case's decoded geometry is checked against both squareness and its own baseline.
  assert.match(source, /assert\.equal\(cropped\.width, cropped\.height/u);
  assert.match(source, /assert\.notEqual\(\s*cropped\.width,\s*baseline\.width/mu);

  // The one fixed codec is proven empirically across every case, not only claimed in prose.
  assert.match(source, /assert\.equal\(videoCodecs\.size, 1/u);
  assert.match(source, /assert\.equal\(audioCodecs\.size, 1/u);

  // Independent oracles beyond the decoded ffprobe geometry itself.
  assert.match(source, /assertManagedArtifactLedgerMatchesDisk\(root\)/u);
  assert.match(source, /installTransientRenderErrorLedger\(\)/u);
  assert.match(source, /assertNoRenderFailure\(surface\)/u);
  assert.match(source, /artifact\.project_id, projectId/u);

  for (const [label, forbidden] of [
    ['browser storage mutation', /\b(?:localStorage|sessionStorage|indexedDB)\b/u],
    ['private IPC', /__TAURI__|invokeDesktop|invokeCommand/u],
    ['native picker', /showOpen|showSave|input\s*\[\s*type\s*=\s*["']file/u],
    ['raw SQL mutation', /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|app_settings|projects|jobs)\b/iu],
    ['pointer-drag crop authoring', /handleMouseDown|onMouseDown|dispatchEvent\(new (?:Mouse|Pointer)Event/u],
    ['fullscreen request', /requestFullscreen|exitFullscreen/u],
  ]) {
    assert.doesNotMatch(source, forbidden, `journey contains forbidden ${label}`);
  }
};

test('the journey drives every matrix case through one reviewed render call site', () => {
  const source = readFileSync(journeyPath, 'utf8');
  assertJourneyContract(source);
});

test('the contract fails when any one load-bearing matrix assertion is removed', () => {
  const source = readFileSync(journeyPath, 'utf8');
  for (const needle of [
    'verifyRenderMatrixCase({',
    'assert.equal(cropped.width, cropped.height',
    'assertManagedArtifactLedgerMatchesDisk(root)',
    "artifact.project_id, projectId",
  ]) {
    const weakened = source.replace(needle, '/* removed */');
    assert.notEqual(weakened, source, `mutation needle is stale: ${needle}`);
    assert.throws(() => assertJourneyContract(weakened), undefined, needle);
  }
});

test('the matrix covers exactly the two dropdowns RenderSettingsRow.js actually renders', () => {
  const component = readFileSync(renderSettingsRowPath, 'utf8');
  const resolutionValues = [...component.matchAll(/\{ value: '([^']+)', label: '[^']*' \}/gu)]
    .map(([, value]) => value);
  assert.deepEqual(resolutionValues, [...RESOLUTION_DROPDOWN_OPTIONS], (
    'the Resolution dropdown options changed; the matrix/oracle enumeration is stale'
  ));
  const frameRateValues = [...component.matchAll(/\{ value: (\d+), label: t\(/gu)]
    .map(([, value]) => Number(value));
  assert.deepEqual(frameRateValues, [...FRAME_RATE_DROPDOWN_OPTIONS], (
    'the Frame Rate dropdown options changed; the matrix/oracle enumeration is stale'
  ));
  assert.doesNotMatch(
    component,
    /container|codec/iu,
    'RenderSettingsRow.js grew a container/codec control the matrix does not cover',
  );
});

test('the crop control selectors the journey drives still exist in VideoCropControls.js', () => {
  const component = readFileSync(cropControlsPath, 'utf8');
  assert.match(component, /className=\{`crop-toggle-btn/u);
  assert.match(component, /className="crop-aspect-buttons"/u);
  assert.match(component, /title=\{preset\.value == null[^}]*\}/u);
  assert.match(component, /className="crop-action-btn apply"/u);
  assert.match(component, /label: '1:1', value: 1,/u);
});
