import { fontOptions } from '../components/subtitleCustomization/fontOptions';
import {
  FONT_WEIGHT_MAXIMUM,
  FONT_WEIGHT_MINIMUM,
  LEGACY_WEB_FONT_ALIASES,
  MANAGED_FONT_PACKAGE,
  MAX_FONT_FAMILY_BYTES,
  SYSTEM_FACE_DECLARATIONS,
  UNAVAILABLE_REASON,
  classifyFontCatalog,
  describeFontCatalogAliases,
  fontIdentityKey,
  normalizeFontWeight,
  parseFontFamilyValue,
  resolveFontIdentity,
  resolveSavedFontIdentity,
  resolveVariableAxisInstance,
  sameFontIdentity,
} from './fontIdentity';

const installed = () => true;
const notInstalled = () => false;

const resolve = (overrides = {}) => resolveFontIdentity({
  fontWeight: 400,
  platform: 'windows',
  managedPackInstalled: true,
  isSystemFaceInstalled: installed,
  ...overrides,
});

const primaryFamily = (value) => parseFontFamilyValue(value).primary;

describe('catalog facts the identity layer has to cover', () => {
  it('measures the shipped catalog', () => {
    const values = new Set(fontOptions.map((option) => option.value));
    const families = new Set(fontOptions.map((option) => primaryFamily(option.value)));
    const groups = new Set(fontOptions.map((option) => option.group));
    expect(fontOptions).toHaveLength(121);
    expect(values.size).toBe(116);
    expect(families.size).toBe(115);
    expect(groups.size).toBe(17);
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

describe('classification', () => {
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
      expect(SYSTEM_FACE_DECLARATIONS[platform].faces).toHaveLength(0);
      expect(report.entries.find((entry) => entry.family === 'Arial').reason)
        .toBe(UNAVAILABLE_REASON.platformNotReviewed);
    }
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

  it('counts every entry exactly once', () => {
    const report = classifyFontCatalog({ platform: 'windows' });
    const total = Object.values(report.counts).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(report.entries.length);
  });
});

describe('exact resolution', () => {
  it('resolves the managed family to content-addressed bytes', () => {
    const result = resolve({ fontFamily: "'Google Sans', 'Open Sans', sans-serif" });
    expect(result.status).toBe('exact');
    expect(result.identity.source).toBe('managed');
    expect(result.identity.family).toBe('Google Sans');
    expect(result.identity.packageId).toBe('google-sans-flex');
    expect(result.identity.packageVersion).toBe('v22-ui4');
    expect(result.identity.bytes.map((file) => file.sha256)).toEqual([
      '7343aefa9061998bdfea8c1e2aa6943a029218dd78a23e5fde441e832fe66629',
      '0f63b3ae4c60341fc1348749796505e9ab621a3ab690b80f9cdf66dafc1eca19',
      '3215351d7b5587396710ab80bd31994ebbf3a9ee6f8e67b3c29a30d909cec55f',
    ]);
    expect(result.identity.key)
      .toBe('managed:google-sans-flex@v22-ui4|Google Sans|400|normal');
  });

  it('resolves a declared, probed system face', () => {
    const result = resolve({ fontFamily: "'Malgun Gothic', sans-serif" });
    expect(result.status).toBe('exact');
    expect(result.identity.source).toBe('system');
    expect(result.identity.platform).toBe('windows');
    expect(result.identity.bytes).toEqual([]);
    expect(result.identity.key).toBe('system:windows|Malgun Gothic|400|normal');
  });

  it('refuses to assume a system face is installed without a probe', () => {
    const result = resolveFontIdentity({
      fontFamily: "'Arial', sans-serif", fontWeight: 400, platform: 'windows',
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(UNAVAILABLE_REASON.systemFaceUnverified);
  });

  it('refuses the managed family when its bytes are not installed', () => {
    const result = resolve({
      fontFamily: "'Google Sans', sans-serif", managedPackInstalled: false,
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(UNAVAILABLE_REASON.managedPackUnavailable);
  });
});

describe('hostile input', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['comma only', ',,,'],
    ['tab and newline', "'Arial'\t\n"],
    ['null byte', "'Ari\u0000al', sans-serif"],
    ['escape control', "'Arial\u001b', sans-serif"],
    ['delete control', "'Arial\u007f', sans-serif"],
    ['c1 control', "'Arial\u009f', sans-serif"],
    ['lone high surrogate', "'Ari\ud800al', sans-serif"],
    ['lone low surrogate', "'Ari\udc00al', sans-serif"],
    ['over the byte bound', `'${'A'.repeat(MAX_FONT_FAMILY_BYTES + 1)}', sans-serif`],
    ['multibyte over the byte bound', `'${'한'.repeat(MAX_FONT_FAMILY_BYTES)}'`],
    ['not a string', 42],
    ['null', null],
    ['undefined', undefined],
  ])('rejects an invalid family: %s', (_label, fontFamily) => {
    const result = resolve({ fontFamily });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(UNAVAILABLE_REASON.invalidFamily);
    expect(result.identity).toBeNull();
  });

  it.each(['sans-serif', 'serif', 'monospace', 'cursive', 'system-ui', 'inherit', 'SANS-SERIF'])(
    'never turns the generic family %s into an identity',
    (fontFamily) => {
      const result = resolve({ fontFamily });
      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe(UNAVAILABLE_REASON.genericFamily);
    },
  );

  it.each([
    ['below the range', 50],
    ['above the range', 1000],
    ['far above the range', 10_000],
    ['zero', 0],
    ['negative', -400],
    ['off the 100 step', 450],
    ['fractional', 400.5],
    ['numeric string', '400'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['missing', undefined],
  ])('rejects a weight outside 100-900: %s', (_label, fontWeight) => {
    const result = resolve({ fontFamily: "'Google Sans', sans-serif", fontWeight });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(UNAVAILABLE_REASON.invalidWeight);
  });

  it('accepts both ends of the weight range', () => {
    expect(normalizeFontWeight(FONT_WEIGHT_MINIMUM)).toBe(100);
    expect(normalizeFontWeight(FONT_WEIGHT_MAXIMUM)).toBe(900);
    for (const fontWeight of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      expect(resolve({ fontFamily: "'Google Sans', sans-serif", fontWeight }).status).toBe('exact');
    }
  });

  it('reports a weight the system face does not actually ship', () => {
    // Impact ships one file. A 700 request would be synthesised by the rasteriser; say so instead.
    const result = resolve({ fontFamily: "'Impact', sans-serif", fontWeight: 700 });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(UNAVAILABLE_REASON.weightNotInFace);
    expect(result.declaredWeights).toEqual([400]);
  });

  it('reports an italic the system face does not actually ship', () => {
    expect(resolve({ fontFamily: "'Tahoma', sans-serif", fontStyle: 'italic' }).reason)
      .toBe(UNAVAILABLE_REASON.styleNotInFace);
    expect(resolve({ fontFamily: "'Georgia', serif", fontStyle: 'italic' }).status).toBe('exact');
    expect(resolve({ fontFamily: "'Arial', sans-serif", fontStyle: 'oblique' }).reason)
      .toBe(UNAVAILABLE_REASON.invalidStyle);
  });

  it('rejects an unsupported platform rather than guessing one', () => {
    expect(resolve({ fontFamily: "'Arial', sans-serif", platform: 'solaris' }).reason)
      .toBe(UNAVAILABLE_REASON.unsupportedPlatform);
    expect(resolve({ fontFamily: "'Arial', sans-serif", platform: undefined }).reason)
      .toBe(UNAVAILABLE_REASON.unsupportedPlatform);
  });
});

describe('missing, corrupt and substituted faces', () => {
  it('reports a missing font instead of letting the rasteriser choose', () => {
    const result = resolve({
      fontFamily: "'Malgun Gothic', sans-serif", isSystemFaceInstalled: notInstalled,
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(UNAVAILABLE_REASON.systemFaceMissing);
    expect(result.identity).toBeNull();
  });

  it.each([
    ['truncated hash', { sha256: 'abc123' }],
    ['non-hex hash', { sha256: 'z'.repeat(64) }],
    ['uppercase hash', { sha256: 'A'.repeat(64) }],
    ['zero length', { sizeBytes: 0 }],
    ['negative length', { sizeBytes: -1 }],
    ['fractional length', { sizeBytes: 1.5 }],
  ])('refuses a corrupt managed declaration: %s', (_label, corruption) => {
    const managedPackage = {
      ...MANAGED_FONT_PACKAGE,
      files: [{ ...MANAGED_FONT_PACKAGE.files[0], ...corruption }],
    };
    const result = resolve({
      fontFamily: "'Google Sans', sans-serif", declarations: { managedPackage },
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(UNAVAILABLE_REASON.managedPackInvalid);
  });

  it('refuses a managed declaration with duplicate subsets', () => {
    const managedPackage = {
      ...MANAGED_FONT_PACKAGE,
      files: [MANAGED_FONT_PACKAGE.files[0], MANAGED_FONT_PACKAGE.files[0]],
    };
    expect(resolve({
      fontFamily: "'Google Sans', sans-serif", declarations: { managedPackage },
    }).reason).toBe(UNAVAILABLE_REASON.managedPackInvalid);
  });

  it('refuses the family the OS silently substitutes, and names the substitute', () => {
    const result = resolve({ fontFamily: "'Helvetica', sans-serif" });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(UNAVAILABLE_REASON.osSubstituted);
    expect(result.osSubstitution)
      .toEqual({ declaredFamily: 'Helvetica', substitutedFamily: 'Arial' });
    // Arial is genuinely present, which is exactly why the substitution is invisible today.
    expect(resolve({ fontFamily: "'Arial', sans-serif" }).status).toBe('exact');
  });

  it('surfaces the legacy alias on an otherwise exact resolution', () => {
    const result = resolve({ fontFamily: "'Courier New', monospace" });
    expect(result.status).toBe('exact');
    expect(result.identity.family).toBe('Courier New');
    expect(result.legacyAlias)
      .toEqual({ declaredFamily: 'Courier New', servedFamily: 'Courier Prime' });
  });

  it('never resolves an alias-only family to the family the alias served', () => {
    const result = resolve({ fontFamily: "'Gotham', sans-serif" });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(UNAVAILABLE_REASON.noDeclaredSource);
    expect(result.legacyAlias).toEqual({ declaredFamily: 'Gotham', servedFamily: 'Inter' });
    expect(result.identity).toBeNull();
  });
});

describe('fallback chains are never followed', () => {
  it('fails on the primary family even when a fallback would resolve', () => {
    const result = resolve({ fontFamily: "'Helvetica', Arial, 'Google Sans', sans-serif" });
    expect(result.status).toBe('unavailable');
    expect(result.fallbacksIgnored).toEqual(['Arial', 'Google Sans', 'sans-serif']);
  });

  it('ignores the fallback of an unknown primary', () => {
    const result = resolve({ fontFamily: "'Absolutely Not A Font', 'Google Sans', sans-serif" });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(UNAVAILABLE_REASON.unknownFamily);
    expect(result.fallbacksIgnored).toEqual(['Google Sans', 'sans-serif']);
  });

  it('separates a catalog family with no byte source from a family nobody declared', () => {
    expect(resolve({ fontFamily: "'Verdana', sans-serif" }).status).toBe('exact');
    expect(resolve({ fontFamily: "'Bebas Neue', sans-serif" }).reason)
      .toBe(UNAVAILABLE_REASON.noDeclaredSource);
    expect(resolve({ fontFamily: "'Bebas Neu', sans-serif" }).reason)
      .toBe(UNAVAILABLE_REASON.unknownFamily);
  });

  it('parses quoting, spacing and the declared stack the same way each time', () => {
    expect(parseFontFamilyValue('"Google Sans" ,  sans-serif ')).toEqual({
      ok: true, primary: 'Google Sans', fallbacks: ['sans-serif'],
    });
    expect(parseFontFamilyValue('Google Sans').primary).toBe('Google Sans');
  });
});

describe('scripts the renderer must not mangle', () => {
  it.each([
    ['Korean', "'Noto Sans KR', sans-serif", 'Noto Sans KR'],
    ['Vietnamese', "'Be Vietnam Pro', sans-serif", 'Be Vietnam Pro'],
    ['Arabic / RTL', "'Noto Sans Arabic', sans-serif", 'Noto Sans Arabic'],
    ['Japanese', "'Noto Sans JP', sans-serif", 'Noto Sans JP'],
    ['Chinese', "'Noto Sans SC', sans-serif", 'Noto Sans SC'],
  ])('reports %s catalog families honestly rather than substituting', (_label, value, family) => {
    const result = resolve({ fontFamily: value });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(UNAVAILABLE_REASON.noDeclaredSource);
    expect(result.requested.family).toBe(family);
  });

  it.each([
    ['Korean name', "'맑은 고딕', sans-serif", '맑은 고딕'],
    ['Vietnamese name', "'Tiếng Việt Sans', sans-serif", 'Tiếng Việt Sans'],
    ['Arabic RTL name', "'الخط العربي', sans-serif", 'الخط العربي'],
    ['emoji name', "'Font 😀 Emoji', sans-serif", 'Font 😀 Emoji'],
    ['astral plane name', "'𝕱𝖗𝖆𝖐𝖙𝖚𝖗', sans-serif", '𝕱𝖗𝖆𝖐𝖙𝖚𝖗'],
    ['combining marks', "'Xám Hạu', sans-serif", 'Xám Hạu'],
    ['bidi text', "'‮Arial‬', sans-serif", '‮Arial‬'],
  ])('accepts well-formed %s and reports it unknown, unchanged', (_label, value, family) => {
    const result = resolve({ fontFamily: value });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(UNAVAILABLE_REASON.unknownFamily);
    expect(result.requested.family).toBe(family);
  });

  it('does not let a bidi override smuggle in a different family', () => {
    // The visually reversed form is a different string, so it must not match 'Arial'.
    expect(resolve({ fontFamily: "'‮Arial‬', sans-serif" }).identity).toBeNull();
  });
});

describe('variable axes', () => {
  it('pins every declared axis to a value derived from the inputs', () => {
    const { identity } = resolve({ fontFamily: "'Google Sans', sans-serif", fontWeight: 600 });
    expect(identity.axes.map((axis) => axis.tag)).toEqual(['opsz', 'wght', 'GRAD', 'ROND']);
    const instance = resolveVariableAxisInstance(identity, { fontSizePx: 48 });
    expect(instance).toEqual({ ok: true, axes: { opsz: 48, wght: 600, GRAD: 0, ROND: 0 } });
  });

  it('clamps the optical size into the declared axis range', () => {
    const { identity } = resolve({ fontFamily: "'Google Sans', sans-serif" });
    expect(resolveVariableAxisInstance(identity, { fontSizePx: 1 }).axes.opsz).toBe(6);
    expect(resolveVariableAxisInstance(identity, { fontSizePx: 5_000 }).axes.opsz).toBe(144);
  });

  it('is a pure function of its inputs', () => {
    const { identity } = resolve({ fontFamily: "'Google Sans', sans-serif", fontWeight: 300 });
    const first = resolveVariableAxisInstance(identity, { fontSizePx: 33.7 });
    const second = resolveVariableAxisInstance(identity, { fontSizePx: 33.7 });
    expect(first).toEqual(second);
  });

  it('refuses to invent an optical size', () => {
    const { identity } = resolve({ fontFamily: "'Google Sans', sans-serif" });
    for (const fontSizePx of [undefined, null, 0, -12, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveVariableAxisInstance(identity, { fontSizePx }))
        .toEqual({ ok: false, reason: UNAVAILABLE_REASON.opticalSizeRequired });
    }
  });

  it('has no axes for a static system face', () => {
    const { identity } = resolve({ fontFamily: "'Arial', sans-serif" });
    expect(identity.variable).toBe(false);
    expect(resolveVariableAxisInstance(identity, {})).toEqual({ ok: true, axes: {} });
  });

  it('reports a weight outside a narrower variable range instead of clamping it', () => {
    const managedPackage = {
      ...MANAGED_FONT_PACKAGE,
      axes: [{ tag: 'wght', minimum: 400, maximum: 700, pinnedFrom: 'font-weight' }],
    };
    const result = resolve({
      fontFamily: "'Google Sans', sans-serif", fontWeight: 900, declarations: { managedPackage },
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(UNAVAILABLE_REASON.weightNotInFace);
    expect(result.declaredWeightRange).toEqual([400, 700]);
  });
});

describe('saved project identity', () => {
  const savedManaged = () => resolve({ fontFamily: "'Google Sans', sans-serif" }).identity;

  it('keeps resolving a saved identity to the same identity', () => {
    const saved = savedManaged();
    const reopened = resolveSavedFontIdentity(saved, {
      platform: 'windows', managedPackInstalled: true, isSystemFaceInstalled: installed,
    });
    expect(reopened.status).toBe('exact');
    expect(sameFontIdentity(reopened.identity, saved)).toBe(true);
    expect(fontIdentityKey(reopened.identity)).toBe(fontIdentityKey(saved));
  });

  it('reports drift when the managed package version moves', () => {
    const saved = savedManaged();
    const reopened = resolveSavedFontIdentity(saved, {
      platform: 'windows',
      managedPackInstalled: true,
      declarations: { managedPackage: { ...MANAGED_FONT_PACKAGE, version: 'v23-ui1' } },
    });
    expect(reopened.status).toBe('unavailable');
    expect(reopened.reason).toBe(UNAVAILABLE_REASON.identityDrift);
    expect(reopened.expectedKey).toBe('managed:google-sans-flex@v22-ui4|Google Sans|400|normal');
    expect(reopened.actualKey).toBe('managed:google-sans-flex@v23-ui1|Google Sans|400|normal');
    expect(reopened.identity).toBeNull();
  });

  it('reports drift when the bytes change under an unchanged version', () => {
    const saved = savedManaged();
    const managedPackage = {
      ...MANAGED_FONT_PACKAGE,
      files: [{ ...MANAGED_FONT_PACKAGE.files[0], sha256: 'f'.repeat(64) }],
    };
    const reopened = resolveSavedFontIdentity(saved, {
      platform: 'windows', managedPackInstalled: true, declarations: { managedPackage },
    });
    expect(reopened.reason).toBe(UNAVAILABLE_REASON.identityDrift);
  });

  it('reports unavailable rather than silently moving a project to another platform face', () => {
    const saved = resolve({ fontFamily: "'Arial', sans-serif" }).identity;
    const reopened = resolveSavedFontIdentity(saved, {
      platform: 'macos', managedPackInstalled: true, isSystemFaceInstalled: installed,
    });
    expect(reopened.status).toBe('unavailable');
    expect(reopened.reason).toBe(UNAVAILABLE_REASON.platformNotReviewed);
    expect(reopened.identity).toBeNull();
  });

  it('reports unavailable when the saved face is uninstalled', () => {
    const saved = resolve({ fontFamily: "'Verdana', sans-serif" }).identity;
    const reopened = resolveSavedFontIdentity(saved, {
      platform: 'windows', managedPackInstalled: true, isSystemFaceInstalled: notInstalled,
    });
    expect(reopened.reason).toBe(UNAVAILABLE_REASON.systemFaceMissing);
  });

  it.each([[null], [undefined], ['Arial'], [42], [[]]])(
    'refuses a malformed saved identity: %s',
    (saved) => {
      expect(resolveSavedFontIdentity(saved, { platform: 'windows' }).status)
        .toBe('unavailable');
    },
  );

  it('never returns a mutable identity a caller could rewrite', () => {
    const saved = savedManaged();
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.bytes)).toBe(true);
    expect(() => { saved.family = 'Arial'; }).toThrow(TypeError);
    expect(saved.family).toBe('Google Sans');
  });
});
