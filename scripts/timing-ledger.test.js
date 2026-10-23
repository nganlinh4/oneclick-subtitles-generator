const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_RECORDS, defaultLedgerPath, readRecords, recordTiming, report,
} = require('./timing-ledger');

const temporaryLedger = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-timing-ledger-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'nested', 'timings.jsonl');
};

const record = (ledgerPath, name, seconds, outcome = 'pass', lines = []) => recordTiming({
  name, seconds, outcome, ledgerPath, commit: 'abc1234', write: (line) => lines.push(line),
});

test('the ledger sits beside the managed cache root, never inside it', () => {
  assert.equal(
    defaultLedgerPath({ OSG_DEV_CACHE_ROOT: path.resolve('/x/cache') }),
    path.join(path.resolve('/x'), 'timings.jsonl'),
  );
  assert.equal(
    defaultLedgerPath({ LOCALAPPDATA: path.resolve('/l') }),
    path.join(path.resolve('/l'), 'OSG-Development', 'timings.jsonl'),
  );
  const cacheRoot = path.resolve('/l', 'OSG-Development', 'cache');
  assert.ok(!defaultLedgerPath({ LOCALAPPDATA: path.resolve('/l') }).startsWith(`${cacheRoot}${path.sep}`));
});

test('each run appends one record and is compared with the median of earlier passes', (t) => {
  const ledgerPath = temporaryLedger(t);
  const lines = [];
  assert.equal(record(ledgerPath, 'journey a', 10, 'pass', lines).baseline, null);
  record(ledgerPath, 'journey a', 12);
  record(ledgerPath, 'journey a', 60, 'fail');
  record(ledgerPath, 'other', 1);
  const steady = record(ledgerPath, 'journey a', 11.5, 'pass', lines);
  assert.equal(steady.baseline, 11, 'the failed run and other names stay out of the baseline');
  assert.equal(steady.regression, false);
  const slow = record(ledgerPath, 'journey a', 14, 'pass', lines);
  assert.equal(slow.baseline, 11.5);
  assert.equal(slow.regression, true);
  assert.match(lines.at(-1), /journey a pass in 14\.0s \(median 11\.5s, \+22%, REGRESSION\)/u);
  assert.match(lines[0], /first recorded run/u);

  const records = readRecords(ledgerPath);
  assert.equal(records.length, 6);
  assert.deepEqual(Object.keys(records[0]).sort(), ['at', 'commit', 'name', 'outcome', 'seconds']);
  assert.ok(!Number.isNaN(Date.parse(records[0].at)));
  assert.equal(fs.readdirSync(path.dirname(ledgerPath)).length, 1, 'no temporary file is left behind');
});

test('sub-second jitter on a fast item is not a regression', (t) => {
  const ledgerPath = temporaryLedger(t);
  record(ledgerPath, 'fast', 0.5);
  assert.equal(record(ledgerPath, 'fast', 0.9).regression, false);
});

test('minute durations round as a whole, never to "1m 60s"', (t) => {
  const ledgerPath = temporaryLedger(t);
  const lines = [];
  record(ledgerPath, 'long', 119.6, 'pass', lines);
  assert.match(lines[0], /long pass in 2m 0s/u);
});

test('the ledger keeps only the newest records and skips corrupt lines', (t) => {
  const ledgerPath = temporaryLedger(t);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const old = Array.from({ length: MAX_RECORDS }, (_, index) => JSON.stringify({
    name: `old ${index}`, seconds: 1, outcome: 'pass', commit: 'x', at: new Date(0).toISOString(),
  }));
  fs.writeFileSync(ledgerPath, `${old.join('\n')}\nnot json\n`);
  record(ledgerPath, 'newest', 2);
  const records = readRecords(ledgerPath);
  assert.equal(records.length, MAX_RECORDS);
  assert.equal(records[0].name, 'old 1');
  assert.equal(records.at(-1).name, 'newest');
});

test('an unwritable ledger never fails the timed run', (t) => {
  const ledgerPath = temporaryLedger(t);
  fs.mkdirSync(ledgerPath, { recursive: true });
  assert.equal(record(ledgerPath, 'blocked', 1), null);
});

test('the report lists the slowest items and current regressions', (t) => {
  const ledgerPath = temporaryLedger(t);
  assert.match(report({ ledgerPath }), /no timings recorded/u);
  record(ledgerPath, 'slow build', 300);
  record(ledgerPath, 'slow build', 400);
  record(ledgerPath, 'quick check', 5);
  record(ledgerPath, 'quick check', 5);
  const text = report({ ledgerPath });
  assert.ok(text.indexOf('slow build') < text.indexOf('quick check'), text);
  assert.match(text, /slow build pass in 6m 40s \(median 5m 0s, \+33%, REGRESSION\)/u);
  assert.doesNotMatch(text.split('regressions')[1], /quick check/u);
});
