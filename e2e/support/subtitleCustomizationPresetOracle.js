import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

const SCREENSHOT_PRESETS = new Set([
  'default',
  'modern',
  'classic',
  'neon',
  'minimal',
  'gaming',
  'cinematic',
  'vaporwave',
  'retro',
  'comic',
]);

const PRESET_DIGESTS = Object.freeze({
  default: 'e6dbc49bb939385bf5c2621b551ed0964b7c7a94dc20c0ddeeebe7d2ddf32fee',
  modern: '5ee9a630c52f98ddd77ed1b8de10bef8350ef8fde2b6d8122033207644d79884',
  classic: 'bccb3d10ee9112e738d395b40869a1779d123330b410936696bc1aee0ded7d79',
  neon: '614139a52000c0ad06876eb5ef0e66a716d4f3d174730a371f5bc100b7bae71e',
  minimal: '1be6a2dce4bc23f8266797d11ed65f6a57f7c2184199fa50e816630e7d119b28',
  gaming: 'fbe6f14e8a9c24fb6c921e931330b19dc3ddc73770991d1a88ce1d39ca97a6bb',
  cinematic: '04e0b2e1acbf2b9f3c8c9952ede097809d64116bac7f084f4be9d90ff0a16914',
  gradient: '4e68d7e4e98be528a05d22fdd5f0b36147879d5be2f0cf3403e083d70667e491',
  retro: '7ba3e746e4ba450de99b5a99c94f81df840a527ca753e5051c726ecb51bf5cba',
  elegant: 'f7dc431f2ecbb28c993d0009cbd1390a4b34c2cb343318f9cf7d31747741690d',
  cyberpunk: 'aa71b02420726fce3f091b060e9d740e3456a646058d8ca60045e3bd06692b1e',
  vintage: '6a87af753ef29bc5f72fb59bb60bfdd2124292ebc2ebd6fe99bb02bc38901066',
  comic: '6b94975aebbfa4a14e2013d17358f5cb4b2a86813691650cf983f32c4d4d8fa7',
  horror: '2a077a88c1f745b28b80c4720cae54cde42a239ba7ecce1ac6b5f28553beb739',
  luxury: '3c7336f435380fd26639449bc9109463287bf9abcbab54b0044b32783220fc78',
  kawaii: 'db3d36f9fabdcdee55c628d07daca206622dc16b2c34adafc60062b56158ea3b',
  grunge: 'fe6a9a0abee2a1bedf7af3ee78ef0c88352865725df31a8ce3372df4b053c898',
  corporate: '4060a4ff3df92b78faa21461ae7302fac5727c86cd3f1731d71e0f690735c1d7',
  anime: '0376ce437253652ad6dcf7e1bdb26c1157f6c41d28949f24b75b6296b141f1a7',
  vaporwave: 'd56dcffd63905ec4983be3e6861c6d3275a7abee4a743caa43a7522c8c97fb58',
  steampunk: '5610afd7322f68c1151d6e1d7b4132c753d51030e80af102c52943216fc980ac',
  noir: 'e3bf55ca06ccb85b6398e74bfb9530f6a69dc038f6ec762353ac0a0fb216ca4e',
  pastel: '45aea960209c4dcdde5a1fe3f17dd43309ef0733d06a207a950b393da6ce9fa1',
  bold: '75407be1642410a009c13a3710b2c16c58a31250fcf925f3b97bc62f510dafbe',
  sketch: '72b451d7f7f8f6dacaed8cc887e51582af0e9fc274bf57cbe642390afbdb1275',
  glitch: '4eb0fe896a2bc2d08db62611a39a3822db7ffa005206fca077dc2cf51455919a',
  royal: 'cd622ab343853f213c7e90cab36d57e6676f8ee56a87d3e58e85f83e80a82866',
  sunset: '52b18f9312a4f397acec487095db7ffd578e8f2dc8e2f9d7ad56e7429fd27d09',
  ocean: 'e92168983888faf3dd0d32790906b88e2aa9f55cd2c9a3bbd43f35e8128451ab',
  forest: '82fe416cf466f60f7f9da3b5376476838c39872ada4aad7bd800073a872c49af',
});

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
    );
  }
  return value;
};

export const customizationDigest = (customization) => {
  assert.ok(customization !== null && typeof customization === 'object' && !Array.isArray(customization), (
    'preset customization must be an object'
  ));
  return createHash('sha256')
    .update(JSON.stringify(stableValue(customization)))
    .digest('hex');
};

export const SUBTITLE_PRESET_MATRIX = Object.freeze(
  Object.entries(PRESET_DIGESTS).map(([id, digest], index) => {
    const ordinal = String(index + 1).padStart(2, '0');
    const evidenceStem = `preset-${ordinal}-${id}`;
    const captureScreenshot = SCREENSHOT_PRESETS.has(id);
    return Object.freeze({
      index: index + 1,
      id,
      name: `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
      digest,
      captureScreenshot,
      evidenceStem,
      nativeArtifactName: `${evidenceStem}-native-frame`,
      screenshotStep: captureScreenshot ? `${evidenceStem}-preset-ready` : null,
    });
  }),
);

export const verifyExactWeightDropdown = ({
  expectedValues,
  currentValue,
  options,
  context = 'font weight dropdown',
}) => {
  assert.ok(Array.isArray(expectedValues) && expectedValues.length > 0, (
    `${context}: exact dropdown values are required`
  ));
  const values = expectedValues.map(String);
  assert.equal(new Set(values).size, values.length, `${context}: duplicate expected dropdown values`);
  assert.ok(values.includes(String(currentValue)), (
    `${context}: closed dropdown exposed unsupported value ${currentValue}; expected ${values.join(', ')}`
  ));
  assert.ok(Array.isArray(options), `${context}: dropdown options are not observable`);
  assert.equal(options.length, values.length, (
    `${context}: expected exactly ${values.length} renderer-backed weights, found ${options.length}`
  ));
  const descriptions = options.map((option, index) => Object.freeze({
    value: values[index],
    label: String(option?.label ?? '').trim(),
    selected: option?.selected === true,
    disabled: option?.disabled === true,
  }));
  assert.ok(descriptions.every(({ label }) => label.length > 0), `${context}: an option has no label`);
  assert.deepEqual(
    descriptions.filter(({ selected }) => selected).map(({ value }) => value),
    [String(currentValue)],
    `${context}: selected option disagrees with the closed exact weight`,
  );
  assert.deepEqual(
    descriptions.filter(({ disabled }) => disabled),
    [],
    `${context}: an advertised exact weight is disabled`,
  );
  return Object.freeze({
    currentValue: String(currentValue),
    values: Object.freeze(values),
    descriptions: Object.freeze(descriptions),
  });
};

/**
 * Verify the customer-visible preset action against the independently read SQLite render scene.
 * A button class, compositor counter, or partial field check cannot satisfy this oracle alone.
 */
export const verifyPresetObservation = ({
  preset,
  activePreset,
  activePresetId,
  beforeSceneRevision,
  durableScene,
}) => {
  assert.ok(SUBTITLE_PRESET_MATRIX.includes(preset), 'preset must come from the frozen matrix');
  assert.equal(activePreset, preset.name, `${preset.name} did not own the active public button`);
  assert.equal(activePresetId, preset.id, `${preset.name} active button exposed another preset ID`);
  assert.ok(Number.isSafeInteger(beforeSceneRevision) && beforeSceneRevision >= 0, (
    'preset proof needs a valid prior durable scene revision'
  ));
  assert.ok(durableScene !== null && typeof durableScene === 'object', (
    `${preset.name} has no independently read durable render scene`
  ));
  assert.ok(durableScene.sceneRevision > beforeSceneRevision, (
    `${preset.name} did not advance the durable scene revision`
  ));
  const customization = durableScene.scene?.customization;
  assert.equal(customization?.preset, preset.id, `${preset.name} persisted another preset identity`);
  const digest = customizationDigest(customization);
  assert.equal(digest, preset.digest, `${preset.name} did not persist its exact 56-field definition`);
  return Object.freeze({
    id: preset.id,
    name: preset.name,
    beforeSceneRevision,
    sceneRevision: durableScene.sceneRevision,
    fieldCount: Object.keys(customization).length,
    digest,
  });
};
