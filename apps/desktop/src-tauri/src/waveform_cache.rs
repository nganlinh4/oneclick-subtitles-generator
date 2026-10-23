use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use osg_infrastructure::storage::{
    ArtifactDraft, ArtifactFailureCode, ArtifactKind, ArtifactRegistration, ArtifactRetention,
    CacheCategory, CacheKey, CacheWrite, ContentHash, Database,
};
use osg_media::{MediaTimeRange, WaveformLevel, WaveformPoint, WaveformPyramid};
use serde_json::json;

use crate::error::{CommandError, CommandResult};

const CACHE_MAGIC: &[u8; 8] = b"OSGWFC01";
const CACHE_SCHEMA_VERSION: u32 = 1;
pub(crate) const WAVEFORM_ALGORITHM_VERSION: u32 = 1;
const CACHE_CATEGORY: &str = "waveform";
const CACHE_ARTIFACT_KIND: &str = "waveformCache";
const MAX_CACHE_BYTES: usize = 16 * 1024 * 1024;
const MAX_LEVELS: usize = 16;
const MAX_DURATION_US: u64 = 7 * 24 * 60 * 60 * 1_000_000;
static CACHE_PUBLICATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WaveformCacheSpec {
    source_content_hash: ContentHash,
    points_per_second: u32,
    max_points: usize,
    start_us: u64,
    duration_us: Option<u64>,
}

impl WaveformCacheSpec {
    pub(crate) const fn new(
        source_content_hash: ContentHash,
        points_per_second: u32,
        max_points: usize,
        range: MediaTimeRange,
    ) -> Self {
        Self {
            source_content_hash,
            points_per_second,
            max_points,
            start_us: range.start_us,
            duration_us: range.duration_us,
        }
    }

    pub(crate) fn key(self) -> CommandResult<CacheKey> {
        let category = CacheCategory::new(CACHE_CATEGORY)?;
        let max_points = u64::try_from(self.max_points)
            .map_err(|_| CommandError::internal("The waveform cache request is invalid."))?;
        let duration_tag = [u8::from(self.duration_us.is_some())];
        let duration = self.duration_us.unwrap_or_default().to_be_bytes();
        CacheKey::derive(
            &category,
            WAVEFORM_ALGORITHM_VERSION,
            &[
                self.source_content_hash.as_bytes(),
                &self.points_per_second.to_be_bytes(),
                &max_points.to_be_bytes(),
                &self.start_us.to_be_bytes(),
                &duration_tag,
                &duration,
            ],
        )
        .map_err(Into::into)
    }
}

#[derive(Debug)]
pub(crate) struct WaveformCacheLookup {
    pub(crate) waveform: WaveformPyramid,
    pub(crate) cache_hit: bool,
}

/// Returns a semantically validated cache hit. Missing bytes, content corruption, a stale schema,
/// or a payload that does not describe the exact request is evicted and treated as a miss.
pub(crate) fn lookup(
    database: &Database,
    spec: WaveformCacheSpec,
) -> CommandResult<Option<WaveformCacheLookup>> {
    let key = spec.key()?;
    let Some(artifact) = database.lookup_cache(key)? else {
        return Ok(None);
    };
    let valid_record = artifact.record().kind().as_str() == CACHE_ARTIFACT_KIND
        && artifact.record().retention() == ArtifactRetention::Cache
        && artifact.record().project_id().is_none()
        && artifact.record().size_bytes() <= MAX_CACHE_BYTES as u64;
    let waveform = valid_record
        .then(|| read_bounded(artifact.path()))
        .transpose()
        .ok()
        .flatten()
        .and_then(|bytes| decode(&bytes, spec).ok());
    if let Some(waveform) = waveform {
        return Ok(Some(WaveformCacheLookup {
            waveform,
            cache_hit: true,
        }));
    }
    database.invalidate_cache(key)?;
    Ok(None)
}

/// Publishes encoded waveform bytes as an unowned, rebuildable cache artifact. The ready artifact
/// transition and `cache_entries` row are committed together by the database actor.
pub(crate) fn publish(
    database: &Database,
    spec: WaveformCacheSpec,
    waveform: &WaveformPyramid,
) -> CommandResult<()> {
    let bytes = encode(waveform, spec)?;
    let content_hash = ContentHash::digest(&bytes);
    let metadata = json!({
        "schemaVersion": CACHE_SCHEMA_VERSION,
        "algorithmVersion": WAVEFORM_ALGORITHM_VERSION,
        "sourceContentHash": hex(spec.source_content_hash.as_bytes()),
        "pointsPerSecond": spec.points_per_second,
        "maxPoints": spec.max_points,
        "startUs": spec.start_us,
        "durationUs": spec.duration_us,
    });
    let draft = ArtifactDraft::new_cache(
        ArtifactKind::new(CACHE_ARTIFACT_KIND)?,
        content_hash,
        u64::try_from(bytes.len())
            .map_err(|_| CommandError::internal("The waveform cache output is too large."))?,
        metadata,
    )?;
    let category = CacheCategory::new(CACHE_CATEGORY)?;
    let key = spec.key()?;

    let _guard = CACHE_PUBLICATION_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let registration = database.register_artifact(&draft)?;
    let (artifact_id, staged) = match registration {
        ArtifactRegistration::Staging(staging) => {
            write_staged(staging.path(), &bytes).map_err(|error| {
                let _ = database.mark_artifact_failed(
                    staging.record().id(),
                    &ArtifactFailureCode::new("waveformCacheWrite")
                        .expect("the static failure code is valid"),
                );
                CommandError::internal(format!(
                    "The waveform cache bytes could not be staged: {error}"
                ))
            })?;
            (staging.record().id(), true)
        }
        ArtifactRegistration::Existing(record) => {
            if record.retention() != ArtifactRetention::Cache || record.project_id().is_some() {
                return Err(CommandError::internal(
                    "The waveform cache artifact has unsafe ownership.",
                ));
            }
            (record.id(), false)
        }
        ArtifactRegistration::Pending(record) => {
            return Err(CommandError::internal(format!(
                "Waveform cache publication is already pending for artifact {}.",
                record.id()
            )));
        }
    };
    let write = CacheWrite::new(key, artifact_id, category, WAVEFORM_ALGORITHM_VERSION, None)?;
    if let Err(error) = database.commit_cache_artifact(&write) {
        if staged {
            let _ = database.mark_artifact_failed(
                artifact_id,
                &ArtifactFailureCode::new("waveformCacheCommit")
                    .expect("the static failure code is valid"),
            );
        }
        return Err(error.into());
    }
    Ok(())
}

fn write_staged(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).truncate(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, ()> {
    let metadata = fs::metadata(path).map_err(|_| ())?;
    if !metadata.is_file() || metadata.len() > MAX_CACHE_BYTES as u64 {
        return Err(());
    }
    let bytes = fs::read(path).map_err(|_| ())?;
    (bytes.len() as u64 == metadata.len())
        .then_some(bytes)
        .ok_or(())
}

fn encode(waveform: &WaveformPyramid, spec: WaveformCacheSpec) -> CommandResult<Vec<u8>> {
    validate_for_ipc(waveform, spec)?;
    let mut bytes = Vec::with_capacity(
        encoded_size(waveform)
            .ok_or_else(|| CommandError::internal("The generated waveform cache is too large."))?,
    );
    bytes.extend_from_slice(CACHE_MAGIC);
    put_u32(&mut bytes, CACHE_SCHEMA_VERSION);
    put_u32(&mut bytes, WAVEFORM_ALGORITHM_VERSION);
    bytes.extend_from_slice(spec.source_content_hash.as_bytes());
    put_u32(&mut bytes, spec.points_per_second);
    put_u64(
        &mut bytes,
        u64::try_from(spec.max_points)
            .map_err(|_| CommandError::internal("The waveform cache point limit is invalid."))?,
    );
    put_u64(&mut bytes, spec.start_us);
    bytes.push(u8::from(spec.duration_us.is_some()));
    put_u64(&mut bytes, spec.duration_us.unwrap_or_default());
    put_u64(&mut bytes, waveform.duration_us);
    put_u32(&mut bytes, waveform.source_sample_rate_hz);
    put_u32(
        &mut bytes,
        u32::try_from(waveform.levels.len())
            .map_err(|_| CommandError::internal("The waveform cache has too many levels."))?,
    );
    for level in &waveform.levels {
        put_u64(&mut bytes, level.points_per_second.to_bits());
        put_u32(
            &mut bytes,
            u32::try_from(level.points.len())
                .map_err(|_| CommandError::internal("The waveform cache has too many points."))?,
        );
        for point in &level.points {
            put_u32(&mut bytes, point.minimum.to_bits());
            put_u32(&mut bytes, point.maximum.to_bits());
            put_u32(&mut bytes, point.root_mean_square.to_bits());
        }
    }
    if bytes.len() > MAX_CACHE_BYTES {
        return Err(CommandError::internal(
            "The generated waveform cache is too large.",
        ));
    }
    Ok(bytes)
}

pub(crate) fn validate_for_ipc(
    waveform: &WaveformPyramid,
    spec: WaveformCacheSpec,
) -> CommandResult<()> {
    validate_waveform(waveform, spec)
        .map_err(|()| CommandError::internal("The generated waveform cache is invalid."))
}

fn decode(bytes: &[u8], spec: WaveformCacheSpec) -> Result<WaveformPyramid, ()> {
    if bytes.len() > MAX_CACHE_BYTES {
        return Err(());
    }
    let mut reader = Reader::new(bytes);
    if reader.take(CACHE_MAGIC.len())? != CACHE_MAGIC
        || reader.u32()? != CACHE_SCHEMA_VERSION
        || reader.u32()? != WAVEFORM_ALGORITHM_VERSION
        || reader.take(32)? != spec.source_content_hash.as_bytes()
        || reader.u32()? != spec.points_per_second
        || reader.u64()? != u64::try_from(spec.max_points).map_err(|_| ())?
        || reader.u64()? != spec.start_us
    {
        return Err(());
    }
    let duration_present = reader.byte()?;
    let duration = reader.u64()?;
    if duration_present > 1
        || (duration_present == 1) != spec.duration_us.is_some()
        || duration != spec.duration_us.unwrap_or_default()
    {
        return Err(());
    }
    let duration_us = reader.u64()?;
    let source_sample_rate_hz = reader.u32()?;
    let level_count = usize::try_from(reader.u32()?).map_err(|_| ())?;
    if level_count == 0 || level_count > MAX_LEVELS {
        return Err(());
    }
    let mut levels = Vec::with_capacity(level_count);
    let mut total_points = 0_usize;
    let point_limit = maximum_pyramid_points(spec.max_points).ok_or(())?;
    for _ in 0..level_count {
        let points_per_second = f64::from_bits(reader.u64()?);
        let point_count = usize::try_from(reader.u32()?).map_err(|_| ())?;
        total_points = total_points.checked_add(point_count).ok_or(())?;
        if point_count == 0 || total_points > point_limit {
            return Err(());
        }
        let mut points = Vec::with_capacity(point_count);
        for _ in 0..point_count {
            points.push(WaveformPoint {
                minimum: f32::from_bits(reader.u32()?),
                maximum: f32::from_bits(reader.u32()?),
                root_mean_square: f32::from_bits(reader.u32()?),
            });
        }
        levels.push(WaveformLevel {
            points_per_second,
            points,
        });
    }
    if !reader.is_finished() {
        return Err(());
    }
    let waveform = WaveformPyramid {
        duration_us,
        source_sample_rate_hz,
        levels,
    };
    validate_waveform(&waveform, spec)?;
    Ok(waveform)
}

fn validate_waveform(waveform: &WaveformPyramid, spec: WaveformCacheSpec) -> Result<(), ()> {
    if waveform.duration_us == 0
        || waveform.duration_us > MAX_DURATION_US
        || !(400..=4_000).contains(&waveform.source_sample_rate_hz)
        || waveform.levels.is_empty()
        || waveform.levels.len() > MAX_LEVELS
        || waveform.levels[0].points.is_empty()
        || waveform.levels[0].points.len() > spec.max_points
    {
        return Err(());
    }
    let allowed_points = maximum_pyramid_points(spec.max_points).ok_or(())?;
    let mut total_points = 0_usize;
    for (index, level) in waveform.levels.iter().enumerate() {
        if !level.points_per_second.is_finite()
            || level.points_per_second <= 0.0
            || level.points_per_second > f64::from(waveform.source_sample_rate_hz)
            || level.points.is_empty()
        {
            return Err(());
        }
        if index > 0 {
            let previous = &waveform.levels[index - 1];
            if level.points_per_second.to_bits() != (previous.points_per_second / 4.0).to_bits()
                || level.points.len() != previous.points.len().div_ceil(4)
                || previous.points.len() <= 2_000
            {
                return Err(());
            }
        }
        total_points = total_points.checked_add(level.points.len()).ok_or(())?;
        if total_points > allowed_points
            || level.points.iter().any(|point| {
                !point.minimum.is_finite()
                    || !point.maximum.is_finite()
                    || !point.root_mean_square.is_finite()
                    || point.minimum < -1.0
                    || point.maximum > 1.0
                    || point.minimum > point.maximum
                    || !(0.0..=1.0).contains(&point.root_mean_square)
            })
        {
            return Err(());
        }
    }
    if waveform
        .levels
        .last()
        .is_some_and(|level| level.points.len() > 2_000)
    {
        return Err(());
    }
    Ok(())
}

fn maximum_pyramid_points(max_points: usize) -> Option<usize> {
    let mut count = max_points;
    let mut total = count;
    while count > 2_000 {
        count = count.div_ceil(4);
        total = total.checked_add(count)?;
    }
    Some(total)
}

fn encoded_size(waveform: &WaveformPyramid) -> Option<usize> {
    const HEADER_BYTES: usize = 8 + 4 + 4 + 32 + 4 + 8 + 8 + 1 + 8 + 8 + 4 + 4;
    waveform
        .levels
        .iter()
        .try_fold(HEADER_BYTES, |size, level| {
            size.checked_add(8 + 4)?
                .checked_add(level.points.len().checked_mul(12)?)
        })
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn put_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn put_u64(output: &mut Vec<u8>, value: u64) {
    output.extend_from_slice(&value.to_le_bytes());
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], ()> {
        let end = self.offset.checked_add(count).ok_or(())?;
        let value = self.bytes.get(self.offset..end).ok_or(())?;
        self.offset = end;
        Ok(value)
    }

    fn byte(&mut self) -> Result<u8, ()> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, ()> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().map_err(|_| ())?,
        ))
    }

    fn u64(&mut self) -> Result<u64, ()> {
        Ok(u64::from_le_bytes(
            self.take(8)?.try_into().map_err(|_| ())?,
        ))
    }

    const fn is_finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

#[cfg(test)]
mod tests;
