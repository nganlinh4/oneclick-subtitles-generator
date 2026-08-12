//! A private, bounded loopback server for seekable media.
//!
//! Tauri custom-protocol responses are buffered. This server streams large media from an open
//! file handle while exposing only opaque, per-process capability URLs to the `WebView`. Connection
//! parsing and response work stay on a fixed-size worker pool; incomplete or stalled clients are
//! bounded by header, queue, and socket timeouts.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;

const REQUEST_QUEUE_CAPACITY: usize = 64;
const WORKER_COUNT: usize = 4;
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
}

struct ServerContext {
    port: u16,
    token: String,
    allowed_origins: HashSet<String>,
    assets: RwLock<HashMap<Uuid, MediaEntry>>,
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
            }),
        })
    }

    #[must_use]
    pub fn port(&self) -> u16 {
        self.inner.context.port
    }

    pub fn register(&self, path: &Path) -> Result<RegisteredMedia, MediaServerError> {
        let mime_type = mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .to_owned();
        self.register_with_mime_type(path, mime_type)
    }

    /// Registers an extensionless native artifact using the extension retained
    /// in its validated, path-free media metadata.
    pub fn register_with_extension(
        &self,
        path: &Path,
        extension: &str,
    ) -> Result<RegisteredMedia, MediaServerError> {
        if extension.is_empty()
            || extension.len() > 16
            || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(MediaServerError::InvalidPath);
        }
        let mime_type = mime_guess::from_ext(extension)
            .first_or_octet_stream()
            .essence_str()
            .to_owned();
        self.register_with_mime_type(path, mime_type)
    }

    /// Registers media whose durable, content-addressed path intentionally has
    /// no filename extension. The caller must supply MIME metadata derived from
    /// a previously validated native media asset; the value never comes from
    /// the `WebView`.
    pub fn register_with_mime_type(
        &self,
        path: &Path,
        mime_type: impl Into<String>,
    ) -> Result<RegisteredMedia, MediaServerError> {
        let mime_type = mime_type.into();
        if !valid_media_mime_type(&mime_type) {
            return Err(MediaServerError::InvalidPath);
        }
        let canonical_path = fs::canonicalize(path).map_err(|_| MediaServerError::InvalidPath)?;
        let file = File::open(&canonical_path).map_err(|_| MediaServerError::InvalidPath)?;
        let metadata = file.metadata().map_err(|_| MediaServerError::InvalidPath)?;
        if !metadata.is_file() {
            return Err(MediaServerError::InvalidPath);
        }
        if metadata.len() == 0 {
            return Err(MediaServerError::EmptyFile);
        }
        let id = Uuid::new_v4();
        let entry = MediaEntry {
            source: MediaSource::File {
                file: Arc::new(file),
                modified: metadata.modified().ok(),
            },
            mime_type: mime_type.clone(),
            byte_length: metadata.len(),
        };
        let mut assets = self
            .inner
            .context
            .assets
            .write()
            .map_err(|_| MediaServerError::RegistryUnavailable)?;
        if assets.len() >= MAX_REGISTERED_ASSETS {
            return Err(MediaServerError::RegistryFull);
        }
        assets.insert(id, entry);
        drop(assets);

        Ok(RegisteredMedia {
            id,
            playback_url: format!(
                "http://127.0.0.1:{}/asset/{id}?token={}",
                self.inner.context.port, self.inner.context.token
            ),
            mime_type,
            byte_length: metadata.len(),
        })
    }

    /// Registers a provider-fetched raster image in the process-scoped capability registry.
    ///
    /// Image bytes never touch a caller-selected path. Exact MIME/signature validation, per-entry
    /// and aggregate memory bounds, LRU eviction, and a fixed lifetime keep the WebView-facing URL
    /// both opaque and short-lived.
    pub fn register_image(
        &self,
        mime_type: &str,
        bytes: Vec<u8>,
    ) -> Result<RegisteredMedia, MediaServerError> {
        self.register_image_with_lifetime(mime_type, bytes, IMAGE_LIFETIME)
    }

    /// Atomically registers a bounded group of provider images.
    ///
    /// Existing least-recently-used images may be evicted to make room, but images in this batch
    /// are either all retained or none are inserted. This prevents a multi-result provider command
    /// from returning a capability that another insertion in the same response already evicted.
    pub fn register_images(
        &self,
        images: Vec<(String, Vec<u8>)>,
    ) -> Result<Vec<RegisteredMedia>, MediaServerError> {
        self.register_images_with_lifetime(images, IMAGE_LIFETIME)
    }

    fn register_image_with_lifetime(
        &self,
        mime_type: &str,
        bytes: Vec<u8>,
        lifetime: Duration,
    ) -> Result<RegisteredMedia, MediaServerError> {
        let mut registered =
            self.register_images_with_lifetime(vec![(mime_type.to_owned(), bytes)], lifetime)?;
        registered.pop().ok_or(MediaServerError::InvalidPath)
    }

    fn register_images_with_lifetime(
        &self,
        images: Vec<(String, Vec<u8>)>,
        lifetime: Duration,
    ) -> Result<Vec<RegisteredMedia>, MediaServerError> {
        if images.is_empty() || images.len() > MAX_REGISTERED_IMAGES || lifetime.is_zero() {
            return Err(MediaServerError::InvalidPath);
        }
        let mut incoming_bytes = 0_usize;
        let mut prepared = Vec::with_capacity(images.len());
        for (mime_type, bytes) in images {
            if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
                return Err(MediaServerError::InvalidPath);
            }
            let Some(mime_type) = canonical_image_mime_type(&mime_type, &bytes) else {
                return Err(MediaServerError::InvalidPath);
            };
            incoming_bytes = incoming_bytes
                .checked_add(bytes.len())
                .filter(|total| *total <= MAX_PROVIDER_IMAGE_REGISTRY_BYTES)
                .ok_or(MediaServerError::RegistryFull)?;
            let byte_length =
                u64::try_from(bytes.len()).map_err(|_| MediaServerError::InvalidPath)?;
            prepared.push((mime_type.to_owned(), Arc::<[u8]>::from(bytes), byte_length));
        }

        let now = Instant::now();
        let mut assets = self
            .inner
            .context
            .assets
            .write()
            .map_err(|_| MediaServerError::RegistryUnavailable)?;
        purge_expired_images(&mut assets, now);
        make_image_capacity(&mut assets, prepared.len(), incoming_bytes)?;

        let mut registered = Vec::with_capacity(prepared.len());
        for (mime_type, bytes, byte_length) in prepared {
            let id = Uuid::new_v4();
            assets.insert(
                id,
                MediaEntry {
                    source: MediaSource::Image {
                        bytes,
                        expires_at: now + lifetime,
                        last_accessed: now,
                    },
                    mime_type: mime_type.clone(),
                    byte_length,
                },
            );
            registered.push(RegisteredMedia {
                id,
                playback_url: format!(
                    "http://127.0.0.1:{}/asset/{id}?token={}",
                    self.inner.context.port, self.inner.context.token
                ),
                mime_type,
                byte_length,
            });
        }
        drop(assets);
        Ok(registered)
    }

    pub fn unregister(&self, id: Uuid) -> Result<bool, MediaServerError> {
        Ok(self
            .inner
            .context
            .assets
            .write()
            .map_err(|_| MediaServerError::RegistryUnavailable)?
            .remove(&id)
            .is_some())
    }
}

fn valid_media_mime_type(value: &str) -> bool {
    let Some((top_level, subtype)) = value.split_once('/') else {
        return false;
    };
    matches!(top_level, "audio" | "video")
        && !subtype.is_empty()
        && subtype.len() <= 127
        && subtype
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte))
}

fn canonical_image_mime_type<'a>(value: &'a str, bytes: &[u8]) -> Option<&'a str> {
    match value {
        "image/jpeg" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => Some(value),
        "image/png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Some(value),
        "image/webp"
            if bytes.len() >= 12
                && bytes.starts_with(b"RIFF")
                && bytes.get(8..12) == Some(b"WEBP") =>
        {
            Some(value)
        }
        "image/gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => Some(value),
        _ => None,
    }
}

fn purge_expired_images(assets: &mut HashMap<Uuid, MediaEntry>, now: Instant) {
    assets.retain(|_, entry| {
        !matches!(
            &entry.source,
            MediaSource::Image { expires_at, .. } if *expires_at <= now
        )
    });
}

fn make_image_capacity(
    assets: &mut HashMap<Uuid, MediaEntry>,
    incoming_count: usize,
    incoming_bytes: usize,
) -> Result<(), MediaServerError> {
    if incoming_count == 0
        || incoming_count > MAX_REGISTERED_IMAGES
        || incoming_bytes > MAX_PROVIDER_IMAGE_REGISTRY_BYTES
    {
        return Err(MediaServerError::RegistryFull);
    }
    loop {
        let image_count = assets
            .values()
            .filter(|entry| matches!(&entry.source, MediaSource::Image { .. }))
            .count();
        let image_bytes = assets
            .values()
            .filter_map(|entry| match &entry.source {
                MediaSource::Image { .. } => usize::try_from(entry.byte_length).ok(),
                MediaSource::File { .. } => None,
            })
            .try_fold(0_usize, usize::checked_add)
            .ok_or(MediaServerError::RegistryFull)?;
        let has_capacity = assets
            .len()
            .checked_add(incoming_count)
            .is_some_and(|total| total <= MAX_REGISTERED_ASSETS)
            && image_count
                .checked_add(incoming_count)
                .is_some_and(|total| total <= MAX_REGISTERED_IMAGES)
            && image_bytes
                .checked_add(incoming_bytes)
                .is_some_and(|total| total <= MAX_PROVIDER_IMAGE_REGISTRY_BYTES);
        if has_capacity {
            return Ok(());
        }
        let oldest = assets
            .iter()
            .filter_map(|(id, entry)| match &entry.source {
                MediaSource::Image { last_accessed, .. } => Some((*id, *last_accessed)),
                MediaSource::File { .. } => None,
            })
            .min_by_key(|(_, last_accessed)| *last_accessed)
            .map(|(id, _)| id)
            .ok_or(MediaServerError::RegistryFull)?;
        assets.remove(&oldest);
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

fn accept_loop(listener: &TcpListener, sender: &SyncSender<TcpStream>, stopping: &AtomicBool) {
    while !stopping.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, address)) => {
                if !address.ip().is_loopback() {
                    let _ = stream.shutdown(Shutdown::Both);
                    continue;
                }
                match sender.try_send(stream) {
                    Ok(()) => {}
                    Err(TrySendError::Full(mut stream)) => {
                        let _ = stream.set_write_timeout(Some(OVERLOAD_WRITE_TIMEOUT));
                        let _ = write_static_busy(&mut stream);
                        let _ = stream.shutdown(Shutdown::Both);
                    }
                    Err(TrySendError::Disconnected(stream)) => {
                        let _ = stream.shutdown(Shutdown::Both);
                        break;
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(ACCEPT_POLL_INTERVAL);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) if stopping.load(Ordering::Acquire) => break,
            Err(_) => break,
        }
    }
}

fn worker_loop(
    context: &ServerContext,
    receiver: &Mutex<Receiver<TcpStream>>,
    stopping: &AtomicBool,
) {
    loop {
        let stream = match receiver.lock() {
            Ok(receiver) => receiver.recv(),
            Err(poisoned) => poisoned.into_inner().recv(),
        };
        let Ok(mut stream) = stream else {
            return;
        };
        if stopping.load(Ordering::Acquire) {
            let _ = stream.shutdown(Shutdown::Both);
            continue;
        }

        let _ = stream.set_nodelay(true);
        let _ = stream.set_write_timeout(Some(WRITE_POLL_TIMEOUT));
        match read_request(&mut stream, stopping) {
            Ok(request) => handle_request(context, &mut stream, &request, stopping),
            Err(RequestReadError::BadRequest) => {
                let _ = respond_text(&mut stream, false, 400, "Bad Request", "Bad request", &[]);
            }
            Err(RequestReadError::Timeout) => {
                let _ = respond_text(
                    &mut stream,
                    false,
                    408,
                    "Request Timeout",
                    "Request timeout",
                    &[],
                );
            }
            Err(RequestReadError::TooLarge) => {
                let _ = respond_text(
                    &mut stream,
                    false,
                    431,
                    "Request Header Fields Too Large",
                    "Request headers too large",
                    &[],
                );
            }
            Err(RequestReadError::Stopping | RequestReadError::Disconnected) => {}
        }
        let _ = stream.shutdown(Shutdown::Both);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RequestReadError {
    BadRequest,
    Timeout,
    TooLarge,
    Stopping,
    Disconnected,
}

struct HttpRequest {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
}

impl std::fmt::Debug for HttpRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let target_path = self
            .target
            .split_once('?')
            .map_or(self.target.as_str(), |(path, _)| path);
        formatter
            .debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("target_path", &target_path)
            .field("header_count", &self.headers.len())
            .finish_non_exhaustive()
    }
}

impl HttpRequest {
    fn unique_header(&self, name: &str) -> Result<Option<&str>, ()> {
        let mut values = self
            .headers
            .iter()
            .filter(|(header_name, _)| header_name == name)
            .map(|(_, value)| value.as_str());
        let value = values.next();
        if values.next().is_some() {
            return Err(());
        }
        Ok(value)
    }

    fn is_head(&self) -> bool {
        self.method == "HEAD"
    }
}

fn read_request(
    stream: &mut TcpStream,
    stopping: &AtomicBool,
) -> Result<HttpRequest, RequestReadError> {
    stream
        .set_read_timeout(Some(READ_POLL_TIMEOUT))
        .map_err(|_| RequestReadError::Disconnected)?;
    let deadline = Instant::now() + HEADER_READ_DEADLINE;
    let mut raw = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 1024];

    let header_end = loop {
        if stopping.load(Ordering::Acquire) {
            return Err(RequestReadError::Stopping);
        }
        if let Some(position) = find_header_end(&raw) {
            break position;
        }
        if raw.len() >= MAX_HEADER_BYTES {
            return Err(RequestReadError::TooLarge);
        }
        let remaining = MAX_HEADER_BYTES - raw.len();
        let read_capacity = remaining.min(buffer.len());
        match stream.read(&mut buffer[..read_capacity]) {
            Ok(0) => return Err(RequestReadError::Disconnected),
            Ok(read) => raw.extend_from_slice(&buffer[..read]),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                if Instant::now() >= deadline {
                    return Err(RequestReadError::Timeout);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(RequestReadError::Disconnected),
        }
    };

    parse_request_bytes(&raw[..header_end])
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_request_bytes(bytes: &[u8]) -> Result<HttpRequest, RequestReadError> {
    let text = std::str::from_utf8(bytes).map_err(|_| RequestReadError::BadRequest)?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or(RequestReadError::BadRequest)?;
    let mut request_parts = request_line.split(' ');
    let method = request_parts.next().ok_or(RequestReadError::BadRequest)?;
    let target = request_parts.next().ok_or(RequestReadError::BadRequest)?;
    let version = request_parts.next().ok_or(RequestReadError::BadRequest)?;
    if request_parts.next().is_some()
        || method.is_empty()
        || !method.bytes().all(is_token_byte)
        || !target.starts_with('/')
        || target.contains('#')
        || target.bytes().any(|byte| byte.is_ascii_control())
        || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
    {
        return Err(RequestReadError::BadRequest);
    }

    let mut headers = Vec::new();
    for line in lines {
        if headers.len() >= MAX_HEADER_COUNT || line.starts_with([' ', '\t']) || line.is_empty() {
            return Err(RequestReadError::BadRequest);
        }
        let (name, value) = line.split_once(':').ok_or(RequestReadError::BadRequest)?;
        if name.is_empty() || !name.bytes().all(is_token_byte) {
            return Err(RequestReadError::BadRequest);
        }
        let value = value.trim_matches([' ', '\t']);
        if value
            .bytes()
            .any(|byte| byte.is_ascii_control() && byte != b'\t')
        {
            return Err(RequestReadError::BadRequest);
        }
        headers.push((name.to_ascii_lowercase(), value.to_owned()));
    }

    let request = HttpRequest {
        method: method.to_owned(),
        target: target.to_owned(),
        headers,
    };
    validate_request_framing(&request)?;
    Ok(request)
}

fn validate_request_framing(request: &HttpRequest) -> Result<(), RequestReadError> {
    let host = request
        .unique_header("host")
        .map_err(|()| RequestReadError::BadRequest)?;
    let transfer_encoding = request
        .unique_header("transfer-encoding")
        .map_err(|()| RequestReadError::BadRequest)?;
    if host.is_none() || transfer_encoding.is_some() {
        return Err(RequestReadError::BadRequest);
    }
    let content_length = request
        .unique_header("content-length")
        .map_err(|()| RequestReadError::BadRequest)?;
    if content_length.is_some_and(|value| parse_decimal(value) != Some(0)) {
        return Err(RequestReadError::BadRequest);
    }
    Ok(())
}

fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

fn handle_request(
    context: &ServerContext,
    stream: &mut TcpStream,
    request: &HttpRequest,
    stopping: &AtomicBool,
) {
    let Ok(origin) = request.unique_header("origin") else {
        let _ = respond_text(
            stream,
            request.is_head(),
            400,
            "Bad Request",
            "Bad request",
            &[],
        );
        return;
    };
    if origin.is_some_and(|value| !context.allowed_origins.contains(value)) {
        let _ = respond_text(
            stream,
            request.is_head(),
            403,
            "Forbidden",
            "Forbidden",
            &[],
        );
        return;
    }
    let Ok(token_header) = request.unique_header(TOKEN_HEADER) else {
        let _ = respond_text(
            stream,
            request.is_head(),
            400,
            "Bad Request",
            "Bad request",
            &[],
        );
        return;
    };
    if !valid_host(context, request) || !valid_token(context, request, token_header) {
        let _ = respond_text(
            stream,
            request.is_head(),
            403,
            "Forbidden",
            "Forbidden",
            &[],
        );
        return;
    }

    match request.method.as_str() {
        "OPTIONS" => handle_options(stream, request, origin),
        "GET" | "HEAD" => handle_asset_request(context, stream, request, origin, stopping),
        _ => {
            let mut headers = cors_headers(origin);
            headers.push(("Allow", "GET, HEAD, OPTIONS".to_owned()));
            let _ = respond_text(
                stream,
                request.is_head(),
                405,
                "Method Not Allowed",
                "Method not allowed",
                &headers,
            );
        }
    }
}

fn handle_options(stream: &mut TcpStream, request: &HttpRequest, origin: Option<&str>) {
    let private_network = request.unique_header("access-control-request-private-network");
    let Ok(private_network) = private_network else {
        let _ = respond_text(
            stream,
            false,
            400,
            "Bad Request",
            "Bad request",
            &cors_headers(origin),
        );
        return;
    };
    let mut headers = cors_headers(origin);
    headers.push((
        "Access-Control-Allow-Methods",
        "GET, HEAD, OPTIONS".to_owned(),
    ));
    headers.push((
        "Access-Control-Allow-Headers",
        "Range, X-OSG-Media-Token".to_owned(),
    ));
    headers.push(("Access-Control-Max-Age", "600".to_owned()));
    if private_network == Some("true") {
        headers.push(("Access-Control-Allow-Private-Network", "true".to_owned()));
    }
    let _ = respond_empty(stream, 204, "No Content", &headers);
}

fn handle_asset_request(
    context: &ServerContext,
    stream: &mut TcpStream,
    request: &HttpRequest,
    origin: Option<&str>,
    stopping: &AtomicBool,
) {
    let Some(id) = asset_id(&request.target) else {
        let _ = respond_text(
            stream,
            request.is_head(),
            404,
            "Not Found",
            "Media not found",
            &cors_headers(origin),
        );
        return;
    };
    let entry = {
        let Ok(mut assets) = context.assets.write() else {
            let _ = respond_text(
                stream,
                request.is_head(),
                500,
                "Internal Server Error",
                "Media registry unavailable",
                &cors_headers(origin),
            );
            return;
        };
        let now = Instant::now();
        purge_expired_images(&mut assets, now);
        assets.get_mut(&id).map(|entry| {
            if let MediaSource::Image { last_accessed, .. } = &mut entry.source {
                *last_accessed = now;
            }
            CloneableEntry::from(&*entry)
        })
    };
    let Some(entry) = entry else {
        let _ = respond_text(
            stream,
            request.is_head(),
            404,
            "Not Found",
            "Media not found",
            &cors_headers(origin),
        );
        return;
    };
    serve_entry(stream, request, origin, id, &entry, stopping);
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

fn serve_entry(
    stream: &mut TcpStream,
    request: &HttpRequest,
    origin: Option<&str>,
    id: Uuid,
    entry: &CloneableEntry,
    stopping: &AtomicBool,
) {
    let byte_length = match &entry.source {
        CloneableSource::File { file, modified } => match file.metadata() {
            Ok(metadata)
                if metadata.is_file()
                    && metadata.len() == entry.byte_length
                    && metadata.modified().ok() == *modified =>
            {
                metadata.len()
            }
            _ => {
                let _ = respond_text(
                    stream,
                    request.is_head(),
                    409,
                    "Conflict",
                    "Media changed on disk",
                    &cors_headers(origin),
                );
                return;
            }
        },
        CloneableSource::Image(bytes) => {
            let Ok(byte_length) = u64::try_from(bytes.len()) else {
                return;
            };
            if byte_length != entry.byte_length || byte_length == 0 {
                return;
            }
            byte_length
        }
    };
    let Ok(range_header) = request.unique_header("range") else {
        let _ = respond_text(
            stream,
            request.is_head(),
            400,
            "Bad Request",
            "Bad request",
            &cors_headers(origin),
        );
        return;
    };
    let Ok(range) = parse_range(range_header, byte_length) else {
        let mut headers = common_media_headers(origin, id, entry);
        headers.push(("Content-Range", format!("bytes */{byte_length}")));
        let _ = respond_empty(stream, 416, "Range Not Satisfiable", &headers);
        return;
    };
    let (start, end, status, reason) = match range {
        Some((start, end)) => (start, end, 206, "Partial Content"),
        None => (0, byte_length - 1, 200, "OK"),
    };
    let response_length = end - start + 1;
    let mut headers = common_media_headers(origin, id, entry);
    if status == 206 {
        headers.push((
            "Content-Range",
            format!("bytes {start}-{end}/{byte_length}"),
        ));
    }

    if write_response_head(stream, status, reason, response_length, &headers).is_err()
        || request.is_head()
    {
        return;
    }
    let result = match &entry.source {
        CloneableSource::File { file, .. } => {
            write_file_range(stream, file, start, response_length, stopping)
        }
        CloneableSource::Image(bytes) => {
            write_memory_range(stream, bytes, start, response_length, stopping)
        }
    };
    let _ = result;
}

fn write_memory_range(
    stream: &mut TcpStream,
    bytes: &[u8],
    offset: u64,
    length: u64,
    stopping: &AtomicBool,
) -> io::Result<()> {
    let start =
        usize::try_from(offset).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let length =
        usize::try_from(length).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let end = start
        .checked_add(length)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    write_all_interruptible(stream, &bytes[start..end], stopping)
}

fn write_file_range(
    stream: &mut TcpStream,
    file: &File,
    mut offset: u64,
    mut remaining: u64,
    stopping: &AtomicBool,
) -> io::Result<()> {
    let mut buffer = vec![0_u8; STREAM_BUFFER_BYTES].into_boxed_slice();
    while remaining != 0 {
        if stopping.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "media server is stopping",
            ));
        }
        let requested = usize::try_from(remaining.min(STREAM_BUFFER_BYTES as u64))
            .expect("the bounded stream chunk fits usize");
        let read = loop {
            match positioned_read(file, &mut buffer[..requested], offset) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                result => break result?,
            }
        };
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "registered media ended during streaming",
            ));
        }
        write_all_interruptible(stream, &buffer[..read], stopping)?;
        let read = u64::try_from(read).expect("read length fits u64");
        offset += read;
        remaining -= read;
    }
    Ok(())
}

fn write_all_interruptible(
    stream: &mut TcpStream,
    mut bytes: &[u8],
    stopping: &AtomicBool,
) -> io::Result<()> {
    let mut progress_deadline = Instant::now() + STALLED_WRITE_DEADLINE;
    while !bytes.is_empty() {
        if stopping.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "media server is stopping",
            ));
        }
        match stream.write(bytes) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
            Ok(written) => {
                bytes = &bytes[written..];
                progress_deadline = Instant::now() + STALLED_WRITE_DEADLINE;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                if Instant::now() >= progress_deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "media client stopped receiving",
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn positioned_read(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    use std::os::unix::fs::FileExt;

    file.read_at(buffer, offset)
}

#[cfg(windows)]
fn positioned_read(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    use std::os::windows::fs::FileExt;

    file.seek_read(buffer, offset)
}

fn parse_range(value: Option<&str>, byte_length: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    if byte_length == 0 {
        return Err(());
    }
    let (unit, value) = value.split_once('=').ok_or(())?;
    if !unit.eq_ignore_ascii_case("bytes") || value.contains(',') {
        return Err(());
    }
    let (start, end) = value.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = parse_decimal(end).ok_or(())?;
        if suffix == 0 {
            return Err(());
        }
        return Ok(Some((byte_length.saturating_sub(suffix), byte_length - 1)));
    }
    let start = parse_decimal(start).ok_or(())?;
    if start >= byte_length {
        return Err(());
    }
    let end = if end.is_empty() {
        byte_length - 1
    } else {
        parse_decimal(end).ok_or(())?.min(byte_length - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some((start, end)))
}

fn parse_decimal(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn asset_id(target: &str) -> Option<Uuid> {
    let path = target.split_once('?').map_or(target, |(path, _)| path);
    let id = path.strip_prefix("/asset/")?;
    if id.contains('/') || id.is_empty() {
        return None;
    }
    Uuid::parse_str(id).ok()
}

fn valid_host(context: &ServerContext, request: &HttpRequest) -> bool {
    request.unique_header("host").is_ok_and(|host| {
        host.is_some_and(|host| {
            host.eq_ignore_ascii_case(&format!("127.0.0.1:{}", context.port))
                || host.eq_ignore_ascii_case(&format!("localhost:{}", context.port))
        })
    })
}

fn valid_token(context: &ServerContext, request: &HttpRequest, token_header: Option<&str>) -> bool {
    if token_header.is_some_and(|value| secure_eq(value, &context.token)) {
        return true;
    }
    request
        .target
        .split_once('?')
        .map(|(_, query)| query)
        .into_iter()
        .flat_map(|query| query.split('&'))
        .filter_map(|pair| pair.split_once('='))
        .any(|(key, value)| key == "token" && secure_eq(value, &context.token))
}

fn secure_eq(candidate: &str, expected: &str) -> bool {
    let candidate = candidate.as_bytes();
    let expected = expected.as_bytes();
    let mut difference = candidate.len() ^ expected.len();
    for (index, expected_byte) in expected.iter().enumerate() {
        difference |= usize::from(candidate.get(index).copied().unwrap_or(0) ^ expected_byte);
    }
    difference == 0
}

type ResponseHeader<'a> = (&'a str, String);

fn common_media_headers<'a>(
    origin: Option<&'a str>,
    id: Uuid,
    entry: &CloneableEntry,
) -> Vec<ResponseHeader<'a>> {
    let mut headers = cors_headers(origin);
    headers.extend([
        ("Content-Type", entry.mime_type.clone()),
        ("Accept-Ranges", "bytes".to_owned()),
        ("Cache-Control", "private, no-store".to_owned()),
        ("ETag", format!("\"{id}-{:x}\"", entry.byte_length)),
        ("X-Content-Type-Options", "nosniff".to_owned()),
        ("Cross-Origin-Resource-Policy", "cross-origin".to_owned()),
    ]);
    headers
}

fn cors_headers(origin: Option<&str>) -> Vec<ResponseHeader<'_>> {
    let Some(origin) = origin else {
        return Vec::new();
    };
    vec![
        ("Access-Control-Allow-Origin", origin.to_owned()),
        ("Vary", "Origin".to_owned()),
        (
            "Access-Control-Expose-Headers",
            "Accept-Ranges, Content-Length, Content-Range, ETag".to_owned(),
        ),
    ]
}

fn respond_text(
    stream: &mut TcpStream,
    head_only: bool,
    status: u16,
    reason: &str,
    body: &str,
    headers: &[ResponseHeader<'_>],
) -> io::Result<()> {
    let mut all_headers = headers.to_vec();
    all_headers.extend([
        ("Content-Type", "text/plain; charset=utf-8".to_owned()),
        ("Cache-Control", "no-store".to_owned()),
        ("X-Content-Type-Options", "nosniff".to_owned()),
    ]);
    write_response_head(
        stream,
        status,
        reason,
        u64::try_from(body.len()).expect("response body length fits u64"),
        &all_headers,
    )?;
    if !head_only {
        stream.write_all(body.as_bytes())?;
    }
    Ok(())
}

fn respond_empty(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    headers: &[ResponseHeader<'_>],
) -> io::Result<()> {
    write_response_head(stream, status, reason, 0, headers)
}

fn write_response_head(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_length: u64,
    headers: &[ResponseHeader<'_>],
) -> io::Result<()> {
    write!(stream, "HTTP/1.1 {status} {reason}\r\n")?;
    for (name, value) in headers {
        if !name.bytes().all(is_token_byte) || !valid_response_header_value(value) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid response header",
            ));
        }
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(
        stream,
        "Content-Length: {content_length}\r\nConnection: close\r\n\r\n"
    )
}

fn valid_configured_origin(origin: &str) -> bool {
    !origin.is_empty()
        && origin.len() <= MAX_ORIGIN_BYTES
        && origin.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn valid_response_header_value(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte == b'\t' || (0x20..=0x7e).contains(&byte))
}

fn write_static_busy(stream: &mut TcpStream) -> io::Result<()> {
    stream.write_all(
        b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 20\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\nMedia server is busy",
    )
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{Duration, Instant};

    use tempfile::TempDir;
    use uuid::Uuid;

    use super::{
        HEADER_READ_DEADLINE, MAX_HEADER_BYTES, MAX_IMAGE_BYTES, MAX_REGISTERED_ASSETS,
        MAX_REGISTERED_IMAGES, MediaServer, MediaServerError, REQUEST_QUEUE_CAPACITY,
        RequestReadError, WORKER_COUNT, parse_range, parse_request_bytes,
    };

    fn fixture() -> (TempDir, MediaServer, super::RegisteredMedia) {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("sample.mp4");
        fs::write(&path, b"0123456789").expect("media fixture");
        let server =
            MediaServer::start(["https://tauri.localhost".to_owned()]).expect("start media server");
        let media = server.register(&path).expect("register media");
        (directory, server, media)
    }

    fn request(port: u16, request: &str) -> Vec<u8> {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect media server");
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .expect("read timeout");
        stream.write_all(request.as_bytes()).expect("send request");
        let mut response = Vec::new();
        if let Err(error) = stream.read_to_end(&mut response) {
            assert!(
                error.kind() == std::io::ErrorKind::ConnectionReset && !response.is_empty(),
                "read response: {error}"
            );
        }
        response
    }

    fn url_parts(url: &str) -> (&str, &str) {
        let path_start = url.find("/asset/").expect("asset path");
        let path = &url[path_start..];
        path.split_once('?').expect("token query")
    }

    fn response_body(response: &[u8]) -> &[u8] {
        let offset = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("response headers")
            + 4;
        &response[offset..]
    }

    #[test]
    fn range_parser_handles_edges_and_rejects_non_grammar_numbers() {
        assert_eq!(parse_range(Some("bytes=2-5"), 10), Ok(Some((2, 5))));
        assert_eq!(parse_range(Some("BYTES=-3"), 10), Ok(Some((7, 9))));
        assert_eq!(parse_range(Some("bytes=-99"), 10), Ok(Some((0, 9))));
        assert_eq!(parse_range(Some("bytes=8-99"), 10), Ok(Some((8, 9))));
        assert!(parse_range(Some("bytes=10-"), 10).is_err());
        assert!(parse_range(Some("bytes=1-2,4-5"), 10).is_err());
        assert!(parse_range(Some("items=1-2"), 10).is_err());
        assert!(parse_range(Some("bytes=+1-2"), 10).is_err());
        assert!(parse_range(Some("bytes=1-+2"), 10).is_err());
        assert!(parse_range(Some("bytes=1-2-3"), 10).is_err());
        assert!(parse_range(Some("bytes=-0"), 10).is_err());
        assert!(parse_range(Some("bytes=0-0"), 0).is_err());
    }

    #[test]
    fn request_parser_rejects_smuggling_and_ambiguous_hosts() {
        let duplicate_host = b"GET / HTTP/1.1\r\nHost: a\r\nHost: b";
        assert_eq!(
            parse_request_bytes(duplicate_host).unwrap_err(),
            RequestReadError::BadRequest
        );
        let transfer_encoding = b"GET / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked";
        assert_eq!(
            parse_request_bytes(transfer_encoding).unwrap_err(),
            RequestReadError::BadRequest
        );
        let body = b"GET / HTTP/1.1\r\nHost: a\r\nContent-Length: 1";
        assert_eq!(
            parse_request_bytes(body).unwrap_err(),
            RequestReadError::BadRequest
        );
        let folded = b"GET / HTTP/1.1\r\nHost: a\r\n continued";
        assert_eq!(
            parse_request_bytes(folded).unwrap_err(),
            RequestReadError::BadRequest
        );
    }

    #[test]
    fn streams_full_and_partial_bodies_without_exposing_paths() {
        let (_directory, server, media) = fixture();
        let (path, query) = url_parts(&media.playback_url);
        let token = query.strip_prefix("token=").expect("capability token");
        assert_eq!(media.id.get_version_num(), 4);
        assert!(!media.playback_url.contains("sample.mp4"));
        assert!(!format!("{media:?}").contains("sample.mp4"));
        assert!(!format!("{media:?}").contains(token));
        assert!(!format!("{server:?}").contains(token));

        let full = request(
            server.port(),
            &format!(
                "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        assert!(String::from_utf8_lossy(&full).starts_with("HTTP/1.1 200"));
        assert_eq!(response_body(&full), b"0123456789");

        let partial = request(
            server.port(),
            &format!(
                "GET {path}?{query} HTTP/1.1\r\nHost: localhost:{}\r\nRange: bytes=2-5\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        let partial_text = String::from_utf8_lossy(&partial);
        assert!(partial_text.starts_with("HTTP/1.1 206"));
        assert!(partial_text.contains("Content-Range: bytes 2-5/10"));
        assert_eq!(response_body(&partial), b"2345");
    }

    #[test]
    fn trusted_mime_registration_streams_extensionless_durable_media() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("o-content-addressed-artifact");
        fs::write(&path, b"0123456789").expect("durable media fixture");
        let server =
            MediaServer::start(["https://tauri.localhost".to_owned()]).expect("media server");
        let media = server
            .register_with_extension(&path, "mp4")
            .expect("register trusted media metadata");

        assert_eq!(media.mime_type, "video/mp4");
        assert!(!media.playback_url.contains("content-addressed"));
        let (asset_path, query) = url_parts(&media.playback_url);
        let response = request(
            server.port(),
            &format!(
                "GET {asset_path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nRange: bytes=3-6\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 206"));
        assert_eq!(response_body(&response), b"3456");
    }

    #[test]
    fn trusted_mime_registration_rejects_non_media_and_header_injection() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("artifact");
        fs::write(&path, b"media").expect("fixture");
        let server = MediaServer::start(std::iter::empty()).expect("media server");

        for mime_type in [
            "application/octet-stream",
            "video/",
            "video/mp4\r\nX-Injected: yes",
            "video/mp4; charset=utf-8",
        ] {
            assert!(server.register_with_mime_type(&path, mime_type).is_err());
        }
        assert!(server.register_with_extension(&path, "../mp4").is_err());
        assert!(server.register_with_extension(&path, "unknownext").is_err());
    }

    #[test]
    fn supports_head_and_returns_well_framed_range_errors() {
        let (_directory, server, media) = fixture();
        let (path, query) = url_parts(&media.playback_url);
        let head = request(
            server.port(),
            &format!(
                "HEAD {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        let head_text = String::from_utf8_lossy(&head);
        assert!(head_text.starts_with("HTTP/1.1 200"));
        assert!(head_text.contains("Content-Length: 10"));
        assert!(response_body(&head).is_empty());

        let invalid = request(
            server.port(),
            &format!(
                "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nRange: bytes=99-\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        let invalid_text = String::from_utf8_lossy(&invalid);
        assert!(invalid_text.starts_with("HTTP/1.1 416"));
        assert!(invalid_text.contains("Content-Range: bytes */10"));
        assert!(invalid_text.contains("Content-Length: 0"));
        assert!(response_body(&invalid).is_empty());
    }

    #[test]
    fn rejects_missing_tokens_hosts_origins_duplicates_and_unknown_assets() {
        let (_directory, server, media) = fixture();
        let (path, query) = url_parts(&media.playback_url);
        let missing_token = request(
            server.port(),
            &format!(
                "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        assert!(String::from_utf8_lossy(&missing_token).starts_with("HTTP/1.1 403"));

        let invalid_host = request(
            server.port(),
            &format!(
                "GET {path}?{query} HTTP/1.1\r\nHost: attacker.invalid\r\nConnection: close\r\n\r\n"
            ),
        );
        assert!(String::from_utf8_lossy(&invalid_host).starts_with("HTTP/1.1 403"));

        let invalid_origin = request(
            server.port(),
            &format!(
                "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://attacker.invalid\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        assert!(String::from_utf8_lossy(&invalid_origin).starts_with("HTTP/1.1 403"));

        let duplicate_origin = request(
            server.port(),
            &format!(
                "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://tauri.localhost\r\nOrigin: https://tauri.localhost\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        assert!(String::from_utf8_lossy(&duplicate_origin).starts_with("HTTP/1.1 400"));

        let unknown_path = path.replace(&media.id.to_string(), &Uuid::new_v4().to_string());
        let unknown = request(
            server.port(),
            &format!(
                "GET {unknown_path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        assert!(String::from_utf8_lossy(&unknown).starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn handles_cors_preflight_and_method_rejection() {
        let (_directory, server, media) = fixture();
        let (path, query) = url_parts(&media.playback_url);
        let preflight = request(
            server.port(),
            &format!(
                "OPTIONS {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://tauri.localhost\r\nAccess-Control-Request-Private-Network: true\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        let preflight = String::from_utf8_lossy(&preflight);
        assert!(preflight.starts_with("HTTP/1.1 204"));
        assert!(preflight.contains("Access-Control-Allow-Origin: https://tauri.localhost"));
        assert!(preflight.contains("Access-Control-Allow-Private-Network: true"));

        let post = request(
            server.port(),
            &format!(
                "POST {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        let post = String::from_utf8_lossy(&post);
        assert!(post.starts_with("HTTP/1.1 405"));
        assert!(post.contains("Allow: GET, HEAD, OPTIONS"));
    }

    #[test]
    fn supports_header_capabilities_and_rejects_ambiguous_credentials() {
        let (_directory, server, media) = fixture();
        let (path, query) = url_parts(&media.playback_url);
        let token = query.strip_prefix("token=").expect("capability token");
        let response = request(
            server.port(),
            &format!(
                "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://tauri.localhost\r\nX-OSG-Media-Token: {token}\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        let response_text = String::from_utf8_lossy(&response);
        assert!(response_text.starts_with("HTTP/1.1 200"));
        assert!(response_text.contains("Access-Control-Allow-Origin: https://tauri.localhost"));
        assert!(response_text.contains("Cross-Origin-Resource-Policy: cross-origin"));

        let duplicate = request(
            server.port(),
            &format!(
                "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-OSG-Media-Token: {token}\r\nX-OSG-Media-Token: {token}\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        assert!(String::from_utf8_lossy(&duplicate).starts_with("HTTP/1.1 400"));
    }

    #[test]
    fn concurrent_ranges_do_not_share_file_cursor_state() {
        let (_directory, server, media) = fixture();
        let server = Arc::new(server);
        let barrier = Arc::new(Barrier::new(17));
        let (path, query) = url_parts(&media.playback_url);
        let path = path.to_owned();
        let query = query.to_owned();
        let mut threads = Vec::new();
        for index in 0_u8..16 {
            let server = Arc::clone(&server);
            let barrier = Arc::clone(&barrier);
            let path = path.clone();
            let query = query.clone();
            threads.push(thread::spawn(move || {
                barrier.wait();
                let digit = index % 10;
                let response = request(
                    server.port(),
                    &format!(
                        "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nRange: bytes={digit}-{digit}\r\nConnection: close\r\n\r\n",
                        server.port()
                    ),
                );
                assert_eq!(response_body(&response), &[b'0' + digit]);
            }));
        }
        barrier.wait();
        for thread in threads {
            thread.join().expect("range request");
        }
    }

    #[test]
    fn registered_handle_cannot_be_redirected_by_replacing_the_path() {
        let (directory, server, media) = fixture();
        let path = directory.path().join("sample.mp4");
        fs::write(&path, b"replacement with a different length").expect("replace fixture");
        let (asset_path, query) = url_parts(&media.playback_url);
        let response = request(
            server.port(),
            &format!(
                "GET {asset_path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        let text = String::from_utf8_lossy(&response);
        assert!(text.starts_with("HTTP/1.1 409") || response_body(&response) == b"0123456789");
        assert!(!response.ends_with(b"replacement with a different length"));
    }

    #[test]
    fn oversized_headers_are_rejected_without_growing_unbounded() {
        let (_directory, server, _media) = fixture();
        let oversized = format!(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-Fill: {}\r\n\r\n",
            server.port(),
            "a".repeat(MAX_HEADER_BYTES)
        );
        let response = request(server.port(), &oversized);
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 431"));
    }

    #[test]
    fn shutdown_interrupts_a_stalled_large_response() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("large.mp4");
        let file = File::create(&path).expect("large fixture");
        file.set_len(32 * 1024 * 1024).expect("size large fixture");
        let server = MediaServer::start(std::iter::empty()).expect("start media server");
        let media = server.register(&path).expect("register media");
        let (path, query) = url_parts(&media.playback_url);
        let mut stream = TcpStream::connect(("127.0.0.1", server.port())).expect("connect");
        stream
            .write_all(
                format!(
                    "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                    server.port()
                )
                .as_bytes(),
            )
            .expect("request large media");
        thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        drop(server);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "shutdown exceeded the bounded socket timeout"
        );
        drop(stream);
    }

    #[test]
    fn incomplete_clients_are_bounded_and_excess_connections_get_backpressure() {
        let server = MediaServer::start(std::iter::empty()).expect("start media server");
        let client_count = WORKER_COUNT + REQUEST_QUEUE_CAPACITY + 8;
        let mut clients = Vec::with_capacity(client_count);
        for index in 0..client_count {
            let stream = TcpStream::connect(("127.0.0.1", server.port())).expect("connect client");
            stream
                .set_nonblocking(true)
                .expect("nonblocking overload client");
            clients.push(stream);
            if index + 1 == WORKER_COUNT {
                thread::sleep(Duration::from_millis(50));
            }
        }

        let mut responses = vec![Vec::new(); client_count];
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut overloaded = false;
        while Instant::now() < deadline && !overloaded {
            for (stream, response) in clients.iter_mut().zip(&mut responses) {
                let mut buffer = [0_u8; 512];
                loop {
                    match stream.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(length) => response.extend_from_slice(&buffer[..length]),
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock
                                    | std::io::ErrorKind::ConnectionReset
                            ) =>
                        {
                            break;
                        }
                        Err(error) => panic!("read overload response: {error}"),
                    }
                }
                if response.starts_with(b"HTTP/1.1 503") {
                    overloaded = true;
                    break;
                }
            }
            if !overloaded {
                thread::sleep(Duration::from_millis(5));
            }
        }
        assert!(
            overloaded,
            "excess clients did not receive bounded backpressure"
        );
        drop(clients);
        drop(server);
    }

    #[test]
    fn rejects_invalid_configured_origins_and_empty_files() {
        assert!(MediaServer::start(["https://valid.invalid\r\nInjected: yes".to_owned()]).is_err());
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("empty.mp4");
        fs::write(&path, []).expect("empty fixture");
        let server = MediaServer::start(std::iter::empty()).expect("start media server");
        assert!(server.register(&path).is_err());
        assert_eq!(HEADER_READ_DEADLINE, Duration::from_secs(5));
    }

    #[test]
    fn registry_capacity_is_bounded_and_recoverable() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("sample.mp4");
        fs::write(&path, b"media").expect("media fixture");
        let server = MediaServer::start(std::iter::empty()).expect("start media server");
        let mut first_id = None;
        for index in 0..MAX_REGISTERED_ASSETS {
            let media = server.register(&path).expect("register within capacity");
            if index == 0 {
                first_id = Some(media.id);
            }
        }
        assert!(matches!(
            server.register(&path),
            Err(MediaServerError::RegistryFull)
        ));
        assert!(
            server
                .unregister(first_id.expect("first media ID"))
                .expect("unregister media")
        );
        server
            .register(&path)
            .expect("capacity is released by unregister");
    }

    #[test]
    fn registered_images_use_the_same_tokenized_range_transport() {
        let server =
            MediaServer::start(["https://tauri.localhost".to_owned()]).expect("start media server");
        let image = server
            .register_image("image/png", b"\x89PNG\r\n\x1a\nprivate-image".to_vec())
            .expect("register image");
        assert_eq!(image.mime_type, "image/png");
        let (path, query) = url_parts(&image.playback_url);
        let response = request(
            server.port(),
            &format!(
                "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://tauri.localhost\r\nRange: bytes=8-14\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        let headers = String::from_utf8_lossy(&response);
        assert!(headers.starts_with("HTTP/1.1 206"));
        assert!(headers.contains("Content-Type: image/png"));
        assert!(headers.contains("X-Content-Type-Options: nosniff"));
        assert_eq!(response_body(&response), b"private");
    }

    #[test]
    fn image_registration_rejects_mime_confusion_and_oversized_payloads() {
        let server = MediaServer::start(std::iter::empty()).expect("start media server");
        for (mime_type, bytes) in [
            ("image/svg+xml", b"<svg></svg>".to_vec()),
            ("image/jpeg", b"\x89PNG\r\n\x1a\nnot-jpeg".to_vec()),
            (
                "image/png; charset=binary",
                b"\x89PNG\r\n\x1a\nimage".to_vec(),
            ),
            ("text/html", b"<script>alert(1)</script>".to_vec()),
        ] {
            assert!(matches!(
                server.register_image(mime_type, bytes),
                Err(MediaServerError::InvalidPath)
            ));
        }
        let mut oversized = vec![0_u8; MAX_IMAGE_BYTES + 1];
        oversized[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        assert!(matches!(
            server.register_image("image/png", oversized),
            Err(MediaServerError::InvalidPath)
        ));
    }

    #[test]
    fn image_batch_registration_is_atomic_and_never_evicts_its_own_results() {
        let server = MediaServer::start(std::iter::empty()).expect("start media server");
        let retained = server
            .register_images(
                (0..MAX_REGISTERED_IMAGES)
                    .map(|index| {
                        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
                        bytes.extend_from_slice(index.to_string().as_bytes());
                        ("image/png".to_owned(), bytes)
                    })
                    .collect(),
            )
            .expect("atomic image batch");
        assert_eq!(retained.len(), MAX_REGISTERED_IMAGES);
        let assets = server.inner.context.assets.read().expect("image registry");
        assert!(retained.iter().all(|image| assets.contains_key(&image.id)));
        drop(assets);

        let oversized_batch = (0..=MAX_REGISTERED_IMAGES)
            .map(|index| {
                let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
                bytes.extend_from_slice(index.to_string().as_bytes());
                ("image/png".to_owned(), bytes)
            })
            .collect();
        assert!(matches!(
            server.register_images(oversized_batch),
            Err(MediaServerError::InvalidPath)
        ));
        let assets = server.inner.context.assets.read().expect("image registry");
        assert!(retained.iter().all(|image| assets.contains_key(&image.id)));
    }

    #[test]
    fn image_registry_evicts_lru_entries_and_expires_capabilities() {
        let server = MediaServer::start(std::iter::empty()).expect("start media server");
        let first = server
            .register_image("image/png", b"\x89PNG\r\n\x1a\nfirst".to_vec())
            .expect("first image");
        for index in 1..=MAX_REGISTERED_IMAGES {
            let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
            bytes.extend_from_slice(index.to_string().as_bytes());
            server
                .register_image("image/png", bytes)
                .expect("bounded image registration");
        }
        let (first_path, first_query) = url_parts(&first.playback_url);
        let evicted = request(
            server.port(),
            &format!(
                "GET {first_path}?{first_query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        assert!(String::from_utf8_lossy(&evicted).starts_with("HTTP/1.1 404"));

        let expiring = server
            .register_image_with_lifetime(
                "image/png",
                b"\x89PNG\r\n\x1a\nshort-lived".to_vec(),
                Duration::from_millis(1),
            )
            .expect("short-lived image");
        thread::sleep(Duration::from_millis(10));
        let (path, query) = url_parts(&expiring.playback_url);
        let expired = request(
            server.port(),
            &format!(
                "GET {path}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                server.port()
            ),
        );
        assert!(String::from_utf8_lossy(&expired).starts_with("HTTP/1.1 404"));
    }
}
