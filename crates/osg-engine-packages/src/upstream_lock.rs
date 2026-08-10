use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};
use url::Url;

use crate::catalog::{PLATFORM_KEYS, validate_identifier, validate_sha256};
use crate::path_security::validate_manifest_path;
use crate::{PackageError, Result};

const EMBEDDED_LOCK: &str = include_str!("../../osg-speech/delivery/speech-upstreams.lock.json");
const PYTHON_PACKAGE_IDS: &[&str] = &[
    "chatterbox-tts",
    "edge-tts",
    "f5-tts",
    "gTTS",
    "google-genai",
];
const MODEL_IDS: &[&str] = &["chatterbox", "f5-tts-v1-base", "f5-vocos"];
const BLOCKER_IDS: &[&str] = &[
    "chatterbox-platform-validation",
    "f5-non-commercial-model",
    "offline-worker-contract",
    "provider-terms-review",
    "transitive-wheel-lock",
];
const SPEECH_IDS: &[&str] = &["chatterbox", "edge-tts", "f5-tts", "gemini-tts", "gtts"];

pub(crate) fn validate_builtin() -> Result<()> {
    validate(EMBEDDED_LOCK)
}

fn validate(raw: &str) -> Result<()> {
    let document: Value = serde_json::from_str(raw)?;
    let root = object(&document)?;
    exact_keys(
        root,
        &[
            "blockers",
            "models",
            "policy",
            "python",
            "pythonPackages",
            "reviewedAt",
            "schemaVersion",
        ],
    )?;
    if integer(root, "schemaVersion")? != 1 || !valid_date(string(root, "reviewedAt")?) {
        return Err(PackageError::InvalidCatalog);
    }
    validate_policy(value(root, "policy")?)?;
    validate_python(value(root, "python")?)?;
    validate_python_packages(value(root, "pythonPackages")?)?;
    validate_models(value(root, "models")?)?;
    validate_blockers(value(root, "blockers")?)
}

fn validate_policy(input: &Value) -> Result<()> {
    let policy = object(input)?;
    exact_keys(
        policy,
        &[
            "networkDuringBuild",
            "networkDuringRuntime",
            "reason",
            "releaseState",
        ],
    )?;
    if string(policy, "networkDuringBuild")? != "download-only-from-this-lock"
        || string(policy, "networkDuringRuntime")? != "provider-requests-only"
        || !matches!(
            string(policy, "releaseState")?,
            "blocked" | "windows-x86_64-available"
        )
        || string(policy, "reason")?.len() < 40
    {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(())
}

fn validate_python(input: &Value) -> Result<()> {
    let python = object(input)?;
    exact_keys(
        python,
        &[
            "distribution",
            "license",
            "licenseUrl",
            "platforms",
            "release",
            "thirdPartyNoticesRequired",
            "version",
        ],
    )?;
    if string(python, "distribution")? != "astral-sh/python-build-standalone"
        || string(python, "license")? != "MPL-2.0"
        || python
            .get("thirdPartyNoticesRequired")
            .and_then(Value::as_bool)
            != Some(true)
        || !valid_version(string(python, "version")?)
        || !string(python, "release")?
            .bytes()
            .all(|byte| byte.is_ascii_digit())
        || !valid_immutable_url(string(python, "licenseUrl")?, Some("github.com"))
    {
        return Err(PackageError::InvalidCatalog);
    }
    let platforms = object(value(python, "platforms")?)?;
    exact_keys(platforms, PLATFORM_KEYS)?;
    for platform in PLATFORM_KEYS {
        let delivery = object(value(platforms, platform)?)?;
        exact_keys(delivery, &["asset", "sha256", "sizeBytes", "sourceUrl"])?;
        let asset = string(delivery, "asset")?;
        if !valid_download_name(asset)
            || !asset.ends_with(".tar.gz")
            || positive_integer(delivery, "sizeBytes").is_err()
            || validate_sha256(string(delivery, "sha256")?).is_err()
            || !valid_immutable_url(string(delivery, "sourceUrl")?, Some("github.com"))
        {
            return Err(PackageError::InvalidCatalog);
        }
    }
    Ok(())
}

fn validate_python_packages(input: &Value) -> Result<()> {
    let packages = object(input)?;
    exact_keys(packages, PYTHON_PACKAGE_IDS)?;
    for package_id in PYTHON_PACKAGE_IDS {
        let package = object(value(packages, package_id)?)?;
        let mut expected = vec![
            "license",
            "sha256",
            "sizeBytes",
            "sourceUrl",
            "version",
            "wheel",
        ];
        if matches!(*package_id, "f5-tts" | "chatterbox-tts") {
            expected.push("modelLicense");
        }
        exact_keys(package, &expected)?;
        if !valid_version(string(package, "version")?)
            || !valid_download_name(string(package, "wheel")?)
            || !std::path::Path::new(string(package, "wheel")?)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("whl"))
            || positive_integer(package, "sizeBytes").is_err()
            || validate_sha256(string(package, "sha256")?).is_err()
            || !valid_immutable_url(
                string(package, "sourceUrl")?,
                Some("files.pythonhosted.org"),
            )
            || string(package, "license")?.is_empty()
            || package
                .get("modelLicense")
                .is_some_and(|license| license.as_str().is_none_or(str::is_empty))
        {
            return Err(PackageError::InvalidCatalog);
        }
    }
    let f5 = object(value(packages, "f5-tts")?)?;
    if string(f5, "modelLicense")? != "CC-BY-NC-4.0" {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(())
}

fn validate_models(input: &Value) -> Result<()> {
    let models = object(input)?;
    exact_keys(models, MODEL_IDS)?;
    for model_id in MODEL_IDS {
        let model = object(value(models, model_id)?)?;
        let mut expected = vec!["files", "license", "repository", "revision"];
        if *model_id == "f5-tts-v1-base" {
            expected.push("commercialDistributionAllowed");
        }
        exact_keys(model, &expected)?;
        if !valid_repository(string(model, "repository")?)
            || !valid_git_revision(string(model, "revision")?)
            || string(model, "license")?.is_empty()
            || (*model_id == "f5-tts-v1-base"
                && (string(model, "license")? != "CC-BY-NC-4.0"
                    || model
                        .get("commercialDistributionAllowed")
                        .and_then(Value::as_bool)
                        != Some(false)))
        {
            return Err(PackageError::InvalidCatalog);
        }
        let files = value(model, "files")?
            .as_array()
            .filter(|files| !files.is_empty() && files.len() <= 100)
            .ok_or(PackageError::InvalidCatalog)?;
        let mut paths = HashSet::new();
        for file in files {
            let file = object(file)?;
            exact_keys(file, &["path", "sha256", "sizeBytes"])?;
            let path = string(file, "path")?;
            if validate_manifest_path(path).is_err()
                || !paths.insert(path)
                || positive_integer(file, "sizeBytes").is_err()
                || validate_sha256(string(file, "sha256")?).is_err()
            {
                return Err(PackageError::InvalidCatalog);
            }
        }
    }
    Ok(())
}

fn validate_blockers(input: &Value) -> Result<()> {
    let blockers = input
        .as_array()
        .filter(|entries| entries.len() == BLOCKER_IDS.len())
        .ok_or(PackageError::InvalidCatalog)?;
    let mut found = HashMap::new();
    for blocker in blockers {
        let blocker = object(blocker)?;
        exact_keys(blocker, &["backends", "detail", "id"])?;
        let id = string(blocker, "id")?;
        let backends = value(blocker, "backends")?
            .as_array()
            .filter(|entries| !entries.is_empty())
            .ok_or(PackageError::InvalidCatalog)?;
        let mut seen = HashSet::new();
        for backend in backends {
            let backend = backend.as_str().ok_or(PackageError::InvalidCatalog)?;
            if !SPEECH_IDS.contains(&backend) || !seen.insert(backend) {
                return Err(PackageError::InvalidCatalog);
            }
        }
        if !BLOCKER_IDS.contains(&id)
            || found.insert(id, seen).is_some()
            || string(blocker, "detail")?.len() < 40
        {
            return Err(PackageError::InvalidCatalog);
        }
    }
    if found.len() != BLOCKER_IDS.len()
        || !found
            .get("f5-non-commercial-model")
            .is_some_and(|backends| backends.contains("f5-tts"))
    {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(())
}

fn object(value: &Value) -> Result<&Map<String, Value>> {
    value.as_object().ok_or(PackageError::InvalidCatalog)
}

fn value<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a Value> {
    object.get(key).ok_or(PackageError::InvalidCatalog)
}

fn string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    value(object, key)?
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or(PackageError::InvalidCatalog)
}

fn integer(object: &Map<String, Value>, key: &str) -> Result<u64> {
    value(object, key)?
        .as_u64()
        .ok_or(PackageError::InvalidCatalog)
}

fn positive_integer(object: &Map<String, Value>, key: &str) -> Result<u64> {
    let value = integer(object, key)?;
    if value == 0 {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(value)
}

fn exact_keys(object: &Map<String, Value>, expected: &[&str]) -> Result<()> {
    if object.len() != expected.len() || object.keys().any(|key| !expected.contains(&key.as_str()))
    {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(())
}

fn valid_version(value: &str) -> bool {
    !value.to_ascii_lowercase().contains("latest")
        && validate_identifier(value).is_ok()
        && value.bytes().any(|byte| byte.is_ascii_digit())
}

fn valid_download_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+'))
}

fn valid_date(value: &str) -> bool {
    value.len() == 10
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 4 | 7) {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}

fn valid_git_revision(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_repository(value: &str) -> bool {
    let Some((owner, repository)) = value.split_once('/') else {
        return false;
    };
    !owner.is_empty()
        && !repository.is_empty()
        && !repository.contains('/')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
}

fn valid_immutable_url(value: &str, expected_host: Option<&str>) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.query().is_none()
        && url.fragment().is_none()
        && expected_host.is_none_or(|host| url.host_str() == Some(host))
        && !url.path_segments().is_some_and(|segments| {
            segments
                .into_iter()
                .any(|segment| segment.eq_ignore_ascii_case("latest"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_in_upstream_lock_is_strict_and_declares_exact_platform_availability() {
        validate_builtin().unwrap();
    }

    #[test]
    fn mutable_or_incomplete_lock_is_rejected() {
        let mut lock: Value = serde_json::from_str(EMBEDDED_LOCK).unwrap();
        lock["pythonPackages"]["edge-tts"]["sourceUrl"] =
            Value::String("https://files.pythonhosted.org/latest/edge.whl".to_string());
        assert_eq!(
            validate(&lock.to_string()),
            Err(PackageError::InvalidCatalog)
        );

        let mut lock: Value = serde_json::from_str(EMBEDDED_LOCK).unwrap();
        lock["blockers"].as_array_mut().unwrap().pop();
        assert_eq!(
            validate(&lock.to_string()),
            Err(PackageError::InvalidCatalog)
        );
    }
}
