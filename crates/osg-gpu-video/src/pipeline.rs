//! Bounded three-stage decode -> composite -> encode pipeline.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::Duration;

use osg_compositor::{
    AdapterSelection, Compositor, CompositorTargetFormat, Crop, FrameSize, SubtitleScene,
};
use osg_decode::{DecoderConfig, GpuVideoDecoder, open_decoder, open_gpu_decoder};
use osg_encode::{
    AudioBlock, AudioConfig, EncodeOutcome, EncoderConfig, GpuVideoEncoder, open_gpu_encoder,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_RESOURCE_MISC_FLAG,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11Resource, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::core::Interface;

use crate::d3d::{DecodeFenceSignal, DecodeFenceWait, VideoDevice, compositor_luid, decode_fence};
use crate::processor::VideoProcessor;
use crate::shared::{SharedSurface, wait_submission};
use crate::{GpuVideoError, InteropStage, WorkerStage};

const RING_SIZE: usize = 3;
const CHANNEL_WAIT: Duration = Duration::from_secs(30);

#[derive(Debug)]
struct DecodedReady {
    frame_index: u32,
    slot: usize,
    fence_value: u64,
}

enum EncodeCommand {
    Video {
        frame_index: u32,
        slot: usize,
    },
    Audio {
        first_sample: u64,
        samples: Vec<f32>,
        config: AudioConfig,
    },
    Finalize(mpsc::SyncSender<Result<EncodeOutcome, GpuVideoError>>),
    Cancel,
}

/// A complete native video path with no frame-sized CPU pixel buffer.
///
/// Decode and encode own their Media Foundation objects on dedicated threads. The caller owns
/// wgpu composition. Three shared textures on either side provide bounded backpressure.
pub struct GpuVideoPipeline {
    compositor: Compositor,
    scene: SubtitleScene,
    crop: Crop,
    source_size: FrameSize,
    decoded_slots: Vec<Arc<SharedSurface>>,
    decoded_local: wgpu::Texture,
    decode_fence: DecodeFenceWait,
    encoded_slots: Vec<Arc<SharedSurface>>,
    decoded_ready: mpsc::Receiver<Result<DecodedReady, GpuVideoError>>,
    decoded_free: mpsc::SyncSender<usize>,
    encoded_free: mpsc::Receiver<usize>,
    encode_commands: mpsc::SyncSender<EncodeCommand>,
    encode_failures: mpsc::Receiver<GpuVideoError>,
    cancelled: Arc<AtomicBool>,
    decode_thread: Option<JoinHandle<()>>,
    encode_thread: Option<JoinHandle<()>>,
}

impl core::fmt::Debug for GpuVideoPipeline {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("GpuVideoPipeline")
            .field("source_size", &self.source_size)
            .field("decode_ring", &self.decoded_slots.len())
            .field("encode_ring", &self.encoded_slots.len())
            .field("cancelled", &self.cancelled.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

impl GpuVideoPipeline {
    #[expect(
        clippy::too_many_lines,
        reason = "construction is a transactional ordering of two devices, two rings and two workers"
    )]
    pub fn open(
        source: &Path,
        output: &Path,
        decoder_config: DecoderConfig,
        encoder_config: EncoderConfig,
        scene: SubtitleScene,
        crop: Crop,
    ) -> Result<Self, GpuVideoError> {
        let compositor = Compositor::with_target_format(
            AdapterSelection::Automatic,
            CompositorTargetFormat::Bgra8,
        )?;
        let luid = compositor_luid(compositor.device())?;

        // Metadata only: no decoded sample is locked or materialized on the host.
        let mut probe = open_decoder(source, decoder_config)?;
        let geometry = probe.source().geometry();
        probe.close();
        let source_size = FrameSize::new(edge(geometry.width()), edge(geometry.height()))?;
        let output_size = scene.size();

        let decode_device = VideoDevice::on_adapter(luid)?;
        let encode_device = VideoDevice::on_adapter(luid)?;
        let (decode_signal, decode_wait) = decode_fence(&decode_device, compositor.device())?;
        let decoded_slots = shared_ring(
            &decode_device.device,
            compositor.device(),
            source_size,
            wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
        )?;
        let encoded_slots = shared_ring(
            &encode_device.device,
            compositor.device(),
            output_size,
            wgpu::TextureUsages::RENDER_ATTACHMENT,
        )?;
        let decoded_local = compositor
            .device()
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("osg GPU decoded frame"),
                size: extent(source_size),
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Bgra8Unorm,
                usage: wgpu::TextureUsages::COPY_DST
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
        let cancelled = Arc::new(AtomicBool::new(false));
        let (decoded_free_tx, decoded_free_rx) = mpsc::sync_channel(RING_SIZE);
        let (decoded_ready_tx, decoded_ready_rx) = mpsc::channel();
        for slot in 0..RING_SIZE {
            decoded_free_tx.send(slot).map_err(|_| sync_error())?;
        }
        let (encoded_free_tx, encoded_free_rx) = mpsc::sync_channel(RING_SIZE);
        for slot in 0..RING_SIZE {
            encoded_free_tx.send(slot).map_err(|_| sync_error())?;
        }
        // Video slots already cap in-flight frames. Bound commands independently so audio blocks
        // cannot accumulate with media duration if the hardware encoder slows or stalls.
        let (encode_command_tx, encode_command_rx) = mpsc::sync_channel(RING_SIZE * 2);
        let (encode_failure_tx, encode_failure_rx) = mpsc::channel();
        let (opened_tx, opened_rx) = mpsc::sync_channel(1);
        let encode_thread = spawn_encoder(
            output.to_path_buf(),
            encoder_config,
            encode_device,
            encoded_slots.clone(),
            encoded_free_tx,
            encode_command_rx,
            encode_failure_tx,
            opened_tx,
            Arc::clone(&cancelled),
        )?;
        match opened_rx.recv_timeout(CHANNEL_WAIT) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = encode_thread.join();
                return Err(error);
            }
            Err(_) => {
                cancelled.store(true, Ordering::Release);
                let _ = encode_command_tx.try_send(EncodeCommand::Cancel);
                let _ = encode_thread.join();
                return Err(GpuVideoError::GpuTimeout);
            }
        }

        let decode_thread = match spawn_decoder(
            source.to_path_buf(),
            decoder_config,
            encoder_config.video().frame_count(),
            decode_device,
            decoded_slots.clone(),
            decoded_free_rx,
            decoded_ready_tx,
            decode_signal,
            Arc::clone(&cancelled),
        ) {
            Ok(worker) => worker,
            Err(error) => {
                cancelled.store(true, Ordering::Release);
                let _ = encode_command_tx.try_send(EncodeCommand::Cancel);
                let _ = encode_thread.join();
                return Err(error);
            }
        };

        Ok(Self {
            compositor,
            scene,
            crop,
            source_size,
            decoded_slots,
            decoded_local,
            decode_fence: decode_wait,
            encoded_slots,
            decoded_ready: decoded_ready_rx,
            decoded_free: decoded_free_tx,
            encoded_free: encoded_free_rx,
            encode_commands: encode_command_tx,
            encode_failures: encode_failure_rx,
            cancelled,
            decode_thread: Some(decode_thread),
            encode_thread: Some(encode_thread),
        })
    }

    pub fn write_frame(&mut self, index: u32) -> Result<(), GpuVideoError> {
        self.write_frame_cancellable(index, || false)
    }

    /// Writes one frame while polling the caller's cancellation signal during bounded waits.
    pub fn write_frame_cancellable(
        &mut self,
        index: u32,
        mut should_cancel: impl FnMut() -> bool,
    ) -> Result<(), GpuVideoError> {
        trace(index, "render.wait-decode");
        self.check_encode_failure()?;
        let decoded = loop {
            if should_cancel() {
                return Err(GpuVideoError::Cancelled);
            }
            match self.decoded_ready.recv_timeout(Duration::from_millis(100)) {
                Ok(result) => break result?,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(sync_error()),
            }
        };
        if decoded.frame_index != index {
            trace(index, "render.decode-index-mismatch");
            return Err(sync_error());
        }
        let decoded_slot = self
            .decoded_slots
            .get(decoded.slot)
            .ok_or_else(sync_error)?;
        // Reserve the output slot before submitting any work which reads the decoded slot. If the
        // encoder is applying backpressure this leaves no un-waited GPU submission behind an early
        // cancellation or channel error.
        let encoded_slot_index = self.next_encode_slot(&mut should_cancel)?;
        trace(index, "render.compose");
        let encoded_slot = self
            .encoded_slots
            .get(encoded_slot_index)
            .ok_or_else(sync_error)?;
        {
            // Keep both cross-API resources owned until the LAST submission completes. The copy
            // and render are submitted to one ordered D3D12 queue, so waiting for the render also
            // completes the decode copy. Waiting between the two serialized every frame and threw
            // away the pipeline overlap the three-slot rings exist to provide.
            let _read = decoded_slot.acquire()?;
            let _write = encoded_slot.acquire()?;
            self.decode_fence
                .wait(self.compositor.device(), decoded.fence_value)?;
            let mut commands =
                self.compositor
                    .device()
                    .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("osg coherent shared decode copy"),
                    });
            commands.copy_texture_to_texture(
                texture_copy(&decoded_slot.wgpu),
                texture_copy(&self.decoded_local),
                self.decoded_local.size(),
            );
            // Leave the shared resource in COPY_DST after reading it so the next frame must cross
            // COPY_DST -> COPY_SRC. The corner comes from the just-read frame, preserving the exact
            // pixel while retaining the reference architecture's cache-transition guarantee.
            commands.copy_texture_to_texture(
                texture_copy(&self.decoded_local),
                texture_copy(&decoded_slot.wgpu),
                wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
            );
            let copy_submission = self.compositor.queue().submit(Some(commands.finish()));
            let render_submission = match self.compositor.render_scene_texture_over_into(
                &self.scene,
                &self.decoded_local,
                self.source_size,
                self.crop,
                index,
                &encoded_slot.wgpu,
            ) {
                Ok(submission) => submission,
                Err(error) => {
                    // The copy is already queued. Complete it before either keyed mutex is released
                    // on this error path; otherwise D3D11 could overwrite a texture D3D12 still
                    // reads. Preserve the composition refusal when synchronization itself succeeds.
                    wait_submission(
                        self.compositor.device(),
                        self.compositor.queue(),
                        copy_submission,
                    )?;
                    return Err(error.into());
                }
            };
            wait_submission(
                self.compositor.device(),
                self.compositor.queue(),
                render_submission,
            )?;
        }
        // The worker drops its receiver immediately after publishing the final frame. Recycling
        // that last slot can therefore report disconnection, which is normal completion.
        let _ = self.decoded_free.send(decoded.slot);
        self.send_command_cancellable(
            EncodeCommand::Video {
                frame_index: index,
                slot: encoded_slot_index,
            },
            &mut should_cancel,
        )?;
        trace(index, "render.queued-encode");
        Ok(())
    }

    pub fn write_audio(
        &self,
        first_sample: u64,
        block: &AudioBlock<'_>,
        config: AudioConfig,
    ) -> Result<(), GpuVideoError> {
        self.write_audio_cancellable(first_sample, block, config, || false)
    }

    pub fn write_audio_cancellable(
        &self,
        first_sample: u64,
        block: &AudioBlock<'_>,
        config: AudioConfig,
        mut should_cancel: impl FnMut() -> bool,
    ) -> Result<(), GpuVideoError> {
        self.send_command_cancellable(
            EncodeCommand::Audio {
                first_sample,
                samples: block.samples().to_vec(),
                config,
            },
            &mut should_cancel,
        )
    }

    pub fn finalize(&mut self) -> Result<EncodeOutcome, GpuVideoError> {
        self.check_encode_failure()?;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.encode_commands
            .send(EncodeCommand::Finalize(reply_tx))
            .map_err(|_| self.take_encode_failure())?;
        let outcome = reply_rx
            .recv_timeout(CHANNEL_WAIT)
            .map_err(|_| self.take_encode_failure())??;
        self.cancelled.store(true, Ordering::Release);
        self.wake_decoder();
        self.join_workers()?;
        Ok(outcome)
    }

    pub fn cancel(&mut self) -> Result<(), GpuVideoError> {
        self.cancelled.store(true, Ordering::Release);
        self.wake_decoder();
        // A full queue already guarantees the worker has a command to wake on; the cancellation
        // flag makes it stop at that next boundary, so cancellation never blocks trying to enqueue.
        let _ = self.encode_commands.try_send(EncodeCommand::Cancel);
        self.join_workers()?;
        self.check_encode_failure()
    }

    fn next_encode_slot(
        &self,
        should_cancel: &mut impl FnMut() -> bool,
    ) -> Result<usize, GpuVideoError> {
        loop {
            if should_cancel() {
                return Err(GpuVideoError::Cancelled);
            }
            self.check_encode_failure()?;
            match self.encoded_free.recv_timeout(Duration::from_millis(100)) {
                Ok(slot) => return Ok(slot),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    trace(u32::MAX, "render.encode-free-disconnected");
                    return Err(self.take_encode_failure());
                }
            }
        }
    }

    fn check_encode_failure(&self) -> Result<(), GpuVideoError> {
        match self.encode_failures.try_recv() {
            Ok(error) => {
                if std::env::var_os("OSG_GPU_TRACE").is_some() {
                    eprintln!("[osg-gpu-video] observed-encode-error={error:?}");
                }
                Err(error)
            }
            Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => Ok(()),
        }
    }

    fn send_command_cancellable(
        &self,
        mut command: EncodeCommand,
        should_cancel: &mut impl FnMut() -> bool,
    ) -> Result<(), GpuVideoError> {
        loop {
            if should_cancel() {
                return Err(GpuVideoError::Cancelled);
            }
            self.check_encode_failure()?;
            match self.encode_commands.try_send(command) {
                Ok(()) => return Ok(()),
                Err(mpsc::TrySendError::Full(returned)) => {
                    command = returned;
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    return Err(self.take_encode_failure());
                }
            }
        }
    }

    fn take_encode_failure(&self) -> GpuVideoError {
        self.encode_failures
            .try_recv()
            .unwrap_or_else(|_| sync_error())
    }

    fn wake_decoder(&self) {
        for slot in 0..RING_SIZE {
            let _ = self.decoded_free.try_send(slot);
        }
    }

    fn join_workers(&mut self) -> Result<(), GpuVideoError> {
        let mut first_error = None;
        if let Some(worker) = self.decode_thread.take()
            && worker.join().is_err()
        {
            first_error = Some(GpuVideoError::WorkerPanicked {
                worker: WorkerStage::Decode,
            });
        }
        if let Some(worker) = self.encode_thread.take()
            && worker.join().is_err()
            && first_error.is_none()
        {
            first_error = Some(GpuVideoError::WorkerPanicked {
                worker: WorkerStage::Encode,
            });
        }
        first_error.map_or(Ok(()), Err)
    }
}

impl Drop for GpuVideoPipeline {
    fn drop(&mut self) {
        if self.decode_thread.is_some() || self.encode_thread.is_some() {
            let _ = self.cancel();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_decoder(
    source: PathBuf,
    config: DecoderConfig,
    frame_count: u32,
    device: VideoDevice,
    slots: Vec<Arc<SharedSurface>>,
    free: mpsc::Receiver<usize>,
    ready: mpsc::Sender<Result<DecodedReady, GpuVideoError>>,
    mut fence: DecodeFenceSignal,
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
            for frame_index in 0..frame_count {
                if cancelled.load(Ordering::Acquire) {
                    break;
                }
                let Ok(slot) = free.recv() else {
                    break;
                };
                if cancelled.load(Ordering::Acquire) {
                    break;
                }
                let result = decode_into_slot(
                    decoder.as_mut(),
                    &device,
                    &slots,
                    &mut processor,
                    frame_index,
                    slot,
                    &mut fence,
                )
                .map(|fence_value| DecodedReady {
                    frame_index,
                    slot,
                    fence_value,
                });
                let failed = result.is_err();
                if let Err(error) = &result
                    && std::env::var_os("OSG_GPU_TRACE").is_some()
                {
                    eprintln!("[osg-gpu-video] frame={frame_index} decode-error={error:?}");
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
    decoder: &mut dyn GpuVideoDecoder,
    device: &VideoDevice,
    slots: &[Arc<SharedSurface>],
    processor: &mut Option<VideoProcessor>,
    frame_index: u32,
    slot: usize,
    fence: &mut DecodeFenceSignal,
) -> Result<u64, GpuVideoError> {
    let frame = decoder.frame_for_output(frame_index)?;
    if processor
        .as_ref()
        .is_none_or(|value| !value.matches(frame.presentation()))
    {
        let source = decoder.source();
        *processor = Some(VideoProcessor::new(
            &device.device,
            &device.context,
            frame.presentation(),
            source.colorimetry(),
            (source.grid().numerator(), source.grid().denominator()),
        )?);
    }
    let target = slots.get(slot).ok_or_else(sync_error)?;
    let _write = target.acquire()?;
    processor
        .as_ref()
        .ok_or_else(sync_error)?
        .convert(&frame, &target.d3d11)?;
    let fence_value = fence.signal()?;
    device.wait()?;
    Ok(fence_value)
}

#[allow(clippy::too_many_arguments)]
fn spawn_encoder(
    output: PathBuf,
    config: EncoderConfig,
    device: VideoDevice,
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
                    EncodeCommand::Video { frame_index, slot } => {
                        trace(frame_index, "encode.video");
                        encode_slot(encoder.as_mut(), &device, &slots, frame_index, slot)
                            .and_then(|()| free.send(slot).map_err(|_| sync_error()))
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
    slots: &[Arc<SharedSurface>],
    frame_index: u32,
    slot: usize,
) -> Result<(), GpuVideoError> {
    let source = slots.get(slot).ok_or_else(sync_error)?;
    let video = encoder.config().video();
    let private = private_bgra(&device.device, video.width(), video.height())?;
    {
        let _read = source.acquire()?;
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
    encoder.write_gpu_frame(frame_index, &private, 0)?;
    Ok(())
}

fn shared_ring(
    owner: &ID3D11Device,
    wgpu_device: &wgpu::Device,
    size: FrameSize,
    usage: wgpu::TextureUsages,
) -> Result<Vec<Arc<SharedSurface>>, GpuVideoError> {
    (0..RING_SIZE)
        .map(|_| {
            SharedSurface::new(owner, wgpu_device, size.width(), size.height(), usage).map(Arc::new)
        })
        .collect()
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

fn extent(size: FrameSize) -> wgpu::Extent3d {
    wgpu::Extent3d {
        width: size.width(),
        height: size.height(),
        depth_or_array_layers: 1,
    }
}

fn texture_copy(texture: &wgpu::Texture) -> wgpu::TexelCopyTextureInfo<'_> {
    wgpu::TexelCopyTextureInfo {
        texture,
        mip_level: 0,
        origin: wgpu::Origin3d::ZERO,
        aspect: wgpu::TextureAspect::All,
    }
}

fn edge(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn trace(index: u32, stage: &str) {
    if std::env::var_os("OSG_GPU_TRACE").is_some() {
        eprintln!("[osg-gpu-video] frame={index} stage={stage}");
    }
}

const fn sync_error() -> GpuVideoError {
    GpuVideoError::null(InteropStage::Synchronization)
}

fn worker_start_error(worker: WorkerStage, error: &std::io::Error) -> GpuVideoError {
    GpuVideoError::WorkerUnavailable {
        worker,
        code: error.raw_os_error().unwrap_or(0),
    }
}
