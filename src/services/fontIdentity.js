/**
 * Font identity: every subtitle selection resolves to ONE exact face identity backed by ONE byte
 * source, or to an honest `unavailable`. There is no silent substitute anywhere in this module.
 *
 * Why this exists: the shipped font system lies. `fontOptions.js` offers selectable entries over
 * fewer primary families (`fontInventory.js` counts both, and is the only place those counts are
 * stated); the legacy Remotion `fontUrlMap` mapped most of them, 18 to a *different* family than
 * the one named, and several to nothing at all. On top of that the
 * operating system substitutes silently — Windows' `FontSubstitutes` registry maps
 * `Helvetica -> Arial`, so the shipped default (`'Arial', sans-serif`) and the Helvetica entry are
 * indistinguishable on screen. Under the accepted native-renderer architecture the WebView bakes
 * glyphs once and Rust composites them, so an unresolved family is not a cosmetic issue: it is the
 * export silently disagreeing with what the user picked.
 *
 * The rules this module enforces:
 *   - A resolution is exact or it is unavailable. A CSS fallback chain is never followed.
 *   - Generic families (`sans-serif`, ...) are never an identity; they are the substitution vector.
 *   - A system face counts only when it is explicitly declared for the running platform AND a
 *     caller-supplied probe confirms it is installed. Unverified is unavailable.
 *   - Aliases and OS substitutions are surfaced on the result, never applied.
 *   - A saved project's recorded identity either resolves to the same identity or reports drift.
 */

import { fontOptions } from '../components/subtitleCustomization/fontOptions';

export const FONT_IDENTITY_CONTRACT_VERSION = 1;

export const FONT_WEIGHT_MINIMUM = 100;
export const FONT_WEIGHT_MAXIMUM = 900;
export const FONT_WEIGHT_STEP = 100;
/** Mirrors the `boundedText(256)` bound the customization validator already applies. */
export const MAX_FONT_FAMILY_BYTES = 256;

export const FONT_SOURCE_KIND = Object.freeze({ managed: 'managed', system: 'system' });

export const FONT_STYLES = Object.freeze(['normal', 'italic']);

export const PLATFORMS = Object.freeze(['windows', 'macos', 'linux']);

export const UNAVAILABLE_REASON = Object.freeze({
  invalidFamily: 'invalid-family',
  invalidWeight: 'invalid-weight',
  invalidStyle: 'invalid-style',
  unsupportedPlatform: 'unsupported-platform',
  genericFamily: 'generic-family',
  unknownFamily: 'unknown-family',
  osSubstituted: 'os-substituted',
  platformNotReviewed: 'platform-not-reviewed',
  noDeclaredSource: 'no-declared-source',
  managedPackInvalid: 'managed-pack-invalid',
  managedPackUnavailable: 'managed-pack-unavailable',
  systemFaceUnverified: 'system-face-unverified',
  systemFaceMissing: 'system-face-missing',
  weightNotInFace: 'weight-not-in-face',
  styleNotInFace: 'style-not-in-face',
  identityDrift: 'identity-drift',
  opticalSizeRequired: 'optical-size-required',
});

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif',
  'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
  'inherit', 'initial', 'revert', 'revert-layer', 'unset',
]);

/**
 * The only content-addressed font bytes this repository ships. Mirrored field-for-field from
 * `crates/osg-engine-packages/delivery/ui-fonts.delivery.json`; the delivery build renames the
 * `@font-face` family from `Google Sans Flex` to `Google Sans`, which is the name the catalog and
 * every saved project use.
 */
export const MANAGED_FONT_PACKAGE = Object.freeze({
  packageId: 'google-sans-flex',
  version: 'v22-ui4',
  license: 'OFL-1.1',
  family: 'Google Sans',
  upstreamFamily: 'Google Sans Flex',
  variable: true,
  // wght spans 1..1000, so every catalog weight (100..900) is a real instance, never synthesised.
  axes: Object.freeze([
    Object.freeze({ tag: 'opsz', minimum: 6, maximum: 144, pinnedFrom: 'font-size' }),
    Object.freeze({ tag: 'wght', minimum: 1, maximum: 1000, pinnedFrom: 'font-weight' }),
    Object.freeze({ tag: 'GRAD', minimum: 0, maximum: 100, pinnedFrom: 'neutral', neutral: 0 }),
    Object.freeze({ tag: 'ROND', minimum: 0, maximum: 100, pinnedFrom: 'neutral', neutral: 0 }),
  ]),
  styles: Object.freeze(['normal']),
  files: Object.freeze([
    Object.freeze({
      subset: 'vietnamese',
      sizeBytes: 57_620,
      sha256: '7343aefa9061998bdfea8c1e2aa6943a029218dd78a23e5fde441e832fe66629',
    }),
    Object.freeze({
      subset: 'latin-ext',
      sizeBytes: 131_208,
      sha256: '0f63b3ae4c60341fc1348749796505e9ab621a3ab690b80f9cdf66dafc1eca19',
    }),
    Object.freeze({
      subset: 'latin',
      sizeBytes: 270_324,
      sha256: '3215351d7b5587396710ab80bd31994ebbf3a9ee6f8e67b3c29a30d909cec55f',
    }),
  ]),
});

/**
 * Explicitly declared system faces, per platform. `windows` is enumerated from the faces the OS
 * actually registers; the discrete `weights` are the real files, so a request for any other weight
 * is reported rather than synthesised by the rasteriser. `macos` and `linux` are deliberately empty
 * blockers: nothing is declared for a platform whose faces have not been reviewed.
 */
export const SYSTEM_FACE_DECLARATIONS = Object.freeze({
  windows: Object.freeze({
    reviewed: true,
    faces: Object.freeze([
      Object.freeze({ family: 'Arial', weights: Object.freeze([400, 700]), italic: true }),
      Object.freeze({ family: 'Calibri', weights: Object.freeze([300, 400, 700]), italic: true }),
      Object.freeze({ family: 'Comic Sans MS', weights: Object.freeze([400, 700]), italic: true }),
      Object.freeze({ family: 'Courier New', weights: Object.freeze([400, 700]), italic: true }),
      Object.freeze({ family: 'Georgia', weights: Object.freeze([400, 700]), italic: true }),
      Object.freeze({ family: 'Impact', weights: Object.freeze([400]), italic: false }),
      Object.freeze({ family: 'Malgun Gothic', weights: Object.freeze([400, 700]), italic: false }),
      Object.freeze({ family: 'Tahoma', weights: Object.freeze([400, 700]), italic: false }),
      Object.freeze({
        family: 'Times New Roman', weights: Object.freeze([400, 700]), italic: true,
      }),
      Object.freeze({ family: 'Verdana', weights: Object.freeze([400, 700]), italic: true }),
      Object.freeze({
        family: 'Yu Gothic', weights: Object.freeze([300, 400, 500, 700]), italic: false,
      }),
    ]),
  }),
  macos: Object.freeze({ reviewed: false, faces: Object.freeze([]) }),
  linux: Object.freeze({ reviewed: false, faces: Object.freeze([]) }),
});

/**
 * Families the operating system silently redirects. Measured from the Windows
 * `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\FontSubstitutes` key. A redirected family can
 * never be an identity: the user asked for one face and would receive another with no signal.
 */
export const OS_FAMILY_SUBSTITUTIONS = Object.freeze({
  windows: Object.freeze({ Helvetica: 'Arial', Times: 'Times New Roman' }),
  macos: Object.freeze({}),
  linux: Object.freeze({}),
});

/**
 * The legacy Remotion `fontUrlMap` entries whose stylesheet served a *different* family than the
 * catalog name. Recorded so the UI can disclose what a pre-existing project was actually drawn
 * with. Resolution never follows these.
 */
export const LEGACY_WEB_FONT_ALIASES = Object.freeze({
  'Noto Sans Vietnamese': 'Noto Sans',
  'Arial Unicode MS': 'Noto Sans',
  'Courier New': 'Courier Prime',
  'Comic Sans MS': 'Comic Neue',
  'PingFang SC': 'Noto Sans SC',
  'Hiragino Sans': 'Noto Sans JP',
  'Yu Gothic': 'Noto Sans JP',
  Calibri: 'Carlito',
  Gotham: 'Inter',
  'Harriet Display': 'Crimson Text',
  'Doctor Glitch': 'Righteous',
  Azonix: 'Audiowide',
  'Maximum Impact': 'Bungee',
  'Episode 1': 'Creepster',
  Dollamin: 'Fredoka One',
  'Montages Retro': 'Righteous',
  Moenstories: 'Crimson Text',
  'Peacock Showier': 'Dancing Script',
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Copies rather than mutating, so already-frozen inputs can be embedded in a result. */
export const freezeDeep = (value) => {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeep));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = freezeDeep(value[key]);
    return Object.freeze(copy);
  }
  return value;
};

const hasControlCharacter = (value) => Array.from(value).some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
});

// Under the `u` flag a matched surrogate pair is one code point, so this matches only lone halves.
const isWellFormedUnicode = (value) => !/[\uD800-\uDFFF]/u.test(value);

const unavailable = (reason, extra = {}) => freezeDeep({
  status: 'unavailable', reason, identity: null, ...extra,
});

/**
 * Split a CSS `font-family` value into its declared families. The primary family is the only one
 * that can become an identity; the rest are returned purely so a caller can disclose them.
 */
export const parseFontFamilyValue = (value) => {
  if (typeof value !== 'string') return { ok: false, reason: UNAVAILABLE_REASON.invalidFamily };
  if (!isWellFormedUnicode(value) || hasControlCharacter(value)) {
    return { ok: false, reason: UNAVAILABLE_REASON.invalidFamily };
  }
  if (new TextEncoder().encode(value).byteLength > MAX_FONT_FAMILY_BYTES) {
    return { ok: false, reason: UNAVAILABLE_REASON.invalidFamily };
  }
  const families = value
    .split(',')
    .map((part) => part.trim().replace(/^["'](.*)["']$/su, '$1').trim())
    .filter((part) => part.length > 0);
  if (families.length === 0) return { ok: false, reason: UNAVAILABLE_REASON.invalidFamily };
  const [primary, ...fallbacks] = families;
  if (GENERIC_FAMILIES.has(primary.toLowerCase())) {
    return { ok: false, reason: UNAVAILABLE_REASON.genericFamily, primary, fallbacks };
  }
  return { ok: true, primary, fallbacks: Object.freeze(fallbacks) };
};

/** Accepts only the weights the customization validator persists: 100..900 in steps of 100. */
export const normalizeFontWeight = (weight) => (
  Number.isInteger(weight)
    && weight >= FONT_WEIGHT_MINIMUM
    && weight <= FONT_WEIGHT_MAXIMUM
    && weight % FONT_WEIGHT_STEP === 0
    ? weight
    : null
);

const normalizeFontStyle = (style) => (FONT_STYLES.includes(style) ? style : null);

export const managedPackageIsWellFormed = (pack) => (
  Boolean(pack)
  && typeof pack.family === 'string' && pack.family.length > 0
  && typeof pack.packageId === 'string' && pack.packageId.length > 0
  && typeof pack.version === 'string' && pack.version.length > 0
  && Array.isArray(pack.files) && pack.files.length > 0
  && pack.files.every((file) => (
    typeof file.subset === 'string' && file.subset.length > 0
    && Number.isInteger(file.sizeBytes) && file.sizeBytes > 0
    && typeof file.sha256 === 'string' && SHA256_PATTERN.test(file.sha256)
  ))
  && new Set(pack.files.map((file) => file.subset)).size === pack.files.length
  && Array.isArray(pack.axes)
  && pack.axes.every((axis) => (
    typeof axis.tag === 'string'
    && Number.isFinite(axis.minimum) && Number.isFinite(axis.maximum)
    && axis.minimum <= axis.maximum
  ))
);

const managedAxis = (pack, tag) => pack.axes.find((axis) => axis.tag === tag) ?? null;

export const fontIdentityKey = (identity) => {
  if (!identity) return '';
  const suffix = `${identity.family}|${identity.weight}|${identity.style}`;
  return identity.source === FONT_SOURCE_KIND.managed
    ? `managed:${identity.packageId}@${identity.packageVersion}|${suffix}`
    : `system:${identity.platform}|${suffix}`;
};

const bytesFingerprint = (identity) => (
  identity?.bytes?.map((file) => `${file.subset}:${file.sha256}:${file.sizeBytes}`).join('+') ?? ''
);

/** Two identities match only when the label AND the byte source agree. */
export const sameFontIdentity = (left, right) => (
  Boolean(left) && Boolean(right)
  && fontIdentityKey(left) === fontIdentityKey(right)
  && bytesFingerprint(left) === bytesFingerprint(right)
);

const buildManagedIdentity = (pack, { family, weight, style, requested }) => freezeDeep({
  contractVersion: FONT_IDENTITY_CONTRACT_VERSION,
  source: FONT_SOURCE_KIND.managed,
  family,
  weight,
  style,
  packageId: pack.packageId,
  packageVersion: pack.version,
  license: pack.license,
  variable: true,
  axes: pack.axes.map((axis) => ({ ...axis })),
  bytes: pack.files.map((file) => ({ ...file })),
  platform: null,
  requested,
  key: fontIdentityKey({
    source: FONT_SOURCE_KIND.managed,
    packageId: pack.packageId,
    packageVersion: pack.version,
    family,
    weight,
    style,
  }),
});

const buildSystemIdentity = (face, { platform, weight, style, requested }) => freezeDeep({
  contractVersion: FONT_IDENTITY_CONTRACT_VERSION,
  source: FONT_SOURCE_KIND.system,
  family: face.family,
  weight,
  style,
  packageId: null,
  packageVersion: null,
  license: null,
  variable: false,
  axes: [],
  bytes: [],
  platform,
  declaredWeights: [...face.weights],
  declaredItalic: face.italic === true,
  requested,
  key: fontIdentityKey({ source: FONT_SOURCE_KIND.system, platform, family: face.family, weight, style }),
});

/**
 * What a caller must be told about a family, in the one direction the tables are written: the key
 * is what the user asked for, the value is what something else would have served instead. Both are
 * reported and neither is ever followed.
 */
export const describeFontDisclosures = (family, platform) => ({
  legacyAlias: Object.hasOwn(LEGACY_WEB_FONT_ALIASES, family)
    ? { declaredFamily: family, servedFamily: LEGACY_WEB_FONT_ALIASES[family] }
    : null,
  osSubstitution: Object.hasOwn(OS_FAMILY_SUBSTITUTIONS[platform] ?? {}, family)
    ? { declaredFamily: family, substitutedFamily: OS_FAMILY_SUBSTITUTIONS[platform][family] }
    : null,
});

let catalogFamilyCache = null;
/** The distinct primary families the catalog offers. Cached; the catalog is a frozen constant. */
export const catalogPrimaryFamilies = () => {
  if (catalogFamilyCache === null) {
    const families = new Set();
    for (const option of fontOptions) {
      const parsed = parseFontFamilyValue(option.value);
      if (parsed.ok) families.add(parsed.primary);
    }
    catalogFamilyCache = families;
  }
  return catalogFamilyCache;
};

/**
 * Resolve one selection to one exact face identity, or say why it cannot be resolved.
 *
 * @param {object} request
 * @param {string} request.fontFamily      the persisted CSS `font-family` value
 * @param {number} request.fontWeight      100..900 in steps of 100
 * @param {'normal'|'italic'} [request.fontStyle]
 * @param {'windows'|'macos'|'linux'} request.platform
 * @param {boolean} [request.managedPackInstalled] managed bytes verified present
 * @param {(face: object) => boolean} [request.isSystemFaceInstalled] runtime probe; absent means
 *        unverified, which is reported as unavailable rather than assumed
 * @param {object} [request.declarations] injectable declaration set (tests, future review waves)
 */
export const resolveFontIdentity = ({
  fontFamily,
  fontWeight,
  fontStyle = 'normal',
  platform,
  managedPackInstalled = false,
  isSystemFaceInstalled = null,
  declarations = {},
} = {}) => {
  const managedPackage = declarations.managedPackage ?? MANAGED_FONT_PACKAGE;
  const systemFaces = declarations.systemFaces ?? SYSTEM_FACE_DECLARATIONS;

  const style = normalizeFontStyle(fontStyle);
  if (style === null) return unavailable(UNAVAILABLE_REASON.invalidStyle);
  const weight = normalizeFontWeight(fontWeight);
  if (weight === null) return unavailable(UNAVAILABLE_REASON.invalidWeight);
  if (!PLATFORMS.includes(platform)) return unavailable(UNAVAILABLE_REASON.unsupportedPlatform);

  const parsed = parseFontFamilyValue(fontFamily);
  if (!parsed.ok) {
    return unavailable(parsed.reason, {
      requested: { family: parsed.primary ?? null, weight, style },
      fallbacksIgnored: parsed.fallbacks ?? [],
    });
  }

  const requested = Object.freeze({
    family: parsed.primary, weight, style, fallbacks: parsed.fallbacks,
  });
  const seen = {
    ...describeFontDisclosures(parsed.primary, platform), fallbacksIgnored: parsed.fallbacks,
  };
  const reject = (reason, extra = {}) => unavailable(reason, { requested, ...seen, ...extra });

  if (seen.osSubstitution) return reject(UNAVAILABLE_REASON.osSubstituted);

  if (parsed.primary === managedPackage.family) {
    if (!managedPackageIsWellFormed(managedPackage)) {
      return reject(UNAVAILABLE_REASON.managedPackInvalid);
    }
    if (managedPackInstalled !== true) return reject(UNAVAILABLE_REASON.managedPackUnavailable);
    if (!managedPackage.styles.includes(style)) return reject(UNAVAILABLE_REASON.styleNotInFace);
    const axis = managedAxis(managedPackage, 'wght');
    if (!axis || weight < axis.minimum || weight > axis.maximum) {
      return reject(UNAVAILABLE_REASON.weightNotInFace, {
        declaredWeightRange: axis ? [axis.minimum, axis.maximum] : null,
      });
    }
    return freezeDeep({
      status: 'exact',
      reason: null,
      identity: buildManagedIdentity(managedPackage, {
        family: managedPackage.family, weight, style, requested,
      }),
      ...seen,
    });
  }

  const platformDeclaration = systemFaces[platform];
  const face = platformDeclaration?.faces?.find((entry) => entry.family === parsed.primary) ?? null;
  if (!face) {
    if (platformDeclaration?.reviewed !== true) {
      return reject(UNAVAILABLE_REASON.platformNotReviewed);
    }
    return reject(
      catalogPrimaryFamilies().has(parsed.primary)
        ? UNAVAILABLE_REASON.noDeclaredSource
        : UNAVAILABLE_REASON.unknownFamily,
    );
  }
  if (!face.weights.includes(weight)) {
    return reject(UNAVAILABLE_REASON.weightNotInFace, { declaredWeights: [...face.weights] });
  }
  if (style === 'italic' && face.italic !== true) {
    return reject(UNAVAILABLE_REASON.styleNotInFace);
  }
  if (typeof isSystemFaceInstalled !== 'function') {
    return reject(UNAVAILABLE_REASON.systemFaceUnverified);
  }
  if (isSystemFaceInstalled({ family: face.family, weight, style, platform }) !== true) {
    return reject(UNAVAILABLE_REASON.systemFaceMissing);
  }
  return freezeDeep({
    status: 'exact',
    reason: null,
    identity: buildSystemIdentity(face, { platform, weight, style, requested }),
    ...seen,
  });
};

/**
 * Pin every variable axis to an explicit value. Determinism requires that nothing is left to the
 * rasteriser: `opsz` follows CSS `font-optical-sizing: auto` (clamped font size, as the app's own
 * headline rule does), and `GRAD`/`ROND` take the neutral value the app uses.
 */
export const resolveVariableAxisInstance = (identity, { fontSizePx = null } = {}) => {
  if (!identity) return { ok: false, reason: UNAVAILABLE_REASON.invalidFamily };
  if (identity.variable !== true) return { ok: true, axes: Object.freeze({}) };
  const axes = {};
  for (const axis of identity.axes) {
    if (axis.pinnedFrom === 'font-weight') {
      axes[axis.tag] = identity.weight;
    } else if (axis.pinnedFrom === 'neutral') {
      axes[axis.tag] = axis.neutral;
    } else {
      if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) {
        return { ok: false, reason: UNAVAILABLE_REASON.opticalSizeRequired };
      }
      axes[axis.tag] = Math.min(Math.max(fontSizePx, axis.minimum), axis.maximum);
    }
  }
  return { ok: true, axes: Object.freeze(axes) };
};

/**
 * Re-resolve the identity a project recorded. The saved identity is authoritative: if the current
 * declarations would produce a different face, that is reported as drift, never applied.
 */
export const resolveSavedFontIdentity = (savedIdentity, options = {}) => {
  if (!savedIdentity || typeof savedIdentity !== 'object') {
    return unavailable(UNAVAILABLE_REASON.invalidFamily);
  }
  const resolution = resolveFontIdentity({
    ...options,
    fontFamily: savedIdentity.requested?.family ?? savedIdentity.family,
    fontWeight: savedIdentity.weight,
    fontStyle: savedIdentity.style,
  });
  if (resolution.status !== 'exact') return resolution;
  if (!sameFontIdentity(resolution.identity, savedIdentity)) {
    return unavailable(UNAVAILABLE_REASON.identityDrift, {
      requested: resolution.requested ?? null,
      expectedKey: fontIdentityKey(savedIdentity),
      actualKey: fontIdentityKey(resolution.identity),
      legacyAlias: resolution.legacyAlias ?? null,
      osSubstitution: resolution.osSubstitution ?? null,
    });
  }
  return resolution;
};
