import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invokeDesktop } from '../platform/desktopRuntime';

const CANCELLABLE_JOB_KINDS = new Set(['downloadMedia', 'exportMedia']);
const CANCELLING_STATES = new Set(['cancelling', 'cancelled']);

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

export const cancelDownloadOnly = async (id) => {
  if (!isUuidV7(id)) return false;
  try {
    const job = await invokeDesktop('job_cancel', { id });
    return job?.id === id
      && CANCELLABLE_JOB_KINDS.has(job.kind)
      && CANCELLING_STATES.has(job.state);
  } catch {
    return false;
  }
};
