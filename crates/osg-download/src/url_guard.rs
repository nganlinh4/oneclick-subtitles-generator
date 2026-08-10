use crate::{DownloadError, Result};
use serde::Serialize;
use std::fmt;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use url::{Host, Url};

const MAX_URL_LENGTH: usize = 8_192;

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

#[derive(Clone, Debug)]
pub struct UrlValidator<R = SystemResolver> {
    resolver: R,
    policy: UrlPolicy,
}

impl UrlValidator<SystemResolver> {
    #[must_use]
    pub fn system(policy: UrlPolicy) -> Self {
        Self {
            resolver: SystemResolver,
            policy,
        }
    }
}

impl<R: AddressResolver> UrlValidator<R> {
    #[must_use]
    pub fn new(resolver: R, policy: UrlPolicy) -> Self {
        Self { resolver, policy }
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
        let expected_port = if url.scheme() == "https" { 443 } else { 80 };
        if url.port().is_some_and(|port| port != expected_port) {
            return Err(DownloadError::InvalidUrl(
                "non-default ports are not allowed",
            ));
        }
        url.set_fragment(None);

        let host = url
            .host()
            .ok_or(DownloadError::InvalidUrl("host is missing"))?;
        match host {
            Host::Ipv4(address) => ensure_public(IpAddr::V4(address))?,
            Host::Ipv6(address) => ensure_public(IpAddr::V6(address))?,
            Host::Domain(domain) => self.validate_domain(domain, expected_port)?,
        }
        Ok(ValidatedMediaUrl { url })
    }

    /// Repeats DNS/IP checks immediately before process launch to narrow the
    /// DNS-rebinding window between initial UI validation and execution.
    pub(crate) fn revalidate(&self, value: &ValidatedMediaUrl) -> Result<()> {
        let host = value
            .url
            .host()
            .ok_or(DownloadError::InvalidUrl("host is missing"))?;
        let port = if value.url.scheme() == "https" {
            443
        } else {
            80
        };
        match host {
            Host::Ipv4(address) => ensure_public(IpAddr::V4(address)),
            Host::Ipv6(address) => ensure_public(IpAddr::V6(address)),
            Host::Domain(domain) => self.validate_domain(domain, port),
        }
    }

    fn validate_domain(&self, domain: &str, port: u16) -> Result<()> {
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
        if self.policy == UrlPolicy::SupportedSitesOnly && !is_supported_site(&domain) {
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
}

#[derive(Clone)]
pub struct ValidatedMediaUrl {
    url: Url,
}

impl ValidatedMediaUrl {
    #[must_use]
    pub fn host(&self) -> &str {
        self.url.host_str().unwrap_or_default()
    }

    pub(crate) fn as_str(&self) -> &str {
        self.url.as_str()
    }
}

impl fmt::Debug for ValidatedMediaUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ValidatedMediaUrl")
            .field("scheme", &self.url.scheme())
            .field("host", &self.url.host_str().unwrap_or("<missing>"))
            .field("path_and_query", &"<redacted>")
            .finish()
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
