use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{State, ipc::Channel};

use crate::error::{CommandError, CommandResult};
use crate::speech::SpeechRuntime;

#[derive(Clone, Copy)]
struct Asset {
    name: &'static str,
    url: &'static str,
    bytes: u64,
    sha256: &'static str,
}

#[derive(Clone, Copy)]
struct Model {
    id: &'static str,
    name: &'static str,
    author: &'static str,
    language: &'static str,
    license: &'static str,
    revision: &'static str,
    architecture: &'static str,
    checkpoint: Asset,
    vocabulary: Asset,
}

const BASE_VOCAB: Asset = Asset {
    name: "vocab.txt",
    url: "https://huggingface.co/SWivid/F5-TTS/resolve/84e5a410d9cead4de2f847e7c9369a6440bdfaca/F5TTS_v1_Base/vocab.txt",
    bytes: 13_800,
    sha256: "2a05f992e00af9b0bd3800a8d23e78d520dbd705284ed2eedb5f4bd29398fa3c",
};

const MODELS: &[Model] = &[
    Model {
        id: "f5tts-spanish",
        name: "F5 Spanish",
        author: "jpgallegoar",
        language: "es",
        license: "CC-BY-NC-4.0",
        revision: "4765c14ffd01075479c2fde8615831acc0adca9a",
        architecture: "F5TTS_Base",
        checkpoint: Asset {
            name: "model.safetensors",
            url: "https://huggingface.co/jpgallegoar/F5-Spanish/resolve/4765c14ffd01075479c2fde8615831acc0adca9a/model_1250000.safetensors",
            bytes: 1_348_435_761,
            sha256: "9cd5757a92c0b979e9769558fea922243c4916090ad93dd2c595b73e6f05a3b2",
        },
        vocabulary: Asset {
            name: "vocab.txt",
            url: "https://huggingface.co/jpgallegoar/F5-Spanish/resolve/4765c14ffd01075479c2fde8615831acc0adca9a/vocab.txt",
            bytes: 13_800,
            sha256: "2a05f992e00af9b0bd3800a8d23e78d520dbd705284ed2eedb5f4bd29398fa3c",
        },
    },
    Model {
        id: "f5tts-russian",
        name: "F5 Russian",
        author: "Misha24-10",
        language: "ru",
        license: "CC-BY-NC-4.0",
        revision: "ea166adeae4c80ec5ee423a671e2bdb83906cf84",
        architecture: "F5TTS_v1_Base",
        checkpoint: Asset {
            name: "model.safetensors",
            url: "https://huggingface.co/Misha24-10/F5-TTS_RUSSIAN/resolve/ea166adeae4c80ec5ee423a671e2bdb83906cf84/F5TTS_v1_Base/model_240000_inference.safetensors",
            bytes: 1_348_435_761,
            sha256: "376c29a569c691375a4cd19b8254497204fcd2127ca7168b12cb2b78fa8f54e3",
        },
        vocabulary: BASE_VOCAB,
    },
    Model {
        id: "f5tts-portuguese-br",
        name: "F5 Portuguese (Brazil)",
        author: "firstpixel",
        language: "pt",
        license: "CC-BY-NC-4.0",
        revision: "5ebc6913f2d92e4c0cb5396a9867aa1c0c1c4281",
        architecture: "F5TTS_Base",
        checkpoint: Asset {
            name: "model.safetensors",
            url: "https://huggingface.co/firstpixel/F5-TTS-pt-br/resolve/5ebc6913f2d92e4c0cb5396a9867aa1c0c1c4281/pt-br/model_last.safetensors",
            bytes: 1_348_431_976,
            sha256: "c25e2678bdd4304071e3d0e39a283a7d23ffbc23678080c5b0b741dda2e07f0f",
        },
        vocabulary: BASE_VOCAB,
    },
    Model {
        id: "f5tts-italian",
        name: "F5 Italian",
        author: "alien79",
        language: "it",
        license: "CC-BY-4.0",
        revision: "6582a16ac03894f0ddae21e3e9b013ef5e33577e",
        architecture: "F5TTS_Base",
        checkpoint: Asset {
            name: "model.safetensors",
            url: "https://huggingface.co/alien79/F5-TTS-italian/resolve/6582a16ac03894f0ddae21e3e9b013ef5e33577e/model_159600.safetensors",
            bytes: 1_348_435_761,
            sha256: "c92b19a07843bda8bf55c8b525e67051ef4f95d3bd28cec2d330a45a48a1ac91",
        },
        vocabulary: BASE_VOCAB,
    },
    Model {
        id: "f5tts-vietnamese-vivoice",
        name: "F5 Vietnamese ViVoice",
        author: "hynt",
        language: "vi",
        license: "CC-BY-NC-SA-4.0",
        revision: "50228ccc563853f0ac628f49ed99a11f653d9ebe",
        architecture: "F5TTS_Base",
        checkpoint: Asset {
            name: "model.pt",
            url: "https://huggingface.co/hynt/F5-TTS-Vietnamese-ViVoice/resolve/50228ccc563853f0ac628f49ed99a11f653d9ebe/model_last.pt",
            bytes: 5_394_362_124,
            sha256: "5ae8293dd09868d5758cd1edc6b74f53bd0200652d907bd43724a69c7b82ea1f",
        },
        vocabulary: Asset {
            name: "vocab.txt",
            url: "https://huggingface.co/hynt/F5-TTS-Vietnamese-ViVoice/resolve/50228ccc563853f0ac628f49ed99a11f653d9ebe/config.json",
            bytes: 11_337,
            sha256: "031ab4b5cab593dfba597551159b7d6594f2cb6acf2fabf5897d56c3e695d2ea",
        },
    },
    Model {
        id: "f5tts-german",
        name: "F5 German",
        author: "marduk-ra",
        language: "de",
        license: "CC-BY-NC-4.0",
        revision: "0205060ea71ff8cfc100eb3b662e87581b2fc01e",
        architecture: "F5TTS_Base",
        checkpoint: Asset {
            name: "model.safetensors",
            url: "https://huggingface.co/marduk-ra/F5-TTS-German/resolve/0205060ea71ff8cfc100eb3b662e87581b2fc01e/f5_tts_german_1010000.safetensors",
            bytes: 1_349_621_553,
            sha256: "7f052b7f3f807e788e8c8cb56e4f2d3929123ea4536acba96d8354f9cb5c09cf",
        },
        vocabulary: Asset {
            name: "vocab.txt",
            url: "https://huggingface.co/marduk-ra/F5-TTS-German/resolve/0205060ea71ff8cfc100eb3b662e87581b2fc01e/vocab.txt",
            bytes: 13_571,
            sha256: "c573548344b36a456bdf88e1fab154be2825b385ce5d88d5255792a1ed8c33d4",
        },
    },
    Model {
        id: "f5tts-finnish",
        name: "F5 Finnish",
        author: "AsmoKoskinen",
        language: "fi",
        license: "CC-BY-NC-4.0",
        revision: "cba9413e3c8ebe3e8f89513ad43510f97decac29",
        architecture: "F5TTS_Base",
        checkpoint: Asset {
            name: "model.safetensors",
            url: "https://huggingface.co/AsmoKoskinen/F5-TTS_Finnish_Model/resolve/cba9413e3c8ebe3e8f89513ad43510f97decac29/model_commonvoice_fi_librivox_fi_vox_populi_fi_20250323/model_last_20250323.safetensors",
            bytes: 1_348_439_857,
            sha256: "b3a7c67a9aac0f73f64299654fa658632a569b85e489fe31421ff71ea2e9b89e",
        },
        vocabulary: Asset {
            name: "vocab.txt",
            url: "https://huggingface.co/AsmoKoskinen/F5-TTS_Finnish_Model/resolve/cba9413e3c8ebe3e8f89513ad43510f97decac29/model_commonvoice_fi_librivox_fi_vox_populi_fi_20250323/vocab.txt",
            bytes: 11_261,
            sha256: "4436601e07d6e601bc37182b94237bd48d7330fdb62f44192c63619ae91014fa",
        },
    },
    Model {
        id: "f5tts-polish",
        name: "F5 Polish Marek",
        author: "Sticzu",
        language: "pl",
        license: "MIT fine-tune; base CC-BY-NC-4.0",
        revision: "18a6ff36748c1d4c91fdf39a2cdd7e202adfe324",
        architecture: "F5TTS_Base",
        checkpoint: Asset {
            name: "model.pt",
            url: "https://huggingface.co/Sticzu/marek-f5tts-polish/resolve/18a6ff36748c1d4c91fdf39a2cdd7e202adfe324/model_205500.pt",
            bytes: 3_383_863_925,
            sha256: "c4a4038cb97ec25d69b78977a6a678707794db663894d64fc4007bd1200b3544",
        },
        vocabulary: BASE_VOCAB,
    },
];

#[derive(Default)]
struct Operation {
    id: String,
    model: String,
    bytes: Arc<AtomicU64>,
    total: u64,
    cancel: Arc<AtomicBool>,
}

pub(crate) struct F5ModelRuntime {
    root: PathBuf,
    operation: Mutex<Option<Operation>>,
}

impl F5ModelRuntime {
    pub(crate) fn new(root: &Path) -> std::io::Result<Self> {
        fs::create_dir_all(root)?;
        Ok(Self {
            root: fs::canonicalize(root)?,
            operation: Mutex::new(None),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelStatus {
    id: &'static str,
    name: &'static str,
    author: &'static str,
    language: &'static str,
    license: &'static str,
    revision: &'static str,
    architecture: &'static str,
    installed: bool,
    download_bytes: u64,
    operation: Option<OperationStatus>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationStatus {
    id: String,
    model: String,
    bytes_done: u64,
    total_bytes: u64,
    basis_points: u64,
}

#[derive(Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum ModelEvent {
    Progress { operation: OperationStatus },
    Completed { model: String },
    Cancelled { model: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    id: String,
    revision: String,
    checkpoint_sha256: String,
    vocabulary_sha256: String,
}

fn catalog(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|model| model.id == id)
}
fn directory(root: &Path, model: &Model) -> PathBuf {
    root.join(model.id)
}
fn installed(root: &Path, model: &Model) -> bool {
    let dir = directory(root, model);
    let Ok(raw) = fs::read(dir.join("receipt.json")) else {
        return false;
    };
    let Ok(receipt) = serde_json::from_slice::<Receipt>(&raw) else {
        return false;
    };
    receipt.id == model.id
        && receipt.revision == model.revision
        && receipt.checkpoint_sha256 == model.checkpoint.sha256
        && receipt.vocabulary_sha256 == model.vocabulary.sha256
        && fs::metadata(dir.join(model.checkpoint.name))
            .is_ok_and(|m| m.len() == model.checkpoint.bytes)
        && fs::metadata(dir.join(model.vocabulary.name))
            .is_ok_and(|m| m.len() == model.vocabulary.bytes)
}

fn operation_status(operation: &Operation) -> OperationStatus {
    let done = operation.bytes.load(Ordering::Relaxed).min(operation.total);
    OperationStatus {
        id: operation.id.clone(),
        model: operation.model.clone(),
        bytes_done: done,
        total_bytes: operation.total,
        basis_points: done.saturating_mul(10_000) / operation.total.max(1),
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors are owned"
)]
pub(crate) fn f5_models_status(
    runtime: State<'_, F5ModelRuntime>,
) -> CommandResult<Vec<ModelStatus>> {
    let operation = runtime
        .operation
        .lock()
        .map_err(|_| CommandError::internal("model state unavailable"))?;
    Ok(MODELS
        .iter()
        .map(|model| ModelStatus {
            id: model.id,
            name: model.name,
            author: model.author,
            language: model.language,
            license: model.license,
            revision: model.revision,
            architecture: model.architecture,
            installed: installed(&runtime.root, model),
            download_bytes: model.checkpoint.bytes + model.vocabulary.bytes,
            operation: operation
                .as_ref()
                .filter(|op| op.model == model.id)
                .map(operation_status),
        })
        .collect())
}

fn download(
    asset: Asset,
    destination: &Path,
    progress: &AtomicU64,
    cancel: &AtomicBool,
) -> Result<(), ()> {
    let mut response = reqwest::blocking::Client::builder()
        .user_agent("OSG/1.0")
        .build()
        .map_err(|_| ())?
        .get(asset.url)
        .send()
        .map_err(|_| ())?
        .error_for_status()
        .map_err(|_| ())?;
    let mut file = File::create(destination).map_err(|_| ())?;
    let mut hasher = Sha256::new();
    let mut count = 0_u64;
    let mut buffer = vec![0_u8; 256 * 1024].into_boxed_slice();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(());
        }
        let read = response.read(&mut buffer).map_err(|_| ())?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read]).map_err(|_| ())?;
        hasher.update(&buffer[..read]);
        count += read as u64;
        progress.fetch_add(read as u64, Ordering::Relaxed);
        if count > asset.bytes {
            return Err(());
        }
    }
    file.sync_all().map_err(|_| ())?;
    if count != asset.bytes || format!("{:x}", hasher.finalize()) != asset.sha256 {
        return Err(());
    }
    Ok(())
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors are owned"
)]
pub(crate) async fn f5_model_install(
    model: String,
    on_event: Channel<ModelEvent>,
    runtime: State<'_, F5ModelRuntime>,
    speech: State<'_, SpeechRuntime>,
) -> CommandResult<()> {
    let entry = *catalog(&model)
        .ok_or_else(|| CommandError::invalid_input("unsupported narration model"))?;
    if installed(&runtime.root, &entry) {
        return Ok(());
    }
    let id = uuid::Uuid::now_v7().to_string();
    let bytes = Arc::new(AtomicU64::new(0));
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = runtime
            .operation
            .lock()
            .map_err(|_| CommandError::internal("model state unavailable"))?;
        if slot.is_some() {
            return Err(CommandError::invalid_input(
                "another model operation is running",
            ));
        }
        *slot = Some(Operation {
            id: id.clone(),
            model: model.clone(),
            bytes: Arc::clone(&bytes),
            total: entry.checkpoint.bytes + entry.vocabulary.bytes,
            cancel: Arc::clone(&cancel),
        });
    }
    let root = runtime.root.clone();
    let reporter = {
        let bytes = Arc::clone(&bytes);
        let cancel = Arc::clone(&cancel);
        let model = model.clone();
        let id = id.clone();
        let channel = on_event.clone();
        let total = entry.checkpoint.bytes + entry.vocabulary.bytes;
        tokio::spawn(async move {
            while !cancel.load(Ordering::Relaxed) {
                let done = bytes.load(Ordering::Relaxed).min(total);
                let _ = channel.send(ModelEvent::Progress {
                    operation: OperationStatus {
                        id: id.clone(),
                        model: model.clone(),
                        bytes_done: done,
                        total_bytes: total,
                        basis_points: done.saturating_mul(10_000) / total,
                    },
                });
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            }
        })
    };
    let work_cancel = Arc::clone(&cancel);
    let work = tokio::task::spawn_blocking(move || -> Result<(), ()> {
        let staging = root.join(format!(".{}.{}", entry.id, id));
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir(&staging).map_err(|_| ())?;
        let result = (|| {
            download(entry.checkpoint, &staging.join(entry.checkpoint.name), &bytes, &work_cancel)?;
            download(entry.vocabulary, &staging.join(entry.vocabulary.name), &bytes, &work_cancel)?;
            let receipt = serde_json::json!({ "id": entry.id, "revision": entry.revision, "checkpointSha256": entry.checkpoint.sha256, "vocabularySha256": entry.vocabulary.sha256 });
            fs::write(staging.join("receipt.json"), serde_json::to_vec_pretty(&receipt).map_err(|_| ())?).map_err(|_| ())?;
            let target = root.join(entry.id);
            if target.exists() { fs::remove_dir_all(&target).map_err(|_| ())?; }
            fs::rename(&staging, target).map_err(|_| ())?;
            Ok(())
        })();
        if result.is_err() { let _ = fs::remove_dir_all(staging); }
        result
    }).await.map_err(|_| CommandError::internal("model install failed"))?;
    let was_cancelled = cancel.load(Ordering::Relaxed);
    cancel.store(true, Ordering::Relaxed);
    reporter.abort();
    runtime
        .operation
        .lock()
        .map_err(|_| CommandError::internal("model state unavailable"))?
        .take();
    if work.is_err() {
        if was_cancelled {
            let _ = on_event.send(ModelEvent::Cancelled { model });
            return Ok(());
        }
        return Err(CommandError::internal(
            "model download or integrity verification failed",
        ));
    }
    speech.reload_f5_models()?;
    let _ = on_event.send(ModelEvent::Completed { model });
    Ok(())
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors are owned"
)]
pub(crate) fn f5_model_cancel(
    model: String,
    runtime: State<'_, F5ModelRuntime>,
) -> CommandResult<()> {
    let slot = runtime
        .operation
        .lock()
        .map_err(|_| CommandError::internal("model state unavailable"))?;
    let operation = slot
        .as_ref()
        .filter(|operation| operation.model == model)
        .ok_or_else(|| CommandError::invalid_input("model operation not found"))?;
    operation.cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors are owned"
)]
pub(crate) fn f5_model_remove(
    model: String,
    runtime: State<'_, F5ModelRuntime>,
    speech: State<'_, SpeechRuntime>,
) -> CommandResult<()> {
    let entry = catalog(&model)
        .ok_or_else(|| CommandError::invalid_input("unsupported narration model"))?;
    if runtime
        .operation
        .lock()
        .map_err(|_| CommandError::internal("model state unavailable"))?
        .is_some()
    {
        return Err(CommandError::invalid_input(
            "another model operation is running",
        ));
    }
    let target = directory(&runtime.root, entry);
    if target.exists() {
        fs::remove_dir_all(target).map_err(|_| CommandError::internal("model removal failed"))?;
    }
    speech.reload_f5_models()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech::F5_MODEL_IDS;
    #[test]
    fn catalog_is_closed_unique_and_content_addressed() {
        let mut ids = std::collections::HashSet::new();
        for model in MODELS {
            assert!(ids.insert(model.id));
            assert!(model.checkpoint.url.contains(model.revision));
            assert_eq!(model.checkpoint.sha256.len(), 64);
            assert_eq!(model.vocabulary.sha256.len(), 64);
            assert!(model.checkpoint.bytes > 1_000_000_000);
            assert!(F5_MODEL_IDS.contains(&model.id));
            assert!(
                std::str::from_utf8(crate::speech::WORKER_BYTES)
                    .unwrap()
                    .contains(model.id)
            );
        }
    }
    #[test]
    fn receipt_requires_exact_catalog_identity_and_sizes() {
        let temp = tempfile::tempdir().unwrap();
        let model = &MODELS[0];
        let dir = temp.path().join(model.id);
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join(model.checkpoint.name), vec![0; 1]).unwrap();
        fs::write(dir.join(model.vocabulary.name), vec![0; 1]).unwrap();
        fs::write(dir.join("receipt.json"), serde_json::to_vec(&serde_json::json!({"id":model.id,"revision":model.revision,"checkpointSha256":model.checkpoint.sha256,"vocabularySha256":model.vocabulary.sha256})).unwrap()).unwrap();
        assert!(!installed(temp.path(), model));
    }
}
