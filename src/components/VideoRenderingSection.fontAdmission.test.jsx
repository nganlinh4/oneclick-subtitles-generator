import { fireEvent, render } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { defaultProjectRenderSceneValues } from '../platform/projectRenderScene';

const mocks = vi.hoisted(() => ({
  renderScene: null,
  previewProps: null,
  renderControlProps: null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('../platform/projectRenderScene', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useProjectRenderScene: () => mocks.renderScene,
  };
});
vi.mock('./VideoRenderingSection/useVideoUpload', () => ({
  useVideoUpload: () => ({
    isDragging: false,
    selectedVideoFile: { id: 'source', type: 'video/mp4' },
    setSelectedVideoFile: vi.fn(),
    handleVideoUpload: vi.fn(),
    handleBrowseClick: vi.fn(),
    nativeDropZoneRef: { current: null },
    handleDragEnter: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDragOver: vi.fn(),
    handleDrop: vi.fn(),
  }),
}));
vi.mock('./VideoRenderingSection/useRenderQueue', () => ({
  useRenderQueue: () => ({
    renderQueue: [],
    setRenderQueue: vi.fn(),
    currentQueueItem: null,
    startNextPendingRender: vi.fn(),
    ownsRenderLease: () => true,
    ownQueuePlayback: vi.fn(),
    removeFromQueue: vi.fn(),
    clearQueue: vi.fn(),
  }),
}));
vi.mock('./VideoRenderingSection/useNarration', () => ({
  requireGeneratedNarrationArtifact: () => null,
  useNarration: () => ({
    isRefreshingNarration: false,
    alignedNarrationUrl: null,
    isAlignedNarrationAvailable: false,
    hasNarrationSegments: false,
    getNarrationArtifactId: vi.fn(),
    handleRefreshNarration: vi.fn(),
  }),
}));
vi.mock('./VideoRenderingSection/usePanelResize', () => ({
  usePanelResize: () => ({
    leftPanelWidth: 50,
    containerRef: { current: null },
    handleMouseDown: vi.fn(),
  }),
}));
vi.mock('./VideoRenderingSection/useAutoFill', () => ({
  useAutoFill: () => ({ sectionRef: { current: null } }),
}));
vi.mock('./VideoRenderingSection/InputSelectionRow', () => ({ default: () => null }));
vi.mock('./VideoRenderingSection/TrimTimelineRow', () => ({ default: () => null }));
vi.mock('./QueueManagerPanel', () => ({ default: () => null }));
vi.mock('./VideoRenderingSection/PreviewCustomizationRow', () => ({
  default: (props) => {
    mocks.previewProps = props;
    return <div data-testid="render-preview" />;
  },
}));
vi.mock('./VideoRenderingSection/RenderSettingsRow', () => ({
  default: (props) => {
    mocks.renderControlProps = props;
    return <div data-testid="render-controls" />;
  },
}));
vi.mock('../platform/renderService', () => ({
  buildNativeRenderRequest: vi.fn(),
  cancelNativeRender: vi.fn(),
  ensureNativeRenderProject: vi.fn(),
  getNativeRenderStatus: vi.fn(),
  resolveNativeRenderSource: vi.fn(),
  runNativeRender: vi.fn(),
}));
vi.mock('./previews/native/exportTextStaging', () => ({ stageNativeRenderText: vi.fn() }));

import VideoRenderingSection from './VideoRenderingSection';

const props = {
  selectedVideo: null,
  uploadedFile: null,
  actualVideoUrl: null,
  subtitlesData: [{ id: 'cue', start: 0, end: 1, text: 'Hello' }],
  translatedSubtitles: [],
  narrationResults: [],
  onNativeVideoSelected: vi.fn(),
};

beforeEach(() => {
  mocks.previewProps = null;
  mocks.renderControlProps = null;
  window.addToast = vi.fn();
  window.removeToastByKey = vi.fn();
  mocks.renderScene = {
    status: 'repairing',
    scene: null,
    error: null,
    updateScene: vi.fn(),
    flushScene: vi.fn(),
  };
});

test('Render mounts neither preview nor export controls until the repaired scene is admitted', () => {
  const result = render(<VideoRenderingSection {...props} />);
  fireEvent.click(result.container.querySelector('.collapse-button'));

  expect(mocks.previewProps).toBeNull();
  expect(mocks.renderControlProps).toBeNull();
  expect(window.addToast).not.toHaveBeenCalled();

  const values = defaultProjectRenderSceneValues();
  mocks.renderScene = {
    ...mocks.renderScene,
    status: 'ready',
    scene: {
      schemaVersion: 1,
      projectId: '019ffbea-40eb-7c3c-b2f3-214ca260a7cc',
      sceneRevision: 9,
      ...values,
      customization: {
        ...values.customization,
        fontFamily: "'Google Sans', sans-serif",
        fontWeight: 400,
      },
    },
  };
  result.rerender(<VideoRenderingSection {...props} />);

  expect(mocks.previewProps.subtitleCustomization).toMatchObject({
    fontFamily: "'Google Sans', sans-serif",
    fontWeight: 400,
  });
  expect(mocks.renderControlProps.onRender).toEqual(expect.any(Function));
});
