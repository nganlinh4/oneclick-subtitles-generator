// Subtitle-font admission for the project render scene: the barrier that inspects the saved face,
// blocks or repairs it, and only then lets the scene reach preview and export.
import { PROJECT_SUBTITLE_FONT_ADMISSION } from '../services/projectSubtitleFontRepair';
import {
  FONT_ADMISSION_KEYS,
  FONT_REPAIR_KEYS,
  FONT_SELECTION_KEYS,
  ProjectRenderSceneError,
  normalizeProjectRenderSceneValues,
  sceneResponse,
} from './projectRenderSceneValues';
import { snapshotExactRecord, snapshotPlainRecord } from './plainDataRecord';

/** The admission half of one render-scene authority; returns its `admitOwner(owner)`. */
export const createProjectRenderSceneAdmission = ({
  isActive,
  inspectFontAdmission,
  cancelTimer,
  applyPendingUpdates,
  persistOwner,
  publishOwner,
  publishFontAdmission,
  publishFontAdmissionFailure,
}) => {
  const failInvalidFontAdmission = (owner, cause) => {
    const error = new ProjectRenderSceneError(
      'projectSubtitleFontAdmissionFailed',
      'The saved subtitle font could not be checked',
      { cause },
    );
    publishFontAdmissionFailure(owner, error);
    return error;
  };
  const admitOwner = async (owner) => {
    if (!isActive(owner) || owner.initialized !== true) return null;
    if (owner.admitting !== null) return owner.admitting;

    const admissionWork = (async () => {
      while (isActive(owner)) {
        if (owner.pendingUpdateError !== null) {
          publishFontAdmissionFailure(owner, owner.pendingUpdateError);
          throw owner.pendingUpdateError;
        }
        if (owner.persistenceError !== null) {
          publishFontAdmissionFailure(owner, owner.persistenceError);
          throw owner.persistenceError;
        }
        if (owner.requiredFontRepairMutation !== null
            && owner.persistedMutation < owner.requiredFontRepairMutation) {
          const error = new ProjectRenderSceneError(
            'projectSubtitleFontRepairNotDurable',
            'The repaired subtitle font was not durably acknowledged',
          );
          owner.persistenceError = error;
          publishFontAdmissionFailure(owner, error);
          throw error;
        }
        // Admission failures (an unavailable capability or a failed synchronous inspection) may
        // become answerable on a later native epoch. Persistence failures above may not.
        owner.error = null;
        applyPendingUpdates(owner);
        const inspectedScene = sceneResponse(
          owner.projectId,
          owner.persistedRevision,
          owner.values,
        );
        let admission;
        try {
          admission = inspectFontAdmission(inspectedScene);
        } catch (cause) {
          throw failInvalidFontAdmission(owner, cause);
        }
        const admissionRecord = snapshotExactRecord(admission, FONT_ADMISSION_KEYS);
        if (admissionRecord === null) {
          throw failInvalidFontAdmission(owner, new TypeError(
            'The subtitle-font admission inspector returned an invalid record',
          ));
        }

        if (admissionRecord.status === PROJECT_SUBTITLE_FONT_ADMISSION.preparing
            && admissionRecord.repair === null) {
          publishFontAdmission(owner, 'preparing');
          return null;
        }
        if (admissionRecord.status === PROJECT_SUBTITLE_FONT_ADMISSION.refused
            && admissionRecord.repair === null) {
          const error = new ProjectRenderSceneError(
            'projectSubtitleFontUnavailable',
            'The saved subtitle font is unavailable on this computer',
            { fontReason: snapshotPlainRecord(admissionRecord.resolution)?.reason ?? null },
          );
          publishFontAdmissionFailure(owner, error);
          throw error;
        }
        if (admissionRecord.status === PROJECT_SUBTITLE_FONT_ADMISSION.ready
            && admissionRecord.repair === null) {
          owner.error = null;
          owner.fontAdmissionStatus = 'ready';
          if (owner.lastFontRepair !== null
              && (owner.values.customization.fontFamily !== owner.lastFontRepair.to.fontFamily
                || owner.values.customization.fontWeight !== owner.lastFontRepair.to.fontWeight)) {
            // A user choice queued behind the repair owns the scene now. Publishing the older
            // receipt would truthfully describe a CAS write but falsely describe what is on screen.
            owner.lastFontRepair = null;
          }
          publishOwner(owner);
          return sceneResponse(owner.projectId, owner.persistedRevision, owner.values);
        }
        if (admissionRecord.status !== PROJECT_SUBTITLE_FONT_ADMISSION.repairing) {
          throw failInvalidFontAdmission(owner, new TypeError(
            'The subtitle-font admission inspector returned an invalid state',
          ));
        }

        const repair = snapshotExactRecord(admissionRecord.repair, FONT_REPAIR_KEYS);
        const repairFrom = snapshotExactRecord(repair?.from, FONT_SELECTION_KEYS);
        const repairTo = snapshotExactRecord(repair?.to, FONT_SELECTION_KEYS);
        const customization = owner.values.customization;
        if (repair === null || repairFrom === null || repairTo === null
            || typeof repair.reason !== 'string' || repair.reason.length === 0
            || customization.fontFamily !== repairFrom.fontFamily
            || customization.fontWeight !== repairFrom.fontWeight) {
          throw failInvalidFontAdmission(owner, new TypeError(
            'The subtitle-font repair does not own the inspected selection',
          ));
        }
        // Publish the barrier before changing the local scene. Subscribers can therefore observe
        // either the old admitted scene or no scene, never a repaired-but-not-durable intermediate.
        cancelTimer(owner);
        publishFontAdmission(owner, 'repairing');
        try {
          owner.values = normalizeProjectRenderSceneValues({
            ...owner.values,
            customization: {
              ...customization,
              fontFamily: repairTo.fontFamily,
              fontWeight: repairTo.fontWeight,
              preset: 'custom',
            },
          });
        } catch (cause) {
          throw failInvalidFontAdmission(owner, cause);
        }
        owner.mutation += 1;
        const repairMutation = owner.mutation;
        owner.requiredFontRepairMutation = repairMutation;
        try {
          await persistOwner(owner, { publish: false });
        } catch (cause) {
          const error = owner.error ?? new ProjectRenderSceneError(
            'projectSubtitleFontRepairWriteFailed',
            'The repaired subtitle font could not be saved',
            { cause },
          );
          owner.persistenceError = error;
          if (isActive(owner)) {
            publishFontAdmissionFailure(owner, error);
          }
          throw error;
        }
        if (!isActive(owner)) return null;
        if (owner.persistedMutation < repairMutation) {
          const error = new ProjectRenderSceneError(
            'projectSubtitleFontRepairNotDurable',
            'The repaired subtitle font was not durably acknowledged',
          );
          owner.persistenceError = error;
          publishFontAdmissionFailure(owner, error);
          throw error;
        }
        owner.requiredFontRepairMutation = null;
        owner.lastFontRepair = Object.freeze({
          ...repair,
          sceneRevision: owner.persistedRevision,
        });
        // Re-inspect the exact persisted values. This closes capability changes and any update that
        // queued while the CAS write was in flight without inventing a second font authority.
      }
      return null;
    })();
    owner.admitting = admissionWork;
    try {
      return await admissionWork;
    } finally {
      if (owner.admitting === admissionWork) owner.admitting = null;
    }
  };

  return admitOwner;
};
