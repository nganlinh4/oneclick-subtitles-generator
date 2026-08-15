//! Pure Rust decoding of a source's audio track to interleaved `f32` PCM.
//!
//! `symphonia` does the container demuxing and almost all of the codec work, so nothing here shells
//! out or downloads a tool. The one exception is Opus, which symphonia has no decoder for: see
//! [`codecs`]. The decoder is a pull source: each call hands back one packet's
//! worth of interleaved frames at the source's own rate and channel count, and the caller decides
//! what to do about rate and layout.
//!
//! Every loop in this module is bounded. A file that claims an absurd packet size, changes its
//! format mid-stream, produces an unbounded run of undecodable packets, or simply never ends is a
//! typed [`AudioError`], never an unbounded allocation and never a panic.

use std::fs::File;
use std::io::{Cursor, ErrorKind};
use std::path::Path;

use std::sync::OnceLock;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, CodecRegistry, Decoder, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::error::{AccessFailure, AudioError};
use crate::format::{MAX_SAMPLE_RATE, MIN_SAMPLE_RATE};

/// Every codec this build can decode: symphonia's own, plus Opus.
///
/// Opus needs its own line because symphonia has no decoder for it, and Opus is not an exotic case
/// here — `osg-download` recognises `webm`/`opus` containers, so a video fetched with yt-dlp very
/// often carries exactly this. Without the adapter, exporting such a video fails at the audio stage
/// after the user has already waited for the download.
///
/// The adapter wraps the reference C libopus (`symphonia-adapter-libopus` is MIT OR Apache-2.0,
/// `opusic-sys` is BSD-3-Clause; both are redistributable and both need a notice entry). It is
/// built from vendored source that cargo checksums, so no binary is fetched and no system library
/// is trusted. A C toolchain is already required by this workspace — `aws-lc-sys`, `ring`,
/// `zstd-sys`, `libsqlite3-sys` and `blake3` all need one — so this adds a dependency, not a
/// dependency class.
fn codecs() -> &'static CodecRegistry {
    static CODECS: OnceLock<CodecRegistry> = OnceLock::new();
    CODECS.get_or_init(|| {
        let mut registry = CodecRegistry::new();
        symphonia::default::register_enabled_codecs(&mut registry);
        registry.register_all::<symphonia_adapter_libopus::OpusDecoder>();
        registry
    })
}

/// The most channels a *source* may declare. Wider than the output ceiling so a 7.1 source can be
/// downmixed rather than refused.
pub const MAX_SOURCE_CHANNELS: u16 = 16;
/// The most frames one decoded packet may contain.
pub const MAX_PACKET_FRAMES: u64 = 65_536;
/// The most frames one source may contribute to a mix.
///
/// This is [`MAX_MIX_DURATION_SECONDS`](crate::MAX_MIX_DURATION_SECONDS) at [`MAX_SAMPLE_RATE`];
/// the equality is asserted by a test because a cast-free `const` expression cannot express it.
pub const MAX_SOURCE_FRAMES: u64 = 4_320_000_000;
/// How many consecutive undecodable packets are tolerated before the stream is called corrupt.
const MAX_CONSECUTIVE_DECODE_ERRORS: u32 = 64;
/// How many packets may be read in total before the stream is called corrupt.
const MAX_PACKETS: u64 = 8_000_000;

/// A source's audio track, decoded on demand to interleaved `f32`.
///
/// The first packet is decoded when the decoder is opened, so [`Self::sample_rate`] and
/// [`Self::channels`] describe what the decoder actually produced rather than what the container
/// claimed, and a source whose header lies is refused at open time rather than half way through a
/// render.
pub struct AudioDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    sample_rate: u32,
    channels: u16,
    buffer: Option<SampleBuffer<f32>>,
    buffer_frames: usize,
    pending: bool,
    ended: bool,
    packets: u64,
}

impl core::fmt::Debug for AudioDecoder {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("AudioDecoder")
            .field("sample_rate", &self.sample_rate)
            .field("channels", &self.channels)
            .field("ended", &self.ended)
            .finish_non_exhaustive()
    }
}

impl AudioDecoder {
    /// Open a source from the filesystem.
    ///
    /// The path is used to open the file and to hint the container to the prober. It is never
    /// stored and never appears in an error.
    ///
    /// # Errors
    /// Returns [`AudioError`] when the file cannot be read, no container reader recognises it, it
    /// carries no decodable audio track, or its declared format is outside the supported bounds.
    pub fn open_path(path: &Path) -> Result<Self, AudioError> {
        let file = File::open(path).map_err(|error| AudioError::SourceUnavailable {
            reason: AccessFailure::from_io_kind(error.kind()),
        })?;
        let mut hint = Hint::new();
        if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
            hint.with_extension(extension);
        }
        Self::open(Box::new(file), &hint)
    }

    /// Open a source already held in memory.
    ///
    /// # Errors
    /// Returns [`AudioError`] on the same terms as [`Self::open_path`].
    pub fn open_bytes(bytes: Vec<u8>) -> Result<Self, AudioError> {
        Self::open(Box::new(Cursor::new(bytes)), &Hint::new())
    }

    fn open(source: Box<dyn MediaSource>, hint: &Hint) -> Result<Self, AudioError> {
        let stream = MediaSourceStream::new(source, MediaSourceStreamOptions::default());
        let probed = symphonia::default::get_probe()
            .format(
                hint,
                stream,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .map_err(|_| AudioError::UnrecognisedContainer)?;
        let format = probed.format;
        let track = format
            .tracks()
            .iter()
            .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or(AudioError::NoAudioTrack)?;
        let track_id = track.id;
        let decoder = codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|_| AudioError::UnsupportedCodec)?;

        let mut opened = Self {
            format,
            decoder,
            track_id,
            sample_rate: 0,
            channels: 0,
            buffer: None,
            buffer_frames: 0,
            pending: false,
            ended: false,
            packets: 0,
        };
        if !opened.decode_packet()? {
            return Err(AudioError::NoAudioTrack);
        }
        opened.pending = true;
        Ok(opened)
    }

    /// The rate the decoded frames are sampled at, in Hz.
    #[must_use]
    pub const fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// How many channels each decoded frame carries.
    #[must_use]
    pub const fn channels(&self) -> u16 {
        self.channels
    }

    /// The next packet's frames, interleaved, or `None` at the end of the track.
    ///
    /// The slice borrows the decoder's own buffer and is valid until the next call.
    ///
    /// # Errors
    /// Returns [`AudioError::CorruptStream`] or [`AudioError::PacketTooLarge`] when the stream
    /// cannot be decoded any further.
    pub fn next_frames(&mut self) -> Result<Option<&[f32]>, AudioError> {
        if self.pending {
            self.pending = false;
        } else if !self.decode_packet()? {
            return Ok(None);
        }
        Ok(Some(
            self.buffer
                .as_ref()
                .map_or(&[][..], |buffer| buffer.samples()),
        ))
    }

    /// Decode packets until one yields frames. Returns `false` at the end of the stream.
    fn decode_packet(&mut self) -> Result<bool, AudioError> {
        if self.ended {
            return Ok(false);
        }
        let mut consecutive_errors = 0_u32;
        loop {
            self.packets += 1;
            if self.packets > MAX_PACKETS {
                return Err(AudioError::CorruptStream);
            }
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                    self.ended = true;
                    return Ok(false);
                }
                Err(SymphoniaError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(_) => return Err(AudioError::CorruptStream),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => {
                    consecutive_errors += 1;
                    if consecutive_errors > MAX_CONSECUTIVE_DECODE_ERRORS {
                        return Err(AudioError::CorruptStream);
                    }
                    continue;
                }
                Err(SymphoniaError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                    self.ended = true;
                    return Ok(false);
                }
                Err(_) => return Err(AudioError::CorruptStream),
            };
            consecutive_errors = 0;

            let spec = *decoded.spec();
            let frames = decoded.frames();
            if frames == 0 {
                continue;
            }
            let frame_count = check_packet_frames(frames)?;
            let channels = check_channels(spec.channels.count())?;
            let sample_rate = check_sample_rate(spec.rate)?;
            if self.sample_rate == 0 {
                self.sample_rate = sample_rate;
                self.channels = channels;
            } else if self.sample_rate != sample_rate || self.channels != channels {
                // A mid-stream format change would silently reinterpret every later frame.
                return Err(AudioError::CorruptStream);
            }

            if self.buffer.is_none() || self.buffer_frames < frames {
                self.buffer = Some(SampleBuffer::<f32>::new(frame_count, spec));
                self.buffer_frames = frames;
            }
            if let Some(buffer) = self.buffer.as_mut() {
                buffer.copy_interleaved_ref(decoded);
            }
            return Ok(true);
        }
    }
}

/// Refuse a packet whose declared frame count would make the sample buffer unbounded.
///
/// This runs before any allocation: `SampleBuffer::new` asserts on an absurd duration, so the
/// bound has to bite first for a corrupt header to be an error rather than a panic.
fn check_packet_frames(frames: usize) -> Result<u64, AudioError> {
    let count = u64::try_from(frames).unwrap_or(u64::MAX);
    if count > MAX_PACKET_FRAMES {
        return Err(AudioError::PacketTooLarge {
            max: MAX_PACKET_FRAMES,
        });
    }
    Ok(count)
}

/// Refuse a channel count the mixer could not address, including the zero a corrupt header gives.
fn check_channels(count: usize) -> Result<u16, AudioError> {
    let value = u32::try_from(count).unwrap_or(u32::MAX);
    if count == 0 || value > u32::from(MAX_SOURCE_CHANNELS) {
        return Err(AudioError::SourceChannelCountOutOfRange {
            value,
            max: u32::from(MAX_SOURCE_CHANNELS),
        });
    }
    u16::try_from(count).map_err(|_| AudioError::SourceChannelCountOutOfRange {
        value,
        max: u32::from(MAX_SOURCE_CHANNELS),
    })
}

/// Refuse a sample rate outside the range the resampler is designed for.
fn check_sample_rate(rate: u32) -> Result<u32, AudioError> {
    if rate == 0 {
        return Err(AudioError::MissingStreamParameters);
    }
    if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&rate) {
        return Err(AudioError::SourceSampleRateOutOfRange {
            value: rate,
            min: MIN_SAMPLE_RATE,
            max: MAX_SAMPLE_RATE,
        });
    }
    Ok(rate)
}

#[cfg(test)]
mod tests {
    use super::{
        AudioError, MAX_PACKET_FRAMES, MAX_SAMPLE_RATE, MAX_SOURCE_CHANNELS, MAX_SOURCE_FRAMES,
        MIN_SAMPLE_RATE, check_channels, check_packet_frames, check_sample_rate,
    };
    use crate::format::MAX_MIX_DURATION_SECONDS;

    #[test]
    fn the_packet_bound_refuses_an_absurd_frame_count_before_allocating() {
        assert_eq!(check_packet_frames(1_024), Ok(1_024));
        let at_ceiling = usize::try_from(MAX_PACKET_FRAMES).expect("the ceiling fits");
        assert_eq!(check_packet_frames(at_ceiling), Ok(MAX_PACKET_FRAMES));
        assert!(matches!(
            check_packet_frames(at_ceiling + 1),
            Err(AudioError::PacketTooLarge {
                max: MAX_PACKET_FRAMES
            })
        ));
        assert!(matches!(
            check_packet_frames(usize::MAX),
            Err(AudioError::PacketTooLarge { .. })
        ));
    }

    #[test]
    fn the_source_frame_ceiling_is_the_mix_ceiling_at_the_highest_rate() {
        assert_eq!(
            MAX_SOURCE_FRAMES,
            u64::from(MAX_MIX_DURATION_SECONDS) * u64::from(MAX_SAMPLE_RATE)
        );
    }

    #[test]
    fn channel_bounds_reject_zero_and_absurd_layouts() {
        assert_eq!(check_channels(2), Ok(2));
        assert_eq!(
            check_channels(usize::from(MAX_SOURCE_CHANNELS)),
            Ok(MAX_SOURCE_CHANNELS)
        );
        assert!(matches!(
            check_channels(0),
            Err(AudioError::SourceChannelCountOutOfRange { .. })
        ));
        assert!(matches!(
            check_channels(usize::from(MAX_SOURCE_CHANNELS) + 1),
            Err(AudioError::SourceChannelCountOutOfRange { .. })
        ));
        assert!(matches!(
            check_channels(usize::MAX),
            Err(AudioError::SourceChannelCountOutOfRange { .. })
        ));
    }

    #[test]
    fn sample_rate_bounds_reject_missing_and_absurd_rates() {
        assert_eq!(check_sample_rate(48_000), Ok(48_000));
        assert!(matches!(
            check_sample_rate(0),
            Err(AudioError::MissingStreamParameters)
        ));
        assert!(matches!(
            check_sample_rate(MIN_SAMPLE_RATE - 1),
            Err(AudioError::SourceSampleRateOutOfRange { .. })
        ));
        assert!(matches!(
            check_sample_rate(MAX_SAMPLE_RATE + 1),
            Err(AudioError::SourceSampleRateOutOfRange { .. })
        ));
    }
}
