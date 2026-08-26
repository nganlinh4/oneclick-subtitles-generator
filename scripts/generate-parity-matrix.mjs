#!/usr/bin/env node
// Freeze the customization matrix the exhaustive parity gate has to cover.
//
// The removal gate must exercise all 30 shipped presets and all 72 persisted options. Those live in
// JavaScript — the presets are React-adjacent data and the schema authority is the renderer package
// — while the gate that compares native frames against decoded exports is Rust. This script is the
// bridge, and it is generated from the real modules rather than transcribed, so a preset added or a
// field renamed shows up here instead of silently falling outside the gate.
//
// It emits three things:
//
//   * `presets`     — every shipped preset, fully merged against the defaults, so the gate renders
//                     what a user actually gets rather than the sparse override the preset stores.
//   * `fieldMatrix` — for each of the 56 subtitle fields, the values worth rendering: the default,
//                     the bounds the validator accepts, and any value the parity ledger calls out as
//                     behaving unusually. This is what turns "all 72 fields" into a finite run.
//   * `coverage`    — the arithmetic that proves nothing was skipped, asserted by the gate itself.
//
// Regenerate deliberately, never to make a failing gate pass:
//   node scripts/generate-parity-matrix.mjs

import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_FIXTURE_PATH = join(
  REPOSITORY_ROOT,
  'crates/osg-export/tests/fixtures/parity-matrix.json',
);

const outputPath = () => {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 0) return DEFAULT_FIXTURE_PATH;
  if (arguments_.length !== 2 || arguments_[0] !== '--output' || !arguments_[1]) {
    throw new Error('usage: generate-parity-matrix.mjs [--output <path>]');
  }
  return resolve(arguments_[1]);
};

const ENTRY = `
export { presets, presetOrder } from ${JSON.stringify(
  join(REPOSITORY_ROOT, 'src/components/subtitleCustomization/presetDefinitions.js'),
)};
export { defaultCustomization, mergeSubtitleCustomizationDefaults } from ${JSON.stringify(
  join(REPOSITORY_ROOT, 'src/components/subtitleCustomization/defaultCustomization.js'),
)};
export {
  RENDER_PARITY_LEDGER,
  RENDER_OUTPUT_PARITY_LEDGER,
} from ${JSON.stringify(join(REPOSITORY_ROOT, 'src/platform/renderParityLedger.js'))};
`;

/**
 * Values worth rendering per field, beyond the default.
 *
 * Chosen from what the validator accepts and what the ledger records as surprising, not from what
 * looks tidy. A field absent from here is covered by its default and by whichever presets set it.
 */
const INTERESTING = Object.freeze({
  fontSize: [8, 24, 200],
  fontWeight: [100, 400, 900],
  lineHeight: [0.5, 1.0, 3.0],
  letterSpacing: [-5, 0, 40],
  textTransform: ['none', 'uppercase', 'lowercase', 'capitalize'],
  textAlign: ['left', 'center', 'right', 'justify'],
  // The ledger records that opacity 50 lands on 127, not 128, because 2.55 is not representable.
  backgroundOpacity: [0, 1, 50, 99, 100],
  backgroundPaddingX: [0, 16, 30, 100],
  backgroundPaddingY: [0, 8, 30, 100],
  // #rgba is accepted by every validator and parses; as a background it is refused deliberately.
  backgroundColor: ['#000000', '#101820', '#abc'],
  borderRadius: [0, 4, 100],
  borderWidth: [0, 1, 20],
  borderStyle: ['none', 'solid', 'dashed', 'dotted', 'double'],
  textShadowEnabled: [false, true],
  textShadowBlur: [0, 4, 50],
  textShadowOffsetX: [-25, 0, 25],
  textShadowOffsetY: [-25, 0, 25],
  glowEnabled: [false, true],
  glowIntensity: [0, 20, 100],
  strokeEnabled: [false, true],
  strokeWidth: [0, 2, 10],
  gradientEnabled: [false, true],
  gradientDirection: ['0deg', '90deg', '180deg', '360deg'],
  position: ['bottom', 'top', 'center', 'custom'],
  customPositionX: [-100, 0, 100],
  customPositionY: [-100, 0, 100],
  marginBottom: [0, 41.31, 200],
  marginTop: [0, 20.682, 200],
  marginLeft: [0, 4.704, 200],
  marginRight: [0, 73.44, 200],
  maxWidth: [10, 80, 100],
  fadeInDuration: [0, 0.3, 2],
  fadeOutDuration: [0, 0.3, 2],
  animationType: [
    'fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right',
    'scale', 'bounce', 'flip', 'rotate', 'typewriter',
  ],
  animationEasing: [
    'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out',
    'cubic-bezier(0.25, 0.46, 0.45, 0.94)', 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
  ],
  wordWrap: [false, true],
  rtlSupport: [false, true],
});

/** Text worth rendering. The gate must not only ever draw Latin. */
const TEXTS = Object.freeze([
  { id: 'latin', text: 'The quick brown fox' },
  { id: 'korean', text: '한국어 자막' },
  { id: 'vietnamese', text: 'Tiếng Việt có dấu' },
  { id: 'arabic', text: 'مرحبا بالعالم' },
  { id: 'mixed-rtl', text: 'Latin مرحبا 123 tail' },
  { id: 'emoji', text: 'Family 👨‍👩‍👧 flag 🇰🇷' },
  { id: 'combining', text: 'áèîõü nfd' },
  { id: 'long-word', text: 'Pneumonoultramicroscopicsilicovolcanoconiosis' },
  { id: 'dense', text: 'One two three four five six seven eight nine ten eleven twelve' },
]);

/** Output shapes worth rendering. */
const OUTPUTS = Object.freeze([
  { id: 'sd-30', resolution: '480p', frameRate: 30 },
  { id: 'hd-2997', resolution: '1080p', frameRate: 30 },
  { id: 'hd-25', resolution: '720p', frameRate: 25 },
  { id: 'uhd-60', resolution: '4K', frameRate: 60 },
]);

const bundle = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'osg-parity-matrix-'));
  try {
    const outfile = join(directory, 'matrix.mjs');
    await build({
      stdin: { contents: ENTRY, resolveDir: REPOSITORY_ROOT, sourcefile: 'entry.js', loader: 'js' },
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const main = async () => {
  const fixturePath = outputPath();
  const module = await bundle();
  const { presets, presetOrder, defaultCustomization, mergeSubtitleCustomizationDefaults } = module;
  const { RENDER_PARITY_LEDGER, RENDER_OUTPUT_PARITY_LEDGER } = module;

  const fields = Object.keys(defaultCustomization).sort();
  const ledgerFields = Object.keys(RENDER_PARITY_LEDGER).sort();
  if (fields.join() !== ledgerFields.join()) {
    throw new Error('the ledger and the schema disagree about which fields exist');
  }

  const missing = Object.keys(presets).filter((id) => !presetOrder.includes(id));
  if (missing.length > 0) {
    throw new Error(`presets missing from presetOrder: ${missing.join(', ')}`);
  }

  // Merge each preset against the defaults. A preset stores only its overrides, and the gate has to
  // render what the user sees, which is the merged result.
  const mergedPresets = presetOrder.map((id) => ({
    id,
    customization: mergeSubtitleCustomizationDefaults(presets[id]),
  }));

  // The default is always rendered, whatever else is interesting about a field. Listing bounds and
  // quirks without it would leave the value every project actually carries outside the gate — which
  // is the one value a regression is most likely to break.
  const fieldMatrix = fields.map((field) => {
    const fallback = defaultCustomization[field];
    const interesting = Object.hasOwn(INTERESTING, field) ? INTERESTING[field] : [];
    const values = [];
    for (const value of [fallback, ...interesting]) {
      if (!values.some((existing) => JSON.stringify(existing) === JSON.stringify(value))) {
        values.push(value);
      }
    }
    return {
      field,
      disposition: RENDER_PARITY_LEDGER[field].disposition,
      default: fallback,
      values,
    };
  });

  const outputFields = Object.keys(RENDER_OUTPUT_PARITY_LEDGER).sort();

  const fixture = {
    // Bumped whenever the shape changes, so a stale fixture fails loudly instead of under-covering.
    version: 1,
    coverage: {
      presets: mergedPresets.length,
      subtitleFields: fields.length,
      outputFields: outputFields.length,
      totalPersistedOptions: fields.length + outputFields.length,
      texts: TEXTS.length,
      outputs: OUTPUTS.length,
      // Every field contributes at least its default, so this is the real number of renders the
      // field sweep costs, not an estimate.
      fieldValueRenders: fieldMatrix.reduce((total, entry) => total + entry.values.length, 0),
    },
    presets: mergedPresets,
    fieldMatrix,
    outputFields,
    texts: TEXTS,
    outputs: OUTPUTS,
  };

  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

  const { coverage } = fixture;
  process.stdout.write(
    `parity matrix: ${coverage.presets} presets, ${coverage.totalPersistedOptions} persisted options `
      + `(${coverage.subtitleFields} subtitle + ${coverage.outputFields} output), `
      + `${coverage.fieldValueRenders} field-value renders, ${coverage.texts} texts, `
      + `${coverage.outputs} output shapes\n`,
  );
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
