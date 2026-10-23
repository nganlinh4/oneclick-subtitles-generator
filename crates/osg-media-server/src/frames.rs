//! Element-loadable delivery for natively rendered frames.
//!
//! The editor `WebView` may only reach this server through `<img>` and `<video>` element loads, so
//! a natively rendered frame is published as an ordinary image response addressed by an opaque
//! capability, a per-registration token, and a zero-based frame index. Frame bytes are held in
//! memory: this boundary accepts no filesystem path, stores none, and renders none into any
//! response or error.
//!
//! The transport reuses the request parsing, header validation, and response writing that already
//! serve registered media. Only the lookup is new.

use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use uuid::Uuid;

use crate::auth::secure_eq;
use crate::images::canonical_image_mime_type;
use crate::range::serve_entry;
use crate::request::HttpRequest;
use crate::response::{cors_headers, respond_text};
use crate::{CloneableEntry, MediaServer, MediaServerError, ServerContext};

/// Maximum frame sequences retained at once.
const MAX_FRAME_SEQUENCES: usize = 8;
/// Maximum frames a single sequence may carry.
const MAX_SEQUENCE_FRAMES: usize = 480;
/// Maximum encoded bytes for one frame.
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// Maximum encoded bytes retained across every registered sequence.
const MAX_FRAME_REGISTRY_BYTES: usize = 64 * 1024 * 1024;
const FRAME_SEQUENCE_LIFETIME: Duration = Duration::from_mins(10);
const FRAME_PATH_PREFIX: &str = "/frame/";
const FRAME_TOKEN_KEY: &str = "frame_token";
/// Bounds the frame index before parsing so a hostile target cannot overflow the parse.
const MAX_FRAME_INDEX_DIGITS: usize = 9;

/// An opaque capability for one natively rendered frame sequence.
///
/// [`Self::frame_url_template`] carries a literal `{frame}` placeholder that the consumer replaces
/// with a zero-based frame index. The template is the only way to reach the frames and it never
/// contains a filesystem path.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredFrameSequence {
    pub id: Uuid,
    pub frame_count: usize,
    pub mime_type: String,
    pub frame_url_template: String,
    /// Retained for the native owner so it can revoke the capability it just published.
    #[serde(skip)]
    token: String,
}

impl std::fmt::Debug for RegisteredFrameSequence {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RegisteredFrameSequence")
            .field("id", &self.id)
            .field("frame_count", &self.frame_count)
            .field("mime_type", &self.mime_type)
            .finish_non_exhaustive()
    }
}

impl RegisteredFrameSequence {
    /// Returns the per-registration token that authorizes revoking this capability.
    #[must_use]
    pub fn registration_token(&self) -> &str {
        &self.token
    }

    /// Resolves the element-loadable URL for one frame, or `None` when the index is out of range.
    #[must_use]
    pub fn frame_url(&self, index: usize) -> Option<String> {
        if index >= self.frame_count {
            return None;
        }
        Some(
            self.frame_url_template
                .replace("{frame}", &index.to_string()),
        )
    }
}

impl MediaServer {
    /// Publishes a bounded, natively rendered frame sequence as element-loadable images.
    ///
    /// Every frame is signature-checked against the single declared image MIME type. The sequence
    /// is inserted atomically: either all frames become reachable under one capability or none do.
    /// Least-recently-used sequences are evicted to make room, and every sequence expires.
    pub fn register_frame_sequence(
        &self,
        mime_type: &str,
        frames: Vec<Vec<u8>>,
    ) -> Result<RegisteredFrameSequence, MediaServerError> {
        self.register_frame_sequence_with_lifetime(mime_type, frames, FRAME_SEQUENCE_LIFETIME)
    }

    fn register_frame_sequence_with_lifetime(
        &self,
        mime_type: &str,
        frames: Vec<Vec<u8>>,
        lifetime: Duration,
    ) -> Result<RegisteredFrameSequence, MediaServerError> {
        let context = &self.inner.context;
        let published = context.frames.insert(mime_type, frames, lifetime)?;
        Ok(RegisteredFrameSequence {
            id: published.id,
            frame_count: published.frame_count,
            mime_type: published.mime_type,
            frame_url_template: format!(
                "http://127.0.0.1:{}{FRAME_PATH_PREFIX}{}/{{frame}}?token={}&{FRAME_TOKEN_KEY}={}",
                context.port, published.id, context.token, published.token
            ),
            token: published.token,
        })
    }

    /// Removes a frame-sequence capability for a caller that presents its registration token.
    pub fn unregister_frame_sequence(
        &self,
        id: Uuid,
        token: &str,
    ) -> Result<bool, MediaServerError> {
        self.inner.context.frames.remove(id, token)
    }
}

/// The process-scoped store of published frame sequences.
#[derive(Default)]
pub(crate) struct FrameRegistry {
    sequences: RwLock<HashMap<Uuid, FrameSequence>>,
    /// Monotonic recency stamp. A counter rather than a clock keeps eviction order total and
    /// reproducible even when two registrations land inside one clock tick.
    access_counter: AtomicU64,
}

impl std::fmt::Debug for FrameRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let sequence_count = self.sequences.read().map_or(0, |sequences| sequences.len());
        formatter
            .debug_struct("FrameRegistry")
            .field("sequence_count", &sequence_count)
            .finish_non_exhaustive()
    }
}

struct FrameSequence {
    token: String,
    mime_type: String,
    frames: Vec<Arc<[u8]>>,
    total_bytes: usize,
    expires_at: Instant,
    last_accessed: u64,
}

struct PublishedSequence {
    id: Uuid,
    token: String,
    mime_type: String,
    frame_count: usize,
}

enum FrameLookup {
    Unavailable,
    Missing,
    Forbidden,
    Found { mime_type: String, bytes: Arc<[u8]> },
}

impl FrameRegistry {
    fn next_access(&self) -> u64 {
        self.access_counter.fetch_add(1, Ordering::Relaxed)
    }

    fn insert(
        &self,
        mime_type: &str,
        frames: Vec<Vec<u8>>,
        lifetime: Duration,
    ) -> Result<PublishedSequence, MediaServerError> {
        if frames.is_empty() || frames.len() > MAX_SEQUENCE_FRAMES || lifetime.is_zero() {
            return Err(MediaServerError::InvalidPath);
        }
        let mut total_bytes = 0_usize;
        for bytes in &frames {
            if bytes.is_empty()
                || bytes.len() > MAX_FRAME_BYTES
                || canonical_image_mime_type(mime_type, bytes).is_none()
            {
                return Err(MediaServerError::InvalidPath);
            }
            total_bytes = total_bytes
                .checked_add(bytes.len())
                .filter(|total| *total <= MAX_FRAME_REGISTRY_BYTES)
                .ok_or(MediaServerError::RegistryFull)?;
        }
        let frame_count = frames.len();
        let prepared: Vec<Arc<[u8]>> = frames.into_iter().map(Arc::from).collect();

        let now = Instant::now();
        let id = Uuid::new_v4();
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let last_accessed = self.next_access();
        let mut sequences = self
            .sequences
            .write()
            .map_err(|_| MediaServerError::RegistryUnavailable)?;
        purge_expired_sequences(&mut sequences, now);
        make_frame_capacity(&mut sequences, total_bytes)?;
        sequences.insert(
            id,
            FrameSequence {
                token: token.clone(),
                mime_type: mime_type.to_owned(),
                frames: prepared,
                total_bytes,
                expires_at: now + lifetime,
                last_accessed,
            },
        );
        drop(sequences);
        Ok(PublishedSequence {
            id,
            token,
            mime_type: mime_type.to_owned(),
            frame_count,
        })
    }

    fn lookup(&self, id: Uuid, token: Option<&str>, index: usize) -> FrameLookup {
        let recency = self.next_access();
        let Ok(mut sequences) = self.sequences.write() else {
            return FrameLookup::Unavailable;
        };
        purge_expired_sequences(&mut sequences, Instant::now());
        let Some(sequence) = sequences.get_mut(&id) else {
            return FrameLookup::Missing;
        };
        if !token.is_some_and(|value| secure_eq(value, &sequence.token)) {
            return FrameLookup::Forbidden;
        }
        let Some(bytes) = sequence.frames.get(index).map(Arc::clone) else {
            return FrameLookup::Missing;
        };
        sequence.last_accessed = recency;
        FrameLookup::Found {
            mime_type: sequence.mime_type.clone(),
            bytes,
        }
    }

    fn remove(&self, id: Uuid, token: &str) -> Result<bool, MediaServerError> {
        let mut sequences = self
            .sequences
            .write()
            .map_err(|_| MediaServerError::RegistryUnavailable)?;
        purge_expired_sequences(&mut sequences, Instant::now());
        let Some(sequence) = sequences.get(&id) else {
            return Ok(false);
        };
        if !secure_eq(token, &sequence.token) {
            return Err(MediaServerError::InvalidPath);
        }
        Ok(sequences.remove(&id).is_some())
    }
}

fn purge_expired_sequences(sequences: &mut HashMap<Uuid, FrameSequence>, now: Instant) {
    sequences.retain(|_, sequence| sequence.expires_at > now);
}

fn make_frame_capacity(
    sequences: &mut HashMap<Uuid, FrameSequence>,
    incoming_bytes: usize,
) -> Result<(), MediaServerError> {
    if incoming_bytes == 0 || incoming_bytes > MAX_FRAME_REGISTRY_BYTES {
        return Err(MediaServerError::RegistryFull);
    }
    loop {
        let retained_bytes = sequences
            .values()
            .map(|sequence| sequence.total_bytes)
            .try_fold(0_usize, usize::checked_add)
            .ok_or(MediaServerError::RegistryFull)?;
        let has_capacity = sequences.len() < MAX_FRAME_SEQUENCES
            && retained_bytes
                .checked_add(incoming_bytes)
                .is_some_and(|total| total <= MAX_FRAME_REGISTRY_BYTES);
        if has_capacity {
            return Ok(());
        }
        let oldest = sequences
            .iter()
            .min_by_key(|(_, sequence)| sequence.last_accessed)
            .map(|(id, _)| *id)
            .ok_or(MediaServerError::RegistryFull)?;
        sequences.remove(&oldest);
    }
}

/// Reports whether a request target addresses the frame transport.
pub(crate) fn is_frame_target(path: &str) -> bool {
    path.starts_with(FRAME_PATH_PREFIX)
}

/// Serves one frame of a published sequence as an ordinary image response.
///
/// The caller has already validated the request framing, the host, the allowed origin, and the
/// server capability token. This adds the per-registration token and the frame index, and refuses
/// every other case without describing what was wrong.
pub(crate) fn handle_frame_request(
    context: &ServerContext,
    stream: &mut TcpStream,
    request: &HttpRequest,
    origin: Option<&str>,
    stopping: &AtomicBool,
) {
    let Some((id, index)) = parse_frame_target(request.path()) else {
        respond_not_found(stream, request, origin);
        return;
    };
    let token = unique_query_value(&request.target, FRAME_TOKEN_KEY);
    match context.frames.lookup(id, token, index) {
        FrameLookup::Unavailable => {
            let _ = respond_text(
                stream,
                request.is_head(),
                500,
                "Internal Server Error",
                "Frame registry unavailable",
                &cors_headers(origin),
            );
        }
        FrameLookup::Forbidden => {
            let _ = respond_text(
                stream,
                request.is_head(),
                403,
                "Forbidden",
                "Forbidden",
                &cors_headers(origin),
            );
        }
        FrameLookup::Missing => respond_not_found(stream, request, origin),
        FrameLookup::Found { mime_type, bytes } => {
            let Some(entry) = CloneableEntry::from_memory(mime_type, bytes) else {
                respond_not_found(stream, request, origin);
                return;
            };
            serve_entry(
                stream,
                request,
                origin,
                &format!("{id}-{index}"),
                &entry,
                stopping,
            );
        }
    }
}

fn respond_not_found(stream: &mut TcpStream, request: &HttpRequest, origin: Option<&str>) {
    let _ = respond_text(
        stream,
        request.is_head(),
        404,
        "Not Found",
        "Frame not found",
        &cors_headers(origin),
    );
}

/// Parses `/frame/{capability}/{index}` into its opaque capability and zero-based index.
///
/// The index grammar is exact: bare decimal digits with no sign, no padding, and no leading zero,
/// so one frame has exactly one canonical target.
fn parse_frame_target(path: &str) -> Option<(Uuid, usize)> {
    let (id, index) = path.strip_prefix(FRAME_PATH_PREFIX)?.split_once('/')?;
    if index.is_empty()
        || index.len() > MAX_FRAME_INDEX_DIGITS
        || !index.bytes().all(|byte| byte.is_ascii_digit())
        || (index.len() > 1 && index.starts_with('0'))
    {
        return None;
    }
    Some((Uuid::parse_str(id).ok()?, index.parse().ok()?))
}

/// Reads a query parameter that must appear exactly once, so an ambiguous credential is refused.
fn unique_query_value<'a>(target: &'a str, key: &str) -> Option<&'a str> {
    let mut values = target
        .split_once('?')
        .map(|(_, query)| query)
        .into_iter()
        .flat_map(|query| query.split('&'))
        .filter_map(|pair| pair.split_once('='))
        .filter(|(name, _)| *name == key)
        .map(|(_, value)| value);
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    Some(value)
}

#[cfg(test)]
mod tests;
