import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditDesktopPayload } from './check-desktop-payload-size.mjs';

const digestOf = (contents) => createHash('sha256').update(contents).digest('hex');

/** The three managed font bytes a fixture ships, standing in for the real seven. */
const FONT_BYTES = ['woff2-vietnamese', 'woff2-latin', 'OFL text'];

/**
 * A miniature repository whose payload is exactly what review allows: two protocol workers, the two
 * licence files, and managed font bytes named by their own digests and pinned by a delivery catalog.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-payload-gate-'));
  const tauri = path.join(root, 'apps', 'desktop', 'src-tauri');
  const fonts = path.join(tauri, 'resources', 'ui-fonts');
  const delivery = path.join(root, 'crates', 'osg-engine-packages', 'delivery');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.mkdirSync(fonts, { recursive: true });
  fs.mkdirSync(delivery, { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'index.html'), '<!doctype html>');

  const resources = {
    '../../asr.py': 'workers/osg_asr_worker.py',
    '../../speech.py': 'workers/osg_speech_worker.py',
    '../../../LICENSE': 'licenses/LICENSE',
    '../../../THIRD_PARTY_NOTICES.md': 'licenses/THIRD_PARTY_NOTICES.md',
  };
  const sources = [];
  for (const contents of FONT_BYTES) {
    const digest = digestOf(contents);
    fs.writeFileSync(path.join(fonts, digest), contents);
    resources[`resources/ui-fonts/${digest}`] = `ui-fonts/${digest}`;
    sources.push({ asset: `${digest}.woff2`, sha256: digest, sizeBytes: contents.length });
  }
  fs.writeFileSync(path.join(delivery, 'ui-fonts.delivery.json'), JSON.stringify({
    platforms: {
      'windows-x86_64': {
        releases: [{
          version: 'v1',
          sources: sources.slice(0, -1),
          manifest: sources.at(-1),
        }],
      },
    },
  }));
  fs.writeFileSync(path.join(tauri, 'tauri.conf.json'), JSON.stringify({
    build: { frontendDist: '../../../build' },
    bundle: { resources },
  }));
  return root;
}

const withFixture = (callback) => {
  const root = fixture();
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const configPathOf = (root) => path.join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');

const editConfig = (root, mutate) => {
  const configPath = configPathOf(root);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  mutate(config);
  fs.writeFileSync(configPath, JSON.stringify(config));
};

test('accepts the reviewed payload: workers, licences and pinned font bytes', () => {
  withFixture((root) => {
    const report = auditDesktopPayload({ rootDirectory: root });
    assert.equal(report.frontendFileCount, 1);
    assert.equal(report.resourceDestinations.length, 4 + FONT_BYTES.length);
    assert.equal(report.uiFontBytes, FONT_BYTES.reduce((sum, value) => sum + value.length, 0));
  });
});

test('rejects native tools or model weights hidden in the frontend', () => {
  withFixture((root) => {
    fs.writeFileSync(path.join(root, 'build', 'ffmpeg.exe'), 'MZ');
    assert.throws(() => auditDesktopPayload({ rootDirectory: root }), /Forbidden managed payload/);
  });
});

test('rejects Product Sans and unreviewed Tauri resources', () => {
  withFixture((root) => {
    fs.writeFileSync(path.join(root, 'build', 'Product Sans.otf'), 'font');
    assert.throws(() => auditDesktopPayload({ rootDirectory: root }), /Product Sans remains embedded/);
    fs.rmSync(path.join(root, 'build', 'Product Sans.otf'));
    editConfig(root, (config) => {
      config.bundle.resources['../../tool.exe'] = 'bin/tool.exe';
    });
    assert.throws(
      () => auditDesktopPayload({ rootDirectory: root }),
      /only reviewed workers, licences and managed font bytes/,
    );
  });
});

test('rejects a legacy embedded Google Sans Flex font', () => {
  withFixture((root) => {
    fs.writeFileSync(path.join(root, 'build', 'GoogleSansFlex.ttf'), 'font');
    assert.throws(
      () => auditDesktopPayload({ rootDirectory: root }),
      /Managed Google Sans Flex remains embedded/,
    );
  });
});

test('rejects a dropped worker or licence', () => {
  withFixture((root) => {
    editConfig(root, (config) => { delete config.bundle.resources['../../../LICENSE']; });
    assert.throws(() => auditDesktopPayload({ rootDirectory: root }), /no longer embeds licenses\/LICENSE/);
  });
});

/**
 * The mutation that matters: a font resource that keeps a reviewed NAME while carrying other bytes.
 * A name allowlist accepts it. Recomputing the digest is what refuses it.
 */
test('rejects managed font bytes that are not what their name claims', () => {
  withFixture((root) => {
    const fonts = path.join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'ui-fonts');
    const [first] = fs.readdirSync(fonts);
    fs.writeFileSync(path.join(fonts, first), 'substituted font bytes');
    assert.throws(
      () => auditDesktopPayload({ rootDirectory: root }),
      /is not the bytes its name claims/,
    );
  });
});

test('rejects shipping a font the catalog does not pin', () => {
  withFixture((root) => {
    const fonts = path.join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'ui-fonts');
    const contents = 'an extra face nobody reviewed';
    const digest = digestOf(contents);
    fs.writeFileSync(path.join(fonts, digest), contents);
    editConfig(root, (config) => {
      config.bundle.resources[`resources/ui-fonts/${digest}`] = `ui-fonts/${digest}`;
    });
    assert.throws(
      () => auditDesktopPayload({ rootDirectory: root }),
      /ships managed font bytes no catalog pins/,
    );
  });
});

test('rejects omitting a font the catalog pins', () => {
  withFixture((root) => {
    editConfig(root, (config) => {
      const key = Object.keys(config.bundle.resources).find((name) => name.includes('ui-fonts'));
      delete config.bundle.resources[key];
    });
    assert.throws(
      () => auditDesktopPayload({ rootDirectory: root }),
      /pins managed font bytes the application does not ship/,
    );
  });
});

test('enforces the release executable budget when a binary is supplied', () => {
  withFixture((root) => {
    const executable = path.join(root, 'osg-desktop.exe');
    fs.writeFileSync(executable, Buffer.alloc(16 * 1024 * 1024 + 1));
    assert.throws(
      () => auditDesktopPayload({ rootDirectory: root, executablePath: executable }),
      /executable exceeds the .*byte budget/,
    );
  });
});
