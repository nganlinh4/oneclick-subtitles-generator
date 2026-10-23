use osg_domain::{AssetId, JobId};
use osg_infrastructure::storage::ContentHash;
use osg_media::{MediaTimeRange, WaveformLevel, WaveformPoint, WaveformPyramid};
use serde_json::json;

use super::MAX_OPERATION_TIME_US;
use super::execution::{finalize_waveform_result, processing_job_progress};
use super::request::{MediaPipelineRequest, MediaPipelineResult, ValidatedOperation};
use super::runtime::RuntimeJobs;
use crate::error::CommandError;
use crate::waveform_cache::WaveformCacheSpec;

fn valid_waveform() -> WaveformPyramid {
    WaveformPyramid {
        duration_us: 1_000_000,
        source_sample_rate_hz: 400,
        levels: vec![WaveformLevel {
            points_per_second: 100.0,
            points: vec![WaveformPoint {
                minimum: -0.5,
                maximum: 0.5,
                root_mean_square: 0.25,
            }],
        }],
    }
}

fn waveform_spec() -> WaveformCacheSpec {
    WaveformCacheSpec::new(
        ContentHash::from_bytes([0x42; 32]),
        100,
        10_000,
        MediaTimeRange::new(0, None).expect("range"),
    )
}

#[test]
fn wire_requests_reject_paths_unknown_fields_and_unbounded_ranges() {
    let asset_id = AssetId::new();
    let valid: MediaPipelineRequest = serde_json::from_value(json!({
        "operation": "analysisClip",
        "assetId": asset_id,
        "startUs": 1_000_000,
        "endUs": 2_000_000,
    }))
    .expect("valid request");
    assert!(matches!(
        valid.validate().expect("validated").operation,
        ValidatedOperation::AnalysisClip { .. }
    ));
    assert!(
        serde_json::from_value::<MediaPipelineRequest>(json!({
            "operation": "analysisClip",
            "assetId": asset_id,
            "startUs": 0,
            "endUs": 1,
            "outputPath": "C:\\private\\clip.mp4",
        }))
        .is_err()
    );
    let too_long: MediaPipelineRequest = serde_json::from_value(json!({
        "operation": "analysisClip",
        "assetId": asset_id,
        "startUs": 0,
        "endUs": MAX_OPERATION_TIME_US + 1,
    }))
    .expect("wire shape");
    assert!(too_long.validate().is_err());
}

#[test]
fn full_range_requires_zero_start_and_clip_requires_an_end() {
    let asset_id = AssetId::new();
    let extract: MediaPipelineRequest = serde_json::from_value(json!({
        "operation": "extractAudio",
        "assetId": asset_id,
        "format": "wav",
        "startUs": 1,
        "endUs": null,
    }))
    .expect("wire shape");
    assert!(extract.validate().is_err());
    assert!(
        serde_json::from_value::<MediaPipelineRequest>(json!({
            "operation": "analysisClip",
            "assetId": asset_id,
            "startUs": 0,
            "endUs": null,
        }))
        .is_err()
    );
}

#[test]
fn processing_progress_is_bounded_and_monotonic() {
    let zero = processing_job_progress(0.0).expect("zero");
    let half = processing_job_progress(0.5).expect("half");
    let complete = processing_job_progress(1.0).expect("complete");
    assert!(zero < half && half < complete);
    assert_eq!(zero.basis_points(), 500);
    assert_eq!(complete.basis_points(), 9_500);
}

#[test]
fn finalization_excludes_cancellation_until_the_permit_drops() {
    let jobs = std::sync::Arc::new(RuntimeJobs::default());
    let job_id = JobId::new();
    jobs.remember(job_id).expect("remember");
    let permit = jobs.begin_finalization(job_id).expect("begin finalization");
    assert!(jobs.run_if_cancellable(job_id, || Ok(())).is_err());
    drop(permit);
    assert!(jobs.run_if_cancellable(job_id, || Ok(())).is_ok());
    assert!(jobs.run_if_cancellable(JobId::new(), || Ok(())).is_err());
}

#[test]
fn valid_waveform_survives_cache_storage_failure_but_invalid_ipc_does_not() {
    let asset_id = AssetId::new();
    let result = finalize_waveform_result(
        asset_id,
        JobId::new(),
        valid_waveform(),
        false,
        waveform_spec(),
        |_| Err(CommandError::internal("simulated read-only cache")),
    )
    .expect("valid waveform remains usable without cache storage");
    assert!(matches!(
        result,
        MediaPipelineResult::Waveform {
            asset_id: returned,
            cache_hit: false,
            ..
        } if returned == asset_id
    ));

    let mut invalid = valid_waveform();
    invalid.levels[0].points[0].maximum = f32::NAN;
    assert!(
        finalize_waveform_result(
            asset_id,
            JobId::new(),
            invalid,
            false,
            waveform_spec(),
            |_| panic!("invalid waveform must be refused before cache publication"),
        )
        .is_err()
    );
}
