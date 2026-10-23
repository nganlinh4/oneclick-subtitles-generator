//! Bounded, GPU-timeline decode -> composite -> encode pipeline.

mod rings;
mod workers;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use osg_compositor::{
    AdapterSelection, Compositor, CompositorTargetFormat, Crop, FrameSize, PreparedSubtitleScene,
    PreparedTextureUnderlay, SubtitleScene,
};
use osg_decode::{DecoderConfig, open_decoder};
use osg_encode::{AudioBlock, AudioConfig, EncodeOutcome, EncoderConfig};

use crate::d3d::{
    DecodeFenceWait, RenderFenceSignal, VideoDevice, compositor_luid, decode_fence, render_fence,
};
use crate::processor::edge;
use crate::shared::{SharedSurface, wait_submission};
use crate::{GpuVideoError, WorkerStage};

use rings::{DECODE_RING_MAX, ENCODE_RING_MAX, ring_size, shared_ring};
use workers::{DecodedReady, EncodeCommand, ReusableDecoded, spawn_decoder, spawn_encoder};

const CHANNEL_WAIT: Duration = Duration::from_secs(30);

/// A complete native video path with no frame-sized CPU pixel buffer.
///
/// Decode and encode own their Media Foundation objects on dedicated threads. The caller owns
/// wgpu composition. Memory-budgeted shared rings provide bounded backpressure, while cross-API
/// fences order resource reuse on the GPU timeline instead of stopping the CPU after every frame.
pub struct GpuVideoPipeline {
    compositor: Compositor,
    scene: PreparedSubtitleScene,
    crop: Crop,
    source_size: FrameSize,
    decoded_slots: Vec<Arc<SharedSurface>>,
    decoded_local: wgpu::Texture,
    prepared_underlay: Option<PreparedTextureUnderlay>,
    decode_fence: DecodeFenceWait,
    render_fence: RenderFenceSignal,
    encoded_slots: Vec<Arc<SharedSurface>>,
    decoded_ready: mpsc::Receiver<Result<DecodedReady, GpuVideoError>>,
    decoded_free: mpsc::SyncSender<ReusableDecoded>,
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
        let scene = compositor.prepare_subtitle_scene(scene)?;

        let decode_device = VideoDevice::on_adapter(luid)?;
        let encode_device = VideoDevice::on_adapter(luid)?;
        let (decode_signal, decode_wait) = decode_fence(&decode_device, compositor.device())?;
        let (render_signal, decode_render_wait, encode_render_wait) =
            render_fence(&decode_device, &encode_device, compositor.device())?;
        let decode_ring_size = ring_size(source_size, DECODE_RING_MAX);
        let encode_ring_size = ring_size(output_size, ENCODE_RING_MAX);
        let decoded_slots = shared_ring(
            &decode_device.device,
            compositor.device(),
            source_size,
            wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
            decode_ring_size,
        )?;
        let encoded_slots = shared_ring(
            &encode_device.device,
            compositor.device(),
            output_size,
            wgpu::TextureUsages::RENDER_ATTACHMENT,
            encode_ring_size,
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
        let prepared_underlay =
            compositor.prepare_texture_underlay(&decoded_local, source_size, crop, output_size)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let (decoded_free_tx, decoded_free_rx) = mpsc::sync_channel(decode_ring_size);
        let (decoded_ready_tx, decoded_ready_rx) = mpsc::channel();
        for slot in 0..decode_ring_size {
            decoded_free_tx
                .send(ReusableDecoded {
                    slot,
                    render_fence_value: 0,
                })
                .map_err(|_| GpuVideoError::synchronization())?;
        }
        let (encoded_free_tx, encoded_free_rx) = mpsc::sync_channel(encode_ring_size);
        for slot in 0..encode_ring_size {
            encoded_free_tx
                .send(slot)
                .map_err(|_| GpuVideoError::synchronization())?;
        }
        // Video slots already cap in-flight frames. Bound commands independently so audio blocks
        // cannot accumulate with media duration if the hardware encoder slows or stalls.
        let (encode_command_tx, encode_command_rx) = mpsc::sync_channel(encode_ring_size * 2);
        let (encode_failure_tx, encode_failure_rx) = mpsc::channel();
        let (opened_tx, opened_rx) = mpsc::sync_channel(1);
        let encode_thread = spawn_encoder(
            output.to_path_buf(),
            encoder_config,
            encode_device,
            encode_render_wait,
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
            decode_render_wait,
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
            prepared_underlay,
            decode_fence: decode_wait,
            render_fence: render_signal,
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
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(GpuVideoError::synchronization());
                }
            }
        };
        if decoded.frame_index() != index {
            trace(index, "render.decode-index-mismatch");
            return Err(GpuVideoError::synchronization());
        }
        // Reserve the output slot before submitting any work which reads the decoded slot. If the
        // encoder is applying backpressure this leaves no un-waited GPU submission behind an early
        // cancellation or channel error.
        let encoded_slot_index = self.next_encode_slot(&mut should_cancel)?;
        let render_fence_value = self.compose_decoded(index, &decoded, encoded_slot_index)?;
        // The worker drops its receiver immediately after publishing the final frame. Recycling
        // that last slot can therefore report disconnection, which is normal completion.
        let (render_fence_value, decoded_slot_index) = render_fence_value;
        if let Some(slot) = decoded_slot_index {
            let _ = self.decoded_free.send(ReusableDecoded {
                slot,
                render_fence_value,
            });
        }
        self.send_command_cancellable(
            EncodeCommand::Video {
                frame_index: index,
                slot: encoded_slot_index,
                render_fence_value,
            },
            &mut should_cancel,
        )?;
        trace(index, "render.queued-encode");
        Ok(())
    }

    fn compose_decoded(
        &mut self,
        index: u32,
        decoded: &DecodedReady,
        encoded_slot_index: usize,
    ) -> Result<(u64, Option<usize>), GpuVideoError> {
        trace(index, "render.compose");
        let encoded_slot = self
            .encoded_slots
            .get(encoded_slot_index)
            .ok_or_else(GpuVideoError::synchronization)?;
        // CPU ownership covers command publication. GPU ownership continues through the fence
        // value carried to both workers: their D3D11 queues wait for this frame's last D3D12
        // submission before either shared surface is touched.
        let _write = encoded_slot.acquire()?;
        let (decoded_slot_index, copy_submission) = match decoded {
            DecodedReady::Frame {
                slot, fence_value, ..
            } => {
                let decoded_slot = self
                    .decoded_slots
                    .get(*slot)
                    .ok_or_else(GpuVideoError::synchronization)?;
                let _read = decoded_slot.acquire()?;
                self.decode_fence
                    .wait(self.compositor.device(), *fence_value)?;
                let mut commands = self.compositor.device().create_command_encoder(
                    &wgpu::CommandEncoderDescriptor {
                        label: Some("osg coherent shared decode copy"),
                    },
                );
                commands.copy_texture_to_texture(
                    texture_copy(&decoded_slot.wgpu),
                    texture_copy(&self.decoded_local),
                    self.decoded_local.size(),
                );
                // Return the shared resource to COPY_DST so the next read crosses a cache-coherent
                // COPY_DST -> COPY_SRC transition. The copied corner preserves the exact pixel.
                commands.copy_texture_to_texture(
                    texture_copy(&self.decoded_local),
                    texture_copy(&decoded_slot.wgpu),
                    wgpu::Extent3d {
                        width: 1,
                        height: 1,
                        depth_or_array_layers: 1,
                    },
                );
                (
                    Some(*slot),
                    Some(self.compositor.queue().submit(Some(commands.finish()))),
                )
            }
            DecodedReady::Hold { .. } => {
                trace(index, "render.source-held");
                (None, None)
            }
        };
        let render_submission = match self.compositor.render_prepared_scene_texture_over_into(
            &mut self.scene,
            self.prepared_underlay.as_ref(),
            &self.decoded_local,
            self.source_size,
            self.crop,
            index,
            &encoded_slot.wgpu,
        ) {
            Ok(submission) => submission,
            Err(error) => {
                if let Some(copy_submission) = copy_submission {
                    wait_submission(
                        self.compositor.device(),
                        self.compositor.queue(),
                        copy_submission,
                    )?;
                }
                return Err(error.into());
            }
        };
        let render_fence_value = match self.render_fence.signal(self.compositor.device()) {
            Ok(value) => value,
            Err(error) => {
                wait_submission(
                    self.compositor.device(),
                    self.compositor.queue(),
                    render_submission,
                )?;
                return Err(error);
            }
        };
        trace(index, "render.gpu-queued");
        Ok((render_fence_value, decoded_slot_index))
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
            .unwrap_or_else(|_| GpuVideoError::synchronization())
    }

    fn wake_decoder(&self) {
        for slot in 0..self.decoded_slots.len() {
            let _ = self.decoded_free.try_send(ReusableDecoded {
                slot,
                render_fence_value: 0,
            });
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

fn trace(index: u32, stage: &str) {
    if std::env::var_os("OSG_GPU_TRACE").is_some() {
        static START: OnceLock<Instant> = OnceLock::new();
        let elapsed_us = START.get_or_init(Instant::now).elapsed().as_micros();
        eprintln!(
            "[osg-gpu-video] elapsed_us={elapsed_us} frame={index} stage={stage} thread={:?}",
            std::thread::current().id()
        );
    }
}
