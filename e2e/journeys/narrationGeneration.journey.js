// A customer installs gTTS and turns durable project cues into durable, playable narration audio.
/* global browser, describe, it, $, document */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { ensureEngineReady } from '../support/engines.js';
import { probeMedia } from '../support/nativeMediaOracle.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';

const ENGINE = 'gtts';
const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'interrupted']);

const looksLikeMp3 = (bytes) => (
  bytes.length >= 3
  && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
);

describe('a customer generates narration from subtitles', () => {
  it('installs and starts gTTS, synthesizes every cue, and publishes durable nonempty audio', async () => {
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    assert.ok(destination, 'the aligned-audio save destination must be staged');
    await openProjectWithMedia();
    await importSubtitles();
    await ensureEngineReady(ENGINE);

    await clickControl('label[for="method-gtts"]');
    const generateSelector = '[data-osg-action="generate-narration"][data-narration-method="gtts"]';
    const generate = await $(generateSelector);
    let generateState = null;
    await browser.waitUntil(async () => {
      generateState = await browser.execute((selector) => {
        const button = document.querySelector(selector);
        return button === null ? null : {
          disabled: button.disabled,
          title: button.title,
          text: (button.innerText || '').trim(),
        };
      }, generateSelector);
      return generateState !== null && generateState.disabled === false;
    }, {
      timeout: 120_000,
      interval: 500,
      timeoutMsg: () => `gTTS never became ready to generate: ${JSON.stringify(generateState)}`,
    });
    await generate.click();

    let surface = null;
    let durable = null;
    let failedJob = null;
    await browser.waitUntil(async () => {
      surface = await browser.execute(() => ({
        succeeded: document.querySelectorAll('[data-narration-result-state="succeeded"]').length,
        pending: document.querySelectorAll('[data-narration-result-state="pending"]').length,
        failed: document.querySelectorAll('[data-narration-result-state="failed"]').length,
        toasts: [...document.querySelectorAll('.toast')]
          .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(-5),
      }));
      durable = durableState(process.env.OSG_E2E_DATA_ROOT);
      const narrationJobs = durable.jobs.filter((job) => job.kind === 'synthesizeNarration');
      const readyArtifacts = durable.artifacts.filter((artifact) => (
        artifact.kind === 'narrationOutput' && artifact.state === 'ready'
      ));
      failedJob = narrationJobs.find((job) => TERMINAL_FAILURES.has(job.state)) ?? null;
      return failedJob !== null
        || (surface.succeeded > 0
          && surface.pending === 0
          && surface.failed === 0
          && narrationJobs.length > 0
          && narrationJobs.every((job) => job.state === 'succeeded')
          && readyArtifacts.length === surface.succeeded);
    }, {
      timeout: 900_000,
      interval: 1_000,
      timeoutMsg: () => `narration did not finish: ${JSON.stringify({ surface, failedJob })}`,
    });
    if (failedJob !== null) {
      throw new Error(`native narration job terminated: ${JSON.stringify({ failedJob, surface })}`);
    }

    const artifacts = durable.artifacts.filter((artifact) => (
      artifact.kind === 'narrationOutput' && artifact.state === 'ready'
    ));
    assert.equal(artifacts.length, surface.succeeded, 'one ready narration artifact per UI result');
    const narrationJobIds = new Set(durable.jobs
      .filter((job) => job.kind === 'synthesizeNarration' && job.state === 'succeeded')
      .map((job) => job.id));
    for (const artifact of artifacts) {
      assert.notEqual(artifact.project_id, null, `narration artifact is not project-owned: ${artifact.id}`);
      assert.equal(
        narrationJobIds.has(artifact.job_id),
        true,
        `narration artifact is not owned by its successful native job: ${artifact.id}`,
      );
      assert.ok(artifact.size_bytes > 128, `narration artifact is implausibly small: ${artifact.id}`);
      const path = join(process.env.OSG_E2E_DATA_ROOT, 'data', 'artifacts', artifact.relative_path);
      assert.equal(statSync(path).size, artifact.size_bytes, `artifact size disagrees with SQLite: ${path}`);
      assert.equal(looksLikeMp3(readFileSync(path).subarray(0, 3)), true, `artifact is not MP3 audio: ${path}`);
    }

    const projectIds = new Set(artifacts.map((artifact) => artifact.project_id));
    assert.equal(projectIds.size, 1, 'all narration outputs must belong to one exact project');
    const alignedPath = join(destination, 'aligned_narration.m4a');
    assert.equal(existsSync(alignedPath), false, 'the isolated aligned output already exists');
    await clickControl('[data-osg-action="download-aligned-narration"]');

    let alignedJob = null;
    let alignedArtifact = null;
    await browser.waitUntil(async () => {
      durable = durableState(process.env.OSG_E2E_DATA_ROOT);
      alignedJob = durable.jobs.find((job) => job.kind === 'alignNarration') ?? null;
      alignedArtifact = durable.artifacts.find((artifact) => (
        artifact.kind === 'alignedNarration' && artifact.state === 'ready'
      )) ?? null;
      return alignedJob?.state === 'succeeded'
        && alignedArtifact !== null
        && existsSync(alignedPath);
    }, {
      timeout: 300_000,
      interval: 1_000,
      timeoutMsg: () => `aligned narration did not export: ${JSON.stringify({
        alignedJob,
        alignedArtifact,
      })}`,
    });
    assert.equal(
      alignedArtifact.project_id,
      [...projectIds][0],
      'the aligned artifact escaped its narration project',
    );
    assert.equal(alignedArtifact.job_id, alignedJob.id, 'the aligned artifact lost its job owner');
    assert.ok(statSync(alignedPath).size > 1_000, 'the aligned M4A is implausibly small');
    const probe = probeMedia(alignedPath);
    const audioStreams = probe.streams.filter((stream) => stream.codec_type === 'audio');
    assert.equal(audioStreams.length, 1, `aligned output has no single audio stream: ${JSON.stringify(probe)}`);
    assert.equal(
      probe.streams.some((stream) => stream.codec_type === 'video'),
      false,
      'aligned narration unexpectedly contains video',
    );
    assert.ok(Number(probe.format.duration) > 1, 'aligned narration duration is implausibly short');
  });
});
