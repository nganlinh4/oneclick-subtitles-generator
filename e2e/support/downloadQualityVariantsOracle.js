import { strict as assert } from 'node:assert';

/**
 * Pure geometry logic for the downloadQualityVariants journey.
 *
 * WHY THIS EXISTS. Neither SQLite nor a diagnostic log echoes the video HEIGHT a customer requested
 * through "Download Only": `media_assets` carries only display_name/extension/size_bytes/content_hash
 * (see `downloadDurabilityState` in downloadJourneyOracle.js), and no log records the yt-dlp
 * `--format` string Rust builds from `VideoQuality::AtMost(height)`
 * (crates/osg-download/src/plan.rs, `format_selector`, ~lines 328-366) -- CLAUDE.md requires redacted
 * diagnostics, and the format string is shaped by customer input. The only honest, credential-free
 * observable left is BEHAVIORAL: independently ffprobe the customer's saved file for two or three
 * DIFFERENT requested qualities and require the decoded geometry to track the request. If Rust ever
 * ignored the requested height, every round would decode to the same fixed rung and this would fail
 * to distinguish them -- which is exactly the regression this file exists to catch.
 */

/** Parse a real `.quality-pill-label` ("240p (Very Low)", "1080p (Full HD)", "144p") into its height. */
export const parseQualityHeight = (label) => {
  assert.equal(typeof label, 'string', 'a quality pill label must be a string');
  const match = /^(\d+)p\b/u.exec(label.trim());
  assert.ok(match, `unrecognized quality pill label: ${label}`);
  return Number(match[1]);
};

/**
 * Choose 2-3 distinct real quality-pill rounds to exercise, from the exact labels the live scan
 * returned. Never invents a rung the scan did not offer. Requires the product's own descending-height
 * ordering (src/components/DownloadOnlyModal.js sorts `mapNativeVideoQualities`'s output tallest
 * first) so `pickQuality`'s index math in support/download.js stays meaningful.
 */
export const chooseQualityRounds = (labels) => {
  assert.ok(Array.isArray(labels) && labels.length >= 2, (
    'at least two real qualities are required to prove quality selection reaches the request: '
      + `got ${JSON.stringify(labels)}`
  ));
  const heights = labels.map(parseQualityHeight);
  for (let index = 1; index < heights.length; index += 1) {
    assert.ok(heights[index] < heights[index - 1], (
      `quality pills are not sorted tallest-first as DownloadOnlyModal.js promises: ${JSON.stringify(heights)}`
    ));
  }
  const lastIndex = labels.length - 1;
  const indices = labels.length === 2
    ? [0, lastIndex]
    : [...new Set([0, Math.floor(lastIndex / 2), lastIndex])];
  return Object.freeze(indices.map((index) => Object.freeze({
    index, label: labels[index], height: heights[index],
  })));
};

/**
 * Prove one round's independently probed file matches its requested AtMost(height) bound: never
 * taller than requested, and -- because every round here is a pill taken directly off the real scan,
 * never a fabricated in-between value -- exactly the requested rung.
 */
export const verifyQualityRound = ({ round, probe }) => {
  const video = probe?.streams?.find(({ codec_type: type }) => type === 'video');
  assert.ok(video, `quality round ${round.label} produced no video stream`);
  assert.ok(
    Number.isSafeInteger(video.height) && video.height > 0,
    `quality round ${round.label} decoded no positive integer height`,
  );
  assert.ok(
    video.height <= round.height,
    `quality round ${round.label} requested at most ${round.height}p but decoded ${video.height}p`,
  );
  assert.equal(
    video.height, round.height,
    `quality round ${round.label} names the exact pill the real scan offered; the requested height `
      + 'did not reach the download the way it should have',
  );
  return Object.freeze({
    label: round.label, requestedHeight: round.height, decodedHeight: video.height, video,
  });
};

/**
 * Require every verified round to have decoded a genuinely DISTINCT height. Two different customer
 * quality choices producing the same decoded geometry would mean the request never reached the real
 * download -- the exact regression this journey exists to catch.
 */
export const assertRoundsAreDistinct = (verifiedRounds) => {
  const heights = verifiedRounds.map(({ decodedHeight }) => decodedHeight);
  assert.equal(
    new Set(heights).size, heights.length,
    `quality rounds decoded to non-distinct heights, so the requested quality never reached the `
      + `real download: ${JSON.stringify(heights)}`,
  );
};

/**
 * Loose bitrate-class sanity, not an ordering requirement: a real yt-dlp per-rung encode is not
 * guaranteed strictly monotonic bitrate for a nineteen-second clip, so this is a floor, not equality.
 */
export const approximateBitrateKbps = (probe) => {
  const duration = Number(probe?.format?.duration);
  const size = Number(probe?.format?.size);
  assert.ok(Number.isFinite(duration) && duration > 0, 'probe exposes no positive duration');
  assert.ok(Number.isFinite(size) && size > 0, 'probe exposes no positive size');
  return (size * 8) / duration / 1_000;
};
