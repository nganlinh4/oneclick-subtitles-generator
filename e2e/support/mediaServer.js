import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

/**
 * A deterministic local HTTP origin serving the media fixtures.
 *
 * The application must not be able to tell this from any other web server: it speaks the same wire
 * protocol, including ranges, HEAD, content type and content length, so the real downloader is
 * exercised rather than bypassed. Nothing about the product is stubbed here — this replaces only the
 * Internet, which is the one part of a customer journey that cannot be deterministic.
 *
 * Bound to loopback and to an ephemeral port, so runs never collide and nothing is reachable off the
 * machine.
 */

const FIXTURE_ROOT = new URL('../fixtures/media/', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');

const CONTENT_TYPES = Object.freeze({
  '.mp4': 'video/mp4',
  '.srt': 'application/x-subrip',
  '.json': 'application/json',
});

const contentTypeOf = (name) => {
  const dot = name.lastIndexOf('.');
  return CONTENT_TYPES[name.slice(dot)] ?? 'application/octet-stream';
};

/** `bytes=start-end` against a known length, or `null` when absent or unsatisfiable. */
const parseRange = (header, size) => {
  if (typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  const start = rawStart === '' ? size - Number(rawEnd) : Number(rawStart);
  const end = rawStart === '' || rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end >= size || start > end) return null;
  return { start, end };
};

/**
 * Start the fixture origin.
 *
 * `options.delayMs` slows every response, and `options.failAfterBytes` truncates the connection
 * mid-body. Both exist so a journey can exercise interruption and retry against the real downloader
 * rather than asserting the happy path only.
 */
export const startMediaServer = async ({ delayMs = 0, failAfterBytes = null } = {}) => {
  const requests = [];

  const server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice(1));
    requests.push({ method: request.method, name, range: request.headers.range ?? null });

    // No traversal: a fixture is a bare file name in one directory.
    if (name.includes('/') || name.includes('\\') || name.includes('..') || name === '') {
      response.writeHead(404).end();
      return;
    }

    let size;
    try {
      size = statSync(join(FIXTURE_ROOT, name)).size;
    } catch {
      response.writeHead(404).end();
      return;
    }

    const headers = {
      'Content-Type': contentTypeOf(name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };

    if (request.method === 'HEAD') {
      response.writeHead(200, { ...headers, 'Content-Length': String(size) }).end();
      return;
    }

    const range = parseRange(request.headers.range, size);
    const send = () => {
      const start = range === null ? 0 : range.start;
      const end = range === null ? size - 1 : range.end;
      response.writeHead(range === null ? 200 : 206, {
        ...headers,
        'Content-Length': String(end - start + 1),
        ...(range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${size}` }),
      });

      const stream = createReadStream(join(FIXTURE_ROOT, name), { start, end });
      if (failAfterBytes === null) {
        stream.pipe(response);
        return;
      }
      // Truncate deliberately: the socket closes with the body incomplete, which is what a real
      // interrupted transfer looks like to the downloader.
      let sent = 0;
      stream.on('data', (chunk) => {
        if (sent >= failAfterBytes) return;
        response.write(chunk.subarray(0, Math.max(0, failAfterBytes - sent)));
        sent += chunk.length;
        if (sent >= failAfterBytes) {
          stream.destroy();
          response.destroy();
        }
      });
      stream.on('end', () => response.end());
    };

    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    urlFor: (name) => `http://127.0.0.1:${port}/${name}`,
    /** Every request the application made, so a journey can prove the real protocol was used. */
    requests,
    stop: () => new Promise((resolve) => {
      // Keep-alive sockets outlive `close()` and would hold a journey open until its timeout, which
      // reads as a product hang. Dropped explicitly so shutdown is immediate and unambiguous.
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
};
