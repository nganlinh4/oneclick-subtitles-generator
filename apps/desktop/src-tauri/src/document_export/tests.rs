use std::fs;

use osg_runtime_staging::RuntimeStagingAuthority;

use super::*;

fn request(
    name: &str,
    format: SubtitleDocumentFormat,
    content: &str,
) -> SubtitleDocumentExportRequest {
    SubtitleDocumentExportRequest {
        suggested_name: name.to_owned(),
        format,
        content: content.to_owned(),
    }
}

#[test]
fn validates_unicode_names_and_exact_document_types() {
    assert!(validate_request(&request("phụ đề.srt", SubtitleDocumentFormat::Srt, "1\n")).is_ok());
    assert!(
        validate_request(&request(
            "captions.JSON",
            SubtitleDocumentFormat::Json,
            "[]"
        ))
        .is_ok()
    );
    assert!(validate_request(&request("notes.txt", SubtitleDocumentFormat::Txt, "")).is_ok());
    assert!(
        validate_request(&request(
            "../captions.srt",
            SubtitleDocumentFormat::Srt,
            "1"
        ))
        .is_err()
    );
    assert!(validate_request(&request("captions.txt", SubtitleDocumentFormat::Srt, "1")).is_err());
    assert!(validate_request(&request("captions .srt", SubtitleDocumentFormat::Srt, "1")).is_err());
}

#[test]
fn writes_utf8_with_atomic_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let authority_directory = tempfile::tempdir().unwrap();
    let authority = RuntimeStagingAuthority::prepare(authority_directory.path()).unwrap();
    let destination = directory.path().join("captions.srt");
    fs::write(&destination, b"old").unwrap();

    write_document(
        &authority,
        "1\n00:00:00,000 --> 00:00:01,000\n안녕하세요\n",
        &destination,
    )
    .unwrap();

    assert_eq!(
        fs::read_to_string(destination).unwrap(),
        "1\n00:00:00,000 --> 00:00:01,000\n안녕하세요\n"
    );
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn accepts_only_flat_bounded_structured_subtitle_archives() {
    let request = SubtitleArchiveExportRequest {
        suggested_name: "translated_subtitles.zip".to_owned(),
        entries: vec![
            SubtitleArchiveEntry {
                suggested_name: "captions.srt".to_owned(),
                format: SubtitleDocumentFormat::Srt,
                content: "1\n00:00:00,000 --> 00:00:01,000\nHello".to_owned(),
            },
            SubtitleArchiveEntry {
                suggested_name: "translated.json".to_owned(),
                format: SubtitleDocumentFormat::Json,
                content: "[]".to_owned(),
            },
        ],
    };
    assert!(validate_archive_request(&request).is_ok());

    let duplicate = SubtitleArchiveExportRequest {
        suggested_name: "translated_subtitles.zip".to_owned(),
        entries: vec![
            SubtitleArchiveEntry {
                suggested_name: "captions.srt".to_owned(),
                format: SubtitleDocumentFormat::Srt,
                content: "first".to_owned(),
            },
            SubtitleArchiveEntry {
                suggested_name: "CAPTIONS.SRT".to_owned(),
                format: SubtitleDocumentFormat::Srt,
                content: "second".to_owned(),
            },
        ],
    };
    assert!(validate_archive_request(&duplicate).is_err());
    let oversized = SubtitleArchiveExportRequest {
        suggested_name: "translated_subtitles.zip".to_owned(),
        entries: vec![SubtitleArchiveEntry {
            suggested_name: "captions.srt".to_owned(),
            format: SubtitleDocumentFormat::Srt,
            content: "x".repeat(MAX_DOCUMENT_BYTES + 1),
        }],
    };
    assert!(validate_archive_request(&oversized).is_err());
    assert!(is_safe_archive_name("translated_subtitles.zip"));
    assert!(!is_safe_archive_name("../translated.zip"));
}

#[test]
fn creates_a_native_zip_from_validated_entries() {
    let directory = tempfile::tempdir().unwrap();
    let authority_directory = tempfile::tempdir().unwrap();
    let authority = RuntimeStagingAuthority::prepare(authority_directory.path()).unwrap();
    let destination = directory.path().join("captions.zip");
    let entries = vec![SubtitleArchiveEntry {
        suggested_name: "captions.srt".to_owned(),
        format: SubtitleDocumentFormat::Srt,
        content: "1\n00:00:00,000 --> 00:00:01,000\n안녕하세요".to_owned(),
    }];
    write_archive(&authority, &entries, &destination).unwrap();
    let file = fs::File::open(destination).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let mut content = String::new();
    std::io::Read::read_to_string(&mut archive.by_index(0).unwrap(), &mut content).unwrap();
    assert_eq!(content, entries[0].content);
}

#[test]
fn allows_only_one_document_export_dialog_at_a_time() {
    let first = acquire_export_operation().unwrap();
    assert!(acquire_export_operation().is_err());
    drop(first);
    assert!(acquire_export_operation().is_ok());
}

#[test]
fn validates_generated_file_signatures_and_names() {
    let png = b"\x89PNG\r\n\x1a\ncontent";
    assert!(GeneratedFileFormat::Png.has_valid_signature(png));
    assert!(is_safe_generated_name(
        "background-1.png",
        GeneratedFileFormat::Png
    ));
    assert!(!is_safe_generated_name(
        "../background.png",
        GeneratedFileFormat::Png
    ));
    assert!(!GeneratedFileFormat::Png.has_valid_signature(b"not an image"));

    let mut wav = b"RIFF\0\0\0\0WAVE".to_vec();
    wav.extend_from_slice(b"data");
    assert!(GeneratedFileFormat::Wav.has_valid_signature(&wav));
    assert!(!GeneratedFileFormat::Webm.has_valid_signature(&wav));
}
