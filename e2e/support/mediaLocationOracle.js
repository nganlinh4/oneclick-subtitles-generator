import { Buffer } from 'node:buffer';

/**
 * Decode and compare the durable media-location pointer the application persists.
 *
 * `media_locations.path_bytes` is the canonicalized selection encoded per platform. On Windows,
 * Rust's canonicalize produces an extended-length `\\?\C:\...` UTF-16LE path; a journey comparing
 * it against the staged selection has to decode and normalize both sides, and a mistake here would
 * either miss a dishonest pointer or fail on a perfectly restored one. Kept pure so the decoding
 * itself is testable without a database.
 */

const MAX_PATH_BYTES = 64 * 1024;

export const decodeMediaLocationPath = ({ path_bytes: pathBytes, path_encoding: encoding }) => {
  if (!(pathBytes instanceof Uint8Array) && !Buffer.isBuffer(pathBytes)) {
    throw new Error('media location path bytes are missing');
  }
  if (pathBytes.byteLength === 0 || pathBytes.byteLength > MAX_PATH_BYTES) {
    throw new Error(`media location path bytes have an invalid length ${pathBytes.byteLength}`);
  }
  const buffer = Buffer.from(pathBytes);
  if (encoding === 'windows-utf16le') {
    if (buffer.byteLength % 2 !== 0) {
      throw new Error('a windows-utf16le media location must hold an even byte count');
    }
    return buffer.toString('utf16le');
  }
  if (encoding === 'unix-bytes') return buffer.toString('utf8');
  throw new Error(`unknown media location encoding ${JSON.stringify(encoding)}`);
};

/**
 * One comparable form for a Windows path: extended-length prefix removed, separators unified,
 * case folded. Deliberately NOT a resolver — both sides must already be absolute, so anything
 * beyond presentation differences stays a real mismatch.
 */
export const comparableWindowsPath = (path) => {
  const text = String(path ?? '');
  if (text.trim().length === 0) throw new Error('an empty path is not comparable');
  return text.replace(/^\\\\\?\\/u, '').replaceAll('/', '\\').toLowerCase();
};
