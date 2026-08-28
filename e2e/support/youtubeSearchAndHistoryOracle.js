import { strict as assert } from 'node:assert';

/**
 * Pure bounded-history arithmetic for the youtubeSearchAndHistory journey.
 *
 * These do NOT reimplement src/utils/historyUtils.js's sanitize/parse machinery -- they only
 * describe what a correct bounded most-recently-used push sequence must leave behind, so the journey
 * can check the REAL localStorage state it reads through the WebView against one shared, independent
 * expectation, matching the shape `upsertHistoryItem`/`readBoundedHistory` in that file implement:
 * `[item, ...history.filter(identity mismatch)].slice(0, MAX_HISTORY_ITEMS)`.
 */

/** After pushing distinct identities in order, only the most recent `cap` survive, newest first. */
export const expectedSurvivors = (pushedIdsInOrder, cap) => {
  assert.ok(Number.isSafeInteger(cap) && cap > 0, 'cap must be a positive integer');
  assert.ok(
    Array.isArray(pushedIdsInOrder) && pushedIdsInOrder.length > 0,
    'at least one push is required',
  );
  assert.equal(
    new Set(pushedIdsInOrder).size, pushedIdsInOrder.length,
    'expectedSurvivors assumes every pushed id is distinct',
  );
  return Object.freeze([...pushedIdsInOrder].reverse().slice(0, cap));
};

/** The ids evicted by `expectedSurvivors` for the same push sequence and cap. */
export const expectedEvicted = (pushedIdsInOrder, cap) => {
  const survivors = new Set(expectedSurvivors(pushedIdsInOrder, cap));
  return Object.freeze(pushedIdsInOrder.filter((id) => !survivors.has(id)));
};

/**
 * A dedupe upsert (the YouTube/Douyin lanes, identity = extracted video id): re-pushing an id already
 * present must not grow the list and must move that id to the front.
 */
export const expectedAfterDedupePush = (existingIdsNewestFirst, pushedId) => {
  assert.ok(Array.isArray(existingIdsNewestFirst), 'existingIdsNewestFirst must be an array');
  assert.equal(typeof pushedId, 'string', 'pushedId must be a string');
  return Object.freeze([
    pushedId,
    ...existingIdsNewestFirst.filter((id) => id !== pushedId),
  ]);
};

/**
 * True once a push sequence is long enough to have evicted at least one earlier id under `cap` --
 * the boundary this journey's eviction/no-resurrection proof needs to cross.
 */
export const hasEvictedAtLeastOne = (pushedIdsInOrder, cap) => (
  expectedEvicted(pushedIdsInOrder, cap).length > 0
);
