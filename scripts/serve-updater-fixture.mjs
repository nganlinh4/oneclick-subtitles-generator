import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const HOST = 'localhost';
const PORT = 38_443;
const PLATFORM = 'windows-x86_64-nsis';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_UPDATE_BYTES = 512 * 1024 * 1024;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SIGNATURE = /^[A-Za-z0-9+/=\r\n]{100,16384}$/;

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const exactKeys = (value, keys) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(/^--[a-z-]+$/.test(key ?? '') && value !== undefined,
      'Usage: serve-updater-fixture.mjs --root DIR --pfx FILE --ready-file FILE');
    invariant(!values.has(key), `Duplicate argument: ${key}`);
    values.set(key, value);
  }
  invariant(values.size === 3, 'Only --root, --pfx, and --ready-file are accepted');
  for (const key of ['--root', '--pfx', '--ready-file']) {
    invariant(typeof values.get(key) === 'string' && values.get(key).length > 0,
      `${key} is required`);
  }
  return Object.freeze({
    root: path.resolve(values.get('--root')),
    pfx: path.resolve(values.get('--pfx')),
    readyFile: path.resolve(values.get('--ready-file')),
  });
}

const regularFile = (filePath, label, maximumBytes) => {
  const metadata = fs.lstatSync(filePath);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular file`);
  invariant(metadata.size > 0 && metadata.size <= maximumBytes,
    `${label} has an invalid byte length`);
  return metadata.size;
};

export function validateFixture(root) {
  const metadata = fs.lstatSync(root);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(),
    'Updater fixture root must be a real directory');
  const entries = fs.readdirSync(root).sort();
  invariant(entries.join('\0') === 'latest.json\0update.exe',
    'Updater fixture root must contain exactly latest.json and update.exe');
  const manifestPath = path.join(root, 'latest.json');
  const updatePath = path.join(root, 'update.exe');
  regularFile(manifestPath, 'Updater fixture manifest', MAX_MANIFEST_BYTES);
  const updateBytes = regularFile(updatePath, 'Updater fixture executable', MAX_UPDATE_BYTES);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  invariant(exactKeys(manifest, ['version', 'notes', 'pub_date', 'platforms'])
    && VERSION.test(manifest.version)
    && typeof manifest.notes === 'string' && manifest.notes.length <= 32 * 1024
    && typeof manifest.pub_date === 'string' && Number.isFinite(Date.parse(manifest.pub_date))
    && exactKeys(manifest.platforms, [PLATFORM]),
  'Updater fixture manifest has an invalid top-level contract');
  const platform = manifest.platforms[PLATFORM];
  invariant(exactKeys(platform, ['signature', 'url'])
    && platform.url === `https://${HOST}:${PORT}/update.exe`
    && typeof platform.signature === 'string'
    && SIGNATURE.test(platform.signature),
  'Updater fixture platform has an invalid signed-download contract');
  return Object.freeze({ manifestPath, updatePath, updateBytes, version: manifest.version });
}

export function requestTarget(request) {
  invariant(request.headers.host === `${HOST}:${PORT}`, 'Updater fixture rejected the Host header');
  invariant(request.method === 'GET' || request.method === 'HEAD',
    'Updater fixture accepts only GET and HEAD');
  if (request.url === '/latest.json') return 'manifest';
  if (request.url === '/update.exe') return 'update';
  throw new Error('Updater fixture rejected an unknown route');
}

function serveFile(request, response, filePath, contentType) {
  const size = fs.statSync(filePath).size;
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': size,
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  fs.createReadStream(filePath).pipe(response);
}

async function main() {
  invariant(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true',
    'The signed updater fixture server may run only on GitHub Actions');
  const options = parseArguments(process.argv.slice(2));
  const password = process.env.OSG_UPDATER_FIXTURE_PFX_PASSWORD;
  invariant(typeof password === 'string' && password.length >= 16 && password.length <= 128,
    'Updater fixture PFX password is missing or invalid');
  const fixture = validateFixture(options.root);
  regularFile(options.pfx, 'Updater fixture PFX', 1024 * 1024);
  invariant(!fs.existsSync(options.readyFile), 'Updater fixture readiness path is not clean');

  const server = https.createServer({
    pfx: fs.readFileSync(options.pfx),
    passphrase: password,
    minVersion: 'TLSv1.2',
  }, (request, response) => {
    try {
      const target = requestTarget(request);
      process.stdout.write(`${JSON.stringify({
        event: 'updater-fixture.request',
        method: request.method,
        route: target,
      })}\n`);
      serveFile(
        request,
        response,
        target === 'manifest' ? fixture.manifestPath : fixture.updatePath,
        target === 'manifest' ? 'application/json' : 'application/octet-stream',
      );
    } catch {
      response.writeHead(404, {
        'Cache-Control': 'no-store',
        'Content-Length': 0,
        'X-Content-Type-Options': 'nosniff',
      });
      response.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  fs.writeFileSync(options.readyFile, JSON.stringify({ host: HOST, port: PORT, pid: process.pid }), {
    encoding: 'utf8',
    flag: 'wx',
  });
  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Updater fixture failed'}\n`);
    process.exitCode = 1;
  });
}
