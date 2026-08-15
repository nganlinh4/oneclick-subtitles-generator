import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, '../../..');

test('the production desktop build replaces the browser key manager with the native facade', () => {
  const viteSource = fs.readFileSync(path.join(repositoryRoot, 'vite.config.mjs'), 'utf8');
  expect(viteSource).toMatch(
    /resolve\('src\/services\/gemini\/keyManager\.js'\),\s*resolve\('src\/platform\/desktopGeminiKeyManager\.js'\)/
  );
  expect(viteSource).toMatch(
    /mode\s*===\s*'production'[\s\S]*productionDesktopModules\(\)[\s\S]*foldProductionDesktopBranches\(\)/
  );
});

test('the aliased desktop key manager has no WebView credential or provider transport', () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, 'src/platform/desktopGeminiKeyManager.js'),
    'utf8'
  );
  expect(source).not.toMatch(/localStorage|sessionStorage/);
  expect(source).not.toMatch(/gemini_api_key/i);
  expect(source).not.toMatch(/generativelanguage\.googleapis\.com/i);
  expect(source).not.toMatch(/\bfetch\s*\(|new\s+WebSocket\s*\(/);
});
