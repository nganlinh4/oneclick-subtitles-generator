//! GPU-resident input contract for the Windows Media Foundation encoder.

use std::path::Path;

use windows::Win32::Graphics::Direct3D11::{D3D11_TEXTURE2D_DESC, ID3D11Texture2D};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Media::MediaFoundation::{
    IMFDXGIDeviceManager, MFCreateDXGISurfaceBuffer, MFCreateSample,
};
use windows::core::Interface;

use crate::config::EncoderConfig;
use crate::encoder::VideoEncoder;
use crate::error::{EncodeError, MfStage};
use crate::mf::MediaFoundationEncoder;
use crate::mf::platform::platform_error;

/// Encoder accepting compositor output directly from a BGRA D3D11 texture.
pub trait GpuVideoEncoder: VideoEncoder {
    /// The common audio/lifecycle side of this encoder.
    fn as_video_encoder(&mut self) -> &mut dyn VideoEncoder;

    fn write_gpu_frame(
        &mut self,
        frame_index: u32,
        texture: &ID3D11Texture2D,
        subresource: u32,
    ) -> Result<(), EncodeError>;
}

impl GpuVideoEncoder for MediaFoundationEncoder {
    fn as_video_encoder(&mut self) -> &mut dyn VideoEncoder {
        self
    }

    fn write_gpu_frame(
        &mut self,
        frame_index: u32,
        texture: &ID3D11Texture2D,
        subresource: u32,
    ) -> Result<(), EncodeError> {
        self.check_open()?;
        if frame_index != self.next_frame {
            return Err(EncodeError::FrameOutOfOrder {
                expected: self.next_frame,
                actual: frame_index,
            });
        }

        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: `desc` is a live out-parameter and `texture` remains live through the call.
        unsafe { texture.GetDesc(&raw mut desc) };
        let video = self.config.video();
        if desc.Width != video.width() || desc.Height != video.height() {
            return Err(EncodeError::FrameSizeUnexpected {
                expected_width: video.width(),
                expected_height: video.height(),
                width: desc.Width,
                height: desc.Height,
            });
        }
        if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM {
            return Err(EncodeError::MediaFoundation {
                stage: MfStage::AllocateBuffer,
                code: 0,
            });
        }

        let timestamp = self.clock.timestamp_100ns(frame_index)?;
        let duration = self.clock.duration_100ns(frame_index)?;
        // SAFETY: the live texture implements the requested interface, and MF retains the surface
        // reference through the sample handed to the sink writer.
        let buffer = unsafe {
            MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, subresource, false)
        }
        .map_err(|error| platform_error(MfStage::AllocateBuffer, &error))?;
        // SAFETY: these methods access scalar buffer metadata on a live MF buffer.
        let capacity = unsafe { buffer.GetMaxLength() }
            .map_err(|error| platform_error(MfStage::AllocateBuffer, &error))?;
        // SAFETY: `capacity` came from this exact buffer.
        unsafe { buffer.SetCurrentLength(capacity) }
            .map_err(|error| platform_error(MfStage::AllocateBuffer, &error))?;
        // SAFETY: MFCreateSample takes no borrowed inputs and returns an owned sample.
        let sample = unsafe { MFCreateSample() }
            .map_err(|error| platform_error(MfStage::CreateSample, &error))?;
        // SAFETY: all interfaces remain live through the writer call and scalar times are exact.
        unsafe { sample.AddBuffer(&buffer) }
            .map_err(|error| platform_error(MfStage::CreateSample, &error))?;
        // SAFETY: scalar metadata on the live sample.
        unsafe { sample.SetSampleTime(timestamp) }
            .map_err(|error| platform_error(MfStage::CreateSample, &error))?;
        // SAFETY: scalar metadata on the live sample.
        unsafe { sample.SetSampleDuration(duration) }
            .map_err(|error| platform_error(MfStage::CreateSample, &error))?;
        self.write_sample(self.video_stream, &sample)?;
        self.next_frame = frame_index + 1;
        Ok(())
    }
}

/// Opens the Windows sink writer with its DXGI manager attached.
pub fn open_gpu_encoder(
    output: &Path,
    config: EncoderConfig,
    manager: &IMFDXGIDeviceManager,
) -> Result<Box<dyn GpuVideoEncoder>, EncodeError> {
    Ok(Box::new(MediaFoundationEncoder::open_gpu(
        output, config, manager,
    )?))
}
