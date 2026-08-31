import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  appendFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync,
  statSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';

const TOKEN_BYTES = 32;
const MAX_EVENT_FILE_BYTES = 8 * 1024 * 1024;

const sha256File = (path) => {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
};

const fixedDelay = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

/** Parse the one RFC 7233 byte-range shape the fixture origin accepts. */
export const parseSingleByteRange = (header, size) => {
  if (!Number.isSafeInteger(size) || size <= 0) throw new TypeError('size must be positive');
  if (header === undefined) return { start: 0, end: size - 1, partial: false };
  if (typeof header !== 'string' || !header.startsWith('bytes=') || header.includes(',')) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (match === null || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1, partial: true };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === '' ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
      || start < 0 || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1), partial: true };
};

/** Read the append-only, path-free request ledger written by the local origin. */
export const readDownloadFixtureEvents = (path) => {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  if (size > MAX_EVENT_FILE_BYTES) throw new Error('the download fixture event ledger is oversized');
  return readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => {
    const value = JSON.parse(line);
    if (!Number.isSafeInteger(value.sequence) || typeof value.route !== 'string'
        || typeof value.event !== 'string') {
      throw new Error('the download fixture event ledger is malformed');
    }
    return value;
  });
};

const inspectSource = (label, source, rejectGetAfter = null, height = null) => {
  if (rejectGetAfter !== null
      && (!Number.isSafeInteger(rejectGetAfter) || rejectGetAfter < 0 || rejectGetAfter > 10)) {
    throw new Error(`download fixture ${label} has an invalid rejection boundary`);
  }
  if (height !== null && (!Number.isSafeInteger(height) || height < 144 || height > 4_320)) {
    throw new Error(`download fixture ${label} has an invalid video height`);
  }
  const path = realpathSync(source);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.size <= 0) {
    throw new Error(`download fixture ${label} is not a non-empty regular file`);
  }
  return Object.freeze({
    label,
    path,
    bytes: metadata.size,
    sha256: sha256File(path),
    token: randomBytes(TOKEN_BYTES).toString('hex'),
    pathname: `/${label}.mp4`,
    rejectGetAfter,
    height,
  });
};

const waitForWritable = async (response) => {
  if (!response.writable || response.destroyed) return false;
  const drained = await new Promise((resolve) => {
    const finish = (value) => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
      resolve(value);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onError = () => finish(false);
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
  });
  return drained && response.writable && !response.destroyed;
};

/**
 * Start a deterministic, range-capable, throttled origin for the hidden real-binary journey.
 *
 * The server binds only 127.0.0.1 and gives each source an unguessable exact URL. Production still
 * rejects every loopback address; only the E2E binary receives these exact values before launch.
 * Throttling makes cancellation observable without changing the product or the downloaded bytes.
 */
export const startDownloadFixtureOrigin = async ({
  eventsPath,
  sources,
  chunkBytes = 32 * 1024,
  chunkDelayMs = 60,
  initialDelayMs = 0,
  multiFormatPage = false,
  requireCookie = false,
}) => {
  if (!Array.isArray(sources) || sources.length !== 2) {
    throw new Error('the download identity journey requires exactly two sources');
  }
  if (typeof requireCookie !== 'boolean'
      || !Number.isSafeInteger(chunkBytes) || chunkBytes < 4 * 1024 || chunkBytes > 1024 * 1024
      || !Number.isSafeInteger(chunkDelayMs) || chunkDelayMs < 1 || chunkDelayMs > 5_000
      || !Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > 5_000) {
    throw new Error('the fixture throttle is invalid');
  }
  const routes = sources.map(({ label, path, rejectGetAfter = null, height = null }) => (
    inspectSource(label, path, rejectGetAfter, height)
  ));
  const page = multiFormatPage ? Object.freeze({
    label: 'multi',
    pathname: '/multi.html',
    token: randomBytes(TOKEN_BYTES).toString('hex'),
  }) : null;
  const cookie = requireCookie ? Object.freeze({
    name: 'osg_e2e_auth',
    value: randomBytes(TOKEN_BYTES).toString('hex'),
  }) : null;
  if (new Set(routes.map(({ label }) => label)).size !== routes.length) {
    throw new Error('download fixture route labels must be unique');
  }
  mkdirSync(dirname(eventsPath), { recursive: true });
  writeFileSync(eventsPath, '', { flag: 'wx' });
  let sequence = 0;
  const record = (route, event, details = {}) => {
    sequence += 1;
    appendFileSync(eventsPath, `${JSON.stringify({
      sequence,
      route: route.label,
      event,
      ...details,
    })}\n`);
  };
  const sockets = new Set();
  const getStarts = new Map(routes.map((route) => [route.label, 0]));

  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const authorized = cookie === null || (request.headers.cookie ?? '').split(';')
        .map((part) => part.trim())
        .includes(`${cookie.name}=${cookie.value}`);
      const refuseUnauthorized = (route) => {
        if (authorized) return false;
        record(route, 'request-rejected', { method: request.method, status: 401, authenticated: false });
        response.writeHead(401, {
          'cache-control': 'no-store',
          'content-length': '0',
          'www-authenticate': 'Cookie realm="OSG E2E fixture"',
        });
        response.end();
        return true;
      };
      if (page !== null
          && page.pathname === requestUrl.pathname
          && requestUrl.searchParams.size === 1
          && requestUrl.searchParams.get('token') === page.token
          && ['GET', 'HEAD'].includes(request.method ?? '')) {
        if (refuseUnauthorized(page)) return;
        const host = request.headers.host;
        if (typeof host !== 'string' || !/^127\.0\.0\.1:\d+$/u.test(host)) {
          response.writeHead(400, { 'content-length': '0' });
          response.end();
          return;
        }
        const sourcesMarkup = routes.map((route) => (
          `<source src="http://${host}${route.pathname}?token=${route.token}" type="video/mp4"`
          + (route.height === null ? '' : ` label="${route.height}p" res="${route.height}"`)
          + '>'
        )).join('');
        const body = Buffer.from(
          `<!doctype html><html><head><title>OSG multi-format fixture</title></head>`
          + `<body><video controls>${sourcesMarkup}</video></body></html>`,
          'utf8',
        );
        const requestId = sequence + 1;
        record(page, 'request-start', {
          requestId,
          method: request.method,
          rangeStart: 0,
          rangeEnd: body.length - 1,
          expectedBytes: body.length,
          authenticated: cookie !== null,
        });
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': String(body.length),
          'content-type': 'text/html; charset=utf-8',
        });
        if (request.method === 'HEAD') {
          response.end();
          record(page, 'request-complete', { requestId, bytesSent: 0, method: 'HEAD' });
        } else {
          response.end(body);
          record(page, 'request-complete', { requestId, bytesSent: body.length, method: 'GET' });
        }
        return;
      }
      const route = routes.find((candidate) => (
        candidate.pathname === requestUrl.pathname
        && requestUrl.searchParams.size === 1
        && requestUrl.searchParams.get('token') === candidate.token
      ));
      if (route === undefined || !['GET', 'HEAD'].includes(request.method ?? '')) {
        response.writeHead(404, { 'content-length': '0' });
        response.end();
        return;
      }
      if (refuseUnauthorized(route)) return;
      const range = parseSingleByteRange(request.headers.range, route.bytes);
      if (range === null) {
        response.writeHead(416, {
          'accept-ranges': 'bytes',
          'content-range': `bytes */${route.bytes}`,
          'content-length': '0',
        });
        response.end();
        return;
      }
      const length = range.end - range.start + 1;
      const requestId = sequence + 1;
      const routeGetStarts = request.method === 'GET'
        ? (getStarts.get(route.label) ?? 0) + 1
        : (getStarts.get(route.label) ?? 0);
      if (request.method === 'GET') getStarts.set(route.label, routeGetStarts);
      record(route, 'request-start', {
        requestId,
        method: request.method,
        rangeStart: range.start,
        rangeEnd: range.end,
        expectedBytes: length,
        authenticated: cookie !== null,
      });
      // The failed-download journey lets yt-dlp inspect a real MP4 once, then makes the transfer
      // itself fail at the origin. This is deliberately server-owned rather than an application
      // mock: the production downloader, job ledger, cleanup and presentation paths all run.
      if (request.method === 'GET'
          && route.rejectGetAfter !== null
          && routeGetStarts > route.rejectGetAfter) {
        response.writeHead(503, {
          'cache-control': 'no-store',
          'content-length': '0',
          'retry-after': '0',
        });
        response.end();
        record(route, 'request-rejected', {
          requestId,
          method: 'GET',
          status: 503,
        });
        return;
      }
      const headers = {
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        'content-disposition': `inline; filename="${route.label}.mp4"`,
        'content-length': String(length),
        'content-type': 'video/mp4',
        etag: `"${route.sha256}"`,
      };
      if (range.partial) headers['content-range'] = `bytes ${range.start}-${range.end}/${route.bytes}`;
      response.writeHead(range.partial ? 206 : 200, headers);
      if (request.method === 'HEAD') {
        response.end();
        record(route, 'request-complete', { requestId, bytesSent: 0, method: 'HEAD' });
        return;
      }

      let bytesSent = 0;
      let completed = false;
      let nextProgress = Math.min(length, 64 * 1024);
      const stream = createReadStream(route.path, {
        start: range.start,
        end: range.end,
        highWaterMark: chunkBytes,
      });
      const stop = () => stream.destroy();
      request.once('aborted', stop);
      response.once('close', stop);
      try {
        if (initialDelayMs > 0) await fixedDelay(initialDelayMs);
        for await (const chunk of stream) {
          if (response.destroyed || !response.writable) break;
          bytesSent += chunk.length;
          if (!response.write(chunk) && !await waitForWritable(response)) break;
          if (bytesSent >= nextProgress) {
            record(route, 'request-progress', { requestId, bytesSent, expectedBytes: length });
            nextProgress = Math.min(length, nextProgress + 64 * 1024);
          }
          if (bytesSent < length) await fixedDelay(chunkDelayMs);
        }
        if (!response.destroyed && bytesSent === length) {
          completed = true;
          response.end();
          record(route, 'request-complete', { requestId, bytesSent, method: 'GET' });
        }
      } catch (error) {
        if (!response.destroyed) response.destroy(error);
      } finally {
        request.off('aborted', stop);
        response.off('close', stop);
        if (!completed) {
          record(route, 'request-aborted', { requestId, bytesSent, expectedBytes: length });
        }
      }
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture origin did not bind an IPv4 port');
  }
  const manifest = routes.map((route) => Object.freeze({
    label: route.label,
    url: `http://127.0.0.1:${address.port}${route.pathname}?token=${route.token}`,
    bytes: route.bytes,
    sha256: route.sha256,
    height: route.height,
    failure: route.rejectGetAfter === null ? null : Object.freeze({
      kind: 'rejectGetAfter',
      after: route.rejectGetAfter,
      status: 503,
    }),
  }));
  return Object.freeze({
    eventsPath,
    manifest,
    multiFormatUrl: page === null
      ? null
      : `http://127.0.0.1:${address.port}${page.pathname}?token=${page.token}`,
    cookie,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  });
};
