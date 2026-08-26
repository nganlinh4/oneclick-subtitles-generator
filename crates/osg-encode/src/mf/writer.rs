//! The Media Foundation backend: an `IMFSinkWriter` driven to an MP4 file.
//!
//! The codecs are the operating system's own, licensed by Microsoft to the person running the
//! machine. Nothing here is redistributed, so there is no notice to write and no runtime package to
//! verify — which is the whole point of choosing this path over a bundled encoder.

use core::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use windows::Win32::Media::MediaFoundation::{
    IMFAttributes, IMFByteStream, IMFDXGIDeviceManager, IMFMediaType, IMFSample, IMFSinkWriter,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SINK_WRITER_D3D_MANAGER,
    MF_SINK_WRITER_DISABLE_THROTTLING, MF_TRANSCODE_CONTAINERTYPE, MFCreateAttributes,
    MFCreateSinkWriterFromURL, MFTranscodeContainerType_MPEG4,
};
use windows::core::PCWSTR;

use crate::audio::AudioBlock;
use crate::config::EncoderConfig;
use crate::encoder::{CancelToken, EncodeOutcome, VideoEncoder};
use crate::error::{EncodeError, MfStage, OutputRejection};
use crate::mf::media_type;
use crate::mf::platform::{ensure_media_foundation, platform_error, wide_path};
use crate::mf::sample::build_sample;
use crate::output::check_output_path;
use crate::pixels::FrameBuffer;
use crate::timing::{FrameClock, audio_timestamp_100ns};

/// Where an encode is in its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Accepting samples.
    Open,
    /// Flushed and closed. The file is a finished export.
    Finalized,
    /// Abandoned. The partial file has been removed.
    Cancelled,
}

/// An H.264/AAC MP4 encode over Media Foundation.
pub(crate) struct MediaFoundationEncoder {
    writer: Option<IMFSinkWriter>,
    output: PathBuf,
    pub(crate) config: EncoderConfig,
    pub(crate) clock: FrameClock,
    pub(crate) video_stream: u32,
    audio_stream: Option<u32>,
    pub(crate) next_frame: u32,
    next_audio_sample: u64,
    state: State,
    cancel: CancelToken,
}

impl fmt::Debug for MediaFoundationEncoder {
    /// Redacted on purpose: the output path is the one piece of caller data this type holds, and a
    /// `{:?}` of an encoder must be as safe to log as its errors are.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MediaFoundationEncoder")
            .field("state", &self.state)
            .field("frames_written", &self.next_frame)
            .field("audio_samples_written", &self.next_audio_sample)
            .field("has_audio", &self.audio_stream.is_some())
            .finish_non_exhaustive()
    }
}

impl MediaFoundationEncoder {
    /// Opens `output` and configures the streams `config` asks for.
    pub(crate) fn open(output: &Path, config: EncoderConfig) -> Result<Self, EncodeError> {
        Self::open_inner(output, config, None)
    }

    pub(crate) fn open_gpu(
        output: &Path,
        config: EncoderConfig,
        manager: &IMFDXGIDeviceManager,
    ) -> Result<Self, EncodeError> {
        Self::open_inner(output, config, Some(manager))
    }

    fn open_inner(
        output: &Path,
        config: EncoderConfig,
        manager: Option<&IMFDXGIDeviceManager>,
    ) -> Result<Self, EncodeError> {
        check_output_path(output)?;
        let parent = output.parent().ok_or(EncodeError::OutputUnusable {
            reason: OutputRejection::ParentMissing,
        })?;
        if !parent.is_dir() {
            return Err(EncodeError::OutputUnusable {
                reason: OutputRejection::ParentMissing,
            });
        }
        // No-clobber. A cancelled or dropped encode removes its own output, and that is only safe
        // if nothing that was already there can be caught by it.
        if output.symlink_metadata().is_ok() {
            return Err(EncodeError::OutputUnusable {
                reason: OutputRejection::AlreadyExists,
            });
        }

        ensure_media_foundation()?;
        let clock = config.video().frame_clock()?;
        let attributes = writer_attributes(manager)?;
        let path_units = wide_path(output)?;

        // SAFETY: `path_units` is a NUL-terminated wide string that outlives the call, and both
        // interface arguments are borrowed for the duration of the call only. The writer takes its
        // own reference to the attribute store.
        let writer = unsafe {
            MFCreateSinkWriterFromURL(
                PCWSTR(path_units.as_ptr()),
                None::<&IMFByteStream>,
                &attributes,
            )
        }
        .map_err(|error| platform_error(MfStage::CreateSinkWriter, &error))?;

        let mut encoder = Self {
            writer: Some(writer),
            output: output.to_path_buf(),
            config,
            clock,
            video_stream: 0,
            audio_stream: None,
            next_frame: 0,
            next_audio_sample: 0,
            state: State::Open,
            cancel: CancelToken::new(),
        };

        // From here on every failure path goes through `Drop`, which removes the partial file.
        encoder.configure_streams(manager.is_some())?;
        encoder.begin_writing()?;
        Ok(encoder)
    }

    fn configure_streams(&mut self, gpu_surface_input: bool) -> Result<(), EncodeError> {
        let video = self.config.video();
        let encoded = if gpu_surface_input {
            media_type::encoded_gpu_video_type(video)?
        } else {
            media_type::encoded_video_type(video)?
        };
        self.video_stream = self.add_stream(&encoded)?;
        self.set_input_type(
            self.video_stream,
            &media_type::uncompressed_video_type(video)?,
        )?;

        if let Some(audio) = self.config.audio() {
            let stream = self.add_stream(&media_type::encoded_audio_type(audio)?)?;
            self.set_input_type(stream, &media_type::uncompressed_audio_type(audio)?)?;
            self.audio_stream = Some(stream);
        }
        Ok(())
    }

    fn add_stream(&self, encoded: &IMFMediaType) -> Result<u32, EncodeError> {
        let writer = self.writer()?;
        // SAFETY: both interfaces are live for the duration of the call and the writer copies what
        // it needs from the media type rather than borrowing it.
        unsafe { writer.AddStream(encoded) }
            .map_err(|error| platform_error(MfStage::AddStream, &error))
    }

    fn set_input_type(&self, stream: u32, uncompressed: &IMFMediaType) -> Result<(), EncodeError> {
        let writer = self.writer()?;
        // SAFETY: both interfaces are live for the duration of the call; `None` declares that no
        // extra encoding parameters are supplied.
        unsafe { writer.SetInputMediaType(stream, uncompressed, None::<&IMFAttributes>) }
            .map_err(|error| platform_error(MfStage::InputMediaType, &error))
    }

    fn begin_writing(&self) -> Result<(), EncodeError> {
        let writer = self.writer()?;
        // SAFETY: `BeginWriting` takes no arguments and operates on a live writer whose streams
        // have all been configured above.
        unsafe { writer.BeginWriting() }
            .map_err(|error| platform_error(MfStage::BeginWriting, &error))
    }

    fn writer(&self) -> Result<&IMFSinkWriter, EncodeError> {
        self.writer.as_ref().ok_or(EncodeError::AlreadyFinished)
    }

    /// Rejects a write that the encoder's lifecycle no longer permits.
    pub(crate) fn check_open(&mut self) -> Result<(), EncodeError> {
        match self.state {
            State::Finalized => return Err(EncodeError::AlreadyFinished),
            State::Cancelled => return Err(EncodeError::Cancelled),
            State::Open => {}
        }
        if self.cancel.is_cancelled() {
            self.discard(State::Cancelled);
            return Err(EncodeError::Cancelled);
        }
        Ok(())
    }

    /// Releases the writer and removes the output.
    ///
    /// A sink writer that is dropped without `Finalize` has written no index, so the file on disk
    /// is not a playable MP4. Leaving it behind would put something that looks like a finished
    /// export where a finished export belongs.
    fn discard(&mut self, state: State) {
        self.writer = None;
        // Releasing an unfinalized sink writer tears its byte stream down asynchronously, so the
        // partial container can stay share-locked for a moment after the COM release returns. A
        // single immediate delete therefore reliably left the partial file behind on cancellation.
        // Retry within a small bound so a stopped export leaves no file that could be mistaken for
        // a finished one; the owning staging directory's removal is the second chance after this.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match fs::remove_file(&self.output) {
                Ok(()) => break,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                Err(_) => break,
            }
        }
        self.state = state;
    }

    pub(crate) fn write_sample(&self, stream: u32, sample: &IMFSample) -> Result<(), EncodeError> {
        let writer = self.writer()?;
        // SAFETY: both interfaces are live for the duration of the call; the writer takes its own
        // reference to the sample.
        unsafe { writer.WriteSample(stream, sample) }
            .map_err(|error| platform_error(MfStage::WriteSample, &error))
    }
}

impl VideoEncoder for MediaFoundationEncoder {
    fn config(&self) -> EncoderConfig {
        self.config
    }

    fn cancel_token(&self) -> CancelToken {
        self.cancel.clone()
    }

    fn write_frame(
        &mut self,
        frame_index: u32,
        frame: &FrameBuffer<'_>,
    ) -> Result<(), EncodeError> {
        self.check_open()?;

        if frame_index != self.next_frame {
            return Err(EncodeError::FrameOutOfOrder {
                expected: self.next_frame,
                actual: frame_index,
            });
        }
        let video = self.config.video();
        if frame.width() != video.width() || frame.height() != video.height() {
            return Err(EncodeError::FrameSizeUnexpected {
                expected_width: video.width(),
                expected_height: video.height(),
                width: frame.width(),
                height: frame.height(),
            });
        }

        let timestamp = self.clock.timestamp_100ns(frame_index)?;
        let duration = self.clock.duration_100ns(frame_index)?;

        // The conversion cannot fail: `build_sample` allocates exactly the frame's byte count, and
        // `FrameBuffer` validated that count on construction. The result is still checked, because
        // a silently short copy would encode stale bytes.
        let mut copied = Ok(());
        let sample = build_sample(frame.pixels().len(), timestamp, duration, |destination| {
            copied = frame.copy_as_bgra(destination);
        })?;
        copied?;

        self.write_sample(self.video_stream, &sample)?;
        self.next_frame = frame_index + 1;
        Ok(())
    }

    fn write_audio(
        &mut self,
        first_sample: u64,
        block: &AudioBlock<'_>,
    ) -> Result<(), EncodeError> {
        self.check_open()?;

        let (Some(stream), Some(audio)) = (self.audio_stream, self.config.audio()) else {
            return Err(EncodeError::NoAudioStream);
        };
        if first_sample != self.next_audio_sample {
            return Err(EncodeError::AudioOutOfOrder {
                expected: self.next_audio_sample,
                actual: first_sample,
            });
        }

        let rate = audio.sample_rate().hz();
        let end_sample = first_sample.checked_add(block.frame_count()).ok_or(
            EncodeError::AudioTimestampOutOfRange {
                sample_index: first_sample,
            },
        )?;
        let timestamp = audio_timestamp_100ns(first_sample, rate)?;
        let duration = audio_timestamp_100ns(end_sample, rate)?
            .checked_sub(timestamp)
            .ok_or(EncodeError::AudioTimestampOutOfRange {
                sample_index: first_sample,
            })?;

        let mut copied = Ok(());
        let sample = build_sample(block.byte_len(), timestamp, duration, |destination| {
            copied = block.copy_as_le_bytes(destination);
        })?;
        copied?;

        self.write_sample(stream, &sample)?;
        self.next_audio_sample = end_sample;
        Ok(())
    }

    fn finalize(&mut self) -> Result<EncodeOutcome, EncodeError> {
        match self.state {
            State::Finalized => return Err(EncodeError::AlreadyFinished),
            State::Cancelled => return Err(EncodeError::Cancelled),
            State::Open => {}
        }

        {
            let writer = self.writer()?;
            // SAFETY: `Finalize` takes no arguments and operates on a live writer. It is the call
            // that flushes the encoder and writes the container index.
            unsafe { writer.Finalize() }
                .map_err(|error| platform_error(MfStage::Finalize, &error))?;
        }
        // Released only after `Finalize` succeeded, so the file on disk is complete.
        self.writer = None;
        self.state = State::Finalized;

        let file_bytes = fs::metadata(&self.output)
            .map(|metadata| metadata.len())
            .map_err(|_| EncodeError::OutputUnmeasurable)?;
        let duration = self.clock.boundary_100ns(self.next_frame)?;

        Ok(EncodeOutcome::new(
            self.next_frame,
            self.next_audio_sample,
            file_bytes,
            duration,
        ))
    }

    fn cancel(&mut self) -> Result<(), EncodeError> {
        self.cancel.cancel();
        if self.state == State::Open {
            self.discard(State::Cancelled);
        }
        Ok(())
    }
}

impl Drop for MediaFoundationEncoder {
    fn drop(&mut self) {
        if self.state == State::Open {
            self.discard(State::Cancelled);
        }
    }
}

/// The sink writer's attribute store.
///
/// Hardware transforms are enabled so the encode uses the machine's video encoder when it has one.
/// Throttling is disabled because this is an offline export, not a live capture: there is no
/// wall clock to keep up with and no reason to pace the writer to one.
fn writer_attributes(manager: Option<&IMFDXGIDeviceManager>) -> Result<IMFAttributes, EncodeError> {
    let mut store: Option<IMFAttributes> = None;
    // SAFETY: the out-parameter is a live local for the duration of the call, and the count is the
    // number of attributes the store is sized for, not a length the platform reads through.
    unsafe { MFCreateAttributes(&raw mut store, 3) }
        .map_err(|error| platform_error(MfStage::WriterAttributes, &error))?;
    let store = store.ok_or(EncodeError::MediaFoundation {
        stage: MfStage::WriterAttributes,
        code: 0,
    })?;

    let stage = MfStage::WriterAttributes;
    if let Some(manager) = manager {
        // SAFETY: both are live COM interfaces and the attribute store retains its own reference.
        unsafe { store.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, manager) }
            .map_err(|error| platform_error(stage, &error))?;
    }
    media_type::set_u32(&store, &MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1, stage)?;
    media_type::set_u32(&store, &MF_SINK_WRITER_DISABLE_THROTTLING, 1, stage)?;
    media_type::set_guid(
        &store,
        &MF_TRANSCODE_CONTAINERTYPE,
        &MFTranscodeContainerType_MPEG4,
        stage,
    )?;

    Ok(store)
}
