import { fontOptions } from '../components/subtitleCustomization/fontOptions';
import {
  LEGACY_WEB_FONT_ALIASES,
  MANAGED_FONT_PACKAGE,
  OS_FAMILY_SUBSTITUTIONS,
  SYSTEM_FACE_DECLARATIONS,
  UNAVAILABLE_REASON,
  catalogPrimaryFamilies,
  parseFontFamilyValue,
} from './fontIdentity';
import {
  FAMILY_DELIVERY_PROVENANCE,
  FONT_DELIVERY_PROVENANCE,
  FONT_FAMILY_BUCKET,
  FONT_INVENTORY_BASELINE,
  classifyFontCatalog,
  describeFontCatalogAliases,
  fontInventoryDrift,
  reportFontInventory,
  substitutionTableDrift,
  surveyCoverageDrift,
} from './fontInventory';

const windows = () => reportFontInventory({ platform: 'windows' });
const sum = (counts) => Object.values(counts).reduce((total, value) => total + value, 0);
const familiesWith = (report, provenance) => report.entries
  .filter((entry) => entry.provenance === provenance).map((entry) => entry.family);

describe('the one reported inventory', () => {
  it('names three different counts and never conflates them', () => {
    const report = windows();
    // OPTIONS: what a user can pick. The same family in two groups is two options.
    expect(report.options.total).toBe(121);
    expect(fontOptions).toHaveLength(121);
    // DISTINCT OPTION VALUES: unique font-family strings behind those options.
    expect(report.options.distinctValues).toBe(116);
    expect(new Set(fontOptions.map((option) => option.value)).size).toBe(116);
    // UNIQUE FAMILIES: what a byte source is delivered for. The only count a licence claim may use.
    expect(report.families.total).toBe(115);
    expect(new Set(fontOptions.map((option) => parseFontFamilyValue(option.value).primary)).size)
      .toBe(115);
    expect(report.options.groups).toBe(17);
  });

  it('puts every option in exactly one outcome', () => {
    const report = windows();
    expect(report.options.outcomes)
      .toEqual({ managed: 2, system: 12, osRedirected: 2, noByteSource: 105 });
    expect(sum(report.options.outcomes)).toBe(121);
    expect(report.options.resolvable).toBe(14);
    expect(report.options.unavailable).toBe(107);
    expect(report.options.resolvable + report.options.unavailable).toBe(121);
  });

  it('puts every family in exactly one bucket', () => {
    const report = windows();
    expect(report.families.buckets).toEqual({
      managed: 1, 'system-declared': 11, 'os-redirected': 1, unavailable: 102,
    });
    expect(sum(report.families.buckets)).toBe(115);
    expect(new Set(report.entries.map((entry) => entry.family)).size).toBe(115);
    expect(report.entries.every((entry) => entry.bucketConflict === false)).toBe(true);
  });

  it('gives every family a provenance, so nothing is silently uncounted', () => {
    const report = windows();
    expect(report.families.provenance).toEqual({
      delivered: 1,
      'os-proprietary': 11,
      restricted: 15,
      'open-licence-candidate': 87,
      'not-a-family': 1,
    });
    expect(sum(report.families.provenance)).toBe(115);
    expect(report.families.unclassified).toEqual([]);
    expect(Object.keys(FAMILY_DELIVERY_PROVENANCE)).toHaveLength(115);
  });

  it('reconciles the two figures that were both cited as fact', () => {
    const report = windows();
    // "121 options, 107 unavailable" counted OPTIONS.
    expect(report.reconciliation.unavailableOptions).toBe(107);
    // "115 families, 88 recoverable" counted FAMILIES. Same catalog, different denominator.
    expect(report.reconciliation.uniqueFamilies).toBe(115);
    expect(report.reconciliation.recoverableFamiliesAsReported).toBe(88);
    // Those 107 unavailable OPTIONS are 103 unique families, which is neither 107 nor 88.
    const unresolvable = report.entries.filter((entry) => (
      entry.bucket !== FONT_FAMILY_BUCKET.managed
      && entry.bucket !== FONT_FAMILY_BUCKET.systemDeclared
    ));
    expect(unresolvable).toHaveLength(103);
    expect(unresolvable.reduce((total, entry) => total + entry.optionCount, 0)).toBe(107);
  });

  it('corrects the recoverable figure: one of the 88 is not a family at all', () => {
    const report = windows();
    expect(report.reconciliation.deliverableOpenLicenceFamilies).toBe(87);
    expect(report.reconciliation.phantomFamilies).toBe(1);
    expect(report.reconciliation.deliverableOpenLicenceFamilies
      + report.reconciliation.phantomFamilies)
      .toBe(report.reconciliation.recoverableFamiliesAsReported);
    expect(familiesWith(report, FONT_DELIVERY_PROVENANCE.notAFamily))
      .toEqual(['Noto Sans Vietnamese']);
    // It only ever existed as an alias for a family that does exist, which is why it was counted.
    expect(LEGACY_WEB_FONT_ALIASES['Noto Sans Vietnamese']).toBe('Noto Sans');
  });

  it('splits the unavailable families by what could honestly back them', () => {
    const report = windows();
    expect(report.families.unavailableByProvenance).toEqual({
      delivered: 0,
      'os-proprietary': 0,
      restricted: 14,
      'open-licence-candidate': 87,
      'not-a-family': 1,
    });
    expect(sum(report.families.unavailableByProvenance))
      .toBe(report.families.buckets[FONT_FAMILY_BUCKET.unavailable]);
    // The fifteenth restricted family is Helvetica, which is redirected rather than unavailable.
    expect(familiesWith(report, FONT_DELIVERY_PROVENANCE.restricted)).toHaveLength(15);
    expect(report.entries.find((entry) => entry.family === 'Helvetica')).toMatchObject({
      bucket: FONT_FAMILY_BUCKET.osRedirected,
      provenance: FONT_DELIVERY_PROVENANCE.restricted,
    });
  });

  it('reports an unreviewed platform as unavailable rather than guessing', () => {
    for (const platform of ['macos', 'linux']) {
      const report = reportFontInventory({ platform });
      expect(report.options.outcomes)
        .toEqual({ managed: 2, system: 0, osRedirected: 0, noByteSource: 119 });
      expect(report.families.buckets).toEqual({
        managed: 1, 'system-declared': 0, 'os-redirected': 0, unavailable: 114,
      });
      expect(SYSTEM_FACE_DECLARATIONS[platform].faces).toHaveLength(0);
      // The provenance survey is platform-independent: what is deliverable does not change.
      expect(report.families.provenance).toEqual(windows().families.provenance);
    }
  });
});

describe('no family is classified without saying why', () => {
  it('gives every unresolvable family a typed reason and every resolvable one none', () => {
    for (const platform of ['windows', 'macos', 'linux']) {
      for (const entry of reportFontInventory({ platform }).entries) {
        const resolvable = entry.bucket === FONT_FAMILY_BUCKET.managed
          || entry.bucket === FONT_FAMILY_BUCKET.systemDeclared;
        if (resolvable) expect(entry.reason).toBeNull();
        else expect(Object.values(UNAVAILABLE_REASON)).toContain(entry.reason);
      }
    }
  });

  it('classifies every entry on the reviewed platform', () => {
    const report = classifyFontCatalog({ platform: 'windows' });
    expect(report.total).toBe(121);
    expect(report.uniqueFamilies).toBe(115);
    expect(report.counts).toEqual({ managed: 2, system: 12, unavailable: 107 });
    expect(report.entries.filter((entry) => entry.classification === 'managed')
      .every((entry) => entry.family === 'Google Sans')).toBe(true);
  });

  it('never claims a face on a platform whose faces are not reviewed', () => {
    for (const platform of ['macos', 'linux']) {
      const report = classifyFontCatalog({ platform });
      expect(report.counts).toEqual({ managed: 2, system: 0, unavailable: 119 });
      expect(report.entries.find((entry) => entry.family === 'Arial').reason)
        .toBe(UNAVAILABLE_REASON.platformNotReviewed);
    }
  });

  it('counts every entry exactly once', () => {
    const report = classifyFontCatalog({ platform: 'windows' });
    expect(sum(report.counts)).toBe(report.entries.length);
  });

  it('marks the OS-substituted family unavailable and names the substitute', () => {
    const helvetica = classifyFontCatalog({ platform: 'windows' })
      .entries.filter((entry) => entry.family === 'Helvetica');
    expect(helvetica).toHaveLength(2);
    for (const entry of helvetica) {
      expect(entry.classification).toBe('unavailable');
      expect(entry.reason).toBe(UNAVAILABLE_REASON.osSubstituted);
      expect(entry.osSubstitution).toEqual({
        declaredFamily: 'Helvetica', substitutedFamily: 'Arial',
      });
    }
  });

  it('classifies an alias family by its own bytes, not by what the alias served', () => {
    const entries = classifyFontCatalog({ platform: 'windows' }).entries;
    const courier = entries.find((entry) => entry.family === 'Courier New');
    expect(courier.classification).toBe('system');
    expect(courier.legacyAlias).toEqual({
      declaredFamily: 'Courier New', servedFamily: 'Courier Prime',
    });
    const gotham = entries.find((entry) => entry.family === 'Gotham');
    expect(gotham.classification).toBe('unavailable');
    expect(gotham.legacyAlias).toEqual({ declaredFamily: 'Gotham', servedFamily: 'Inter' });
  });

  it('surfaces every legacy alias instead of hiding it', () => {
    const aliases = describeFontCatalogAliases();
    expect(aliases).toHaveLength(18);
    expect(aliases).toContainEqual({ declaredFamily: 'Gotham', servedFamily: 'Inter' });
    expect(aliases).toContainEqual({ declaredFamily: 'Calibri', servedFamily: 'Carlito' });
    expect(new Set(aliases.map((alias) => alias.declaredFamily)))
      .toEqual(new Set(Object.keys(LEGACY_WEB_FONT_ALIASES)));
    // An alias is never a resolution path: it points at a different family, by definition.
    for (const alias of aliases) expect(alias.servedFamily).not.toBe(alias.declaredFamily);
  });
});

describe('both substitution tables are written in the disclosing direction', () => {
  it('reads the OS table as asked-for to served, never the reverse', () => {
    const report = windows();
    const bucketOf = (family) => report.entries.find((entry) => entry.family === family)?.bucket;
    for (const [declared, served] of Object.entries(OS_FAMILY_SUBSTITUTIONS.windows)) {
      // The key is what the user asked for, so it is the side that must be refused.
      if (bucketOf(declared)) expect(bucketOf(declared)).toBe(FONT_FAMILY_BUCKET.osRedirected);
      // The value is what the OS would have served. It must not be tainted by being a target.
      expect(bucketOf(served)).not.toBe(FONT_FAMILY_BUCKET.osRedirected);
      expect(Object.hasOwn(OS_FAMILY_SUBSTITUTIONS.windows, served)).toBe(false);
    }
  });

  it('reads the alias table as declared to served, never the reverse', () => {
    for (const [declared, served] of Object.entries(LEGACY_WEB_FONT_ALIASES)) {
      expect(served).not.toBe(declared);
      // No chains: a served family is never itself an alias key, so disclosure is one hop.
      expect(Object.hasOwn(LEGACY_WEB_FONT_ALIASES, served)).toBe(false);
    }
  });

  it('detects a table that maps a family to itself or chains', () => {
    expect(substitutionTableDrift('os-substitution', { Helvetica: 'Helvetica' }))
      .toEqual([{ kind: 'os-substitution-maps-a-family-to-itself', family: 'Helvetica' }]);
    expect(substitutionTableDrift('legacy-alias', { Gotham: 'Inter', Inter: 'Roboto' }))
      .toEqual([{ kind: 'legacy-alias-chains', family: 'Gotham' }]);
  });
});

describe('the drift guard', () => {
  it('reports no drift against the reviewed baseline', () => {
    expect(fontInventoryDrift()).toEqual([]);
  });

  it('fails when a catalog option arrives without a classification', () => {
    const drift = surveyCoverageDrift([...catalogPrimaryFamilies(), 'Brand New Face']);
    expect(drift).toContainEqual({ kind: 'catalog-family-not-surveyed', family: 'Brand New Face' });
  });

  it('fails when a surveyed family leaves the catalog', () => {
    const fewer = [...catalogPrimaryFamilies()].filter((family) => family !== 'Inter');
    expect(surveyCoverageDrift(fewer))
      .toContainEqual({ kind: 'surveyed-family-not-in-catalog', family: 'Inter' });
  });

  it('fails when a family moves bucket', () => {
    const systemFaces = {
      ...SYSTEM_FACE_DECLARATIONS,
      windows: {
        reviewed: true,
        faces: [
          ...SYSTEM_FACE_DECLARATIONS.windows.faces,
          { family: 'Inter', weights: [400], italic: false },
        ],
      },
    };
    const moved = reportFontInventory({ platform: 'windows', declarations: { systemFaces } });
    expect(moved.families.buckets).toEqual({
      managed: 1, 'system-declared': 12, 'os-redirected': 1, unavailable: 101,
    });
    expect(moved.families.buckets)
      .not.toEqual(FONT_INVENTORY_BASELINE.platforms.windows.familyBuckets);
    // The survey would then disagree with the declarations, which is the other half of the guard.
    expect(FAMILY_DELIVERY_PROVENANCE.Inter)
      .toBe(FONT_DELIVERY_PROVENANCE.openLicenceCandidate);
  });

  it('keeps the survey and the shipped declarations in agreement', () => {
    const declared = SYSTEM_FACE_DECLARATIONS.windows.faces.map((face) => face.family).sort();
    const surveyed = Object.keys(FAMILY_DELIVERY_PROVENANCE)
      .filter((family) => FAMILY_DELIVERY_PROVENANCE[family]
        === FONT_DELIVERY_PROVENANCE.osProprietary).sort();
    expect(surveyed).toEqual(declared);
    expect(Object.keys(FAMILY_DELIVERY_PROVENANCE)
      .filter((family) => FAMILY_DELIVERY_PROVENANCE[family] === FONT_DELIVERY_PROVENANCE.delivered))
      .toEqual([MANAGED_FONT_PACKAGE.family]);
  });

  it('states the baseline the gate asserts, so changing it is a decision', () => {
    expect(FONT_INVENTORY_BASELINE.options).toBe(121);
    expect(FONT_INVENTORY_BASELINE.uniqueFamilies).toBe(115);
    expect(sum(FONT_INVENTORY_BASELINE.provenance)).toBe(115);
    expect(sum(FONT_INVENTORY_BASELINE.platforms.windows.optionOutcomes)).toBe(121);
    expect(sum(FONT_INVENTORY_BASELINE.platforms.windows.familyBuckets)).toBe(115);
  });
});
