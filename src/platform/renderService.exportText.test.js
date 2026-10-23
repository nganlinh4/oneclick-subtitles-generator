// Native render staged export text: the shape check `render_start` text passes through.
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import { createNativeRenderService, runNativeRender } from './renderService';
import { TestChannel, job, request, requestWith, result } from './renderServiceTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

describe('staged export text', () => {
  const exportText = (overrides = {}) => ({
    schemaVersion: 2,
    face: { family: 'Roboto', source: 'system:windows:Roboto:400:normal', weight: 400 },
    pages: [{ atlasId: uuidv7(), atlasContentHash: 'a1b2c3d4' }],
    cues: [{
      page: 0,
      lines: [{
        glyphs: [0, 1, 2],
        penXPx: [0, 8.5, 17],
        advanceWidthPx: 25.5,
        baselineYPx: 19,
      }],
    }],
    ...overrides,
  });

  const startingService = (invokeCommand) => createNativeRenderService({
    invokeCommand,
    ChannelConstructor: TestChannel,
    isNativeRuntime: () => true,
  });

  test('sends the staged text beside the request, one run per cue in cue order', async () => {
    const initial = job();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      throw new Error(`unexpected command: ${command}`);
    });
    const renderRequest = requestWith({
      lyrics: [
        { id: 1, start: 0, end: 1, text: 'first' },
        { id: 2, start: 1, end: 2, text: 'second' },
      ],
    });
    // Two cues on two different pages: the second must reach the command naming page 1, because a
    // page dropped in transit would draw that cue from another page's cells.
    const text = exportText({
      pages: [
        { atlasId: uuidv7(), atlasContentHash: 'a1b2c3d4' },
        { atlasId: uuidv7(), atlasContentHash: 'e5f60718' },
      ],
      cues: [
        { page: 0, lines: [{ glyphs: [0], penXPx: [0], advanceWidthPx: 6, baselineYPx: 19 }] },
        {
          page: 1,
          lines: [
            { glyphs: [1, 2], penXPx: [0, 7], advanceWidthPx: 13, baselineYPx: 19 },
            { glyphs: [3], penXPx: [0], advanceWidthPx: 6, baselineYPx: 43 },
          ],
        },
      ],
    });

    await expect(startingService(invokeCommand).start(renderRequest, {}, { text }))
      .resolves.toMatchObject({ id: initial.id });

    const [[, payload]] = invokeCommand.mock.calls;
    expect(Object.keys(payload)).toEqual(['request', 'text', 'onEvent']);
    expect(payload.text).toEqual({
      schemaVersion: 2,
      face: { family: 'Roboto', source: 'system:windows:Roboto:400:normal', weight: 400 },
      pages: text.pages,
      cues: [
        { page: 0, lines: [{ glyphs: [0], penXPx: [0], advanceWidthPx: 6, baselineYPx: 19 }] },
        {
          page: 1,
          lines: [
            { glyphs: [1, 2], penXPx: [0, 7], advanceWidthPx: 13, baselineYPx: 19 },
            { glyphs: [3], penXPx: [0], advanceWidthPx: 6, baselineYPx: 43 },
          ],
        },
      ],
    });
    // Copied, not forwarded: nothing the caller mutates afterwards can reach the command.
    expect(Object.isFrozen(payload.text)).toBe(true);
    expect(Object.isFrozen(payload.text.cues[0].lines[0].glyphs)).toBe(true);
  });

  test('omits the argument entirely when no text was staged', async () => {
    const invokeCommand = vi.fn(async () => job());
    await startingService(invokeCommand).start(request(), {});
    expect(Object.keys(invokeCommand.mock.calls[0][1])).toEqual(['request', 'onEvent']);
  });

  test('refuses a payload that does not describe these cues, before any native call', async () => {
    const invokeCommand = vi.fn(async () => job());
    const service = startingService(invokeCommand);
    const twoCues = requestWith({
      lyrics: [
        { id: 1, start: 0, end: 1, text: 'first' },
        { id: 2, start: 1, end: 2, text: 'second' },
      ],
    });
    await expect(service.start(twoCues, {}, { text: exportText() }))
      .rejects.toMatchObject({ code: 'invalidRenderRequest' });
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  test('refuses payloads this boundary owns the bounds of', async () => {
    const invokeCommand = vi.fn(async () => job());
    const service = startingService(invokeCommand);
    const line = (glyphs, penXPx) => ({
      glyphs, penXPx, advanceWidthPx: 10, baselineYPx: 19,
    });
    const page = (overrides = {}) => ({ atlasId: uuidv7(), atlasContentHash: 'a1b2c3d4', ...overrides });
    const rejected = [
      exportText({ schemaVersion: 1 }),
      exportText({ schemaVersion: 3 }),
      exportText({ pages: [page({ atlasId: uuidv4() })] }),
      exportText({ pages: [page({ atlasContentHash: '../../etc/passwd' })] }),
      exportText({ pages: [page({ atlasContentHash: '' })] }),
      exportText({ pages: [] }),
      exportText({ pages: Array.from({ length: 33 }, () => page()) }),
      // A cue naming a page the payload does not carry: the one refusal paging adds, and the one
      // that would otherwise draw a cue from whatever table happened to be at that index.
      exportText({ cues: [{ page: 1, lines: [line([0], [0])] }] }),
      exportText({ cues: [{ page: -1, lines: [line([0], [0])] }] }),
      exportText({ cues: [{ lines: [line([0], [0])] }] }),
      exportText({ face: { family: 'Roboto', source: 'system:x', weight: 450 } }),
      exportText({ face: { family: 'Roboto', source: 'system:x' } }),
      exportText({ cues: [{ page: 0, lines: [] }] }),
      exportText({ cues: [{ page: 0, lines: [line([0, 1], [0])] }] }),
      exportText({ cues: [{ page: 0, lines: [line([0], [Number.NaN])] }] }),
      exportText({ cues: [{ page: 0, lines: [line([-1], [0])] }] }),
      exportText({ cues: [{ page: 0, lines: Array.from({ length: 65 }, () => line([0], [0])) }] }),
      exportText({ cues: [{ page: 0, lines: [{ ...line([0], [0]), extra: 1 }] }] }),
    ];
    for (const text of rejected) {
      await expect(service.start(request(), {}, { text }))
        .rejects.toMatchObject({ code: 'invalidRenderRequest' });
    }
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  test('runNativeRender carries the staged text through to the command', async () => {
    const initial = job();
    const renderRequest = request();
    const completedResult = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      throw new Error(`unexpected command: ${command}`);
    });
    const service = startingService(invokeCommand);
    const text = exportText();
    const running = runNativeRender(renderRequest, { text }, service);
    await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalled());
    expect(invokeCommand.mock.calls[0][1].text.pages).toEqual(text.pages);
    TestChannel.latest.emit({
      event: 'completed',
      job: { ...initial, state: 'succeeded', progress: { basisPoints: 10_000 }, sequence: 2 },
      result: completedResult,
    });
    await expect(running).resolves.toMatchObject({ result: completedResult });
  });
});
