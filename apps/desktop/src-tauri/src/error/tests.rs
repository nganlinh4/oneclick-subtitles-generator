use std::io;

use osg_domain::{ProjectId, RevisionId};
use osg_infrastructure::storage::DatabaseError;

use super::CommandError;

#[test]
fn database_errors_exposed_to_the_webview_are_sanitized() {
    let path_error = DatabaseError::Io(io::Error::other(
        "C:\\Users\\private\\AppData\\Local\\secret.sqlite3",
    ));
    let command: CommandError = path_error.into();

    assert_eq!(command.code, "database");
    assert!(!command.message.contains("Users"));

    let revision_error = DatabaseError::CorruptProjectRevision {
        revision_id: RevisionId::new(),
        detail: "raw blob contains a private diagnostic",
    };
    let command: CommandError = revision_error.into();
    assert_eq!(command.code, "projectDataCorrupt");
    assert!(!command.message.contains("private diagnostic"));

    let stale = DatabaseError::StaleProjectVersion {
        project_id: ProjectId::new(),
        expected: 3,
        actual: 4,
    };
    let command: CommandError = stale.into();
    assert_eq!(command.code, "staleProjectVersion");
    assert!(!command.message.contains('3'));
    assert!(!command.message.contains('4'));

    let stale_track = DatabaseError::StaleProjectTrackHistory {
        project_id: ProjectId::new(),
        expected: 9,
        actual: 10,
    };
    let command: CommandError = stale_track.into();
    assert_eq!(command.code, "staleProjectTrackHistory");
    assert!(!command.message.contains('9'));
    assert!(!command.message.contains("10"));
}

#[test]
fn gemini_errors_exposed_to_the_webview_are_sanitized() {
    let provider = osg_gemini::Error::Provider(osg_gemini::ProviderError {
        http_status: 429,
        api_status: Some("RESOURCE_EXHAUSTED".to_owned()),
        message: "private prompt, key, and provider diagnostic".to_owned(),
        retry_after: Some(std::time::Duration::from_secs(17)),
        retryable: true,
    });
    let command: CommandError = provider.into();

    assert_eq!(command.code, "geminiRateLimited");
    assert!(!command.message.contains("private prompt"));
    assert!(!command.message.contains("RESOURCE_EXHAUSTED"));
    assert!(!command.message.contains("17"));

    let rejected: CommandError = osg_gemini::Error::Provider(osg_gemini::ProviderError {
        http_status: 400,
        api_status: Some("INVALID_ARGUMENT".to_owned()),
        message: "private request body".to_owned(),
        retry_after: None,
        retryable: false,
    })
    .into();
    assert_eq!(rejected.code, "geminiRequestRejected");
    assert!(!rejected.message.contains("private request body"));

    let unavailable: CommandError = osg_gemini::Error::Provider(osg_gemini::ProviderError {
        http_status: 404,
        api_status: Some("NOT_FOUND".to_owned()),
        message: "private model diagnostic".to_owned(),
        retry_after: None,
        retryable: false,
    })
    .into();
    assert_eq!(unavailable.code, "geminiModelUnavailable");
    assert!(!unavailable.message.contains("private model diagnostic"));
}

#[test]
fn engine_package_errors_exposed_to_the_webview_are_bounded_and_sanitized() {
    let command: CommandError = osg_engine_packages::PackageError::OperationInProgress(
        osg_engine_packages::EngineId::Qwen3Asr1_7b,
    )
    .into();

    assert_eq!(command.code, "packageOperationInProgress");
    assert!(!command.message.contains("qwen"));
    assert!(!command.message.contains("Users"));

    let integrity: CommandError = osg_engine_packages::PackageError::ArchiveIntegrity.into();
    assert_eq!(integrity.code, "packageIntegrity");
    assert!(!integrity.message.contains("http"));
}

#[test]
fn native_download_errors_distinguish_http_from_incomplete_transfers() {
    let http: CommandError = osg_native_tools::NativeToolError::HttpStatus(503).into();
    let incomplete: CommandError = osg_native_tools::NativeToolError::IncompleteDownload.into();
    let transport: CommandError = osg_native_tools::NativeToolError::Network.into();
    assert_eq!(http.code(), "nativeToolHttpFailed");
    assert!(http.message.contains("HTTP 503"));
    assert_eq!(incomplete.code(), "nativeToolIncompleteDownload");
    assert_eq!(transport.code(), "nativeToolDownloadFailed");
    for error in [http, incomplete, transport] {
        assert!(!error.message.contains("https://"));
        assert!(error.message.len() < 128);
    }
}
