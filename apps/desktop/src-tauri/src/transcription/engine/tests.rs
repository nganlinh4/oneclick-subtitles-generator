mod run_loop;

use serde_json::json;

use super::executor::credential_slot;
use super::{StartWordNativeTranscriptionRequest, TranscriptionModel};

const PROJECT: &str = "01890f39-7b62-7c4e-8c9a-000000000001";
const ASSET: &str = "01890f39-7b62-7c4e-8c9a-000000000101";

fn parse(value: serde_json::Value) -> Result<StartWordNativeTranscriptionRequest, String> {
    serde_json::from_value(value).map_err(|error| error.to_string())
}

#[test]
fn requests_name_media_only_by_owned_asset_id() {
    let request = parse(json!({
        "projectId": PROJECT,
        "mediaAssetId": ASSET,
        "windowDurationMs": 60_000,
        "config": { "model": "gemini-3.5-transcribe-live" },
    }))
    .expect("an asset-only request is accepted");
    assert_eq!(request.media_asset_id.to_string(), ASSET);
    assert_eq!(request.model(), TranscriptionModel::Live);
}

#[test]
fn requests_with_a_native_file_path_are_refused() {
    let with_both = parse(json!({
        "projectId": PROJECT,
        "mediaAssetId": ASSET,
        "filePath": "C:\\Users\\victim\\secrets.wav",
    }))
    .expect_err("a WebView-supplied path must not reach ffmpeg or Gemini");
    assert!(with_both.contains("filePath"), "{with_both}");

    let path_only = parse(json!({
        "projectId": PROJECT,
        "filePath": "C:\\Users\\victim\\secrets.wav",
    }));
    assert!(path_only.is_err());

    let nested = parse(json!({
        "projectId": PROJECT,
        "mediaAssetId": ASSET,
        "config": { "filePath": "C:\\Users\\victim\\secrets.wav" },
    }));
    assert!(nested.is_err());
}

#[test]
fn requests_without_an_asset_id_are_refused() {
    let missing = parse(json!({ "projectId": PROJECT })).expect_err("asset ID is required");
    assert!(missing.contains("mediaAssetId"), "{missing}");
}

#[test]
fn model_names_match_their_wire_names() {
    for model in [TranscriptionModel::Transcribe, TranscriptionModel::Live] {
        let parsed: TranscriptionModel =
            serde_json::from_value(json!(model.as_str())).expect("wire name");
        assert_eq!(parsed, model);
    }
    assert_eq!(
        TranscriptionModel::default(),
        TranscriptionModel::Transcribe
    );
}

#[test]
fn parallel_windows_rotate_across_ready_credentials() {
    assert_eq!(
        (0..4)
            .map(|index| credential_slot(index, 20))
            .collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
    assert_eq!(
        (0..6)
            .map(|index| credential_slot(index, 2))
            .collect::<Vec<_>>(),
        [0, 1, 0, 1, 0, 1]
    );
}
