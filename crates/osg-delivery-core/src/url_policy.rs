//! Structural URL checks shared by every catalog's host allowlist.

use url::Url;

pub const MAX_REDIRECTS: usize = 5;

/// HTTPS on the default port with no credentials or fragment. Redirect targets may carry a
/// query (signed CDN URLs do); catalog URLs must also pass [`is_immutable_https`].
#[must_use]
pub fn is_pinned_https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.fragment().is_none()
        && url.host_str().is_some()
}

/// A reviewed catalog URL: pinned HTTPS with no query string, spelled exactly as declared.
#[must_use]
pub fn is_immutable_https(url: &Url, declared: &str) -> bool {
    url.as_str() == declared && is_pinned_https(url) && url.query().is_none()
}

/// Admits a redirect only within `MAX_REDIRECTS` hops, when the request started from an
/// immutable HTTPS URL, and when `allowed(initial, target)` pairs the target with that origin.
#[must_use]
pub fn redirect_allowed(url: &Url, previous: &[Url], allowed: fn(&Url, &Url) -> bool) -> bool {
    let Some(first) = previous.first() else {
        return false;
    };
    previous.len() < MAX_REDIRECTS
        && is_pinned_https(first)
        && first.query().is_none()
        && is_pinned_https(url)
        && allowed(first, url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn same_host(first: &Url, target: &Url) -> bool {
        first.host_str() == target.host_str()
    }

    #[test]
    fn immutable_urls_reject_credentials_ports_queries_and_fragments() {
        let good = "https://github.com/owner/repo/releases/download/v1/asset.zip";
        assert!(is_immutable_https(&Url::parse(good).unwrap(), good));
        for invalid in [
            "http://github.com/a",
            "https://user:pass@github.com/a",
            "https://github.com:8443/a",
            "https://github.com/a?b=c",
            "https://github.com/a#b",
        ] {
            assert!(
                !is_immutable_https(&Url::parse(invalid).unwrap(), invalid),
                "{invalid}"
            );
        }
        let normalized = "https://github.com/a/../b";
        assert!(!is_immutable_https(
            &Url::parse(normalized).unwrap(),
            normalized
        ));
    }

    #[test]
    fn redirects_are_bounded_paired_and_require_a_clean_origin() {
        let first = Url::parse("https://example.org/file").unwrap();
        let target = Url::parse("https://example.org/signed?token=1").unwrap();
        assert!(redirect_allowed(
            &target,
            std::slice::from_ref(&first),
            same_host
        ));
        assert!(!redirect_allowed(&target, &[], same_host));
        let foreign = Url::parse("https://example.net/file").unwrap();
        assert!(!redirect_allowed(
            &foreign,
            std::slice::from_ref(&first),
            same_host
        ));
        let downgrade = Url::parse("http://example.org/file").unwrap();
        assert!(!redirect_allowed(
            &downgrade,
            std::slice::from_ref(&first),
            same_host
        ));
        let chain = vec![first; MAX_REDIRECTS];
        assert!(!redirect_allowed(&target, &chain, same_host));
    }
}
