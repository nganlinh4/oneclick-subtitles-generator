import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

const productionFiles = (current) => fs.readdirSync(current, { withFileTypes: true })
  .flatMap((entry) => {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) return productionFiles(absolute);
    return entry.name.endsWith('.js') && !entry.name.includes('.test.') ? [absolute] : [];
  });

test('the Gemini production service graph contains no WebView provider transport', () => {
  const source = productionFiles(directory)
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');

  expect(source).not.toMatch(/generativelanguage\.googleapis\.com/i);
  expect(source).not.toMatch(/upload\/v1beta\/files/i);
  expect(source).not.toMatch(/BidiGenerateContent/i);
  expect(source).not.toMatch(/streamGenerateContent/i);
  expect(source).not.toMatch(/new\s+WebSocket\s*\(/);
  expect(source).not.toMatch(/fetchWithKeyRotation/);
});

test('the compatibility key manager has no WebView credential storage path', () => {
  const source = fs.readFileSync(path.join(directory, 'keyManager.js'), 'utf8');
  expect(source).not.toMatch(/localStorage/);
  expect(source).not.toMatch(/gemini_api_key/);
  expect(source).not.toMatch(/\bfetch\s*\(/);
});
