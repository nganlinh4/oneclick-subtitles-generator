import { StrictMode } from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sceneState: null,
  showInfoToast: vi.fn(),
}));

vi.mock('../../platform/projectRenderScene', () => ({
  useProjectRenderScene: () => mocks.sceneState,
}));
vi.mock('../../utils/toastUtils', () => ({
  showInfoToast: mocks.showInfoToast,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key, fallback, variables) => fallback
      .replace('{{oldFont}}', variables.oldFont)
      .replace('{{newFont}}', variables.newFont),
  }),
}));

import ProjectSubtitleFontRepair from './ProjectSubtitleFontRepair';

beforeEach(() => {
  mocks.showInfoToast.mockReset();
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  });
});

test('the observer notifies once only after the authority publishes a durable repair receipt', async () => {
  const repairedScene = {
    projectId: '019c96b4-42bc-7aa8-92d0-604f12fb5cb4',
    sceneRevision: 12,
    customization: {
      fontFamily: "'Google Sans', sans-serif",
      fontWeight: 400,
      preset: 'custom',
    },
  };
  mocks.sceneState = {
    status: 'ready',
    scene: repairedScene,
    fontRepair: {
      from: { fontFamily: "'Dead Legacy Face', fantasy", fontWeight: 800 },
      to: { fontFamily: "'Google Sans', sans-serif", fontWeight: 400 },
      reason: 'managedDefault',
      sceneRevision: 12,
    },
  };

  const result = render(<StrictMode><ProjectSubtitleFontRepair /></StrictMode>);

  await waitFor(() => expect(mocks.showInfoToast).toHaveBeenCalledTimes(1));
  expect(mocks.showInfoToast).toHaveBeenCalledWith(
    'Subtitle font repaired: Dead Legacy Face 800 → Google Sans 400',
    8_000,
    `project-subtitle-font-repair:${repairedScene.projectId}`,
  );

  mocks.sceneState = {
    ...mocks.sceneState,
    scene: { ...repairedScene, sceneRevision: 13 },
  };
  result.rerender(<StrictMode><ProjectSubtitleFontRepair /></StrictMode>);
  expect(mocks.showInfoToast).toHaveBeenCalledTimes(1);
});

test.each(['preparing', 'repairing', 'failed'])('%s is silent and produces no refusal toast', (status) => {
  mocks.sceneState = {
    status,
    scene: null,
    fontRepair: null,
  };

  render(<ProjectSubtitleFontRepair />);

  expect(mocks.showInfoToast).not.toHaveBeenCalled();
});
