//! Shared BGRA textures imported into wgpu without host memory.

use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX,
    D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Device,
    ID3D11Texture2D,
};
use windows::Win32::Graphics::Direct3D12::ID3D12Resource;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    DXGI_SHARED_RESOURCE_READ, DXGI_SHARED_RESOURCE_WRITE, IDXGIKeyedMutex, IDXGIResource1,
};
use windows::core::Interface;

use crate::{GpuVideoError, InteropStage};

const MUTEX_TIMEOUT_MS: u32 = 30_000;

pub(crate) struct SharedSurface {
    pub d3d11: ID3D11Texture2D,
    pub wgpu: wgpu::Texture,
    mutex: IDXGIKeyedMutex,
    handle: HANDLE,
}

// SAFETY: D3D11 textures and keyed mutexes are free-threaded resources. The owning devices have
// ID3D10Multithread protection enabled, every cross-thread access is enclosed by this surface's
// keyed mutex, wgpu::Texture is Send + Sync, and Arc keeps the NT handle alive until both stages
// have dropped the surface.
unsafe impl Send for SharedSurface {}
// SAFETY: the same keyed-mutex ownership rule serializes all mutable external API access.
unsafe impl Sync for SharedSurface {}

impl core::fmt::Debug for SharedSurface {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("SharedSurface")
            .finish_non_exhaustive()
    }
}

impl SharedSurface {
    pub(crate) fn new(
        owner: &ID3D11Device,
        wgpu_device: &wgpu::Device,
        width: u32,
        height: u32,
        usage: wgpu::TextureUsages,
    ) -> Result<Self, GpuVideoError> {
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
            MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0
                | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0)
                .cast_unsigned(),
        };
        let mut d3d11 = None;
        // SAFETY: the descriptor and out-parameter are live for the call; no initial host data is
        // supplied because the producer writes the complete surface before it is consumed.
        unsafe { owner.CreateTexture2D(&raw const description, None, Some(&raw mut d3d11)) }
            .map_err(|error| GpuVideoError::windows(InteropStage::SharedTexture, &error))?;
        let d3d11 = d3d11.ok_or(GpuVideoError::null(InteropStage::SharedTexture))?;
        let resource: IDXGIResource1 = d3d11
            .cast()
            .map_err(|error| GpuVideoError::windows(InteropStage::SharedTexture, &error))?;
        // SAFETY: the resource is live; null security attributes and name create a process-local NT
        // handle carrying only read/write sharing rights.
        let handle = unsafe {
            resource.CreateSharedHandle(
                None,
                DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0,
                None,
            )
        }
        .map_err(|error| GpuVideoError::windows(InteropStage::SharedHandle, &error))?;
        let mutex = d3d11
            .cast()
            .map_err(|error| GpuVideoError::windows(InteropStage::Synchronization, &error))?;
        let wgpu = import(wgpu_device, handle, width, height, usage)?;
        Ok(Self {
            d3d11,
            wgpu,
            mutex,
            handle,
        })
    }

    pub(crate) fn acquire(&self) -> Result<KeyedGuard<'_>, GpuVideoError> {
        // SAFETY: the mutex is live and the bounded timeout prevents a driver/device loss from
        // hanging the export worker forever.
        unsafe { self.mutex.AcquireSync(0, MUTEX_TIMEOUT_MS) }
            .map_err(|error| GpuVideoError::windows(InteropStage::Synchronization, &error))?;
        Ok(KeyedGuard { mutex: &self.mutex })
    }
}

impl Drop for SharedSurface {
    fn drop(&mut self) {
        if !self.handle.is_invalid() {
            // SAFETY: this object exclusively owns the NT handle and closes it exactly once.
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

pub(crate) struct KeyedGuard<'a> {
    mutex: &'a IDXGIKeyedMutex,
}

impl Drop for KeyedGuard<'_> {
    fn drop(&mut self) {
        // SAFETY: this guard exists only after a successful key-0 acquisition and releases once.
        unsafe {
            let _ = self.mutex.ReleaseSync(0);
        }
    }
}

fn import(
    device: &wgpu::Device,
    handle: HANDLE,
    width: u32,
    height: u32,
    usage: wgpu::TextureUsages,
) -> Result<wgpu::Texture, GpuVideoError> {
    // SAFETY: the wgpu device remains alive and returns a borrowed handle to its exact DX12 device.
    let hal = unsafe { device.as_hal::<wgpu::hal::api::Dx12>() }
        .ok_or(GpuVideoError::BackendUnavailable)?;
    let mut resource: Option<ID3D12Resource> = None;
    // SAFETY: `resource` is a live out-parameter and `handle` names the D3D11 resource created on
    // the same adapter LUID as this D3D12 device.
    unsafe { hal.raw_device().OpenSharedHandle(handle, &raw mut resource) }
        .map_err(|error| GpuVideoError::windows(InteropStage::SharedHandle, &error))?;
    let resource = resource.ok_or(GpuVideoError::null(InteropStage::SharedHandle))?;
    let size = wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    };
    // SAFETY: the resource is a 1-mip, 1-sample BGRA 2D texture exactly matching the descriptor.
    let hal_texture = unsafe {
        wgpu::hal::dx12::Device::texture_from_raw(
            resource,
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureDimension::D2,
            size,
            1,
            1,
        )
    };
    let description = wgpu::TextureDescriptor {
        label: Some("osg shared GPU video surface"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8Unorm,
        usage,
        view_formats: &[],
    };
    // SAFETY: `hal_texture` came from this device. Shared D3D resources are opened in COMMON,
    // which is D3D12's state for PRESENT; the first wgpu use records the required transition.
    Ok(unsafe {
        device.create_texture_from_hal::<wgpu::hal::api::Dx12>(
            hal_texture,
            &description,
            wgpu::TextureUses::PRESENT,
        )
    })
}

pub(crate) fn wait_submission(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    submission: wgpu::SubmissionIndex,
) -> Result<(), GpuVideoError> {
    let (finished_tx, finished_rx) = std::sync::mpsc::sync_channel(1);
    queue.on_submitted_work_done(move || {
        let _ = finished_tx.send(());
    });
    device
        .poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(Duration::from_secs(30)),
        })
        .map_err(|_| GpuVideoError::GpuTimeout)?;
    finished_rx
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| GpuVideoError::GpuTimeout)?;
    Ok(())
}
