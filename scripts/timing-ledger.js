#!/usr/bin/env node
// Wall-clock ledger for managed commands and e2e journeys: timings.jsonl in the managed dev cache.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LEDGER_FILE = 'timings.jsonl';
const MAX_RECORDS = 2_000;
const REGRESSION_RATIO = 1.2;
// Sub-second jitter on a fast item is noise, not a regression.
const MIN_REGRESSION_SECONDS = 1;

const defaultLedgerPath = (environment = process.env) => {
  const explicit = environment.OSG_DEV_CACHE_ROOT;
  const root = typeof explicit === 'string' && explicit.trim() !== ''
    ? explicit
    : path.join(environment.LOCALAPPDATA ?? '', 'OSG-Development', 'cache');
  return path.join(path.resolve(root), LEDGER_FILE);
};

const currentCommit = (cwd = path.resolve(__dirname, '..')) => {
  const result = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  const commit = result.status === 0 ? String(result.stdout).trim() : '';
  return /^[0-9a-f]{7,40}$/u.test(commit) ? commit : 'unknown';
};

const readRecords = (ledgerPath) => {
  let text;
  try {
    text = fs.readFileSync(ledgerPath, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      const record = JSON.parse(line);
      return typeof record?.name === 'string' && Number.isFinite(record.seconds) ? [record] : [];
    } catch {
      return [];
    }
  });
};

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Compare one run with the median of the earlier passing runs of the same name. */
const compare = (record, earlier) => {
  const baseline = median(earlier
    .filter((previous) => previous.name === record.name && previous.outcome === 'pass')
    .map((previous) => previous.seconds));
  if (baseline === null) return { baseline: null, regression: false };
  const regression = record.outcome === 'pass'
    && record.seconds >= baseline * REGRESSION_RATIO
    && record.seconds - baseline >= MIN_REGRESSION_SECONDS;
  return { baseline, regression };
};

const formatSeconds = (seconds) => {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
};

const summarize = (record, { baseline, regression }) => {
  const head = `timing: ${record.name} ${record.outcome} in ${formatSeconds(record.seconds)}`;
  if (baseline === null) return `${head} (first recorded run)`;
  const change = Math.round(((record.seconds - baseline) / baseline) * 100);
  const sign = change >= 0 ? '+' : '';
  return `${head} (median ${formatSeconds(baseline)}, ${sign}${change}%${regression ? ', REGRESSION' : ''})`;
};

const writeAtomically = (ledgerPath, records) => {
  const temporary = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(temporary, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
    fs.renameSync(temporary, ledgerPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};

/**
 * Append one run, keep the newest MAX_RECORDS, and print how it compares. The ledger is advisory:
 * any read, write or git failure is swallowed so a timing problem never fails the timed run.
 */
const recordTiming = ({
  name, seconds, outcome,
  ledgerPath = defaultLedgerPath(),
  commit = currentCommit(),
  now = new Date(),
  write = (line) => process.stderr.write(`${line}\n`),
}) => {
  try {
    const record = {
      name: String(name).slice(0, 200),
      seconds: Math.round(seconds * 10) / 10,
      outcome,
      commit,
      at: now.toISOString(),
    };
    const earlier = readRecords(ledgerPath);
    const comparison = compare(record, earlier);
    write(summarize(record, comparison));
    writeAtomically(ledgerPath, [...earlier, record].slice(-MAX_RECORDS));
    return { record, ...comparison };
  } catch {
    return null;
  }
};

/** Start a timer whose `finish(outcome)` records the elapsed wall time once. */
const startTiming = (name, options = {}) => {
  const started = Date.now();
  return {
    finish: (outcome) => recordTiming({
      ...options, name, outcome, seconds: (Date.now() - started) / 1_000,
    }),
  };
};

/** The `npm run timings` report: slowest items by median, then current regressions. */
const report = ({ ledgerPath = defaultLedgerPath(), limit = 15 } = {}) => {
  const records = readRecords(ledgerPath);
  if (records.length === 0) return `no timings recorded yet in ${ledgerPath}`;
  const byName = new Map();
  for (const [index, record] of records.entries()) {
    byName.set(record.name, [...(byName.get(record.name) ?? []), { ...record, index }]);
  }
  const items = [...byName.entries()].map(([name, runs]) => {
    const latest = runs.at(-1);
    const passed = runs.filter((run) => run.outcome === 'pass').map((run) => run.seconds);
    return {
      name,
      runs: runs.length,
      median: median(passed.length > 0 ? passed : runs.map((run) => run.seconds)),
      latest,
      ...compare(latest, records.slice(0, latest.index)),
    };
  });
  const slowest = [...items].sort((left, right) => right.median - left.median).slice(0, limit);
  const regressions = items.filter((item) => item.regression);
  const lines = [`timings: ${records.length} records, ${items.length} names (${ledgerPath})`, '', 'slowest (median):'];
  for (const item of slowest) {
    lines.push(`  ${formatSeconds(item.median).padStart(8)}  ${item.name}  [${item.runs} runs, last ${item.latest.outcome} ${formatSeconds(item.latest.seconds)}]`);
  }
  lines.push('', regressions.length === 0 ? 'regressions: none' : 'regressions (latest run vs median of earlier passes):');
  for (const item of regressions) lines.push(`  ${summarize(item.latest, item).replace(/^timing: /u, '')}`);
  return lines.join('\n');
};

if (require.main === module) process.stdout.write(`${report()}\n`);

module.exports = {
  MAX_RECORDS, compare, defaultLedgerPath, readRecords, recordTiming, report, startTiming,
};
