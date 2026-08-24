//! GPU-resident decoding contract for the Windows export pipeline.

use std::fmt;
use std::path::Path;

use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::{IMFDXGIBuffer, IMFDXGIDeviceManager, IMFSample};
use windows::core::Interface;

use crate::cancel::CancelToken;
use crate::decoder::{DecodeStats, DecoderConfig};
use crate::error::{DecodeError, MfStage};
use crate::mf::MediaFoundationDecoder;
use crate::mf::platform::platform_error;
use crate::mf::sample::SourceSample;
use crate::presentation::SourcePresentation;
use crate::source::SourceInfo;

/// One selected NV12 frame whose pixels remain on the decoder's D3D11 device.
pub struct GpuDecodedFrame {
    texture: ID3D11Texture2D,
    subresource: u32,
    presentation: SourcePresentation,
    presentation_100ns: i64,
    duration_100ns: i64,
    source_index: u64,
    _sample: IMFSample,
}

impl fmt::Debug for GpuDecodedFrame {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GpuDecodedFrame")
            .field("subresource", &self.subresource)
            .field("presentation", &self.presentation)
            .field("presentation_100ns", &self.presentation_100ns)
            .field("duration_100ns", &self.duration_100ns)
            .field("source_index", &self.source_index)
            .finish_non_exhaustive()
    }
}

impl GpuDecodedFrame {
    fn from_sample(sample: &SourceSample, source: SourceInfo) -> Result<Self, DecodeError> {
        // SAFETY: the sample is live and owns the returned buffer for the lifetime of this frame.
        let buffer = unsafe { sample.interface().GetBufferByIndex(0) }
            .map_err(|error| platform_error(MfStage::SampleBuffer, &error))?;
        let dxgi: IMFDXGIBuffer = buffer
            .cast()
            .map_err(|error| platform_error(MfStage::SampleBuffer, &error))?;
        let mut raw = core::ptr::null_mut();
        // SAFETY: `raw` is a live out-parameter and the requested IID names the exact interface
        // used to wrap the returned AddRef'd pointer below.
        unsafe { dxgi.GetResource(&ID3D11Texture2D::IID, &raw mut raw) }
            .map_err(|error| platform_error(MfStage::SampleBuffer, &error))?;
        if raw.is_null() {
            return Err(DecodeError::MediaFoundation {
                stage: MfStage::SampleBuffer,
                code: 0,
            });
        }
        // SAFETY: GetResource returned one owned COM reference for ID3D11Texture2D.
        let texture = unsafe { ID3D11Texture2D::from_raw(raw) };
        // SAFETY: the DXGI buffer is live and the method returns a scalar.
        let subresource = unsafe { dxgi.GetSubresourceIndex() }
            .map_err(|error| platform_error(MfStage::SampleBuffer, &error))?;
        let presentation_100ns = sample.presentation_100ns();
        let duration_100ns = sample.duration_100ns();
        let source_index = source.grid().nearest_frame_index_100ns(presentation_100ns);
        let keepalive = sample.interface().clone();
        Ok(Self {
            texture,
            subresource,
            presentation: source.presentation(),
            presentation_100ns,
            duration_100ns,
            source_index,
            _sample: keepalive,
        })
    }

    #[must_use]
    pub fn texture(&self) -> &ID3D11Texture2D {
        &self.texture
    }

    #[must_use]
    pub const fn subresource(&self) -> u32 {
        self.subresource
    }

    #[must_use]
    pub const fn presentation(&self) -> SourcePresentation {
        self.presentation
    }

    #[must_use]
    pub const fn presentation_100ns(&self) -> i64 {
        self.presentation_100ns
    }

    #[must_use]
    pub const fn duration_100ns(&self) -> i64 {
        self.duration_100ns
    }

    #[must_use]
    pub const fn source_index(&self) -> u64 {
        self.source_index
    }
}

/// Frame-exact decoder yielding selected Media Foundation surfaces without a CPU lock.
pub trait GpuVideoDecoder: fmt::Debug {
    fn source(&self) -> SourceInfo;
    fn config(&self) -> DecoderConfig;
    fn cancel_token(&self) -> CancelToken;
    fn stats(&self) -> DecodeStats;
    fn frame_for_output(&mut self, index: u32) -> Result<GpuDecodedFrame, DecodeError>;
    fn close(&mut self);
}

impl GpuVideoDecoder for MediaFoundationDecoder {
    fn source(&self) -> SourceInfo {
        self.source_info()
    }

    fn config(&self) -> DecoderConfig {
        self.decoder_config()
    }

    fn cancel_token(&self) -> CancelToken {
        self.decoder_cancel_token()
    }

    fn stats(&self) -> DecodeStats {
        self.decode_stats()
    }

    fn frame_for_output(&mut self, index: u32) -> Result<GpuDecodedFrame, DecodeError> {
        let target = self.output_sample_100ns(index)?;
        let sample = self.selected_sample_at_100ns(target)?;
        GpuDecodedFrame::from_sample(&sample, self.source_info())
    }

    fn close(&mut self) {
        self.close_reader();
    }
}

/// Opens the frame-exact Windows decoder with a caller-owned DXGI device manager.
pub fn open_gpu_decoder(
    source: &Path,
    config: DecoderConfig,
    manager: &IMFDXGIDeviceManager,
) -> Result<Box<dyn GpuVideoDecoder>, DecodeError> {
    Ok(Box::new(MediaFoundationDecoder::open_gpu(
        source, config, manager,
    )?))
}
