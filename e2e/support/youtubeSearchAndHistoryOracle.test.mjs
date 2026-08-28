import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  expectedAfterDedupePush, expectedEvicted, expectedSurvivors, hasEvictedAtLeastOne,
} from './youtubeSearchAndHistoryOracle.js';

test('expectedSurvivors keeps the most recent `cap` pushes, newest first', () => {
  const pushed = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(expectedSurvivors(pushed, 3), ['e', 'd', 'c']);
  assert.deepEqual(expectedSurvivors(pushed, 10), ['e', 'd', 'c', 'b', 'a']);
  assert.deepEqual(expectedSurvivors(pushed, 1), ['e']);
});

test('expectedSurvivors refuses a non-positive cap or an empty/duplicated push sequence', () => {
  assert.throws(() => expectedSurvivors(['a'], 0), /positive integer/);
  assert.throws(() => expectedSurvivors([], 3), /at least one push/);
  assert.throws(() => expectedSurvivors(['a', 'a'], 3), /every pushed id is distinct/);
});

test('expectedEvicted names exactly the ids expectedSurvivors dropped', () => {
  const pushed = Array.from({ length: 11 }, (_, index) => `all-sites-${index + 1}`);
  const evicted = expectedEvicted(pushed, 10);
  assert.deepEqual(evicted, ['all-sites-1']);
  const survivors = expectedSurvivors(pushed, 10);
  assert.equal(survivors.includes(evicted[0]), false);
  assert.equal(survivors.length + evicted.length, pushed.length);
});

test('hasEvictedAtLeastOne is false until the push sequence exceeds the cap', () => {
  const pushed = Array.from({ length: 10 }, (_, index) => `id-${index + 1}`);
  assert.equal(hasEvictedAtLeastOne(pushed, 10), false);
  assert.equal(hasEvictedAtLeastOne([...pushed, 'id-11'], 10), true);
});

test('expectedAfterDedupePush moves an existing id to the front without growing the list', () => {
  const before = ['jNQXAC9IVRw', 'other-id'];
  assert.deepEqual(expectedAfterDedupePush(before, 'jNQXAC9IVRw'), ['jNQXAC9IVRw', 'other-id']);
});

test('expectedAfterDedupePush inserts a genuinely new id at the front', () => {
  const before = ['other-id'];
  assert.deepEqual(expectedAfterDedupePush(before, 'jNQXAC9IVRw'), ['jNQXAC9IVRw', 'other-id']);
});

test('expectedAfterDedupePush refuses non-array history or a non-string pushed id', () => {
  assert.throws(() => expectedAfterDedupePush('not-an-array', 'x'), /must be an array/);
  assert.throws(() => expectedAfterDedupePush([], 7), /must be a string/);
});
