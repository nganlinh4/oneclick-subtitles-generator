use crate::{DownloadError, Result};
use serde::Serialize;
use std::fmt;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use url::{Host, Url};

const MAX_URL_LENGTH: usize = 8_192;
const INSTALLED_MEDIA_SMOKE_HOST: &str = "github.com";
const INSTALLED_MEDIA_SMOKE_PATH: &str = "/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4";
const INSTALLED_MEDIA_SMOKE_URL: &str = "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UrlPolicy {
    /// Only known public media sites. This is the correct policy for IPC input.
    #[default]
    SupportedSitesOnly,
    /// Public Internet hosts after DNS/IP checks. This is intended only for a
    /// deliberate native workflow because a generic extractor may follow a
    /// subsequent redirect outside the initially validated host.
    NativePublicInternet,
}

pub trait AddressResolver: Clone + fmt::Debug + Send + Sync + 'static {
    fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<IpAddr>>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemResolver;

impl AddressResolver for SystemResolver {
    fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<IpAddr>> {
        (host, port)
            .to_socket_addrs()
            .map(|addresses| addresses.map(|address| address.ip()).collect())
    }
}

#[derive(Clone)]
pub struct UrlValidator<R = SystemResolver> {
    resolver: R,
    policy: UrlPolicy,
    #[cfg(feature = "e2e-automation")]
    exact_automation_urls: Vec<Url>,
}

impl UrlValidator<SystemResolver> {
    #[must_use]
    pub fn system(policy: UrlPolicy) -> Self {
        Self {
            resolver: SystemResolver,
            policy,
            #[cfg(feature = "e2e-automation")]
            exact_automation_urls: Vec::new(),
        }
    }

    /// Constructs the hidden-E2E validator with an exact allow-list of tokenized loopback URLs.
    ///
    /// This is deliberately a different constructor from [`Self::system`]. Merely compiling the
    /// automation feature cannot make a loopback URL valid, and production does not compile this
    /// constructor at all. Every allowed value must be canonical, use an explicit unprivileged
    /// port, name an MP4 media path or HTML extractor page, and carry one 256-bit token. Validation
    /// and pre-launch revalidation both require byte-for-byte membership in this list.
    #[cfg(feature = "e2e-automation")]
    pub fn system_with_exact_automation_urls(policy: UrlPolicy, values: &[String]) -> Result<Self> {
        if values.is_empty() || values.len() > 8 {
            return Err(DownloadError::InvalidUrl(
                "the automation URL allow-list is invalid",
            ));
        }
        let mut exact_automation_urls = Vec::with_capacity(values.len());
        for value in values {
            let url = parse_exact_automation_url(value)?;
            if exact_automation_urls.contains(&url) {
                return Err(DownloadError::InvalidUrl(
                    "the automation URL allow-list is invalid",
                ));
            }
            exact_automation_urls.push(url);
        }
        Ok(Self {
            resolver: SystemResolver,
            policy,
            exact_automation_urls,
        })
    }
}

impl<R: AddressResolver> UrlValidator<R> {
    #[must_use]
    pub fn new(resolver: R, policy: UrlPolicy) -> Self {
        Self {
            resolver,
            policy,
            #[cfg(feature = "e2e-automation")]
            exact_automation_urls: Vec::new(),
        }
    }

    pub fn validate(&self, value: &str) -> Result<ValidatedMediaUrl> {
        if value.len() > MAX_URL_LENGTH
            || value.contains('\\')
            || value.chars().any(char::is_control)
        {
            return Err(DownloadError::InvalidUrl("length or control characters"));
        }
        let mut url = Url::parse(value).map_err(|_| DownloadError::InvalidUrl("parse failed"))?;
        if !matches!(url.scheme(), "https" | "http") {
            return Err(DownloadError::InvalidUrl("only HTTP and HTTPS are allowed"));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(DownloadError::InvalidUrl("credentials are not allowed"));
        }
        #[cfg(feature = "e2e-automation")]
        if self.is_exact_automation_url(value, &url) {
            let direct_mp4_passthrough = has_extension(url.path(), "mp4");
            return Ok(ValidatedMediaUrl {
                url,
                direct_mp4_passthrough,
                automation_loopback: true,
            });
        }
        let expected_port = if url.scheme() == "https" { 443 } else { 80 };
        if url.port().is_some_and(|port| port != expected_port) {
            return Err(DownloadError::InvalidUrl(
                "non-default ports are not allowed",
            ));
        }
        let is_installed_media_smoke_url = is_exact_installed_media_smoke_url(value, &url);
        url.set_fragment(None);

        let host = url
            .host()
            .ok_or(DownloadError::InvalidUrl("host is missing"))?;
        match host {
            Host::Ipv4(address) => ensure_public(IpAddr::V4(address))?,
            Host::Ipv6(address) => ensure_public(IpAddr::V6(address))?,
            Host::Domain(domain) => {
                self.validate_domain(domain, expected_port, is_installed_media_smoke_url)?;
            }
        }
        Ok(ValidatedMediaUrl {
            url,
            direct_mp4_passthrough: is_installed_media_smoke_url,
            #[cfg(feature = "e2e-automation")]
            automation_loopback: false,
        })
    }

    /// Repeats DNS/IP checks immediately before process launch to narrow the
    /// DNS-rebinding window between initial UI validation and execution.
    pub(crate) fn revalidate(&self, value: &ValidatedMediaUrl) -> Result<()> {
        #[cfg(feature = "e2e-automation")]
        if value.automation_loopback {
            return self
                .is_exact_automation_url(value.url.as_str(), &value.url)
                .then_some(())
                .ok_or(DownloadError::NonPublicAddress);
        }
        let host = value
            .url
            .host()
            .ok_or(DownloadError::InvalidUrl("host is missing"))?;
        let port = if value.url.scheme() == "https" {
            443
        } else {
            80
        };
        let is_installed_media_smoke_url =
            is_exact_installed_media_smoke_url(value.url.as_str(), &value.url);
        match host {
            Host::Ipv4(address) => ensure_public(IpAddr::V4(address)),
            Host::Ipv6(address) => ensure_public(IpAddr::V6(address)),
            Host::Domain(domain) => {
                self.validate_domain(domain, port, is_installed_media_smoke_url)
            }
        }
    }

    fn validate_domain(
        &self,
        domain: &str,
        port: u16,
        is_installed_media_smoke_url: bool,
    ) -> Result<()> {
        let domain = domain.trim_end_matches('.').to_ascii_lowercase();
        if domain.is_empty()
            || !domain.contains('.')
            || domain == "localhost"
            || [".localhost", ".local", ".internal", ".home", ".lan"]
                .iter()
                .any(|suffix| domain.ends_with(suffix))
        {
            return Err(DownloadError::NonPublicAddress);
        }
        if self.policy == UrlPolicy::SupportedSitesOnly
            && !is_supported_site(&domain)
            && !is_installed_media_smoke_url
        {
            return Err(DownloadError::UnsupportedSite);
        }
        let addresses = self
            .resolver
            .resolve(&domain, port)
            .map_err(|_| DownloadError::ResolutionFailed)?;
        if addresses.is_empty() {
            return Err(DownloadError::ResolutionFailed);
        }
        for address in addresses {
            ensure_public(address)?;
        }
        Ok(())
    }

    #[cfg(feature = "e2e-automation")]
    fn is_exact_automation_url(&self, value: &str, parsed: &Url) -> bool {
        parsed.as_str() == value
            && self
                .exact_automation_urls
                .iter()
                .any(|allowed| allowed == parsed)
    }
}

impl<R: fmt::Debug> fmt::Debug for UrlValidator<R> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut debug = formatter.debug_struct("UrlValidator");
        debug
            .field("resolver", &self.resolver)
            .field("policy", &self.policy);
        #[cfg(feature = "e2e-automation")]
        debug.field(
            "exact_automation_url_count",
            &self.exact_automation_urls.len(),
        );
        debug.finish()
    }
}

#[cfg(feature = "e2e-automation")]
fn parse_exact_automation_url(value: &str) -> Result<Url> {
    if value.len() > MAX_URL_LENGTH || value.contains('\\') || value.chars().any(char::is_control) {
        return Err(DownloadError::InvalidUrl(
            "the automation URL allow-list is invalid",
        ));
    }
    let url = Url::parse(value)
        .map_err(|_| DownloadError::InvalidUrl("the automation URL allow-list is invalid"))?;
    let exact_loopback = url.as_str() == value
        && url.scheme() == "http"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host() == Some(Host::Ipv4(Ipv4Addr::LOCALHOST))
        && url.port().is_some_and(|port| port >= 1_024)
        && url.fragment().is_none()
        && ["mp4", "html"]
            .iter()
            .any(|extension| has_extension(url.path(), extension))
        && !url.path().contains("..")
        && !url.path().contains('%')
        && url.query().is_some_and(|query| !query.contains('%'));
    let query = url.query_pairs().collect::<Vec<_>>();
    let exact_token = query.len() == 1
        && query[0].0 == "token"
        && query[0].1.len() == 64
        && query[0].1.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !exact_loopback || !exact_token {
        return Err(DownloadError::InvalidUrl(
            "the automation URL allow-list is invalid",
        ));
    }
    Ok(url)
}

#[cfg(feature = "e2e-automation")]
fn has_extension(path: &str, expected: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case(expected))
}

fn is_exact_installed_media_smoke_url(value: &str, url: &Url) -> bool {
    value == INSTALLED_MEDIA_SMOKE_URL
        && url.scheme() == "https"
        && url.host_str() == Some(INSTALLED_MEDIA_SMOKE_HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == INSTALLED_MEDIA_SMOKE_PATH
        && url.query().is_none()
        && url.fragment().is_none()
}

#[derive(Clone)]
pub struct ValidatedMediaUrl {
    url: Url,
    direct_mp4_passthrough: bool,
    #[cfg(feature = "e2e-automation")]
    automation_loopback: bool,
}

impl ValidatedMediaUrl {
    #[must_use]
    pub fn host(&self) -> &str {
        self.url.host_str().unwrap_or_default()
    }

    pub(crate) fn as_str(&self) -> &str {
        self.url.as_str()
    }

    pub(crate) fn allows_direct_mp4_passthrough(&self) -> bool {
        self.direct_mp4_passthrough
    }
}

impl fmt::Debug for ValidatedMediaUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut debug = formatter.debug_struct("ValidatedMediaUrl");
        debug
            .field("scheme", &self.url.scheme())
            .field("host", &self.url.host_str().unwrap_or("<missing>"))
            .field("path_and_query", &"<redacted>")
            .field("direct_mp4_passthrough", &self.direct_mp4_passthrough);
        #[cfg(feature = "e2e-automation")]
        debug.field("automation_loopback", &self.automation_loopback);
        debug.finish()
    }
}

fn is_supported_site(host: &str) -> bool {
    const SITES: &[&str] = &[
        "youtube.com",
        "youtu.be",
        "youtube-nocookie.com",
        "tiktok.com",
        "douyin.com",
        "bilibili.com",
        "b23.tv",
        "vimeo.com",
        "dailymotion.com",
        "soundcloud.com",
        "twitch.tv",
        "twitter.com",
        "x.com",
        "instagram.com",
        "facebook.com",
        "fb.watch",
    ];
    SITES.iter().any(|site| {
        host == *site
            || host
                .strip_suffix(site)
                .is_some_and(|prefix| prefix.ends_with('.'))
    })
}

fn ensure_public(address: IpAddr) -> Result<()> {
    let public = match address {
        IpAddr::V4(address) => is_public_v4(address),
        IpAddr::V6(address) => is_public_v6(address),
    };
    public.then_some(()).ok_or(DownloadError::NonPublicAddress)
}

fn is_public_v4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !matches!(
        (a, b, c),
        (0 | 10 | 127 | 224..=255, _, _)
            | (100, 64..=127, _)
            | (169, 254, _)
            | (172, 16..=31, _)
            | (192, 0, 0 | 2)
            | (192, 88, 99)
            | (192, 168, _)
            | (198, 18..=19, _)
            | (198, 51, 100)
            | (203, 0, 113)
    )
}

fn is_public_v6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_public_v4(mapped);
    }
    let segments = address.segments();
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || segments[..6] == [0, 0, 0, 0, 0, 0]
        || segments[0] & 0xfe00 == 0xfc00
        || segments[0] & 0xffc0 == 0xfe80
        || segments[0] & 0xffc0 == 0xfec0
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

#[cfg(test)]
mod tests {
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
}
