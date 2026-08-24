//! Exact-adapter D3D11 devices and Media Foundation managers.

use windows::Win32::Foundation::{CloseHandle, GENERIC_ALL, HMODULE, LUID};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D10::ID3D10Multithread;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_QUERY_DESC,
    D3D11_QUERY_EVENT, D3D11_SDK_VERSION, D3D11CreateDevice, ID3D11Device, ID3D11Device5,
    ID3D11DeviceContext, ID3D11DeviceContext4, ID3D11Fence, ID3D11Query,
};
use windows::Win32::Graphics::Direct3D12::{D3D12_FENCE_FLAG_SHARED, ID3D12Fence};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
use windows::Win32::Media::MediaFoundation::{IMFDXGIDeviceManager, MFCreateDXGIDeviceManager};
use windows::core::Interface;

use crate::{GpuVideoError, InteropStage};

#[derive(Debug)]
pub(crate) struct VideoDevice {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub manager: IMFDXGIDeviceManager,
    fence: GpuFence,
    _reset_token: u32,
}

// SAFETY: D3D11 devices are free-threaded, the immediate context is explicitly protected through
// ID3D10Multithread before this value is constructed, and the pipeline moves the whole bundle to
// exactly one worker rather than using the context concurrently. The DXGI manager is tied to that
// same protected device and is created before the move.
unsafe impl Send for VideoDevice {}

pub(crate) fn compositor_luid(device: &wgpu::Device) -> Result<LUID, GpuVideoError> {
    // SAFETY: the compositor device is held for this call and wgpu returns a borrowed HAL device.
    let hal = unsafe { device.as_hal::<wgpu::hal::api::Dx12>() }
        .ok_or(GpuVideoError::BackendUnavailable)?;
    // SAFETY: GetAdapterLuid returns a scalar identity from the live D3D12 device.
    Ok(unsafe { hal.raw_device().GetAdapterLuid() })
}

impl VideoDevice {
    pub(crate) fn on_adapter(luid: LUID) -> Result<Self, GpuVideoError> {
        // SAFETY: factory creation has no borrowed inputs and returns an owned COM interface.
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }
            .map_err(|error| GpuVideoError::windows(InteropStage::AdapterIdentity, &error))?;
        let mut matched = None;
        for index in 0.. {
            // SAFETY: indices are probed until DXGI reports exhaustion.
            let Ok(adapter) = (unsafe { factory.EnumAdapters1(index) }) else {
                break;
            };
            // SAFETY: the adapter is live and the description is returned by value.
            let description = unsafe { adapter.GetDesc1() }
                .map_err(|error| GpuVideoError::windows(InteropStage::AdapterIdentity, &error))?;
            if description.AdapterLuid == luid {
                matched = Some(adapter);
                break;
            }
        }
        let adapter = matched.ok_or(GpuVideoError::null(InteropStage::AdapterIdentity))?;
        let mut device = None;
        let mut context = None;
        let levels = [D3D_FEATURE_LEVEL_11_0];
        let flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        // SAFETY: all out-parameters are live locals. UNKNOWN is required with an explicit adapter.
        unsafe {
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                flags,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&raw mut device),
                None,
                Some(&raw mut context),
            )
        }
        .map_err(|error| GpuVideoError::windows(InteropStage::D3d11Device, &error))?;
        let device = device.ok_or(GpuVideoError::null(InteropStage::D3d11Device))?;
        let context = context.ok_or(GpuVideoError::null(InteropStage::D3d11Device))?;
        let multithread: ID3D10Multithread = device
            .cast()
            .map_err(|error| GpuVideoError::windows(InteropStage::D3d11Device, &error))?;
        // SAFETY: the interface belongs to this live device. Media Foundation may submit decoder
        // work from its own worker while this crate uses the immediate context for VP/copy work.
        let _ = unsafe { multithread.SetMultithreadProtected(true) };

        let mut reset_token = 0;
        let mut manager = None;
        // SAFETY: both out-parameters are live locals.
        unsafe { MFCreateDXGIDeviceManager(&raw mut reset_token, &raw mut manager) }
            .map_err(|error| GpuVideoError::windows(InteropStage::DeviceManager, &error))?;
        let manager = manager.ok_or(GpuVideoError::null(InteropStage::DeviceManager))?;
        // SAFETY: the manager and device are live; the token came from this manager's creation.
        unsafe { manager.ResetDevice(&device, reset_token) }
            .map_err(|error| GpuVideoError::windows(InteropStage::DeviceManager, &error))?;
        let fence = GpuFence::new(&device, &context)?;
        Ok(Self {
            device,
            context,
            manager,
            fence,
            _reset_token: reset_token,
        })
    }

    pub(crate) fn wait(&self) -> Result<(), GpuVideoError> {
        self.fence.signal_and_wait()
    }
}

/// D3D11 producer half of a fence shared with the compositor's D3D12 queue.
#[derive(Debug)]
pub(crate) struct DecodeFenceSignal {
    context: ID3D11DeviceContext4,
    fence: ID3D11Fence,
    value: u64,
}

// SAFETY: the context belongs to the protected `VideoDevice` moved to the same worker, and this
// producer is moved with it and used by that worker only.
unsafe impl Send for DecodeFenceSignal {}

impl DecodeFenceSignal {
    pub(crate) fn signal(&mut self) -> Result<u64, GpuVideoError> {
        self.value = self.value.checked_add(1).ok_or_else(sync_error)?;
        // SAFETY: the fence was opened on this context's device and remains live through the call.
        unsafe { self.context.Signal(&self.fence, self.value) }
            .map_err(|error| GpuVideoError::windows(InteropStage::Synchronization, &error))?;
        Ok(self.value)
    }
}

/// D3D12 consumer half of the decode fence.
#[derive(Debug)]
pub(crate) struct DecodeFenceWait {
    fence: ID3D12Fence,
}

impl DecodeFenceWait {
    pub(crate) fn wait(&self, device: &wgpu::Device, value: u64) -> Result<(), GpuVideoError> {
        // SAFETY: the compositor device remains live and gives access to its owned queue.
        let hal = unsafe { device.as_hal::<wgpu::hal::api::Dx12>() }
            .ok_or(GpuVideoError::BackendUnavailable)?;
        // SAFETY: queue and fence are live; Wait enqueues a GPU-timeline dependency.
        unsafe { hal.raw_queue().Wait(&self.fence, value) }
            .map_err(|error| GpuVideoError::windows(InteropStage::Synchronization, &error))
    }
}

pub(crate) fn decode_fence(
    d3d11: &VideoDevice,
    d3d12: &wgpu::Device,
) -> Result<(DecodeFenceSignal, DecodeFenceWait), GpuVideoError> {
    // SAFETY: the wgpu device remains live and returns its exact D3D12 device by borrow.
    let hal = unsafe { d3d12.as_hal::<wgpu::hal::api::Dx12>() }
        .ok_or(GpuVideoError::BackendUnavailable)?;
    // SAFETY: creation returns an owned fence on the live device.
    let fence12: ID3D12Fence = unsafe { hal.raw_device().CreateFence(0, D3D12_FENCE_FLAG_SHARED) }
        .map_err(|error| GpuVideoError::windows(InteropStage::Synchronization, &error))?;
    // Resolve every fallible interface before creating the raw handle so no early return can leak
    // it. The COM interfaces themselves are owned and clean up normally.
    let device5: ID3D11Device5 = d3d11
        .device
        .cast()
        .map_err(|error| GpuVideoError::windows(InteropStage::Synchronization, &error))?;
    let context4: ID3D11DeviceContext4 = d3d11
        .context
        .cast()
        .map_err(|error| GpuVideoError::windows(InteropStage::Synchronization, &error))?;
    // SAFETY: the device and fence are live; an unnamed process-local handle is requested.
    let handle = unsafe {
        hal.raw_device()
            .CreateSharedHandle(&fence12, None, GENERIC_ALL.0, None)
    }
    .map_err(|error| GpuVideoError::windows(InteropStage::Synchronization, &error))?;

    let mut fence11 = None;
    // SAFETY: the handle names `fence12`; the typed out-parameter is live for the call.
    let opened = unsafe { device5.OpenSharedFence(handle, &raw mut fence11) };
    // SAFETY: this function exclusively owns the temporary sharing handle and closes it once,
    // after D3D11 has taken its own fence reference (or rejected it).
    unsafe {
        let _ = CloseHandle(handle);
    }
    opened.map_err(|error| GpuVideoError::windows(InteropStage::Synchronization, &error))?;
    let fence11 = fence11.ok_or(GpuVideoError::null(InteropStage::Synchronization))?;

    Ok((
        DecodeFenceSignal {
            context: context4,
            fence: fence11,
            value: 0,
        },
        DecodeFenceWait { fence: fence12 },
    ))
}

const fn sync_error() -> GpuVideoError {
    GpuVideoError::null(InteropStage::Synchronization)
}

#[derive(Debug)]
struct GpuFence {
    query: ID3D11Query,
    context: ID3D11DeviceContext,
}

impl GpuFence {
    fn new(device: &ID3D11Device, context: &ID3D11DeviceContext) -> Result<Self, GpuVideoError> {
        let description = D3D11_QUERY_DESC {
            Query: D3D11_QUERY_EVENT,
            MiscFlags: 0,
        };
        let mut query = None;
        // SAFETY: the description and out-parameter are live through the call.
        unsafe { device.CreateQuery(&raw const description, Some(&raw mut query)) }
            .map_err(|error| GpuVideoError::windows(InteropStage::Synchronization, &error))?;
        Ok(Self {
            query: query.ok_or(GpuVideoError::null(InteropStage::Synchronization))?,
            context: context.clone(),
        })
    }

    fn signal_and_wait(&self) -> Result<(), GpuVideoError> {
        // SAFETY: End and Flush act on the live immediate context and query.
        unsafe { self.context.End(&self.query) };
        // SAFETY: the protected immediate context remains live.
        unsafe { self.context.Flush() };
        let started = std::time::Instant::now();
        let mut spins = 0_u32;
        loop {
            let mut done = 0_i32;
            // SAFETY: the output pointer names a live four-byte BOOL and the query is live.
            let status = unsafe {
                self.context.GetData(
                    &self.query,
                    Some((&raw mut done).cast()),
                    u32::try_from(core::mem::size_of::<i32>()).unwrap_or(4),
                    0,
                )
            };
            status
                .map_err(|error| GpuVideoError::windows(InteropStage::Synchronization, &error))?;
            if done != 0 {
                return Ok(());
            }
            if started.elapsed() >= std::time::Duration::from_secs(30) {
                return Err(GpuVideoError::GpuTimeout);
            }
            spins = spins.saturating_add(1);
            if spins > 1_000 {
                std::thread::sleep(std::time::Duration::from_micros(200));
            } else {
                std::hint::spin_loop();
            }
        }
    }
}
