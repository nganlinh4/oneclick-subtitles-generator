use super::*;
use crate::{AddressResolver, UrlPolicy, UrlValidator};
use std::collections::BTreeSet;
use std::io;
use std::net::{IpAddr, Ipv4Addr};

#[derive(Clone, Debug)]
struct PublicDns;

impl AddressResolver for PublicDns {
    fn resolve(&self, _host: &str, _port: u16) -> io::Result<Vec<IpAddr>> {
        Ok(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))])
    }
}

fn url(value: &str) -> ValidatedMediaUrl {
    UrlValidator::new(PublicDns, UrlPolicy::SupportedSitesOnly)
        .validate(value)
        .unwrap()
}

#[cfg(feature = "e2e-automation")]
fn exact_automation_page() -> ValidatedMediaUrl {
    const PAGE: &str = "http://127.0.0.1:43123/multi.html?token=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    UrlValidator::system_with_exact_automation_urls(
        UrlPolicy::SupportedSitesOnly,
        &[PAGE.to_owned()],
    )
    .unwrap()
    .validate(PAGE)
    .unwrap()
}

#[cfg(feature = "e2e-automation")]
#[test]
fn exact_automation_html_page_accepts_only_bounded_mp4_rungs() {
    let inventory = MediaInventory::from_json(
        &exact_automation_page(),
        br#"{
              "title":"fixture", "_type":"video", "format_id":"480p",
              "formats":[
                {"format_id":"180p","ext":"mp4","height":180,"vcodec":null,"acodec":null},
                {"format_id":"480p","ext":"mp4","height":480,"vcodec":null,"acodec":null},
                {"format_id":"hostile","ext":"webm","height":720,"vcodec":null,"acodec":null},
                {"format_id":"unbounded","ext":"mp4","vcodec":null,"acodec":null}
              ]
            }"#,
    )
    .unwrap();

    assert_eq!(inventory.formats.video.len(), 2);
    assert!(
        inventory
            .formats
            .video
            .iter()
            .all(|format| format.includes_audio)
    );
    assert_eq!(
        inventory
            .formats
            .qualities
            .iter()
            .map(|quality| quality.height)
            .collect::<Vec<_>>(),
        vec![480, 180]
    );
}

#[test]
fn parses_only_path_free_typed_inventory() {
    let json = br#"{
          "title":"../A video", "duration":12.4, "_filename":"C:/secret/raw.mp4",
          "formats":[
            {"format_id":"137","ext":"mp4","width":1920,"height":1080,"fps":29.97,"vcodec":"avc1.640028","acodec":"none","filesize":1000},
            {"format_id":"22","ext":"mp4","height":720,"vcodec":"avc1","acodec":"mp4a","tbr":900},
            {"format_id":"bad/best","ext":"mp4","height":9999,"vcodec":"x","acodec":"none"},
            {"format_id":"140","ext":"m4a","vcodec":"none","acodec":"mp4a.40.2","abr":128}
          ],
          "subtitles":{"en":[{"ext":"vtt","url":"https://secret"}]},
          "automatic_captions":{"ko-KR":[{"ext":"json3"}]},
          "description":"secret description"
        }"#;
    let inventory =
        MediaInventory::from_json(&url("https://youtube.com/watch?v=secret"), json).unwrap();
    assert_eq!(inventory.formats.video.len(), 2);
    assert_eq!(inventory.formats.audio.len(), 1);
    assert_eq!(inventory.formats.qualities[0].height, 1080);
    assert_eq!(inventory.subtitles.len(), 2);
    let serialized = serde_json::to_string(&inventory).unwrap();
    assert!(!serialized.contains("secret"));
    assert!(!serialized.contains("url"));
    assert!(!serialized.contains("filename"));
    assert!(serialized.contains(r#""formatId":"137""#));
    assert!(serialized.contains(r#""container":"mp4""#));
    assert!(serialized.contains(r#""includesAudio":false"#));
    assert!(serialized.contains(r#""source":"automatic""#));
    let debug = format!("{inventory:?}");
    assert!(!debug.contains("secret"));
    assert!(debug.contains("<redacted>"));
}

#[test]
fn accepts_only_bounded_direct_mp4_inventory_without_serializing_source_fields() {
    let source = url(
        "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/\
         osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
    );
    let inventory = MediaInventory::from_json(
        &source,
        br#"{
              "title":"fixture", "direct":true, "_type":"video",
              "format_id":"0", "ext":"unknown_video",
              "url":"https://redirected.invalid/private", "_filename":"C:/private/media.mp4"
            }"#,
    )
    .unwrap();
    assert_eq!(inventory.direct_mp4_format_id(), Some("0"));
    assert_eq!(inventory.formats.video.len(), 1);
    assert!(inventory.formats.audio.is_empty());
    assert!(inventory.formats.qualities.is_empty());
    let format = &inventory.formats.video[0];
    assert_eq!(format.format_id, "0");
    assert_eq!(format.container, FormatContainer::Other);
    assert!(format.includes_audio);
    assert_eq!(format.width, None);
    assert_eq!(format.height, None);
    assert_eq!(format.codec, None);

    let serialized_value = serde_json::to_value(&inventory).unwrap();
    assert_eq!(
        serialized_value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["durationSeconds", "formats", "subtitles", "title"])
    );
    let serialized = serialized_value.to_string();
    assert!(!serialized.contains("redirected"));
    assert!(!serialized.contains("private"));
    assert!(!serialized.contains("filename"));
    assert!(!serialized.contains("http"));
    assert!(serialized.contains(r#""formatId":"0""#));
}

#[test]
fn accepts_current_yt_dlp_generic_direct_shape_with_synthetic_formats() {
    let source = url(
        "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/\
         osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
    );
    let inventory = MediaInventory::from_json(
        &source,
        br#"{
              "title":"fixture", "direct":true, "_type":"video",
              "format_id":"mp4", "ext":"mp4", "vcodec":null, "acodec":null,
              "formats":[{
                "format_id":"mp4", "ext":"mp4", "protocol":"http",
                "vcodec":null, "video_ext":"mp4", "audio_ext":"none",
                "url":"https://redirected.invalid/private"
              }]
            }"#,
    )
    .unwrap();

    assert_eq!(inventory.direct_mp4_format_id(), Some("mp4"));
    assert_eq!(inventory.formats.video.len(), 1);
    assert_eq!(inventory.formats.video[0].format_id, "mp4");
    assert!(inventory.formats.video[0].includes_audio);
    assert!(inventory.formats.audio.is_empty());
}

#[test]
fn rejects_unbounded_or_masquerading_direct_inventory() {
    let mp4 = url(
        "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/\
         osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
    );
    let invalid = [
        br#"{"direct":false,"_type":"video","format_id":"0"}"#.as_slice(),
        br#"{"direct":true,"_type":"audio","format_id":"0"}"#.as_slice(),
        br#"{"direct":true,"_type":"video","format_id":"bad/id"}"#.as_slice(),
        br#"{"direct":true,"_type":"video"}"#.as_slice(),
        br#"{"direct":true,"_type":"video","format_id":"0","formats":null}"#.as_slice(),
        br#"{"direct":true,"_type":"video","format_id":"0","formats":[]}"#.as_slice(),
        br#"{"direct":true,"_type":"video","format_id":"0","formats":[null]}"#.as_slice(),
        br#"{"direct":true,"_type":"video","format_id":"0","formats":[{}]}"#.as_slice(),
        br#"{"direct":true,"_type":"video","format_id":"0","formats":[{"format_id":"other"}]}"#.as_slice(),
        br#"{"direct":true,"_type":"video","format_id":"0","formats":[{"format_id":"0"},{"format_id":"0"}]}"#.as_slice(),
        br#"{"direct":true,"_type":"video","format_id":"0","ext":"mp4","formats":[{"format_id":"0","ext":"webm"}]}"#.as_slice(),
        br#"{"direct":true,"_type":"video","format_id":"0","formats":[{"format_id":"0","protocol":"file"}]}"#.as_slice(),
        br#"{"direct":true,"_type":"video","format_id":"0","formats":[{"format_id":"0","vcodec":"none"}]}"#.as_slice(),
        br#"{"direct":true,"_type":"video","format_id":"0","formats":[{"format_id":"0","video_ext":"none"}]}"#.as_slice(),
    ];
    for json in invalid {
        assert!(MediaInventory::from_json(&mp4, json).is_err());
    }
    let oversized = format!(
        r#"{{"direct":true,"_type":"video","format_id":"{}"}}"#,
        "a".repeat(65)
    );
    assert!(MediaInventory::from_json(&mp4, oversized.as_bytes()).is_err());

    for unapproved in [
        url("https://youtube.com/watch?v=direct"),
        url("https://youtube.com/media.MP4"),
    ] {
        assert!(
            MediaInventory::from_json(
                &unapproved,
                br#"{"direct":true,"_type":"video","format_id":"0"}"#,
            )
            .is_err()
        );
    }

    let unapproved = url("https://youtube.com/watch?v=direct");
    assert!(
        MediaInventory::from_json(
            &unapproved,
            br#"{
                  "direct":true,"_type":"video","format_id":"mp4","ext":"mp4",
                  "formats":[{
                    "format_id":"decoy","ext":"mp4","vcodec":"h264","acodec":"aac"
                  }]
                }"#,
        )
        .is_err(),
        "a synthetic usable format must not bypass the approved direct-media capability"
    );
}

#[test]
fn selections_are_bound_to_the_inspected_url() {
    let json = br#"{"formats":[{"format_id":"18","ext":"mp4","height":360,"vcodec":"h264","acodec":"aac"}]}"#;
    let first = MediaInventory::from_json(&url("https://youtube.com/watch?v=one"), json).unwrap();
    let second = MediaInventory::from_json(&url("https://youtube.com/watch?v=two"), json).unwrap();
    assert_ne!(first.binding(), second.binding());
    assert_eq!(
        first.select_format("18").unwrap().binding(),
        first.binding()
    );
    assert!(first.select_format("18/bestaudio").is_err());
}
