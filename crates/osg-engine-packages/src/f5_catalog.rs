//! The reviewed catalog of F5-TTS language checkpoints: pinned Hugging Face revisions, exact
//! sizes and SHA-256 digests, and the file names the speech worker loads.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::catalog::{
    DeliveryAsset, MAX_ARCHIVE_BYTES, is_asset_name, valid_delivery_url, validate_identifier,
    validate_sha256,
};
use crate::path_security::validate_relative_path;
use crate::{PackageError, Result};

const EMBEDDED_CATALOG: &str = include_str!("../delivery/f5-models.delivery.json");
const MAX_MODELS: usize = 32;
const MAX_LABEL_BYTES: usize = 80;
const ARCHITECTURES: [&str; 2] = ["F5TTS_Base", "F5TTS_v1_Base"];
pub(crate) const RECEIPT_NAME: &str = "receipt.json";

/// What the UI may show about one language checkpoint. Contains no URLs or paths.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct F5ModelInfo {
    pub id: String,
    pub name: String,
    pub author: String,
    pub language: String,
    pub license: String,
    pub revision: String,
    pub architecture: String,
    pub download_bytes: u64,
}

#[derive(Debug)]
pub(crate) struct F5ModelFile {
    pub(crate) path: String,
    pub(crate) asset: DeliveryAsset,
}

#[derive(Debug)]
pub(crate) struct F5Model {
    pub(crate) id: String,
    pub(crate) revision: String,
    pub(crate) checkpoint: F5ModelFile,
    pub(crate) vocabulary: F5ModelFile,
}

impl F5Model {
    pub(crate) fn files(&self) -> [&F5ModelFile; 2] {
        [&self.checkpoint, &self.vocabulary]
    }

    pub(crate) fn download_bytes(&self) -> u64 {
        self.checkpoint.asset.size_bytes + self.vocabulary.asset.size_bytes
    }
}

#[derive(Debug)]
pub(crate) struct F5Catalog {
    pub(crate) info: Vec<F5ModelInfo>,
    pub(crate) models: Vec<F5Model>,
}

impl F5Catalog {
    pub(crate) fn builtin() -> Result<&'static Self> {
        static CATALOG: LazyLock<Result<F5Catalog>> =
            LazyLock::new(|| parse_catalog(EMBEDDED_CATALOG));
        CATALOG.as_ref().map_err(Clone::clone)
    }

    pub(crate) fn model(&self, id: &str) -> Result<&F5Model> {
        self.models
            .iter()
            .find(|model| model.id == id)
            .ok_or(PackageError::InvalidRequest)
    }
}

/// Every reviewed F5 language checkpoint, in catalog order.
pub fn f5_model_catalog() -> Result<&'static [F5ModelInfo]> {
    Ok(&F5Catalog::builtin()?.info)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCatalog {
    schema_version: u32,
    commands: RawCommands,
    models: Vec<RawModel>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCommands {
    status: String,
    install: String,
    cancel: String,
    remove: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawModel {
    id: String,
    name: String,
    author: String,
    language: String,
    license: String,
    revision: String,
    architecture: String,
    checkpoint: RawFile,
    vocabulary: RawFile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawFile {
    path: String,
    asset: String,
    urls: Vec<String>,
    size_bytes: u64,
    sha256: String,
}

pub(crate) fn parse_catalog(raw: &str) -> Result<F5Catalog> {
    let raw: RawCatalog = serde_json::from_str(raw)?;
    if raw.schema_version != 1
        || raw.commands.status != "f5_models_status"
        || raw.commands.install != "f5_model_install"
        || raw.commands.cancel != "f5_model_cancel"
        || raw.commands.remove != "f5_model_remove"
        || raw.models.is_empty()
        || raw.models.len() > MAX_MODELS
    {
        return Err(PackageError::InvalidCatalog);
    }
    let mut ids = HashSet::new();
    let mut catalog = F5Catalog {
        info: Vec::with_capacity(raw.models.len()),
        models: Vec::with_capacity(raw.models.len()),
    };
    for model in raw.models {
        if !ids.insert(model.id.clone()) {
            return Err(PackageError::InvalidCatalog);
        }
        let model = validate_model(model)?;
        catalog.info.push(model.0);
        catalog.models.push(model.1);
    }
    Ok(catalog)
}

fn validate_model(raw: RawModel) -> Result<(F5ModelInfo, F5Model)> {
    validate_identifier(&raw.id)?;
    if !osg_delivery_core::identity::is_git_revision(&raw.revision)
        || !ARCHITECTURES.contains(&raw.architecture.as_str())
        || raw.language.len() != 2
        || !raw.language.bytes().all(|byte| byte.is_ascii_lowercase())
        || ![&raw.name, &raw.author, &raw.license]
            .iter()
            .all(|label| valid_label(label))
    {
        return Err(PackageError::InvalidCatalog);
    }
    let checkpoint = validate_file(raw.checkpoint, &raw.revision)?;
    let vocabulary = validate_file(raw.vocabulary, "")?;
    let checkpoint_named = std::path::Path::new(&checkpoint.path)
        .extension()
        .is_some_and(|extension| extension == "safetensors" || extension == "pt");
    if !checkpoint_named || vocabulary.path != "vocab.txt" {
        return Err(PackageError::InvalidCatalog);
    }
    let model = F5Model {
        id: raw.id,
        revision: raw.revision,
        checkpoint,
        vocabulary,
    };
    let info = F5ModelInfo {
        id: model.id.clone(),
        name: raw.name,
        author: raw.author,
        language: raw.language,
        license: raw.license,
        revision: model.revision.clone(),
        architecture: raw.architecture,
        download_bytes: model.download_bytes(),
    };
    Ok((info, model))
}

/// `pinned_revision` is the model's own revision the file must come from, or empty when the
/// file is a shared asset from another reviewed repository revision.
fn validate_file(raw: RawFile, pinned_revision: &str) -> Result<F5ModelFile> {
    validate_relative_path(&raw.path)?;
    validate_sha256(&raw.sha256)?;
    if raw.path.contains('/')
        || raw.path == RECEIPT_NAME
        || !is_asset_name(&raw.asset)
        || raw.size_bytes == 0
        || raw.size_bytes > MAX_ARCHIVE_BYTES
        || raw.urls.is_empty()
        || raw.urls.len() > 2
        || raw.urls.iter().any(|url| {
            !url.starts_with("https://huggingface.co/")
                || !valid_delivery_url(url, &raw.asset)
                || (!pinned_revision.is_empty()
                    && !url.contains(&format!("/resolve/{pinned_revision}/")))
        })
    {
        return Err(PackageError::InvalidCatalog);
    }
    Ok(F5ModelFile {
        path: raw.path,
        asset: DeliveryAsset {
            asset: raw.asset,
            urls: raw.urls,
            size_bytes: raw.size_bytes,
            sha256: raw.sha256,
        },
    })
}

fn valid_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_LABEL_BYTES
        && value.bytes().all(|byte| (b' '..=b'~').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_in_catalog_is_closed_unique_and_content_addressed() {
        let catalog = F5Catalog::builtin().unwrap();
        assert_eq!(catalog.models.len(), 8);
        for model in &catalog.models {
            assert!(model.checkpoint.asset.size_bytes > 1_000_000_000);
            assert!(
                model.checkpoint.asset.urls[0].contains(&model.revision),
                "{}",
                model.id
            );
        }
        let polish = catalog.model("f5tts-polish").unwrap();
        assert_eq!(polish.checkpoint.path, "model.pt");
        assert_eq!(polish.download_bytes(), 3_383_863_925 + 13_800);
        assert!(catalog.model("f5tts-klingon").is_err());
    }

    #[test]
    fn unreviewed_hosts_mutable_revisions_and_unsafe_names_are_rejected() {
        let good = EMBEDDED_CATALOG;
        let spanish_revision = "4765c14ffd01075479c2fde8615831acc0adca9a";
        for (from, to) in [
            (
                "https://huggingface.co/jpgallegoar",
                "https://example.com/jpgallegoar",
            ),
            (
                &format!("resolve/{spanish_revision}/model_1250000"),
                "resolve/main/model_1250000",
            ),
            (
                "\"path\": \"model.safetensors\"",
                "\"path\": \"../model.safetensors\"",
            ),
            ("\"path\": \"vocab.txt\"", "\"path\": \"receipt.json\""),
            ("\"F5TTS_Base\"", "\"F5TTS_Unknown\""),
            ("\"f5_model_remove\"", "\"remove_anything\""),
        ] {
            let tampered = good.replacen(from, to, 1);
            assert_ne!(tampered, good, "{from}");
            assert!(parse_catalog(&tampered).is_err(), "{from}");
        }
        let duplicated = good.replace("\"f5tts-russian\"", "\"f5tts-spanish\"");
        assert!(parse_catalog(&duplicated).is_err());
    }
}
