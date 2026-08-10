import { validate as validateUuid, v7 as uuidv7, version as uuidVersion } from 'uuid';

export const MAX_LEGACY_SUBTITLE_SECONDS = 31_557_600_000;
export const MAX_PROJECT_CUES = 1_000_000;
export const MAX_PROJECT_TRACKS = 256;

const MAX_CUE_TEXT_CHARS = 1_000_000;
const MAX_PROJECT_NAME_CHARS = 200;
const MAX_TRACK_LABEL_CHARS = 200;
const VALID_TRACK_ORIGINS = new Set(['legacyJson', 'srt']);
const VALID_MEDIA_KINDS = new Set(['audio', 'video']);

export class ProjectSnapshotMappingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectSnapshotMappingError';
    this.code = code;
    Object.assign(this, details);
  }
}

const mappingError = (code, message, details) => (
  new ProjectSnapshotMappingError(code, message, details)
);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const characterCount = (value) => Array.from(value).length;
const hasControlCharacter = (value) => Array.from(value).some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 31 || codePoint === 127;
});

export const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) {
    return false;
  }

  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

const requireUuidV7 = (value, field) => {
  if (!isUuidV7(value)) {
    throw mappingError('invalidProjectId', `${field} must be an RFC 9562 UUIDv7 value`, { field });
  }
  return value;
};

const requireBoundedString = (
  value,
  field,
  maximum,
  { allowEmpty = true, rejectControl = false } = {}
) => {
  if (typeof value !== 'string') {
    throw mappingError('invalidProjectField', `${field} must be a string`, { field });
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw mappingError('invalidProjectField', `${field} cannot be blank`, { field });
  }
  if (rejectControl && hasControlCharacter(value)) {
    throw mappingError('invalidProjectField', `${field} cannot contain control characters`, { field });
  }
  if (characterCount(value) > maximum) {
    throw mappingError('projectFieldTooLarge', `${field} is too long`, { field, maximum });
  }
  return value;
};

const requireSafeInteger = (value, field, { minimum = Number.MIN_SAFE_INTEGER } = {}) => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw mappingError('invalidProjectField', `${field} must be a safe integer`, { field });
  }
  return value;
};

const normalizeCanonicalCue = (cue, trackIndex, cueIndex) => {
  const prefix = `tracks[${trackIndex}].cues[${cueIndex}]`;
  if (!isRecord(cue)) {
    throw mappingError('invalidProjectCue', `${prefix} must be an object`, { trackIndex, cueIndex });
  }

  const id = requireUuidV7(cue.id, `${prefix}.id`);
  const ordinal = requireSafeInteger(cue.ordinal, `${prefix}.ordinal`, { minimum: 1 });
  const startMs = requireSafeInteger(cue.startMs, `${prefix}.startMs`, { minimum: 0 });
  const endMs = requireSafeInteger(cue.endMs, `${prefix}.endMs`, { minimum: 1 });
  if (endMs <= startMs) {
    throw mappingError('invalidSubtitleRange', `${prefix}.endMs must be greater than startMs`, {
      trackIndex,
      cueIndex,
    });
  }

  const text = requireBoundedString(cue.text, `${prefix}.text`, MAX_CUE_TEXT_CHARS);
  const sourceId = cue.sourceId == null
    ? null
    : requireUuidV7(cue.sourceId, `${prefix}.sourceId`);

  return { id, ordinal, startMs, endMs, text, sourceId };
};

const normalizeCanonicalTrack = (track, trackIndex) => {
  const prefix = `tracks[${trackIndex}]`;
  if (!isRecord(track) || !Array.isArray(track.cues)) {
    throw mappingError('invalidProjectTrack', `${prefix} must contain a cues array`, { trackIndex });
  }
  if (track.cues.length === 0) {
    throw mappingError('emptySubtitleTrack', `${prefix} cannot be empty`, { trackIndex });
  }

  const id = requireUuidV7(track.id, `${prefix}.id`);
  const label = requireBoundedString(track.label, `${prefix}.label`, MAX_TRACK_LABEL_CHARS, {
    allowEmpty: false,
    rejectControl: true,
  });
  if (!VALID_TRACK_ORIGINS.has(track.origin)) {
    throw mappingError('invalidProjectTrack', `${prefix}.origin is unsupported`, { trackIndex });
  }

  const cues = track.cues.map((cue, cueIndex) => normalizeCanonicalCue(cue, trackIndex, cueIndex));
  const cueIds = new Set(cues.map((cue) => cue.id));
  cues.forEach((cue, cueIndex) => {
    if (cue.ordinal !== cueIndex + 1) {
      throw mappingError('invalidCueOrdinal', `${prefix}.cues must have consecutive ordinals`, {
        trackIndex,
        cueIndex,
      });
    }
    if (cue.sourceId !== null && !cueIds.has(cue.sourceId)) {
      throw mappingError('unknownSourceCue', `${prefix}.cues[${cueIndex}].sourceId is not in its track`, {
        trackIndex,
        cueIndex,
      });
    }
  });

  return { id, label, origin: track.origin, cues };
};

const normalizeMediaAsset = (asset, index) => {
  const prefix = `media[${index}]`;
  if (!isRecord(asset)) {
    throw mappingError('invalidProjectMedia', `${prefix} must be an object`, { mediaIndex: index });
  }
  if (!VALID_MEDIA_KINDS.has(asset.kind)) {
    throw mappingError('invalidProjectMedia', `${prefix}.kind is unsupported`, { mediaIndex: index });
  }

  return {
    id: requireUuidV7(asset.id, `${prefix}.id`),
    displayName: requireBoundedString(asset.displayName, `${prefix}.displayName`, 512, {
      allowEmpty: false,
      rejectControl: true,
    }),
    extension: requireBoundedString(asset.extension, `${prefix}.extension`, 32, {
      allowEmpty: false,
    }),
    sizeBytes: requireSafeInteger(asset.sizeBytes, `${prefix}.sizeBytes`, { minimum: 1 }),
    kind: asset.kind,
  };
};

/**
 * Validate and copy the exact path-free ProjectSnapshot wire shape. Unknown fields are deliberately
 * not copied across the IPC boundary, preventing legacy File/path objects from leaking into a
 * durable revision.
 */
export const normalizeProjectSnapshot = (snapshot) => {
  if (!isRecord(snapshot) || !isRecord(snapshot.metadata)) {
    throw mappingError('invalidProjectSnapshot', 'A project snapshot and metadata are required');
  }
  if (!Array.isArray(snapshot.media) || !Array.isArray(snapshot.tracks)) {
    throw mappingError('invalidProjectSnapshot', 'Project media and tracks must be arrays');
  }
  if (snapshot.tracks.length > MAX_PROJECT_TRACKS) {
    throw mappingError('tooManyProjectTracks', 'The project contains too many subtitle tracks');
  }

  const metadata = {
    id: requireUuidV7(snapshot.metadata.id, 'metadata.id'),
    name: requireBoundedString(snapshot.metadata.name, 'metadata.name', MAX_PROJECT_NAME_CHARS, {
      allowEmpty: false,
      rejectControl: true,
    }),
  };
  const stateVersion = requireSafeInteger(snapshot.stateVersion, 'stateVersion', { minimum: 0 });
  const media = snapshot.media.map(normalizeMediaAsset);
  const tracks = snapshot.tracks.map(normalizeCanonicalTrack);

  const mediaIds = new Set();
  media.forEach((asset) => {
    if (mediaIds.has(asset.id)) {
      throw mappingError('duplicateProjectId', `Media asset ${asset.id} occurs more than once`);
    }
    mediaIds.add(asset.id);
  });

  const trackIds = new Set();
  const cueIds = new Set();
  let cueCount = 0;
  tracks.forEach((track) => {
    if (trackIds.has(track.id)) {
      throw mappingError('duplicateProjectId', `Subtitle track ${track.id} occurs more than once`);
    }
    trackIds.add(track.id);
    cueCount += track.cues.length;
    track.cues.forEach((cue) => {
      if (cueIds.has(cue.id)) {
        throw mappingError('duplicateProjectId', `Subtitle cue ${cue.id} occurs more than once`);
      }
      cueIds.add(cue.id);
    });
  });
  if (cueCount > MAX_PROJECT_CUES) {
    throw mappingError('tooManyProjectCues', 'The project contains too many subtitle cues');
  }

  return { metadata, stateVersion, media, tracks };
};

const INVALID_IDENTITY = Symbol('invalidIdentity');

const normalizeIdentityValue = (value, seen) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_IDENTITY;
  if (typeof value !== 'object' || seen.has(value)) return INVALID_IDENTITY;

  seen.add(value);
  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map((entry) => normalizeIdentityValue(entry, seen));
    if (normalized.includes(INVALID_IDENTITY)) normalized = INVALID_IDENTITY;
  } else {
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      const entry = normalizeIdentityValue(value[key], seen);
      if (entry === INVALID_IDENTITY) {
        normalized = INVALID_IDENTITY;
        break;
      }
      normalized[key] = entry;
    }
  }
  seen.delete(value);
  return normalized;
};

const canonicalIdentity = (value) => {
  // serde's Option<Value> treats a top-level null exactly like an absent legacy ID.
  if (value === null || value === undefined) return null;
  const normalized = normalizeIdentityValue(value, new Set());
  return normalized === INVALID_IDENTITY ? null : JSON.stringify(normalized);
};

const secondsToMilliseconds = (value, rowIndex, field) => {
  if (typeof value !== 'number' || !Number.isFinite(value)
      || value < 0 || value > MAX_LEGACY_SUBTITLE_SECONDS) {
    throw mappingError('invalidLegacySubtitleTime', `Subtitle ${rowIndex + 1} has an invalid ${field} time`, {
      rowIndex,
      field,
    });
  }

  const milliseconds = Math.round(value * 1_000);
  if (!Number.isSafeInteger(milliseconds)) {
    throw mappingError('invalidLegacySubtitleTime', `Subtitle ${rowIndex + 1} has an unsafe ${field} time`, {
      rowIndex,
      field,
    });
  }
  return milliseconds;
};

const legacyTime = (row, primary, alias, rowIndex) => {
  const value = row[primary] == null ? row[alias] : row[primary];
  return secondsToMilliseconds(value, rowIndex, primary);
};

const newUniqueId = (usedIds) => {
  let id;
  do {
    id = uuidv7();
  } while (usedIds.has(id));
  usedIds.add(id);
  return id;
};

/** Convert legacy UI rows (seconds) into one canonical millisecond subtitle track. */
export const legacyRowsToCanonicalTrack = (rows, options = {}) => {
  if (!Array.isArray(rows)) {
    throw mappingError('invalidLegacySubtitles', 'Legacy subtitles must be an array');
  }
  if (rows.length === 0) {
    throw mappingError('emptyLegacySubtitles', 'An empty legacy cache cannot form a canonical track');
  }
  if (rows.length > MAX_PROJECT_CUES) {
    throw mappingError('tooManyProjectCues', 'The subtitle cache contains too many cues');
  }

  const existingTrack = options.existingTrack == null
    ? null
    : normalizeCanonicalTrack(options.existingTrack, 0);
  const label = requireBoundedString(
    options.label ?? existingTrack?.label ?? 'Subtitles',
    'track.label',
    MAX_TRACK_LABEL_CHARS,
    { allowEmpty: false, rejectControl: true }
  );
  const origin = options.origin ?? existingTrack?.origin ?? 'legacyJson';
  if (!VALID_TRACK_ORIGINS.has(origin)) {
    throw mappingError('invalidProjectTrack', 'track.origin is unsupported');
  }

  const existingByOrdinal = new Map(
    (existingTrack?.cues ?? []).map((cue) => [cue.ordinal, cue.id])
  );
  const usedIds = new Set();
  const converted = rows.map((row, rowIndex) => {
    if (!isRecord(row)) {
      throw mappingError('invalidLegacySubtitle', `Subtitle ${rowIndex + 1} must be an object`, {
        rowIndex,
      });
    }

    const startMs = legacyTime(row, 'start', 'startTime', rowIndex);
    const endMs = legacyTime(row, 'end', 'endTime', rowIndex);
    if (endMs <= startMs) {
      throw mappingError('invalidSubtitleRange', `Subtitle ${rowIndex + 1} must end after it starts`, {
        rowIndex,
      });
    }
    const text = requireBoundedString(row.text, `subtitles[${rowIndex}].text`, MAX_CUE_TEXT_CHARS);

    let id = null;
    if (isUuidV7(row.id)) {
      id = row.id;
    } else if (Number.isInteger(row.id) && row.id > 0 && existingByOrdinal.has(row.id)) {
      id = existingByOrdinal.get(row.id);
    }
    if (id !== null) {
      if (usedIds.has(id)) {
        throw mappingError('duplicateLegacySubtitleId', `Subtitle ID ${String(row.id)} occurs more than once`, {
          rowIndex,
        });
      }
      usedIds.add(id);
    } else {
      id = newUniqueId(usedIds);
    }

    return {
      id,
      inputIndex: rowIndex,
      legacyId: canonicalIdentity(row.id),
      legacySourceId: canonicalIdentity(row.originalId),
      explicitSourceId: row.sourceId,
      startMs,
      endMs,
      text,
    };
  });

  const cueIdByLegacyId = new Map();
  converted.forEach((cue) => {
    if (cue.legacyId === null) return;
    if (cueIdByLegacyId.has(cue.legacyId)) {
      throw mappingError('duplicateLegacySubtitleId', 'Legacy subtitle IDs must be unique');
    }
    cueIdByLegacyId.set(cue.legacyId, cue.id);
  });

  const cueIds = new Set(converted.map((cue) => cue.id));
  converted.forEach((cue) => {
    if (cue.legacySourceId !== null) {
      cue.sourceId = cueIdByLegacyId.get(cue.legacySourceId) ?? null;
    } else if (cue.explicitSourceId == null) {
      cue.sourceId = null;
    } else if (isUuidV7(cue.explicitSourceId) && cueIds.has(cue.explicitSourceId)) {
      cue.sourceId = cue.explicitSourceId;
    } else {
      throw mappingError('unknownSourceCue', `Subtitle ${cue.inputIndex + 1} has an unknown source cue`, {
        rowIndex: cue.inputIndex,
      });
    }
  });

  converted.sort((left, right) => (
    left.startMs - right.startMs
      || left.endMs - right.endMs
      || left.inputIndex - right.inputIndex
  ));

  const cues = converted.map((cue, index) => ({
    id: cue.id,
    ordinal: index + 1,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text,
    sourceId: cue.sourceId,
  }));

  const trackId = existingTrack?.id ?? options.trackId;
  return {
    id: trackId == null ? uuidv7() : requireUuidV7(trackId, 'track.id'),
    label,
    origin,
    cues,
  };
};

/** Convert a canonical millisecond track back to the legacy UI's seconds-based minimum shape. */
export const canonicalTrackToLegacyRows = (track) => {
  const canonical = normalizeCanonicalTrack(track, 0);
  const ordinalById = new Map(canonical.cues.map((cue) => [cue.id, cue.ordinal]));

  return canonical.cues.map((cue) => {
    const row = {
      id: cue.ordinal,
      start: cue.startMs / 1_000,
      end: cue.endMs / 1_000,
      text: cue.text,
    };
    if (cue.sourceId !== null) {
      row.originalId = ordinalById.get(cue.sourceId);
    }
    return row;
  });
};

const findTrackIndex = (snapshot, options) => {
  if (options.trackId != null) {
    return snapshot.tracks.findIndex((track) => track.id === options.trackId);
  }
  if (options.label != null) {
    const exact = snapshot.tracks.findIndex((track) => (
      track.origin === 'legacyJson' && track.label === options.label
    ));
    if (exact >= 0) return exact;
  }
  const legacyTracks = snapshot.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.origin === 'legacyJson');
  return legacyTracks.length === 1 ? legacyTracks[0].index : -1;
};

export const replaceLegacySubtitleTrack = (snapshot, rows, options = {}) => {
  const canonical = normalizeProjectSnapshot(snapshot);
  const trackIndex = findTrackIndex(canonical, options);
  const existingTrack = trackIndex >= 0 ? canonical.tracks[trackIndex] : null;
  const track = legacyRowsToCanonicalTrack(rows, { ...options, existingTrack });
  const tracks = [...canonical.tracks];
  if (trackIndex >= 0) {
    tracks[trackIndex] = track;
  } else {
    if (tracks.length >= MAX_PROJECT_TRACKS) {
      throw mappingError('tooManyProjectTracks', 'The project cannot contain another track');
    }
    tracks.push(track);
  }
  return { ...canonical, tracks };
};

export const removeLegacySubtitleTrack = (snapshot, options = {}) => {
  const canonical = normalizeProjectSnapshot(snapshot);
  const trackIndex = findTrackIndex(canonical, options);
  if (trackIndex < 0) return canonical;
  return {
    ...canonical,
    tracks: canonical.tracks.filter((_, index) => index !== trackIndex),
  };
};

export const readLegacySubtitleTrack = (snapshot, options = {}) => {
  const canonical = normalizeProjectSnapshot(snapshot);
  const trackIndex = findTrackIndex(canonical, options);
  return trackIndex < 0 ? null : canonicalTrackToLegacyRows(canonical.tracks[trackIndex]);
};
