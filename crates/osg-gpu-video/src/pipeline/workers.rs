//! The decode and encode worker threads and the commands that cross their channels.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;

use osg_decode::{DecoderConfig, GpuDecodedFrame, open_gpu_decoder};
use osg_encode::{
    AudioBlock, AudioConfig, EncodeOutcome, EncoderConfig, GpuVideoEncoder, open_gpu_encoder,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_RESOURCE_MISC_FLAG,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11Resource, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::core::Interface;

use crate::d3d::{DecodeFenceSignal, RenderFenceWait, VideoDevice};
use crate::processor::VideoProcessor;
use crate::shared::SharedSurface;
use crate::{GpuVideoError, InteropStage, WorkerStage};

use super::trace;

#[derive(Debug)]
pub(super) enum DecodedReady {
    Frame {
        frame_index: u32,
        slot: usize,
        fence_value: u64,
    },
    /// This output instant selects the same decoded source sample as the preceding instant.
    /// D3D12 queue ordering keeps `decoded_local` valid, so no VP conversion or VRAM copy is needed.
    Hold { frame_index: u32 },
}

impl DecodedReady {
    pub(super) const fn frame_index(&self) -> u32 {
        match self {
            Self::Frame { frame_index, .. } | Self::Hold { frame_index } => *frame_index,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct ReusableDecoded {
    pub(super) slot: usize,
    pub(super) render_fence_value: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DecodedSampleKey {
    presentation_100ns: i64,
    duration_100ns: i64,
    source_index: u64,
}

impl DecodedSampleKey {
    const fn of(frame: &GpuDecodedFrame) -> Self {
        Self {
            presentation_100ns: frame.presentation_100ns(),
            duration_100ns: frame.duration_100ns(),
            source_index: frame.source_index(),
        }
    }
}

const fn holds_source_sample(
    previous: Option<DecodedSampleKey>,
    current: DecodedSampleKey,
) -> bool {
    matches!(previous, Some(previous) if previous.presentation_100ns == current.presentation_100ns
        && previous.duration_100ns == current.duration_100ns
        && previous.source_index == current.source_index)
}

pub(super) enum EncodeCommand {
    Video {
        frame_index: u32,
        slot: usize,
        render_fence_value: u64,
    },
    Audio {
        first_sample: u64,
        samples: Vec<f32>,
        config: AudioConfig,
    },
    Finalize(mpsc::SyncSender<Result<EncodeOutcome, GpuVideoError>>),
    Cancel,
}
#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_decoder(
    source: PathBuf,
    config: DecoderConfig,
    frame_count: u32,
    device: VideoDevice,
    slots: Vec<Arc<SharedSurface>>,
    free: mpsc::Receiver<ReusableDecoded>,
    ready: mpsc::Sender<Result<DecodedReady, GpuVideoError>>,
    mut fence: DecodeFenceSignal,
    render_fence: RenderFenceWait,
    cancelled: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, GpuVideoError> {
    std::thread::Builder::new()
        .name("osg-gpu-decode".into())
        .spawn(move || {
            let mut decoder = match open_gpu_decoder(&source, config, &device.manager) {
                Ok(value) => value,
                Err(error) => {
                    let _ = ready.send(Err(error.into()));
                    return;
                }
            };
            let mut processor = None;
            let mut previous_sample = None;
            for frame_index in 0..frame_count {
                if cancelled.load(Ordering::Acquire) {
                    break;
                }
                let frame = match decoder.frame_for_output(frame_index) {
                    Ok(frame) => frame,
                    Err(error) => {
                        let _ = ready.send(Err(error.into()));
                        break;
                    }
                };
                let sample = DecodedSampleKey::of(&frame);
                if holds_source_sample(previous_sample, sample) {
                    trace(frame_index, "decode.source-held");
                    if ready.send(Ok(DecodedReady::Hold { frame_index })).is_err() {
                        break;
                    }
                    continue;
                }
                let Ok(reusable) = free.recv() else {
                    break;
                };
                if cancelled.load(Ordering::Acquire) {
                    break;
                }
                if let Err(error) = render_fence.wait(reusable.render_fence_value) {
                    let _ = ready.send(Err(error));
                    break;
                }
                let result = decode_into_slot(
                    &frame,
                    decoder.source(),
                    &device,
                    &slots,
                    &mut processor,
                    reusable.slot,
                    &mut fence,
                )
                .map(|fence_value| DecodedReady::Frame {
                    frame_index,
                    slot: reusable.slot,
                    fence_value,
                });
                trace(frame_index, "decode.complete");
                let failed = result.is_err();
                if let Err(error) = &result
                    && std::env::var_os("OSG_GPU_TRACE").is_some()
                {
                    eprintln!("[osg-gpu-video] frame={frame_index} decode-error={error:?}");
                }
                if !failed {
                    previous_sample = Some(sample);
                }
                if ready.send(result).is_err() || failed {
                    break;
                }
            }
            decoder.close();
        })
        .map_err(|error| worker_start_error(WorkerStage::Decode, &error))
}

fn decode_into_slot(
    frame: &GpuDecodedFrame,
    source: osg_decode::SourceInfo,
    device: &VideoDevice,
    slots: &[Arc<SharedSurface>],
    processor: &mut Option<VideoProcessor>,
    slot: usize,
    fence: &mut DecodeFenceSignal,
) -> Result<u64, GpuVideoError> {
    if processor
        .as_ref()
        .is_none_or(|value| !value.matches(frame.presentation()))
    {
        *processor = Some(VideoProcessor::new(
            &device.device,
            &device.context,
            frame.presentation(),
            source.colorimetry(),
            (source.grid().numerator(), source.grid().denominator()),
        )?);
    }
    let target = slots.get(slot).ok_or_else(GpuVideoError::synchronization)?;
    let _write = target.acquire()?;
    processor
        .as_ref()
        .ok_or_else(GpuVideoError::synchronization)?
        .convert(frame, &target.d3d11)?;
    let fence_value = fence.signal()?;
    device.wait()?;
    Ok(fence_value)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_encoder(
    output: PathBuf,
    config: EncoderConfig,
    device: VideoDevice,
    render_fence: RenderFenceWait,
    slots: Vec<Arc<SharedSurface>>,
    free: mpsc::SyncSender<usize>,
    commands: mpsc::Receiver<EncodeCommand>,
    failures: mpsc::Sender<GpuVideoError>,
    opened: mpsc::SyncSender<Result<(), GpuVideoError>>,
    cancelled: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, GpuVideoError> {
    std::thread::Builder::new()
        .name("osg-gpu-encode".into())
        .spawn(move || {
            let mut encoder = match open_gpu_encoder(&output, config, &device.manager) {
                Ok(value) => value,
                Err(error) => {
                    let _ = opened.send(Err(error.into()));
                    return;
                }
            };
            if opened.send(Ok(())).is_err() {
                let _ = encoder.cancel();
                return;
            }
            while let Ok(command) = commands.recv() {
                if cancelled.load(Ordering::Acquire) {
                    trace(u32::MAX, "encode.observed-cancel");
                    if let Err(error) = encoder.cancel() {
                        let _ = failures.send(error.into());
                    }
                    return;
                }
                let result = match command {
                    EncodeCommand::Video {
                        frame_index,
                        slot,
                        render_fence_value,
                    } => {
                        trace(frame_index, "encode.video");
                        encode_slot(
                            encoder.as_mut(),
                            &device,
                            &render_fence,
                            &slots,
                            frame_index,
                            slot,
                            render_fence_value,
                        )
                        .and_then(|()| {
                            free.send(slot)
                                .map_err(|_| GpuVideoError::synchronization())
                        })
                    }
                    EncodeCommand::Audio {
                        first_sample,
                        samples,
                        config,
                    } => AudioBlock::new(&samples, config)
                        .map_err(GpuVideoError::from)
                        .and_then(|block| {
                            encoder
                                .write_audio(first_sample, &block)
                                .map_err(GpuVideoError::from)
                        }),
                    EncodeCommand::Finalize(reply) => {
                        trace(u32::MAX, "encode.finalize");
                        let result = encoder.finalize().map_err(GpuVideoError::from);
                        let _ = reply.send(result);
                        return;
                    }
                    EncodeCommand::Cancel => {
                        trace(u32::MAX, "encode.cancel");
                        if let Err(error) = encoder.cancel() {
                            let _ = failures.send(error.into());
                        }
                        return;
                    }
                };
                if let Err(error) = result {
                    trace(u32::MAX, "encode.failed");
                    let _ = encoder.cancel();
                    let _ = failures.send(error);
                    return;
                }
            }
            trace(u32::MAX, "encode.commands-disconnected");
            let _ = encoder.cancel();
        })
        .map_err(|error| worker_start_error(WorkerStage::Encode, &error))
}

fn encode_slot(
    encoder: &mut dyn GpuVideoEncoder,
    device: &VideoDevice,
    render_fence: &RenderFenceWait,
    slots: &[Arc<SharedSurface>],
    frame_index: u32,
    slot: usize,
    render_fence_value: u64,
) -> Result<(), GpuVideoError> {
    let source = slots.get(slot).ok_or_else(GpuVideoError::synchronization)?;
    let video = encoder.config().video();
    let private = private_bgra(&device.device, video.width(), video.height())?;
    {
        let _read = source.acquire()?;
        render_fence.wait(render_fence_value)?;
        let source_resource: ID3D11Resource = source
            .d3d11
            .cast()
            .map_err(|error| GpuVideoError::windows(InteropStage::GpuCopy, &error))?;
        let target_resource: ID3D11Resource = private
            .cast()
            .map_err(|error| GpuVideoError::windows(InteropStage::GpuCopy, &error))?;
        // SAFETY: both resources belong to this device and carry identical BGRA geometry.
        unsafe {
            device
                .context
                .CopyResource(&target_resource, &source_resource);
        };
        device.wait()?;
    }
    trace(frame_index, "encode.copy-complete");
    encoder.write_gpu_frame(frame_index, &private, 0)?;
    trace(frame_index, "encode.submitted");
    Ok(())
}

fn private_bgra(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<ID3D11Texture2D, GpuVideoError> {
    let description = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0).cast_unsigned(),
        CPUAccessFlags: 0,
        MiscFlags: D3D11_RESOURCE_MISC_FLAG(0).0.cast_unsigned(),
    };
    let mut texture = None;
    // SAFETY: the descriptor and out-parameter are live; GPU copy fills the complete texture.
    unsafe { device.CreateTexture2D(&raw const description, None, Some(&raw mut texture)) }
        .map_err(|error| GpuVideoError::windows(InteropStage::SharedTexture, &error))?;
    texture.ok_or_else(|| GpuVideoError::null(InteropStage::SharedTexture))
}

fn worker_start_error(worker: WorkerStage, error: &std::io::Error) -> GpuVideoError {
    GpuVideoError::WorkerUnavailable {
        worker,
        code: error.raw_os_error().unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::{DecodedSampleKey, holds_source_sample, worker_start_error};
    use crate::{GpuVideoError, WorkerStage};

    #[test]
    fn worker_start_failures_keep_only_the_os_error_number() {
        let error = worker_start_error(WorkerStage::Decode, &std::io::Error::from_raw_os_error(8));
        assert!(matches!(
            error,
            GpuVideoError::WorkerUnavailable {
                worker: WorkerStage::Decode,
                code: 8
            }
        ));
        let error = worker_start_error(WorkerStage::Encode, &std::io::Error::other("private"));
        assert!(matches!(
            error,
            GpuVideoError::WorkerUnavailable { code: 0, .. }
        ));
        assert!(!error.to_string().contains("private"));
    }

    const SAMPLE: DecodedSampleKey = DecodedSampleKey {
        presentation_100ns: 1_000,
        duration_100ns: 333,
        source_index: 3,
    };

    #[test]
    fn only_the_exact_same_selected_source_sample_is_held() {
        assert!(holds_source_sample(Some(SAMPLE), SAMPLE));
        assert!(!holds_source_sample(None, SAMPLE));
        assert!(!holds_source_sample(
            Some(DecodedSampleKey {
                presentation_100ns: SAMPLE.presentation_100ns + 1,
                ..SAMPLE
            }),
            SAMPLE,
        ));
        assert!(!holds_source_sample(
            Some(DecodedSampleKey {
                duration_100ns: SAMPLE.duration_100ns + 1,
                ..SAMPLE
            }),
            SAMPLE,
        ));
        assert!(!holds_source_sample(
            Some(DecodedSampleKey {
                source_index: SAMPLE.source_index + 1,
                ..SAMPLE
            }),
            SAMPLE,
        ));
    }
}
