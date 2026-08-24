//! GPU NV12-to-BGRA conversion with aperture, colour and rotation preserved.

use std::mem::ManuallyDrop;

use osg_decode::{
    GpuDecodedFrame, NominalRange, Rotation, SourceColorimetry, SourcePresentation, YuvMatrix,
};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_ROTATION_90, D3D11_VIDEO_PROCESSOR_ROTATION_180,
    D3D11_VIDEO_PROCESSOR_ROTATION_270, D3D11_VIDEO_PROCESSOR_ROTATION_IDENTITY,
    D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
    D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D, ID3D11Device,
    ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoContext1,
    ID3D11VideoDevice, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_TYPE,
    DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P601, DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P709,
    DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P601, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
    DXGI_RATIONAL,
};
use windows::core::Interface;

use crate::{GpuVideoError, InteropStage};

#[derive(Debug)]
pub(crate) struct VideoProcessor {
    processor: ID3D11VideoProcessor,
    enumerator: ID3D11VideoProcessorEnumerator,
    device: ID3D11VideoDevice,
    context: ID3D11VideoContext,
    presentation: SourcePresentation,
}

impl VideoProcessor {
    #[expect(
        clippy::too_many_lines,
        reason = "construction keeps the complete D3D11 processor state transition auditable in order"
    )]
    pub(crate) fn new(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        presentation: SourcePresentation,
        color: SourceColorimetry,
        frame_rate: (u32, u32),
    ) -> Result<Self, GpuVideoError> {
        if std::env::var_os("OSG_GPU_TRACE").is_some() {
            eprintln!("[osg-gpu-video] processor-color={color:?} presentation={presentation:?}");
        }
        let video_device: ID3D11VideoDevice = device
            .cast()
            .map_err(|error| GpuVideoError::windows(InteropStage::VideoProcessor, &error))?;
        let video_context: ID3D11VideoContext = context
            .cast()
            .map_err(|error| GpuVideoError::windows(InteropStage::VideoProcessor, &error))?;
        let context1: ID3D11VideoContext1 = context
            .cast()
            .map_err(|error| GpuVideoError::windows(InteropStage::VideoProcessor, &error))?;
        let coded = presentation.coded();
        let decoded = presentation.decoded();
        let description = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL {
                Numerator: frame_rate.0,
                Denominator: frame_rate.1,
            },
            InputWidth: edge(coded.width()),
            InputHeight: edge(coded.height()),
            OutputFrameRate: DXGI_RATIONAL {
                Numerator: frame_rate.0,
                Denominator: frame_rate.1,
            },
            OutputWidth: edge(decoded.width()),
            OutputHeight: edge(decoded.height()),
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        // SAFETY: the description is fully initialized and the device returns owned interfaces.
        let enumerator =
            unsafe { video_device.CreateVideoProcessorEnumerator(&raw const description) }
                .map_err(|error| GpuVideoError::windows(InteropStage::VideoProcessor, &error))?;
        // SAFETY: processor index zero is the guaranteed base capability of this enumerator.
        let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0) }
            .map_err(|error| GpuVideoError::windows(InteropStage::VideoProcessor, &error))?;

        let visible = presentation.visible();
        let source = RECT {
            left: i32::try_from(visible.x()).unwrap_or(i32::MAX),
            top: i32::try_from(visible.y()).unwrap_or(i32::MAX),
            right: i32::try_from(visible.x() + visible.size().width()).unwrap_or(i32::MAX),
            bottom: i32::try_from(visible.y() + visible.size().height()).unwrap_or(i32::MAX),
        };
        let target = RECT {
            left: 0,
            top: 0,
            right: i32::try_from(decoded.width()).unwrap_or(i32::MAX),
            bottom: i32::try_from(decoded.height()).unwrap_or(i32::MAX),
        };
        // SAFETY: the processor and rectangles live through each call and describe validated
        // in-bounds geometry from `SourcePresentation`.
        unsafe {
            video_context.VideoProcessorSetStreamSourceRect(
                &processor,
                0,
                true,
                Some(&raw const source),
            );
        };
        // SAFETY: same validated processor and target rectangle.
        unsafe {
            video_context.VideoProcessorSetStreamDestRect(
                &processor,
                0,
                true,
                Some(&raw const target),
            );
        };
        // SAFETY: same validated processor and target rectangle.
        unsafe {
            video_context.VideoProcessorSetOutputTargetRect(
                &processor,
                true,
                Some(&raw const target),
            );
        };
        let rotation = match presentation.rotation() {
            Rotation::None => D3D11_VIDEO_PROCESSOR_ROTATION_IDENTITY,
            Rotation::Quarter => D3D11_VIDEO_PROCESSOR_ROTATION_90,
            Rotation::Half => D3D11_VIDEO_PROCESSOR_ROTATION_180,
            Rotation::ThreeQuarter => D3D11_VIDEO_PROCESSOR_ROTATION_270,
        };
        // SAFETY: stream zero exists and the rotation is one of the platform's four enumerants.
        unsafe {
            context1.VideoProcessorSetStreamRotation(
                &processor,
                0,
                rotation != D3D11_VIDEO_PROCESSOR_ROTATION_IDENTITY,
                rotation,
            );
        };
        // SAFETY: stream zero exists and the color space is a closed mapping of validated source
        // metadata.
        unsafe {
            context1.VideoProcessorSetStreamColorSpace1(&processor, 0, input_color(color));
        };
        // SAFETY: the live processor's output is the full-range BGRA surface this type owns.
        unsafe {
            context1.VideoProcessorSetOutputColorSpace1(
                &processor,
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
            );
        };
        let legacy_input = legacy_input_color(color);
        let legacy_output = legacy_output_color();
        // SAFETY: the legacy setters are required for drivers that expose Context1 but implement
        // the range conversion through the original D3D11 video-processor state. Both structs are
        // fully initialized and live through the calls.
        unsafe {
            video_context.VideoProcessorSetStreamColorSpace(&processor, 0, &raw const legacy_input);
        };
        // SAFETY: the output structure is fully initialized and lives through the call.
        unsafe {
            video_context.VideoProcessorSetOutputColorSpace(&processor, &raw const legacy_output);
        };
        Ok(Self {
            processor,
            enumerator,
            device: video_device,
            context: video_context,
            presentation,
        })
    }

    pub(crate) fn matches(&self, presentation: SourcePresentation) -> bool {
        self.presentation == presentation
    }

    pub(crate) fn convert(
        &self,
        frame: &GpuDecodedFrame,
        output: &ID3D11Texture2D,
    ) -> Result<(), GpuVideoError> {
        let input_description = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV {
                    MipSlice: 0,
                    ArraySlice: frame.subresource(),
                },
            },
        };
        let input_resource: ID3D11Resource = frame
            .texture()
            .cast()
            .map_err(|error| GpuVideoError::windows(InteropStage::VideoProcessor, &error))?;
        let mut input = None;
        // SAFETY: every interface and descriptor is live and the subresource belongs to the frame.
        unsafe {
            self.device.CreateVideoProcessorInputView(
                &input_resource,
                &self.enumerator,
                &raw const input_description,
                Some(&raw mut input),
            )
        }
        .map_err(|error| GpuVideoError::windows(InteropStage::VideoProcessor, &error))?;
        let input = input.ok_or(GpuVideoError::null(InteropStage::VideoProcessor))?;

        let output_description = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
            },
        };
        let output_resource: ID3D11Resource = output
            .cast()
            .map_err(|error| GpuVideoError::windows(InteropStage::VideoProcessor, &error))?;
        let mut output_view = None;
        // SAFETY: the BGRA output texture and descriptor are live through the call.
        unsafe {
            self.device.CreateVideoProcessorOutputView(
                &output_resource,
                &self.enumerator,
                &raw const output_description,
                Some(&raw mut output_view),
            )
        }
        .map_err(|error| GpuVideoError::windows(InteropStage::VideoProcessor, &error))?;
        let output_view = output_view.ok_or(GpuVideoError::null(InteropStage::VideoProcessor))?;
        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            OutputIndex: 0,
            InputFrameOrField: 0,
            PastFrames: 0,
            FutureFrames: 0,
            ppPastSurfaces: core::ptr::null_mut(),
            pInputSurface: ManuallyDrop::new(Some(input)),
            ppFutureSurfaces: core::ptr::null_mut(),
            ppPastSurfacesRight: core::ptr::null_mut(),
            pInputSurfaceRight: ManuallyDrop::new(None),
            ppFutureSurfacesRight: core::ptr::null_mut(),
        };
        let mut streams = [stream];
        // SAFETY: the stream references live input/output views for the duration of the blit.
        let result = unsafe {
            self.context
                .VideoProcessorBlt(&self.processor, &output_view, 0, &streams)
        };
        // The generated Win32 struct uses ManuallyDrop for its two optional COM inputs. The API
        // borrows them; release our references explicitly after the call or the decoder's finite
        // surface pool is exhausted after a handful of frames.
        // SAFETY: these two fields were initialized exactly once above and are dropped exactly once.
        unsafe { ManuallyDrop::drop(&mut streams[0].pInputSurface) };
        // SAFETY: as above for the optional right-eye surface.
        unsafe { ManuallyDrop::drop(&mut streams[0].pInputSurfaceRight) };
        result.map_err(|error| GpuVideoError::windows(InteropStage::VideoProcessor, &error))
    }
}

fn input_color(color: SourceColorimetry) -> DXGI_COLOR_SPACE_TYPE {
    match (color.range, color.matrix) {
        (NominalRange::Studio, YuvMatrix::Bt601) => DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P601,
        (NominalRange::Studio, YuvMatrix::Bt709) => DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
        (NominalRange::Full, YuvMatrix::Bt601) => DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P601,
        (NominalRange::Full, YuvMatrix::Bt709) => DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P709,
    }
}

fn legacy_input_color(color: SourceColorimetry) -> D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
    // D3D11 bitfield: Usage at bit 0, RGB range at 1, matrix at 2, xvYCC at 3,
    // nominal YUV range at bits 4..=5. Usage=processing avoids playback-only driver policy.
    let matrix = u32::from(matches!(color.matrix, YuvMatrix::Bt709));
    let nominal = match color.range {
        NominalRange::Studio => 1_u32,
        NominalRange::Full => 2_u32,
    };
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
        _bitfield: 1 | (matrix << 2) | (nominal << 4),
    }
}

const fn legacy_output_color() -> D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
    // Full-range RGB (RGB_Range=0), processing usage, with full nominal range spelled out for
    // drivers that consult it during YUV->RGB conversion.
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
        _bitfield: 1 | (1 << 2) | (2 << 4),
    }
}

fn edge(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
