import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditDesktopPayload } from './check-desktop-payload-size.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-payload-gate-'));
  const tauri = path.join(root, 'apps', 'desktop', 'src-tauri');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.mkdirSync(tauri, { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(tauri, 'tauri.conf.json'), JSON.stringify({
    build: { frontendDist: '../../../build' },
    bundle: { resources: {
      '../../asr.py': 'workers/osg_asr_worker.py',
      '../../speech.py': 'workers/osg_speech_worker.py',
      '../../render.mjs': 'workers/osg_render_worker.mjs',
    } },
  }));
  return root;
}

test('accepts a small shell with only protocol bootstrap workers', () => {
  const root = fixture();
  try {
    const report = auditDesktopPayload({ rootDirectory: root });
    assert.equal(report.frontendFileCount, 1);
    assert.equal(report.resourceDestinations.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects native tools or model weights hidden in the frontend', () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'build', 'ffmpeg.exe'), 'MZ');
    assert.throws(() => auditDesktopPayload({ rootDirectory: root }), /Forbidden managed payload/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects Product Sans and unreviewed Tauri resources', () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'build', 'Product Sans.otf'), 'font');
    assert.throws(() => auditDesktopPayload({ rootDirectory: root }), /Product Sans remains embedded/);
    fs.rmSync(path.join(root, 'build', 'Product Sans.otf'));
    const configPath = path.join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.bundle.resources['../../tool.exe'] = 'bin/tool.exe';
    fs.writeFileSync(configPath, JSON.stringify(config));
    assert.throws(() => auditDesktopPayload({ rootDirectory: root }), /only the three protocol bootstrap workers/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('enforces the release executable budget when a binary is supplied', () => {
  const root = fixture();
  try {
    const executable = path.join(root, 'osg-desktop.exe');
    fs.writeFileSync(executable, Buffer.alloc(16 * 1024 * 1024 + 1));
    assert.throws(() => auditDesktopPayload({ rootDirectory: root, executablePath: executable }), /executable exceeds the .*byte budget/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
