//! The source frame the composited layer is drawn over, decoded once and kept.
//!
//! # Why this is not simply a call to `osg-decode`
//!
//! Two things force a structure here rather than one function.
//!
//! **A decoder cannot be shared the way the compositor is.** `osg_decode::VideoDecoder` is
//! documented as used from the thread that created it, because the audited backend is a COM API
//! whose objects belong to the apartment they were created in — and, concretely, the interfaces
//! `windows` hands back are raw pointers and are neither `Send` nor `Sync`, so a decoder cannot be
//! held in the [`super::host::PreviewHost`] at all. It is therefore owned by a thread of its own:
//! opened there, used there, dropped there. What crosses the channel is a frame index in one
//! direction and a plain byte buffer in the other, both of which are ordinary data.
//!
//! **Opening a decoder per request would make scrubbing unusable.** Opening a source costs a file
//! open, a stream negotiation and a seek; decoding the *next* frame after one already decoded costs
//! a single sample read, because `osg-decode` prefers walking forward to seeking within its own
//! scan budget. Keeping one decoder alive across a scrub is what turns the second cost into the one
//! that is paid, so exactly one is kept: the next request for the same media and the same output
//! timeline reuses it, and any other request closes it before opening the next.
//!
//! # What identifies "the same source"
//!
//! The media's opaque [`AssetId`] and the [`DecoderConfig`] the conversion produced. The
//! configuration carries the **output** timeline — the trim offset and the output frame rate — so a
//! trim or a frame-rate change is a different decoder rather than the same one answering against a
//! grid it was not opened for. No filesystem path is retained: the path is used to open the source
//! and dropped, and identity is the asset the editor named.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, mpsc};
use std::thread::{self, JoinHandle};

use osg_compositor::{Crop, SourceFrame, VideoUnderlay};
use osg_decode::{DecodeError, DecodedFrame, DecoderConfig, open_decoder};
use osg_domain::AssetId;

use super::refusal::PreviewRefusal;

/// The name the decoder thread runs under, so it is identifiable in a debugger or a crash dump.
const DECODER_THREAD_NAME: &str = "osg-preview-decode";

/// One decoded source frame, in exactly the representation [`SourceFrame::new`] takes.
///
/// `osg_decode::DecodedFrame::pixels` is tightly packed RGBA8 and `SourceFrame` is tightly packed
/// RGBA8, so the seam between the decoder and the compositor is a byte buffer and neither side
/// reinterprets the other's pixels.
pub(crate) struct DecodedSource {
    width: u32,
    height: u32,
    source_index: u64,
    pixels: Vec<u8>,
}

impl fmt::Debug for DecodedSource {
    /// Redacted: the pixels are the user's video, exactly as `osg_decode::DecodedFrame` redacts its
    /// own.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DecodedSource")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("source_index", &self.source_index)
            .field("bytes", &self.pixels.len())
            .finish_non_exhaustive()
    }
}

impl From<DecodedFrame> for DecodedSource {
    fn from(frame: DecodedFrame) -> Self {
        // Saturating rather than refusing, exactly as `osg_export::FrameRenderer` does: a frame this
        // large cannot exist — the decoder's own geometry bound is far below `u32::MAX` — and
        // `SourceFrame::new` refuses a buffer that does not match its dimensions anyway.
        let width = u32::try_from(frame.width()).unwrap_or(u32::MAX);
        let height = u32::try_from(frame.height()).unwrap_or(u32::MAX);
        let source_index = frame.source_index();
        Self {
            width,
            height,
            source_index,
            pixels: frame.into_pixels(),
        }
    }
}

impl DecodedSource {
    /// Pairs the frame with the crop, flip and canvas backfill the conversion produced.
    ///
    /// # Errors
    /// Returns [`PreviewRefusal::SceneRejected`] when the frame is larger than the compositor will
    /// allocate or its buffer is not exactly its own dimensions.
    pub(crate) fn underlay(self, crop: Crop) -> Result<VideoUnderlay, PreviewRefusal> {
        let source = SourceFrame::new(self.width, self.height, self.pixels)?;
        Ok(VideoUnderlay::new(source, crop))
    }

    /// Which frame of the source this is, on the source's own frame grid.
    #[cfg(test)]
    pub(crate) const fn source_index(&self) -> u64 {
        self.source_index
    }

    /// The decoded pixels, for the tests that compare them with the export's own decode.
    #[cfg(test)]
    pub(crate) fn pixels(&self) -> &[u8] {
        &self.pixels
    }
}

/// One request to the decoder thread.
enum DecodeJob {
    /// Decode the source frame output frame `index` shows.
    Frame {
        index: u32,
        reply: mpsc::SyncSender<Result<DecodedSource, DecodeError>>,
    },
    /// What the decoder has had to do so far.
    ///
    /// Test-only, and the reason the reuse guarantee is assertable rather than described: a forward
    /// scrub that re-seeks per frame and one that walks look identical from the outside.
    #[cfg(test)]
    Stats {
        reply: mpsc::SyncSender<osg_decode::DecodeStats>,
    },
}

impl fmt::Debug for DecodeJob {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Frame { index, .. } => formatter
                .debug_struct("Frame")
                .field("index", index)
                .finish_non_exhaustive(),
            #[cfg(test)]
            Self::Stats { .. } => formatter.write_str("Stats"),
        }
    }
}

/// A decoder living on its own thread, answering frame requests until it is dropped.
struct DecoderThread {
    /// `None` only while dropping: closing the channel is what tells the thread to finish.
    jobs: Option<mpsc::Sender<DecodeJob>>,
    thread: Option<JoinHandle<()>>,
}

impl fmt::Debug for DecoderThread {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DecoderThread")
            .field("open", &self.jobs.is_some())
            .finish_non_exhaustive()
    }
}

impl DecoderThread {
    /// Opens `source` on a thread of its own and waits for the platform to accept it.
    ///
    /// Synchronous on purpose: a source that cannot be decoded has to be a typed refusal *here*,
    /// before a frame is composed, or the caller would publish a subtitles-only picture that looks
    /// exactly like a video that failed to load.
    fn open(source: &Path, config: DecoderConfig) -> Result<Self, PreviewRefusal> {
        let (jobs, requests) = mpsc::channel::<DecodeJob>();
        let (opened, ready) = mpsc::sync_channel::<Result<(), DecodeError>>(1);
        let path = source.to_path_buf();
        let thread = thread::Builder::new()
            .name(DECODER_THREAD_NAME.to_owned())
            .spawn(move || decode_loop(path, config, &opened, &requests))
            .map_err(|_| PreviewRefusal::Unavailable)?;
        match ready.recv() {
            Ok(Ok(())) => Ok(Self {
                jobs: Some(jobs),
                thread: Some(thread),
            }),
            // Either failure joins the thread rather than leaving it behind: a decoder that could
            // not open has nothing to answer with, and a thread nobody owns is a leak per request.
            Ok(Err(error)) => {
                drop(jobs);
                let _ = thread.join();
                // Recorded as a bounded token before the type is collapsed into a refusal. Without
                // this, "the source is unreadable" was the whole of what a failure ever said.
                crate::diagnostics::record(
                    "preview.decoder-open-failed",
                    &[("kind", decode_failure_kind(&error))],
                );
                Err(error.into())
            }
            Err(_) => {
                drop(jobs);
                let _ = thread.join();
                Err(PreviewRefusal::SourceUnreadable)
            }
        }
    }

    /// The source frame output frame `index` shows.
    fn frame(&self, index: u32) -> Result<DecodedSource, PreviewRefusal> {
        let (reply, answer) = mpsc::sync_channel(1);
        self.dispatch(DecodeJob::Frame { index, reply })?;
        answer
            .recv()
            .map_err(|_| PreviewRefusal::SourceUnreadable)?
            .map_err(PreviewRefusal::from)
    }

    /// What the decoder has had to do so far.
    #[cfg(test)]
    fn stats(&self) -> Result<osg_decode::DecodeStats, PreviewRefusal> {
        let (reply, answer) = mpsc::sync_channel(1);
        self.dispatch(DecodeJob::Stats { reply })?;
        answer.recv().map_err(|_| PreviewRefusal::SourceUnreadable)
    }

    /// Hands one job to the thread, or refuses because there is no longer one listening.
    ///
    /// A thread that ended — including one that panicked inside the platform layers — is a refusal
    /// rather than a panic on this side, which is the whole reason the reply arrives by channel.
    fn dispatch(&self, job: DecodeJob) -> Result<(), PreviewRefusal> {
        self.jobs
            .as_ref()
            .ok_or(PreviewRefusal::Unavailable)?
            .send(job)
            .map_err(|_| PreviewRefusal::SourceUnreadable)
    }
}

impl Drop for DecoderThread {
    /// Closes the request channel, then waits for the decoder to be released on its own thread.
    ///
    /// Joining rather than detaching is deliberate: the source file stays open until the decoder is
    /// dropped, and the next decoder is opened immediately after this one is replaced.
    fn drop(&mut self) {
        self.jobs = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Opens the source, then answers requests until the channel closes.
fn decode_loop(
    source: PathBuf,
    config: DecoderConfig,
    opened: &mpsc::SyncSender<Result<(), DecodeError>>,
    jobs: &mpsc::Receiver<DecodeJob>,
) {
    let mut decoder = match open_decoder(&source, config) {
        Ok(decoder) => decoder,
        Err(error) => {
            let _ = opened.send(Err(error));
            return;
        }
    };
    // The source is open, so nothing here needs the path any more. Dropped rather than held for the
    // life of the thread, for the same reason nothing else in this module retains one.
    drop(source);
    if opened.send(Ok(())).is_err() {
        decoder.close();
        return;
    }
    for job in jobs {
        match job {
            DecodeJob::Frame { index, reply } => {
                let _ = reply.send(decoder.frame_for_output(index).map(DecodedSource::from));
            }
            #[cfg(test)]
            DecodeJob::Stats { reply } => {
                let _ = reply.send(decoder.stats());
            }
        }
    }
    decoder.close();
}

/// What one open decoder answers for: the media, and the timeline it is sampled against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SourceKey {
    asset_id: AssetId,
    config: DecoderConfig,
}

/// One open decoder and what it answers for.
#[derive(Debug)]
struct OpenSource {
    key: SourceKey,
    decoder: DecoderThread,
}

/// The one decoder the preview keeps, reopened only when it stops answering the question asked.
pub(crate) struct SourceDecoders {
    /// Held across a decode, so the decoder serialises rather than being asked for two frames at
    /// once. `None` means none is open.
    open: Mutex<Option<OpenSource>>,
    /// How many decoders have been opened over this host's life. A scrub that reopens per frame and
    /// one that reuses are indistinguishable without it.
    opens: AtomicUsize,
}

impl fmt::Debug for SourceDecoders {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SourceDecoders")
            .field("opens", &self.opens.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

impl Default for SourceDecoders {
    fn default() -> Self {
        Self {
            open: Mutex::new(None),
            opens: AtomicUsize::new(0),
        }
    }
}

impl SourceDecoders {
    /// The source frame output frame `index` shows, opening a decoder only when the held one cannot
    /// answer.
    ///
    /// # Errors
    /// Returns [`PreviewRefusal::SourceUnreadable`] when the source cannot be opened or cannot
    /// produce the frame the timeline names, [`PreviewRefusal::UnsupportedRequest`] for an index the
    /// output timeline does not contain, and [`PreviewRefusal::Unavailable`] when the decoder
    /// registry is unusable.
    pub(crate) fn frame(
        &self,
        asset_id: AssetId,
        source: &Path,
        config: DecoderConfig,
        index: u32,
    ) -> Result<DecodedSource, PreviewRefusal> {
        let mut held = self.open.lock().map_err(|_| PreviewRefusal::Unavailable)?;
        self.ensure(&mut held, SourceKey { asset_id, config }, source)?
            .decoder
            .frame(index)
    }

    /// Releases the decoder, whatever it was open for.
    ///
    /// Idempotent, and the file is closed by the time this returns.
    pub(crate) fn close(&self) {
        if let Ok(mut held) = self.open.lock() {
            *held = None;
        }
    }

    /// Returns the held decoder, opening one when it is not the decoder this request needs.
    fn ensure<'held>(
        &self,
        held: &'held mut Option<OpenSource>,
        key: SourceKey,
        source: &Path,
    ) -> Result<&'held OpenSource, PreviewRefusal> {
        if held.as_ref().is_none_or(|open| open.key != key) {
            // Closed before the next is opened, so at most one source file is ever held open and the
            // bound is one rather than "one per binding the editor has visited".
            *held = None;
            let decoder = DecoderThread::open(source, key.config)?;
            self.opens.fetch_add(1, Ordering::AcqRel);
            *held = Some(OpenSource { key, decoder });
        }
        held.as_ref().ok_or(PreviewRefusal::Unavailable)
    }

    /// How many decoders have been opened. One per scrub, not one per frame.
    #[cfg(test)]
    pub(crate) fn opens(&self) -> usize {
        self.opens.load(Ordering::Acquire)
    }

    /// What the held decoder has had to do, or `None` when none is open.
    #[cfg(test)]
    pub(crate) fn stats(&self) -> Option<osg_decode::DecodeStats> {
        let held = self.open.lock().ok()?;
        held.as_ref().and_then(|open| open.decoder.stats().ok())
    }
}

/// A bounded token naming why the decoder refused, safe to log.
fn decode_failure_kind(error: &DecodeError) -> String {
    match error {
        DecodeError::SourceUnusable { reason } => format!("source-unusable:{reason:?}"),
        DecodeError::MediaFoundation { stage, code } => {
            format!("media-foundation:{stage:?}:{code:#x}")
        }
        other => format!("{other:?}")
            .split_whitespace()
            .next()
            .unwrap_or("other")
            .to_owned(),
    }
    .to_lowercase()
}
