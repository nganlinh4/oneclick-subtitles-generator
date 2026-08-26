'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertWindowsProcessIdentity, readCurrentWindowsProcessIdentity, readWindowsProcessIdentity,
} = require('./windows-process-identity.js');

test('reads and reasserts the exact live current-process creation identity', () => {
  const identity = readCurrentWindowsProcessIdentity();
  assert.equal(identity.processId, process.pid);
  assert.deepEqual(assertWindowsProcessIdentity(identity), identity);
});

test('rejects a PID-reused timestamp and malformed process identities', () => {
  const identity = readCurrentWindowsProcessIdentity();
  assert.throws(
    () => assertWindowsProcessIdentity({
      ...identity,
      processCreatedUtc: '2026-01-01T00:00:00.0000000Z',
    }),
    /reused or its creation identity changed/u,
  );
  assert.throws(
    () => assertWindowsProcessIdentity({ ...identity, processCreatedUtc: 'not-a-date' }),
    /invalid canonical timestamp/u,
  );
  assert.throws(
    () => readWindowsProcessIdentity({ processId: 0 }),
    /positive integer/u,
  );
});

test('the query transport is injectable without weakening production verification', () => {
  const calls = [];
  const identity = readWindowsProcessIdentity({
    processId: 1234,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '2026-08-26T01:02:03.0000000Z\n', stderr: '' };
    },
  });
  assert.deepEqual(identity, {
    processId: 1234,
    processCreatedUtc: '2026-08-26T01:02:03.0000000Z',
  });
  assert.equal(calls[0].command, 'pwsh');
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 5_000);
  assert.equal(calls[0].options.maxBuffer, 16 * 1024);
});

test('an external PID is queried again so reuse cannot inherit a cached identity', () => {
  const outputs = [
    '2026-08-26T01:02:03.0000000Z\n',
    '2026-08-26T01:02:04.0000000Z\n',
  ];
  const spawn = () => ({ status: 0, stdout: outputs.shift(), stderr: '' });
  const claimed = {
    processId: 1234,
    processCreatedUtc: '2026-08-26T01:02:03.0000000Z',
  };
  assert.deepEqual(assertWindowsProcessIdentity(claimed, { spawn, useCache: true }), claimed);
  assert.throws(
    () => assertWindowsProcessIdentity(claimed, { spawn, useCache: true }),
    /reused or its creation identity changed/u,
  );
  assert.equal(outputs.length, 0);
});
