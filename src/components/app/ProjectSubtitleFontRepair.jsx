import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useProjectRenderScene } from '../../platform/projectRenderScene';
import {
  formatProjectSubtitleFontSelection,
} from '../../services/projectSubtitleFontRepair';
import { showInfoToast } from '../../utils/toastUtils';

const REPAIR_TOAST_DURATION_MS = 8_000;

/** Notify after the scene authority has durably repaired a font; this component owns no repair. */
const ProjectSubtitleFontRepair = () => {
  const { t } = useTranslation();
  const notifiedRef = useRef(null);
  const {
    status,
    scene,
    fontRepair,
  } = useProjectRenderScene();

  useEffect(() => {
    if (status !== 'ready' || scene === null || fontRepair === null) return;
    const receiptKey = `${scene.projectId}:${fontRepair.sceneRevision}:${fontRepair.to.fontFamily}:${fontRepair.to.fontWeight}`;
    if (notifiedRef.current === receiptKey) return;
    notifiedRef.current = receiptKey;
    showInfoToast(t(
      'videoRendering.subtitleFontRepaired',
      'Subtitle font repaired: {{oldFont}} → {{newFont}}',
      {
        oldFont: formatProjectSubtitleFontSelection(fontRepair.from),
        newFont: formatProjectSubtitleFontSelection(fontRepair.to),
      },
    ), REPAIR_TOAST_DURATION_MS, `project-subtitle-font-repair:${scene.projectId}`);
  }, [
    fontRepair,
    scene,
    status,
    t,
  ]);

  return null;
};

export default ProjectSubtitleFontRepair;
