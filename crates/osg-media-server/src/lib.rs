//! A private, bounded loopback server for seekable media.
//!
//! Tauri custom-protocol responses are buffered. This server streams large media from an open
//! file handle while exposing only opaque, per-process capability URLs to the `WebView`. Connection
//! parsing and response work stay on a fixed-size worker pool; incomplete or stalled clients are
//! bounded by header, queue, and socket timeouts.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io;
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex, OnceLock, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;

mod auth;
mod connection;
mod frames;
mod images;
mod range;
mod registry;
mod request;
mod response;
mod routing;
#[cfg(test)]
mod tests;

pub use frames::RegisteredFrameSequence;
pub use images::RegisteredImageCopy;

use auth::valid_configured_origin;
use connection::{accept_loop, worker_loop};
use frames::FrameRegistry;

const REQUEST_QUEUE_CAPACITY: usize = 64;
const WORKER_COUNT: usize = 4;
const MAX_CONCURRENT_SERVER_INSTANCES: usize = 8;
const MAX_REGISTERED_ASSETS: usize = 256;
const MAX_REGISTERED_IMAGES: usize = 64;
/// Maximum encoded provider-image bytes retained by the process-scoped registry.
pub const MAX_PROVIDER_IMAGE_REGISTRY_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ALLOWED_ORIGINS: usize = 16;
const MAX_ORIGIN_BYTES: usize = 512;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_HEADER_COUNT: usize = 100;
const STREAM_BUFFER_BYTES: usize = 64 * 1024;
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const HEADER_READ_DEADLINE: Duration = Duration::from_secs(5);
const READ_POLL_TIMEOUT: Duration = Duration::from_millis(250);
const WRITE_POLL_TIMEOUT: Duration = Duration::from_millis(250);
const MAX_CLOSE_DRAIN_BYTES: usize = 64 * 1024;
const STALLED_WRITE_DEADLINE: Duration = Duration::from_secs(30);
const OVERLOAD_WRITE_TIMEOUT: Duration = Duration::from_millis(50);
const IMAGE_LIFETIME: Duration = Duration::from_hours(24);
const TOKEN_HEADER: &str = "x-osg-media-token";

#[derive(Debug, Error)]
pub enum MediaServerError {
    #[error("could not bind the private media server: {0}")]
    Bind(String),
    #[error("could not start a media server thread: {0}")]
    Thread(#[from] io::Error),
    #[error("an allowed media origin is invalid")]
    InvalidOrigin,
    #[error("the media path is invalid")]
    InvalidPath,
    #[error("the selected media file is empty")]
    EmptyFile,
    #[error("the media registry has reached its capacity")]
    RegistryFull,
    #[error("the media registry is unavailable")]
    RegistryUnavailable,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredMedia {
    pub id: Uuid,
    pub playback_url: String,
    pub mime_type: String,
    pub byte_length: u64,
}

impl std::fmt::Debug for RegisteredMedia {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RegisteredMedia")
            .field("id", &self.id)
            .field("mime_type", &self.mime_type)
            .field("byte_length", &self.byte_length)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct MediaServer {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for MediaServer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let registered_assets = self
            .inner
            .context
            .assets
            .read()
            .map_or(0, |assets| assets.len());
        formatter
            .debug_struct("MediaServer")
            .field("port", &self.inner.context.port)
            .field("registered_assets", &registered_assets)
            .finish_non_exhaustive()
    }
}

struct Inner {
    context: Arc<ServerContext>,
    sender: Mutex<Option<SyncSender<TcpStream>>>,
    accept_thread: Mutex<Option<JoinHandle<()>>>,
    workers: Mutex<Vec<JoinHandle<()>>>,
    stopping: Arc<AtomicBool>,
    _instance_permit: ServerInstancePermit,
}

struct ServerInstancePermit;

fn server_instance_counter() -> &'static (Mutex<usize>, Condvar) {
    static COUNTER: OnceLock<(Mutex<usize>, Condvar)> = OnceLock::new();
    COUNTER.get_or_init(|| (Mutex::new(0), Condvar::new()))
}

fn acquire_server_instance() -> Result<ServerInstancePermit, MediaServerError> {
    let (counter, available) = server_instance_counter();
    let mut active = counter
        .lock()
        .map_err(|_| MediaServerError::RegistryUnavailable)?;
    while *active >= MAX_CONCURRENT_SERVER_INSTANCES {
        active = available
            .wait(active)
            .map_err(|_| MediaServerError::RegistryUnavailable)?;
    }
    *active += 1;
    Ok(ServerInstancePermit)
}

impl Drop for ServerInstancePermit {
    fn drop(&mut self) {
        let (counter, available) = server_instance_counter();
        let mut active = counter
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *active = active.saturating_sub(1);
        available.notify_one();
    }
}

struct ServerContext {
    port: u16,
    token: String,
    allowed_origins: HashSet<String>,
    assets: RwLock<HashMap<Uuid, MediaEntry>>,
    frames: FrameRegistry,
}

impl std::fmt::Debug for ServerContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let registered_assets = self.assets.read().map_or(0, |assets| assets.len());
        formatter
            .debug_struct("ServerContext")
            .field("port", &self.port)
            .field("allowed_origin_count", &self.allowed_origins.len())
            .field("registered_assets", &registered_assets)
            .finish_non_exhaustive()
    }
}

struct MediaEntry {
    source: MediaSource,
    mime_type: String,
    byte_length: u64,
    image_owner: Option<ImageOwnership>,
}

enum MediaSource {
    File {
        file: Arc<File>,
        modified: Option<SystemTime>,
    },
    Image {
        bytes: Arc<[u8]>,
        expires_at: Instant,
        last_accessed: Instant,
    },
}

#[derive(Clone, Copy)]
struct ImageOwnership {
    owner: Uuid,
    committed: bool,
    active_claims: usize,
    release_requested: bool,
}

impl std::fmt::Debug for MediaEntry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MediaEntry")
            .field(
                "source",
                &match &self.source {
                    MediaSource::File { .. } => "file",
                    MediaSource::Image { .. } => "image",
                },
            )
            .field("mime_type", &self.mime_type)
            .field("byte_length", &self.byte_length)
            .field("image_owner", &self.image_owner.map(|_| "<opaque>"))
            .finish_non_exhaustive()
    }
}

impl MediaServer {
    pub fn start(
        allowed_origins: impl IntoIterator<Item = String>,
    ) -> Result<Self, MediaServerError> {
        let mut validated_origins = HashSet::new();
        for (index, origin) in allowed_origins.into_iter().enumerate() {
            if !valid_configured_origin(&origin) || index >= MAX_ALLOWED_ORIGINS {
                return Err(MediaServerError::InvalidOrigin);
            }
            validated_origins.insert(origin);
        }

        // Each server owns one accept thread and a fixed worker pool. Bound the number of live
        // instances before acquiring a socket so concurrent test/application components cannot
        // exhaust Windows' thread or loopback resources (WSAENOBUFS) and turn a valid start into
        // a nondeterministic failure.
        let instance_permit = acquire_server_instance()?;

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .map_err(|error| MediaServerError::Bind(error.to_string()))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| MediaServerError::Bind(error.to_string()))?;
        let address = listener
            .local_addr()
            .map_err(|error| MediaServerError::Bind(error.to_string()))?;
        if !address.ip().is_loopback() {
            return Err(MediaServerError::Bind(
                "the listener did not bind to loopback".to_owned(),
            ));
        }

        let context = Arc::new(ServerContext {
            port: address.port(),
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            allowed_origins: validated_origins,
            assets: RwLock::new(HashMap::new()),
            frames: FrameRegistry::default(),
        });
        let stopping = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = sync_channel(REQUEST_QUEUE_CAPACITY);
        let receiver = Arc::new(Mutex::new(receiver));

        let mut workers = Vec::with_capacity(WORKER_COUNT);
        for index in 0..WORKER_COUNT {
            let worker_context = Arc::clone(&context);
            let worker_receiver = Arc::clone(&receiver);
            let worker_stopping = Arc::clone(&stopping);
            workers.push(
                thread::Builder::new()
                    .name(format!("osg-media-{index}"))
                    .spawn(move || {
                        worker_loop(&worker_context, &worker_receiver, &worker_stopping);
                    })?,
            );
        }

        let accept_sender = sender.clone();
        let accept_stopping = Arc::clone(&stopping);
        let accept_thread = thread::Builder::new()
            .name("osg-media-accept".to_owned())
            .spawn(move || accept_loop(&listener, &accept_sender, &accept_stopping))?;

        Ok(Self {
            inner: Arc::new(Inner {
                context,
                sender: Mutex::new(Some(sender)),
                accept_thread: Mutex::new(Some(accept_thread)),
                workers: Mutex::new(workers),
                stopping,
                _instance_permit: instance_permit,
            }),
        })
    }

    #[must_use]
    pub fn port(&self) -> u16 {
        self.inner.context.port
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);

        let accept_thread = self
            .accept_thread
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(thread) = accept_thread {
            let _ = thread.join();
        }

        self.sender
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let workers = self
            .workers
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for worker in workers.drain(..) {
            let _ = worker.join();
        }
    }
}

struct CloneableEntry {
    source: CloneableSource,
    mime_type: String,
    byte_length: u64,
}

enum CloneableSource {
    File {
        file: Arc<File>,
        modified: Option<SystemTime>,
    },
    Image(Arc<[u8]>),
}

impl From<&MediaEntry> for CloneableEntry {
    fn from(entry: &MediaEntry) -> Self {
        Self {
            source: match &entry.source {
                MediaSource::File { file, modified } => CloneableSource::File {
                    file: Arc::clone(file),
                    modified: *modified,
                },
                MediaSource::Image { bytes, .. } => CloneableSource::Image(Arc::clone(bytes)),
            },
            mime_type: entry.mime_type.clone(),
            byte_length: entry.byte_length,
        }
    }
}

impl CloneableEntry {
    /// Wraps already-validated in-memory bytes so they stream through the shared response path.
    fn from_memory(mime_type: String, bytes: Arc<[u8]>) -> Option<Self> {
        let byte_length = u64::try_from(bytes.len())
            .ok()
            .filter(|length| *length > 0)?;
        Some(Self {
            source: CloneableSource::Image(bytes),
            mime_type,
            byte_length,
        })
    }
}
