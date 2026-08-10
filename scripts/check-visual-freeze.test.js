const assert = require('node:assert/strict');
const test = require('node:test');

const {
  canonicalizeLocaleValue,
  canonicalizeRuntimeRenderSource,
  compareManifests,
  createManifest,
  createRenderSurfaceFingerprint,
  createTaggedTemplateFingerprints,
  hashContents,
  isExcludedSource,
  validateManifest,
} = require('./check-visual-freeze');

test('canonicalizes the retired remote thumbnail expression to the executable native source', () => {
  const relativePath = 'src/components/inputs/VideoPreviewRenderer.js';
  const legacy = '<img src={`https://img.youtube.com/vi/${selectedVideo.id}/0.jpg`} />';
  const native = '<img src={selectedVideo.thumbnail} />';
  assert.equal(canonicalizeRuntimeRenderSource(relativePath, legacy), native);
  assert.equal(canonicalizeRuntimeRenderSource(relativePath, native), native);
  assert.throws(
    () => canonicalizeRuntimeRenderSource(relativePath, '<img src="other" />'),
    /native provider-image render contract drifted/,
  );
});

test('canonicalizes only the reviewed executable security copy corrections', () => {
  const relativePath = 'src/i18n/locales/en/settings.json';
  const legacy = {
    apiKeyDescription: 'Your API key is stored locally in your browser and never sent to our servers.',
    createOAuthClientId: 'Create OAuth 2.0 client ID (web application)',
    addAuthorizedOrigins: 'Add authorized JavaScript origins:',
    addAuthorizedRedirect: 'Add authorized redirect URI:',
    redirectMismatchDescription:
      "This error occurs when the redirect URI in your application doesn't match the URI registered in Google Cloud Console:",
    inAuthorizedOrigins: "In 'Authorized JavaScript origins', add exactly:",
    inAuthorizedRedirect: "In 'Authorized redirect URIs', add exactly:",
  };
  const corrected = canonicalizeLocaleValue(relativePath, {...legacy});
  assert.equal(
    corrected.apiKeyDescription,
    "Your API key is stored in your operating system's credential store and used only by native provider requests.",
  );
  assert.equal(corrected.createOAuthClientId, 'Create OAuth 2.0 client ID (desktop app)');
  assert.throws(
    () => canonicalizeLocaleValue(relativePath, {...legacy, apiKeyDescription: 'unreviewed drift'}),
    /reviewed locale security correction drifted/,
  );
});

function fingerprint(source) {
  return createRenderSurfaceFingerprint(source, 'src/View.jsx').hash;
}

function memoryProvider(files) {
  return {
    listFiles: () => Object.keys(files).sort(),
    readFile: (file) => Buffer.from(files[file]),
  };
}

test('alpha-renames data and callback identifiers without hiding the render structure', () => {
  const before = `
    const View = ({items, onChoose, panelClass}) => (
      <section className={panelClass}>
        {items.map((item) => item.visible
          ? <button onClick={() => onChoose(item.id)}>{item.label}</button>
          : null)}
      </section>
    );
  `;
  const after = `
    const View = ({rows, selectRow, surfaceClass}) => (
      <section className={surfaceClass}>
        {rows.map((row) => row.visible
          ? <button onClick={() => selectRow(row.id)}>{row.label}</button>
          : null)}
      </section>
    );
  `;
  assert.equal(fingerprint(after), fingerprint(before));
});

test('does not treat a native event transport rewrite as visual drift', () => {
  const browser = `<button onClick={() => fetch('/api/retry', {method: 'POST'})}>Retry</button>`;
  const native = `<button onClick={() => invokeNative('retry_job', job)}>Retry</button>`;
  assert.equal(fingerprint(native), fingerprint(browser));
});

test('normalizes an explicitly undefined JSX prop to an omitted prop', () => {
  assert.equal(
    fingerprint(`<LoadingIndicator showContainer={false} style={undefined} />`),
    fingerprint(`<LoadingIndicator showContainer={false} />`),
  );
});

test('normalizes nonvisual JSX syntax without crossing prop-spread boundaries', () => {
  assert.equal(
    fingerprint(`<Panel title="Tools" className="panel"><span /></Panel>`),
    fingerprint(`<Panel className="panel" title="Tools"><span></span></Panel>`),
  );
  assert.notEqual(
    fingerprint(`<Panel className="panel" {...props} />`),
    fingerprint(`<Panel {...props} className="panel" />`),
  );
});

test('protects Lit markup and CSS while anonymizing event behavior and data identifiers', () => {
  const before = `
    const styles = css\`.panel { color: red; }\`;
    const view = html\`<button class=\${buttonClass} @click=\${() => fetch('/old')}>\${label}</button>\`;
  `;
  const after = `
    const styles = css\`.panel { color: red; }\`;
    const view = html\`<button class=\${surfaceClass} @click=\${() => invoke('native')}>\${text}</button>\`;
  `;
  const changedMarkup = after.replace('<button', '<a').replace('</button>', '</a>');
  const changedStyles = after.replace('color: red', 'color: blue');
  assert.deepEqual(
    createTaggedTemplateFingerprints(before, 'src/View.ts'),
    createTaggedTemplateFingerprints(after, 'src/View.ts'),
  );
  assert.notEqual(
    createTaggedTemplateFingerprints(changedMarkup, 'src/View.ts').render.hash,
    createTaggedTemplateFingerprints(before, 'src/View.ts').render.hash,
  );
  assert.notEqual(
    createTaggedTemplateFingerprints(changedStyles, 'src/View.ts').styles.hash,
    createTaggedTemplateFingerprints(before, 'src/View.ts').styles.hash,
  );
});

test('detects element, attribute, class, and static text drift', () => {
  const baseline = fingerprint(`<button className="primary" title="Run">Render</button>`);
  for (const changed of [
    `<a className="primary" title="Run">Render</a>`,
    `<button className="primary" aria-label="Run">Render</button>`,
    `<button className="secondary" title="Run">Render</button>`,
    `<button className="primary" title="Run">Export</button>`,
  ]) {
    assert.notEqual(fingerprint(changed), baseline);
  }
});

test('detects conditional and map render-structure drift', () => {
  const baseline = fingerprint(
    `<main>{visible && rows.map((row) => <span key={row.id}>{row.label}</span>)}</main>`,
  );
  assert.notEqual(
    fingerprint(`<main>{visible ? rows.map((row) => <span key={row.id}>{row.label}</span>) : null}</main>`),
    baseline,
  );
  assert.notEqual(
    fingerprint(`<main>{visible && rows.filter((row) => <span key={row.id}>{row.label}</span>)}</main>`),
    baseline,
  );
  assert.notEqual(
    fingerprint(`<main>{visible && rows.map((row) => <strong key={row.id}>{row.label}</strong>)}</main>`),
    baseline,
  );
});

test('detects inline style property and literal value drift', () => {
  const baseline = fingerprint(`<div style={{color: tone, padding: 8, opacity: enabled ? 1 : 0.5}} />`);
  assert.notEqual(
    fingerprint(`<div style={{backgroundColor: tone, padding: 8, opacity: enabled ? 1 : 0.5}} />`),
    baseline,
  );
  assert.notEqual(
    fingerprint(`<div style={{color: tone, padding: 12, opacity: enabled ? 1 : 0.5}} />`),
    baseline,
  );
  assert.notEqual(
    fingerprint(`<div style={{color: tone, padding: 8, opacity: enabled && 1}} />`),
    baseline,
  );
});

test('normalizes text line endings and terminal newlines but hashes semantic CSS exactly', () => {
  const unix = Buffer.from('.panel { color: red; }\n');
  const windows = Buffer.from('.panel { color: red; }\r\n\r\n');
  assert.equal(hashContents('src/styles/panel.css', unix), hashContents('src/styles/panel.css', windows));
  assert.notEqual(
    hashContents('src/styles/panel.css', unix),
    hashContents('src/styles/panel.css', Buffer.from('.panel { color: blue; }\n')),
  );
  assert.notEqual(
    hashContents('src/assets/image.png', Buffer.from([0, 1, 2])),
    hashContents('src/assets/image.png', Buffer.from([0, 1, 3])),
  );
});

test('excludes generated and test sources from render-surface discovery', () => {
  for (const file of [
    'src/config/version.js',
    'src/setupTests.js',
    'src/View.test.jsx',
    'src/View.spec.tsx',
    'src/__tests__/View.jsx',
    'src/test-utils/Fixture.jsx',
  ]) {
    assert.equal(isExcludedSource(file), true, file);
  }
  assert.equal(isExcludedSource('src/components/View.jsx'), false);
});

test('protects source-backed static assets even when they contain no JSX', () => {
  const manifest = createManifest(memoryProvider({
    'src/assets/generatedLogo.js': `export const logoPath = 'M0 0h10v10z';`,
    'src/assets/Icon.jsx': `export const Icon = () => <svg><path d="M0 0h10v10z" /></svg>;`,
  }));
  assert.match(manifest.exactFiles['src/assets/generatedLogo.js'], /^[0-9a-f]{64}$/);
  assert.equal(manifest.renderSurfaces['src/assets/Icon.jsx'].rootCount, 1);
});

test('reports added, removed, and changed render surfaces separately from exact files', () => {
  const before = createManifest(
    memoryProvider({
      'public/index.html': '<main></main>\n',
      'src/components/Old.jsx': 'export const Old = () => <div>Old</div>',
      'src/components/Stable.jsx': 'export const Stable = () => <div>Stable</div>',
      'src/styles/app.css': '.app { color: red; }',
    }),
    'a'.repeat(40),
  );
  const after = createManifest(
    memoryProvider({
      'public/index.html': '<main></main>\n',
      'src/components/New.jsx': 'export const New = () => <div>New</div>',
      'src/components/Stable.jsx': 'export const Stable = () => <span>Stable</span>',
      'src/styles/app.css': '.app { color: blue; }',
    }),
  );
  assert.deepEqual(compareManifests(before, after), {
    exact: { added: [], removed: [], changed: ['src/styles/app.css'] },
    locale: {added: [], removed: [], changed: []},
    render: {
      added: ['src/components/New.jsx'],
      removed: ['src/components/Old.jsx'],
      changed: ['src/components/Stable.jsx'],
    },
  });
});

test('preserves original locale values while allowing new native-flow keys', () => {
  const before = createManifest(
    memoryProvider({
      'src/i18n/locales/en/common.json': JSON.stringify({stable: 'Original', nested: {text: 'Text'}}),
    }),
    'a'.repeat(40),
  );
  const added = createManifest(memoryProvider({
    'src/i18n/locales/en/common.json': JSON.stringify({
      stable: 'Original',
      nested: {text: 'Text'},
      nativeOnly: 'New flow',
    }),
  }));
  const changed = createManifest(memoryProvider({
    'src/i18n/locales/en/common.json': JSON.stringify({stable: 'Changed', nested: {text: 'Text'}}),
  }));
  assert.deepEqual(compareManifests(before, added).locale, {
    added: [], removed: [], changed: [],
  });
  assert.deepEqual(compareManifests(before, changed).locale.changed, [
    'src/i18n/locales/en/common.json',
  ]);
});

test('records a security-retired static file without allowing it back into the working tree', () => {
  const retired = createManifest(memoryProvider({}), 'a'.repeat(40));
  const working = createManifest(
    memoryProvider({'public/oauth2callback.html': '<main>retired</main>'}),
  );
  assert.equal(Object.keys(retired.retiredExactFiles).length, 1);
  assert.equal(Object.keys(retired.exactFiles).length, 0);
  validateManifest(retired);
  assert.deepEqual(compareManifests(retired, working).exact.added, [
    'public/oauth2callback.html',
  ]);
  assert.throws(
    () => validateManifest(createManifest(
      memoryProvider({'public/oauth2callback.html': '<main>changed</main>'}),
      'a'.repeat(40),
    )),
    /invalid retired visual baseline/,
  );
});

test('rejects obsolete and malformed schema-5 manifests', () => {
  assert.throws(() => validateManifest({schemaVersion: 1}), /invalid or obsolete/);
  assert.throws(
    () =>
      validateManifest({
        schemaVersion: 5,
        algorithm: 'sha256',
        normalization: 'wrong',
        baselineRevision: 'a'.repeat(40),
        retiredExactFiles: {},
        exactFiles: {},
        localeSurfaces: {},
        renderSurfaces: {},
      }),
    /invalid or obsolete/,
  );
});

test('fails closed when a render source cannot be parsed', () => {
  assert.throws(() => fingerprint('const View = () => <div>'), /cannot parse visual source/);
});
