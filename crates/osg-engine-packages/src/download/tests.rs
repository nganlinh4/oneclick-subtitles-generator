use std::sync::Arc;

use super::*;

/// An inner fetcher that fails the test if the bundle did not serve the asset.
///
/// Asserting "no network was used" by counting calls is what makes the offline claim real; a
/// test that merely observes a correct file cannot tell a bundled copy from a download.
#[derive(Debug, Default)]
struct RefusingFetcher {
    calls: std::sync::atomic::AtomicUsize,
}

impl ArchiveFetcher for RefusingFetcher {
    fn fetch(
        &self,
        _asset: &DeliveryAsset,
        _url: &str,
        _request: FetchRequest<'_>,
    ) -> Result<Option<String>> {
        self.calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Err(PackageError::Network)
    }
}

fn bundled_case(contents: &[u8], declared: &[u8]) -> (Result<Option<String>>, Vec<u8>, usize) {
    let root = tempfile::tempdir().unwrap();
    let bundle = root.path().join("bundle");
    fs::create_dir_all(&bundle).unwrap();
    let digest = {
        use sha2::Digest as _;
        let mut hasher = sha2::Sha256::new();
        hasher.update(declared);
        format!("{:x}", hasher.finalize())
    };
    fs::write(bundle.join(&digest), contents).unwrap();

    let asset = DeliveryAsset {
        asset: "google-sans-flex.woff2".to_owned(),
        urls: vec!["https://example.invalid/font.woff2".to_owned()],
        size_bytes: declared.len() as u64,
        sha256: digest,
    };
    let inner = Arc::new(RefusingFetcher::default());
    let fetcher = BundledArchiveFetcher::new(bundle, inner.clone());
    let target = root.path().join("asset.partial");
    let cancellation = CancellationToken::default();
    let outcome = fetcher.fetch(
        &asset,
        &asset.urls[0].clone(),
        FetchRequest {
            target: &target,
            resume_from: 0,
            etag: None,
            cancellation: &cancellation,
            progress: &|_| {},
        },
    );
    let written = fs::read(&target).unwrap_or_default();
    (
        outcome,
        written,
        inner.calls.load(std::sync::atomic::Ordering::Relaxed),
    )
}

#[test]
fn a_bundled_asset_is_served_without_touching_the_network() {
    let bytes = b"the exact bytes the catalog pins";
    let (outcome, written, network_calls) = bundled_case(bytes, bytes);
    assert!(outcome.is_ok());
    assert_eq!(written, bytes);
    assert_eq!(
        network_calls, 0,
        "a bundled asset must not reach the network"
    );
}

#[test]
fn a_bundled_asset_whose_bytes_are_wrong_falls_back_instead_of_failing_the_install() {
    // Same declared size so only the digest can tell them apart — a length check alone would
    // accept this file and install a font nobody reviewed.
    let (outcome, _, network_calls) = bundled_case(b"aaaaaaaaaaaaaaaa", b"bbbbbbbbbbbbbbbb");
    assert!(matches!(outcome, Err(PackageError::Network)));
    assert_eq!(
        network_calls, 1,
        "a damaged bundle must degrade to a download"
    );
}

#[test]
fn a_bundled_asset_of_the_wrong_length_is_not_used() {
    let (outcome, _, network_calls) = bundled_case(b"short", b"the declared contents");
    assert!(matches!(outcome, Err(PackageError::Network)));
    assert_eq!(network_calls, 1);
}

#[test]
fn a_resumed_transfer_always_goes_to_the_network() {
    let root = tempfile::tempdir().unwrap();
    let bundle = root.path().join("bundle");
    fs::create_dir_all(&bundle).unwrap();
    let asset = DeliveryAsset {
        asset: "font.woff2".to_owned(),
        urls: vec!["https://example.invalid/font.woff2".to_owned()],
        size_bytes: 8,
        sha256: "0".repeat(64),
    };
    let inner = Arc::new(RefusingFetcher::default());
    let fetcher = BundledArchiveFetcher::new(bundle, inner.clone());
    let cancellation = CancellationToken::default();
    let _ = fetcher.fetch(
        &asset,
        &asset.urls[0].clone(),
        FetchRequest {
            target: &root.path().join("asset.partial"),
            resume_from: 4,
            etag: None,
            cancellation: &cancellation,
            progress: &|_| {},
        },
    );
    assert_eq!(inner.calls.load(std::sync::atomic::Ordering::Relaxed), 1);
}

#[test]
fn successful_download_cleanup_removes_payload_and_resume_metadata() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("asset.partial");
    let metadata_path = root.path().join("asset.resume.json");
    fs::write(&path, b"payload").unwrap();
    fs::write(&metadata_path, b"metadata").unwrap();
    let downloaded = DownloadedArchive {
        path: path.clone(),
        metadata_path: metadata_path.clone(),
    };
    downloaded.remove_after_success().unwrap();
    assert!(!path.exists());
    assert!(!metadata_path.exists());
    downloaded.remove_after_success().unwrap();
}

#[test]
fn content_range_requires_the_exact_remaining_archive() {
    assert!(valid_content_range(Some("bytes 10-19/100"), 10, 19, 100));
    assert!(!valid_content_range(Some("bytes 9-19/100"), 10, 19, 100));
    assert!(!valid_content_range(Some("bytes 10-20/100"), 10, 19, 100));
    assert!(!valid_content_range(Some("bytes */100"), 10, 19, 100));
}

#[test]
fn redirect_policy_rejects_http_credentials_and_foreign_hosts() {
    let initial = Url::parse(
        "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/asr-engine-packs-v1/pack.zip",
    )
    .unwrap();
    let release = Url::parse("https://release-assets.githubusercontent.com/asset?token=x").unwrap();
    assert!(trusted_redirect(&release, std::slice::from_ref(&initial)));
    assert!(!trusted_redirect(
        &Url::parse("https://example.com/asset").unwrap(),
        std::slice::from_ref(&initial)
    ));
    assert!(!trusted_redirect(
        &Url::parse("http://release-assets.githubusercontent.com/asset").unwrap(),
        &[initial]
    ));

    let hugging_face =
        Url::parse("https://huggingface.co/Qwen/Qwen3-ASR-0.6B/resolve/revision/model.safetensors")
            .unwrap();
    assert!(trusted_redirect(
        &Url::parse("https://us.aws.cdn.hf.co/xet-bridge-us/model?token=x").unwrap(),
        std::slice::from_ref(&hugging_face)
    ));
    assert!(!trusted_redirect(
        &Url::parse("https://cdn.hf.co.example.com/model").unwrap(),
        &[hugging_face]
    ));
}
