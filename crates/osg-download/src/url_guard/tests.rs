use super::*;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone, Debug, Default)]
struct MockResolver(Arc<HashMap<String, Vec<IpAddr>>>);

impl MockResolver {
    fn with(host: &str, addresses: Vec<IpAddr>) -> Self {
        Self(Arc::new(HashMap::from([(host.to_owned(), addresses)])))
    }
}

impl AddressResolver for MockResolver {
    fn resolve(&self, host: &str, _port: u16) -> io::Result<Vec<IpAddr>> {
        self.0
            .get(host)
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "mock DNS miss"))
    }
}

fn youtube(addresses: Vec<IpAddr>) -> UrlValidator<MockResolver> {
    UrlValidator::new(
        MockResolver::with("www.youtube.com", addresses),
        UrlPolicy::SupportedSitesOnly,
    )
}

fn installed_media_smoke(addresses: Vec<IpAddr>) -> UrlValidator<MockResolver> {
    UrlValidator::new(
        MockResolver::with(INSTALLED_MEDIA_SMOKE_HOST, addresses),
        UrlPolicy::SupportedSitesOnly,
    )
}

#[test]
fn accepts_supported_public_https_url_and_redacts_debug() {
    let url = youtube(vec![IpAddr::V4(Ipv4Addr::new(142, 250, 1, 1))])
        .validate("https://www.youtube.com/watch?v=secret-token#fragment")
        .unwrap();
    let debug = format!("{url:?}");
    assert!(debug.contains("youtube.com"));
    assert!(!debug.contains("secret-token"));
}

#[test]
fn accepts_exact_installed_media_smoke_url_and_revalidates_dns() {
    let validator = installed_media_smoke(vec![IpAddr::V4(Ipv4Addr::new(140, 82, 112, 4))]);
    let url = validator.validate(INSTALLED_MEDIA_SMOKE_URL).unwrap();

    assert_eq!(url.host(), INSTALLED_MEDIA_SMOKE_HOST);
    validator.revalidate(&url).unwrap();
}

#[test]
fn rejects_installed_media_smoke_url_near_misses() {
    let validator = installed_media_smoke(vec![IpAddr::V4(Ipv4Addr::new(140, 82, 112, 4))]);
    for hostile in [
        "http://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
        "https://GitHub.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
        "https://github.com./nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
        "https://www.github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
        "https://user@github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
        "https://github.com:443/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
        "https://github.com/nganlinh4/other-repository/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
        "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/other-tag/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
        "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/other-asset.mp4",
        "https://github.com/Nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
        "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/OSG-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
        "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4?download=1",
        "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4#fragment",
        "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4/",
    ] {
        assert!(validator.validate(hostile).is_err(), "accepted {hostile}");
    }
}

#[test]
fn exact_installed_media_smoke_url_still_rejects_non_public_dns() {
    let validator = installed_media_smoke(vec![
        IpAddr::V4(Ipv4Addr::new(140, 82, 112, 4)),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
    ]);

    assert!(matches!(
        validator.validate(INSTALLED_MEDIA_SMOKE_URL),
        Err(DownloadError::NonPublicAddress)
    ));
}

#[test]
fn rejects_schemes_credentials_ports_and_lookalike_hosts() {
    let validator = youtube(vec![IpAddr::V4(Ipv4Addr::new(142, 250, 1, 1))]);
    for hostile in [
        "file:///etc/passwd",
        "ftp://youtube.com/video",
        "https://user:password@youtube.com/video",
        "https://youtube.com:444/video",
        "https://youtube.com.evil.example/video",
        "https://evil-youtube.com/video",
        "https://youtube.com\\@127.0.0.1/video",
    ] {
        assert!(validator.validate(hostile).is_err(), "accepted {hostile}");
    }
}

#[test]
fn rejects_literal_local_private_link_local_and_encoded_loopback() {
    let validator = UrlValidator::new(MockResolver::default(), UrlPolicy::NativePublicInternet);
    for hostile in [
        "http://localhost/video",
        "http://127.0.0.1/video",
        "http://10.0.0.1/video",
        "http://169.254.169.254/latest/meta-data",
        "http://192.168.1.1/video",
        "http://[::1]/video",
        "http://[fe80::1]/video",
        "http://[fc00::1]/video",
        "http://[fec0::1]/video",
        "http://[::ffff:127.0.0.1]/video",
        "http://[::192.168.1.1]/video",
        "http://2130706433/video",
        "http://0x7f000001/video",
        "http://0177.0.0.1/video",
    ] {
        assert!(validator.validate(hostile).is_err(), "accepted {hostile}");
    }
}

#[test]
fn ordinary_validator_rejects_loopback_even_in_an_automation_capable_build() {
    let validator = UrlValidator::system(UrlPolicy::SupportedSitesOnly);
    assert!(matches!(
        validator.validate(
            "http://127.0.0.1:43123/a.mp4?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ),
        Err(DownloadError::InvalidUrl(_) | DownloadError::NonPublicAddress)
    ));
}

#[cfg(feature = "e2e-automation")]
#[test]
fn automation_validator_accepts_only_its_canonical_tokenized_exact_urls() {
    const FIRST: &str = "http://127.0.0.1:43123/a.mp4?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SECOND: &str = "http://127.0.0.1:43123/b.mp4?token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const PAGE: &str = "http://127.0.0.1:43123/multi.html?token=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    let values = vec![FIRST.to_owned(), SECOND.to_owned(), PAGE.to_owned()];
    let validator =
        UrlValidator::system_with_exact_automation_urls(UrlPolicy::SupportedSitesOnly, &values)
            .expect("exact automation validator");

    for value in [FIRST, SECOND] {
        let validated = validator.validate(value).expect("allowed exact URL");
        assert!(validated.allows_direct_mp4_passthrough());
        validator
            .revalidate(&validated)
            .expect("exact revalidation");
    }
    let page = validator.validate(PAGE).expect("allowed exact HTML page");
    assert!(!page.allows_direct_mp4_passthrough());
    validator
        .revalidate(&page)
        .expect("exact page revalidation");

    for near_miss in [
        "http://127.0.0.1:43123/c.mp4?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "http://127.0.0.1:43124/a.mp4?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "http://127.0.0.1:43123/a.mp4?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab",
        "http://127.0.0.1:43123/a.mp4?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&extra=1",
        "http://127.0.0.1:43123/a.mp4?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#fragment",
        "http://localhost:43123/a.mp4?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "http://127.0.0.1:43123/multi.js?token=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    ] {
        assert!(
            validator.validate(near_miss).is_err(),
            "accepted {near_miss}"
        );
    }

    let debug = format!("{validator:?}");
    assert!(debug.contains("exact_automation_url_count"));
    assert!(!debug.contains("43123"));
    assert!(!debug.contains("aaaaaaaa"));
    assert!(!debug.contains("a.mp4"));
}

#[cfg(feature = "e2e-automation")]
#[test]
fn automation_allow_list_rejects_malformed_or_duplicated_capabilities() {
    const EXACT: &str = "http://127.0.0.1:43123/a.mp4?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let encoded_token = format!("http://127.0.0.1:43123/a.mp4?token=%61{}", "a".repeat(63));
    for invalid in [
        Vec::<String>::new(),
        vec![EXACT.to_owned(), EXACT.to_owned()],
        vec!["http://127.0.0.1:80/a.mp4?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned()],
        vec!["http://127.0.0.1:43123/a.mp4?token=short".to_owned()],
        vec!["http://127.0.0.1:43123/a.webm?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned()],
        vec!["http://127.0.0.1:43123/%61.mp4?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned()],
        vec![encoded_token],
    ] {
        assert!(
            UrlValidator::system_with_exact_automation_urls(
                UrlPolicy::SupportedSitesOnly,
                &invalid,
            )
            .is_err(),
            "accepted {invalid:?}"
        );
    }
}

#[test]
fn rejects_public_name_when_any_dns_answer_is_private() {
    let validator = youtube(vec![
        IpAddr::V4(Ipv4Addr::new(142, 250, 1, 1)),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
    ]);
    assert!(matches!(
        validator.validate("https://www.youtube.com/watch?v=x"),
        Err(DownloadError::NonPublicAddress)
    ));
}
