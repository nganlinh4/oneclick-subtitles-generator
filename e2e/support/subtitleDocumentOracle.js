import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  lstatSync, readFileSync, readdirSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';

const decoder = new TextDecoder('utf-8', { fatal: true });
const FORMATS = new Set(['srt', 'json', 'txt']);
const EXACT_JSON_KEYS = Object.freeze([
  'end', 'endTime', 'id', 'start', 'startTime', 'text',
]);
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

const decodeDocument = (path) => {
  const bytes = readFileSync(path);
  assert.ok(bytes.byteLength > 0, `the exported document is empty: ${path}`);
  assert.ok(
    bytes.byteLength <= MAX_DOCUMENT_BYTES,
    `the exported document exceeds the product boundary: ${bytes.byteLength}`,
  );
  assert.equal(
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    false,
    'the exported document unexpectedly starts with a UTF-8 BOM',
  );
  let text;
  try {
    text = decoder.decode(bytes);
  } catch (error) {
    throw new Error(`the exported document is not well-formed UTF-8: ${path}`, { cause: error });
  }
  assert.equal(text.includes('\u0000'), false, 'the exported document contains a NUL byte');
  return { bytes, text: text.replaceAll('\r\n', '\n').replaceAll('\r', '\n') };
};

const parseTimestamp = (value) => {
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(value);
  assert.ok(match, `invalid SRT timestamp: ${JSON.stringify(value)}`);
  const milliseconds = Number(match[1]) * 3_600_000
    + Number(match[2]) * 60_000
    + Number(match[3]) * 1_000
    + Number(match[4]);
  assert.ok(Number.isSafeInteger(milliseconds), `unsafe SRT timestamp: ${value}`);
  return milliseconds;
};

const parseSeconds = (value, label) => {
  assert.ok(
    typeof value === 'number' || (typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)),
    `${label} is not a canonical seconds value`,
  );
  const seconds = Number(value);
  assert.ok(Number.isFinite(seconds) && seconds >= 0, `${label} is outside the time domain`);
  const milliseconds = Math.round(seconds * 1_000);
  assert.ok(Number.isSafeInteger(milliseconds), `${label} is not a safe millisecond value`);
  assert.ok(
    Math.abs(seconds - milliseconds / 1_000) <= Number.EPSILON * Math.max(1, seconds) * 4,
    `${label} has sub-millisecond precision`,
  );
  return milliseconds;
};

const parseSrt = (text) => {
  assert.equal(text.startsWith('\n'), false, 'SRT begins with an empty line');
  assert.equal(text.endsWith('\n\n'), false, 'SRT ends with an empty cue block');
  return text.split(/\n{2}/).map((block, index) => {
    const lines = block.split('\n');
    assert.ok(lines.length >= 3, `SRT cue ${index + 1} is incomplete`);
    assert.equal(lines[0], String(index + 1), `SRT cue ${index + 1} has the wrong ordinal`);
    const timing = /^(\d{2,}:[0-5]\d:[0-5]\d,\d{3}) --> (\d{2,}:[0-5]\d:[0-5]\d,\d{3})$/.exec(lines[1]);
    assert.ok(timing, `SRT cue ${index + 1} has an invalid timing line`);
    const startMs = parseTimestamp(timing[1]);
    const endMs = parseTimestamp(timing[2]);
    assert.ok(endMs >= startMs, `SRT cue ${index + 1} ends before it starts`);
    const cueText = lines.slice(2).join('\n');
    assert.ok(cueText.length > 0, `SRT cue ${index + 1} has no text`);
    return Object.freeze({ ordinal: index + 1, startMs, endMs, text: cueText });
  });
};

const parseJson = (text) => {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error('the JSON subtitle export cannot be parsed', { cause: error });
  }
  assert.ok(Array.isArray(value) && value.length > 0, 'JSON export is not a non-empty cue array');
  return value.map((row, index) => {
    assert.ok(row !== null && typeof row === 'object' && !Array.isArray(row), (
      `JSON cue ${index + 1} is not an object`
    ));
    assert.deepEqual(
      Object.keys(row).sort(),
      EXACT_JSON_KEYS,
      `JSON cue ${index + 1} has an unexpected schema`,
    );
    assert.equal(row.id, index + 1, `JSON cue ${index + 1} has the wrong ordinal`);
    assert.equal(typeof row.text, 'string', `JSON cue ${index + 1} has non-text content`);
    const startMs = parseSeconds(row.start, `JSON cue ${index + 1} start`);
    const endMs = parseSeconds(row.end, `JSON cue ${index + 1} end`);
    assert.equal(
      parseTimestamp(String(row.startTime).replace('.', ',')),
      startMs,
      `JSON cue ${index + 1} has inconsistent start fields`,
    );
    assert.equal(
      parseTimestamp(String(row.endTime).replace('.', ',')),
      endMs,
      `JSON cue ${index + 1} has inconsistent end fields`,
    );
    assert.ok(endMs >= startMs, `JSON cue ${index + 1} ends before it starts`);
    return Object.freeze({ ordinal: index + 1, startMs, endMs, text: row.text });
  });
};

const canonicalExpected = (expected) => {
  assert.ok(Array.isArray(expected) && expected.length > 0, 'expected cues must be non-empty');
  return expected.map((cue, index) => {
    assert.deepEqual(
      Object.keys(cue).sort(),
      ['endMs', 'ordinal', 'startMs', 'text'],
      `expected cue ${index + 1} has an invalid oracle shape`,
    );
    assert.equal(cue.ordinal, index + 1, `expected cue ${index + 1} has the wrong ordinal`);
    assert.ok(Number.isSafeInteger(cue.startMs) && cue.startMs >= 0);
    assert.ok(Number.isSafeInteger(cue.endMs) && cue.endMs >= cue.startMs);
    assert.equal(typeof cue.text, 'string');
    return Object.freeze({ ...cue });
  });
};

export const verifySubtitleDocumentExport = ({ path, format, expected }) => {
  assert.ok(FORMATS.has(format), `unsupported oracle format: ${format}`);
  assert.equal(extname(path).toLowerCase(), `.${format}`, `export has the wrong extension: ${path}`);
  const { bytes, text } = decodeDocument(path);
  const expectedRows = canonicalExpected(expected);
  if (format === 'txt') {
    assert.equal(text, expectedRows.map(({ text: cueText }) => cueText).join('\n'));
    assert.equal(text.includes(' --> '), false, 'TXT export unexpectedly contains SRT timings');
    assert.equal(
      text.trimStart().startsWith('[') || text.trimStart().startsWith('{'),
      false,
      'TXT export unexpectedly contains structured data',
    );
  } else {
    const parsed = format === 'srt' ? parseSrt(text) : parseJson(text);
    assert.deepEqual(parsed, expectedRows, `${format.toUpperCase()} export changed cue content or timing`);
  }
  return Object.freeze({
    path,
    format,
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    cueCount: expectedRows.length,
  });
};

export const snapshotOutputDirectory = (directory) => new Set(readdirSync(directory));

export const waitForNewDocumentExport = async ({
  directory,
  before,
  format,
  timeoutMs = 30_000,
  intervalMs = 100,
}) => {
  assert.ok(before instanceof Set, 'the output snapshot must be a Set');
  assert.ok(FORMATS.has(format), `unsupported output format: ${format}`);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000);
  assert.ok(Number.isSafeInteger(intervalMs) && intervalMs > 0 && intervalMs <= 1_000);
  const deadline = Date.now() + timeoutMs;
  let stable = null;

  while (Date.now() <= deadline) {
    const created = readdirSync(directory).filter((name) => !before.has(name)).sort();
    assert.ok(created.length <= 1, `one save action created multiple outputs: ${created.join(', ')}`);
    if (created.length === 1) {
      const name = created[0];
      assert.equal(extname(name).toLowerCase(), `.${format}`, `save created the wrong format: ${name}`);
      const path = join(directory, name);
      const stat = lstatSync(path);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `save did not create a regular file: ${path}`);
      if (stat.size > 0) {
        const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
        const observation = `${stat.size}:${stat.mtimeMs}:${digest}`;
        if (stable?.path === path && stable.observation === observation) return path;
        stable = { path, observation };
      }
    }
    await delay(intervalMs);
  }
  throw new Error(`no stable .${format} document appeared in ${directory}`);
};

/**
 * Wait for exactly `count` new stable documents (a bulk "Download All" writes several files from
 * one customer click, sequentially, through the same native save boundary as a single export).
 * Returns the settled paths sorted by name. Fails closed the moment more files than expected
 * appear, exactly as `waitForNewDocumentExport` does for one.
 */
export const waitForNewDocumentExports = async ({
  directory,
  before,
  count,
  timeoutMs = 30_000,
  intervalMs = 100,
}) => {
  assert.ok(before instanceof Set, 'the output snapshot must be a Set');
  assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 25, 'unsupported export count');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000);
  assert.ok(Number.isSafeInteger(intervalMs) && intervalMs > 0 && intervalMs <= 1_000);
  const deadline = Date.now() + timeoutMs;
  let stableSignature = null;

  while (Date.now() <= deadline) {
    const createdNames = readdirSync(directory).filter((name) => !before.has(name)).sort();
    assert.ok(
      createdNames.length <= count,
      `one bulk export created more outputs than expected: ${createdNames.join(', ')}`,
    );
    if (createdNames.length === count) {
      const observed = createdNames.map((name) => {
        const path = join(directory, name);
        assert.ok(FORMATS.has(extname(name).toLowerCase().slice(1)), `unsupported export file: ${name}`);
        const stat = lstatSync(path);
        assert.ok(stat.isFile() && !stat.isSymbolicLink(), `save did not create a regular file: ${path}`);
        if (stat.size === 0) return null;
        const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
        return { path, observation: `${stat.size}:${stat.mtimeMs}:${digest}` };
      });
      if (observed.every((entry) => entry !== null)) {
        const signature = observed.map(({ path, observation }) => `${path}=${observation}`).join('|');
        if (stableSignature === signature) return observed.map(({ path }) => path).sort();
        stableSignature = signature;
      }
    }
    await delay(intervalMs);
  }
  throw new Error(`${count} stable documents never appeared in ${directory}`);
};
