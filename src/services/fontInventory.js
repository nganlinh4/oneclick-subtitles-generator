/**
 * The one authoritative font inventory.
 *
 * Two different figures were in circulation and both were cited as fact: "121 options, 107
 * unavailable" and "115 families, 88 recoverable". They were measuring different things, and
 * nothing in either number said so. This module makes every one of them a value computed from the
 * shipped catalog and the reviewed declarations, so a gate can assert them and a drift test can
 * fail when they move.
 *
 * Three counts, each with its own name, and they are not interchangeable:
 *
 *   - OPTIONS  — selectable entries in `fontOptions`. Duplicated names in different groups are
 *                different options, because the user sees and picks each one.
 *   - DISTINCT OPTION VALUES — unique `font-family` strings behind those options.
 *   - UNIQUE FAMILIES — unique primary families those values resolve to. This is what a byte
 *                source is delivered for, so it is the only count a licence claim may use.
 *
 * Two orthogonal axes classify a family, and mixing them is what produced the two figures:
 *
 *   - BUCKET is byte availability on one platform, from the reviewed declarations
 *     (`FONT_FAMILY_BUCKET`). It changes when a platform is reviewed or a pack is delivered.
 *   - PROVENANCE is what could honestly back the family at all (`FONT_DELIVERY_PROVENANCE`). It is
 *     platform-independent, and it is a SURVEY, not a licence finding: `open-licence-candidate`
 *     means the upstream family is published under terms that appear to permit redistribution and
 *     must still be verified against the delivered bytes before anything is shipped.
 */

import { fontOptions } from '../components/subtitleCustomization/fontOptions';
import {
  LEGACY_WEB_FONT_ALIASES,
  MANAGED_FONT_PACKAGE,
  OS_FAMILY_SUBSTITUTIONS,
  PLATFORMS,
  SYSTEM_FACE_DECLARATIONS,
  UNAVAILABLE_REASON,
  catalogPrimaryFamilies,
  describeFontDisclosures,
  freezeDeep,
  managedPackageIsWellFormed,
  parseFontFamilyValue,
} from './fontIdentity';

export const FONT_INVENTORY_CONTRACT_VERSION = 1;

/** Byte availability of a family on one platform. Exactly one applies; there is no other outcome. */
export const FONT_FAMILY_BUCKET = Object.freeze({
  /** Hash-pinned bytes this repository delivers. */
  managed: 'managed',
  /** A face explicitly declared for this platform, so a runtime probe can confirm it. */
  systemDeclared: 'system-declared',
  /** The OS redirects the name to a different family, so it can never be an identity. */
  osRedirected: 'os-redirected',
  /** No byte source at all. Reported honestly; never substituted. */
  unavailable: 'unavailable',
});

/** What could honestly back a family. A survey of provenance, not a licence finding. */
export const FONT_DELIVERY_PROVENANCE = Object.freeze({
  /** Delivered by this repository under a verified licence, with sizes and hashes. */
  delivered: 'delivered',
  /** Proprietary, supplied by the operating system. Usable where declared, never redistributable. */
  osProprietary: 'os-proprietary',
  /** Commercial or unclear provenance. Cannot be delivered without a licence we do not have. */
  restricted: 'restricted',
  /** Published upstream under apparently redistributable terms. Must be verified against bytes. */
  openLicenceCandidate: 'open-licence-candidate',
  /** Not a real font family. It could never resolve and must be corrected, not delivered. */
  notAFamily: 'not-a-family',
});

const DELIVERED_FAMILIES = ['Google Sans'];

/** Mirrors `SYSTEM_FACE_DECLARATIONS.windows`; `fontInventoryDrift` fails if the two disagree. */
const OS_PROPRIETARY_FAMILIES = [
  'Arial', 'Calibri', 'Comic Sans MS', 'Courier New', 'Georgia', 'Impact', 'Malgun Gothic',
  'Tahoma', 'Times New Roman', 'Verdana', 'Yu Gothic',
];

/** Helvetica sits here rather than with the OS faces: Windows redirects it, it does not ship it. */
const RESTRICTED_FAMILIES = [
  'Arial Unicode MS', 'Azonix', 'Doctor Glitch', 'Dollamin', 'Episode 1', 'Futura', 'Gotham',
  'Harriet Display', 'Helvetica', 'Hiragino Sans', 'Maximum Impact', 'Moenstories',
  'Montages Retro', 'Peacock Showier', 'PingFang SC',
];

/** Vietnamese coverage lives in Noto Sans itself; this name never named a face. */
const NOT_A_FAMILY_FAMILIES = ['Noto Sans Vietnamese'];

const OPEN_LICENCE_CANDIDATE_FAMILIES = [
  'Amiri', 'Anton', 'Audiowide', 'Bangers', 'Barlow', 'Be Vietnam Pro', 'Bebas Neue', 'Bungee',
  'Cabin', 'Cairo', 'Cinzel', 'Comfortaa', 'Cormorant Garamond', 'Creepster', 'Crimson Pro',
  'Crimson Text', 'DM Sans', 'Dosis', 'Epilogue', 'Exo', 'Figtree', 'Fira Code', 'Fira Sans',
  'Fredoka One', 'Gowun Dodum', 'Inter', 'JetBrains Mono', 'Jomhuria', 'Josefin Sans', 'Kalam',
  'Karla', 'KoPub Batang', 'Lato', 'Lexend', 'Lexend Deca', 'Libre Baskerville', 'Lora',
  'Manrope', 'Merriweather', 'Montserrat', 'Montserrat Alternates', 'Mukti', 'Nanum Barun Gothic',
  'Nanum Gothic', 'Nanum Gothic Coding', 'Nanum Myeongjo', 'Niramit', 'Nosifer', 'Noto Sans',
  'Noto Sans Arabic', 'Noto Sans JP', 'Noto Sans KR', 'Noto Sans SC', 'Noto Sans TC',
  'Noto Serif', 'Nunito', 'Open Sans', 'Orbitron', 'Oswald', 'Outfit', 'PT Sans',
  'Playfair Display', 'Plus Jakarta Sans', 'Poppins', 'Press Start 2P', 'Quicksand', 'Rajdhani',
  'Raleway', 'Readex Pro', 'Righteous', 'Roboto', 'Rubik', 'Sarabun', 'Sarala', 'Share Tech Mono',
  'Shrikhand', 'Signika', 'Source Han Sans', 'Source Sans Pro', 'Space Grotesk', 'Spectral',
  'Spoqa Han Sans', 'Teko', 'Ubuntu', 'VT323', 'Viga', 'Work Sans',
];

const provenanceMap = () => {
  const map = {};
  const add = (families, provenance) => {
    for (const family of families) map[family] = provenance;
  };
  add(DELIVERED_FAMILIES, FONT_DELIVERY_PROVENANCE.delivered);
  add(OS_PROPRIETARY_FAMILIES, FONT_DELIVERY_PROVENANCE.osProprietary);
  add(RESTRICTED_FAMILIES, FONT_DELIVERY_PROVENANCE.restricted);
  add(OPEN_LICENCE_CANDIDATE_FAMILIES, FONT_DELIVERY_PROVENANCE.openLicenceCandidate);
  add(NOT_A_FAMILY_FAMILIES, FONT_DELIVERY_PROVENANCE.notAFamily);
  return Object.freeze(map);
};

/** Every surveyed family and what could back it. The reviewed source the report is derived from. */
export const FAMILY_DELIVERY_PROVENANCE = provenanceMap();

/**
 * Classify every catalog entry for a platform from the reviewed declarations alone. This is the
 * static picture (what a byte source exists for); `resolveFontIdentity` still demands a runtime
 * probe before it will call a system face exact.
 */
export const classifyFontCatalog = ({ platform, declarations = {} } = {}) => {
  const managedPackage = declarations.managedPackage ?? MANAGED_FONT_PACKAGE;
  const systemFaces = declarations.systemFaces ?? SYSTEM_FACE_DECLARATIONS;
  const declaration = systemFaces[platform] ?? null;
  const counts = { managed: 0, system: 0, unavailable: 0 };
  const entries = fontOptions.map((option) => {
    const parsed = parseFontFamilyValue(option.value);
    const family = parsed.ok ? parsed.primary : null;
    const seen = family
      ? describeFontDisclosures(family, platform)
      : { legacyAlias: null, osSubstitution: null };
    let classification = 'unavailable';
    let reason = parsed.ok ? UNAVAILABLE_REASON.noDeclaredSource : parsed.reason;
    if (family && seen.osSubstitution) {
      reason = UNAVAILABLE_REASON.osSubstituted;
    } else if (family === managedPackage.family && managedPackageIsWellFormed(managedPackage)) {
      classification = 'managed';
      reason = null;
    } else if (family && declaration?.faces?.some((face) => face.family === family)) {
      classification = 'system';
      reason = null;
    } else if (family && declaration?.reviewed !== true) {
      reason = UNAVAILABLE_REASON.platformNotReviewed;
    }
    counts[classification] += 1;
    return {
      value: option.value, label: option.label, group: option.group, family, classification, reason,
      legacyAlias: seen.legacyAlias, osSubstitution: seen.osSubstitution,
    };
  });
  return freezeDeep({
    platform,
    total: entries.length,
    uniqueFamilies: catalogPrimaryFamilies().size,
    counts,
    entries,
  });
};

/** Every catalog family the legacy renderer drew as a different family. */
export const describeFontCatalogAliases = () => freezeDeep(
  [...catalogPrimaryFamilies()]
    .filter((family) => Object.hasOwn(LEGACY_WEB_FONT_ALIASES, family))
    .sort()
    .map((family) => ({ declaredFamily: family, servedFamily: LEGACY_WEB_FONT_ALIASES[family] })),
);

const optionOutcomeOf = (entry) => {
  if (entry.classification === 'managed') return 'managed';
  if (entry.classification === 'system') return 'system';
  return entry.reason === UNAVAILABLE_REASON.osSubstituted ? 'osRedirected' : 'noByteSource';
};

const BUCKET_OF_OUTCOME = Object.freeze({
  managed: FONT_FAMILY_BUCKET.managed,
  system: FONT_FAMILY_BUCKET.systemDeclared,
  osRedirected: FONT_FAMILY_BUCKET.osRedirected,
  noByteSource: FONT_FAMILY_BUCKET.unavailable,
});

const zeroed = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const PROVENANCE_KEYS = Object.values(FONT_DELIVERY_PROVENANCE);

/**
 * The single reported inventory. Every figure below is computed here; none is copied from prose.
 *
 * @param {'windows'|'macos'|'linux'} platform
 * @param {object} [declarations] injectable declaration set, as `resolveFontIdentity` takes
 */
export const reportFontInventory = ({ platform, declarations = {} } = {}) => {
  const catalog = classifyFontCatalog({ platform, declarations });
  const optionOutcomes = zeroed(['managed', 'system', 'osRedirected', 'noByteSource']);
  const familyBuckets = zeroed(Object.values(FONT_FAMILY_BUCKET));
  const provenance = zeroed(PROVENANCE_KEYS);
  const unavailableByProvenance = zeroed(PROVENANCE_KEYS);
  const byFamily = new Map();

  for (const entry of catalog.entries) {
    const outcome = optionOutcomeOf(entry);
    optionOutcomes[outcome] += 1;
    if (entry.family === null) continue;
    const known = byFamily.get(entry.family);
    if (known) {
      known.optionCount += 1;
      if (known.bucket !== BUCKET_OF_OUTCOME[outcome]) known.bucketConflict = true;
      continue;
    }
    byFamily.set(entry.family, {
      family: entry.family,
      bucket: BUCKET_OF_OUTCOME[outcome],
      provenance: FAMILY_DELIVERY_PROVENANCE[entry.family] ?? null,
      reason: entry.reason,
      optionCount: 1,
      bucketConflict: false,
      legacyAlias: entry.legacyAlias,
      osSubstitution: entry.osSubstitution,
    });
  }

  const families = [...byFamily.values()].sort((a, b) => (a.family < b.family ? -1 : 1));
  for (const family of families) {
    familyBuckets[family.bucket] += 1;
    if (family.provenance !== null) provenance[family.provenance] += 1;
    if (family.bucket === FONT_FAMILY_BUCKET.unavailable && family.provenance !== null) {
      unavailableByProvenance[family.provenance] += 1;
    }
  }
  const unclassified = families.filter((family) => family.provenance === null)
    .map((family) => family.family);
  const open = provenance[FONT_DELIVERY_PROVENANCE.openLicenceCandidate];
  const phantom = provenance[FONT_DELIVERY_PROVENANCE.notAFamily];

  return freezeDeep({
    contractVersion: FONT_INVENTORY_CONTRACT_VERSION,
    platform,
    options: {
      total: catalog.total,
      distinctValues: new Set(fontOptions.map((option) => option.value)).size,
      groups: new Set(fontOptions.map((option) => option.group)).size,
      outcomes: optionOutcomes,
      resolvable: optionOutcomes.managed + optionOutcomes.system,
      unavailable: optionOutcomes.osRedirected + optionOutcomes.noByteSource,
    },
    families: {
      total: families.length,
      buckets: familyBuckets,
      provenance,
      unavailableByProvenance,
      unclassified,
    },
    // The two circulating figures, side by side, from this one computation.
    reconciliation: {
      unavailableOptions: optionOutcomes.osRedirected + optionOutcomes.noByteSource,
      uniqueFamilies: families.length,
      // What the earlier "88 recoverable" counted: it included the phantom family.
      recoverableFamiliesAsReported: open + phantom,
      deliverableOpenLicenceFamilies: open,
      phantomFamilies: phantom,
    },
    entries: families,
  });
};

/**
 * The reviewed snapshot a gate asserts against. Editing a number here is a decision; editing the
 * catalog or the declarations without editing it is the drift this module exists to catch.
 */
export const FONT_INVENTORY_BASELINE = Object.freeze({
  contractVersion: FONT_INVENTORY_CONTRACT_VERSION,
  options: 121,
  distinctOptionValues: 116,
  optionGroups: 17,
  uniqueFamilies: 115,
  provenance: Object.freeze({
    delivered: 1, 'os-proprietary': 11, restricted: 15, 'open-licence-candidate': 87,
    'not-a-family': 1,
  }),
  platforms: Object.freeze({
    windows: Object.freeze({
      optionOutcomes: Object.freeze({ managed: 2, system: 12, osRedirected: 2, noByteSource: 105 }),
      familyBuckets: Object.freeze({
        managed: 1, 'system-declared': 11, 'os-redirected': 1, unavailable: 102,
      }),
    }),
    macos: Object.freeze({
      optionOutcomes: Object.freeze({ managed: 2, system: 0, osRedirected: 0, noByteSource: 119 }),
      familyBuckets: Object.freeze({
        managed: 1, 'system-declared': 0, 'os-redirected': 0, unavailable: 114,
      }),
    }),
    linux: Object.freeze({
      optionOutcomes: Object.freeze({ managed: 2, system: 0, osRedirected: 0, noByteSource: 119 }),
      familyBuckets: Object.freeze({
        managed: 1, 'system-declared': 0, 'os-redirected': 0, unavailable: 114,
      }),
    }),
  }),
});

const countDrift = (scope, actual, expected) => Object.keys(expected)
  .filter((key) => actual[key] !== expected[key])
  .map((key) => ({ kind: 'count', scope, key, actual: actual[key], expected: expected[key] }));

const declaredSystemFamilies = () => {
  const declared = new Set();
  for (const platform of PLATFORMS) {
    const declaration = SYSTEM_FACE_DECLARATIONS[platform];
    if (declaration?.reviewed !== true) continue;
    for (const face of declaration.faces) declared.add(face.family);
  }
  return declared;
};

/**
 * The survey and the catalog must be a bijection, and the survey must agree with the declarations
 * it claims to mirror. Takes the family set so the guard itself is testable against a synthetic
 * catalog rather than only against the one that happens to be shipped.
 */
export const surveyCoverageDrift = (families) => {
  const drift = [];
  const catalog = new Set(families);
  const surveyed = Object.keys(FAMILY_DELIVERY_PROVENANCE);
  for (const family of surveyed) {
    if (!catalog.has(family)) drift.push({ kind: 'surveyed-family-not-in-catalog', family });
  }
  for (const family of catalog) {
    if (!Object.hasOwn(FAMILY_DELIVERY_PROVENANCE, family)) {
      drift.push({ kind: 'catalog-family-not-surveyed', family });
    }
  }
  const declared = declaredSystemFamilies();
  for (const family of surveyed) {
    const provenance = FAMILY_DELIVERY_PROVENANCE[family];
    const isOsProprietary = provenance === FONT_DELIVERY_PROVENANCE.osProprietary;
    if (isOsProprietary !== declared.has(family)) {
      drift.push({ kind: 'os-proprietary-disagrees-with-declarations', family, provenance });
    }
    if (provenance === FONT_DELIVERY_PROVENANCE.delivered && family !== MANAGED_FONT_PACKAGE.family) {
      drift.push({ kind: 'delivered-family-is-not-the-managed-pack', family });
    }
    if (provenance === FONT_DELIVERY_PROVENANCE.notAFamily
      && !Object.hasOwn(LEGACY_WEB_FONT_ALIASES, family)) {
      drift.push({ kind: 'phantom-family-has-no-alias-record', family });
    }
  }
  return drift;
};

/**
 * Substitution tables exist to make substitution VISIBLE. Either one applied backwards, or chained,
 * or pointing at itself, would let a family be swapped without anyone being told. The key is always
 * what the user asked for and the value is always what would have been served instead, so a table
 * whose value is itself a key has two hops and a table whose value equals its key has none.
 */
export const substitutionTableDrift = (kind, table) => Object.entries(table).flatMap(
  ([declared, served]) => [
    ...(declared === served ? [{ kind: `${kind}-maps-a-family-to-itself`, family: declared }] : []),
    ...(served !== declared && Object.hasOwn(table, served)
      ? [{ kind: `${kind}-chains`, family: declared }]
      : []),
  ],
);

const declaredSubstitutionDrift = () => {
  const drift = [...substitutionTableDrift('legacy-alias', LEGACY_WEB_FONT_ALIASES)];
  for (const platform of PLATFORMS) {
    const table = OS_FAMILY_SUBSTITUTIONS[platform] ?? {};
    drift.push(...substitutionTableDrift('os-substitution', table));
    for (const declared of Object.keys(table)) {
      // A redirected name that is also a declared face could resolve on one path and refuse on
      // the other, which is exactly the ambiguity the tables exist to remove.
      if (FAMILY_DELIVERY_PROVENANCE[declared] === FONT_DELIVERY_PROVENANCE.osProprietary) {
        drift.push({ kind: 'os-substitution-source-is-also-a-declared-face', family: declared });
      }
    }
  }
  return drift;
};

/**
 * Everything that must be noticed: an option added without a classification, a family that moved
 * bucket, a declaration that no longer agrees with the survey, a substitution table that could
 * succeed silently. Empty means the reported picture is still true.
 */
export const fontInventoryDrift = () => {
  const drift = [
    ...surveyCoverageDrift(catalogPrimaryFamilies()),
    ...declaredSubstitutionDrift(),
  ];
  const windows = reportFontInventory({ platform: 'windows' });
  drift.push(...countDrift('catalog', {
    options: windows.options.total,
    distinctOptionValues: windows.options.distinctValues,
    optionGroups: windows.options.groups,
    uniqueFamilies: windows.families.total,
  }, {
    options: FONT_INVENTORY_BASELINE.options,
    distinctOptionValues: FONT_INVENTORY_BASELINE.distinctOptionValues,
    optionGroups: FONT_INVENTORY_BASELINE.optionGroups,
    uniqueFamilies: FONT_INVENTORY_BASELINE.uniqueFamilies,
  }));
  drift.push(...countDrift('provenance', windows.families.provenance,
    FONT_INVENTORY_BASELINE.provenance));
  for (const platform of PLATFORMS) {
    const report = reportFontInventory({ platform });
    const expected = FONT_INVENTORY_BASELINE.platforms[platform];
    drift.push(...countDrift(`${platform}.optionOutcomes`, report.options.outcomes,
      expected.optionOutcomes));
    drift.push(...countDrift(`${platform}.familyBuckets`, report.families.buckets,
      expected.familyBuckets));
    for (const entry of report.entries) {
      if (entry.bucketConflict) {
        drift.push({ kind: 'family-classified-two-ways', family: entry.family, platform });
      }
    }
  }
  return freezeDeep(drift);
};
