'use strict';

// Where Tauri writes each native bundle type, and which bundle types each release target ships.

const BUNDLE_LAYOUTS = Object.freeze({
  appimage: Object.freeze({ directory: 'appimage', extension: '.AppImage', kind: 'file' }),
  deb: Object.freeze({ directory: 'deb', extension: '.deb', kind: 'file' }),
  app: Object.freeze({ directory: 'macos', extension: '.app', kind: 'directory' }),
  dmg: Object.freeze({ directory: 'dmg', extension: '.dmg', kind: 'file' }),
  nsis: Object.freeze({ directory: 'nsis', extension: '.exe', kind: 'file' }),
});

const TARGET_BUNDLES = Object.freeze({
  'x86_64-unknown-linux-gnu': new Set(['appimage', 'deb']),
  'aarch64-apple-darwin': new Set(['app', 'dmg']),
  'x86_64-apple-darwin': new Set(['app', 'dmg']),
  'x86_64-pc-windows-msvc': new Set(['nsis']),
});

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

module.exports = {
  BUNDLE_LAYOUTS,
  TARGET_BUNDLES,
  invariant,
};
