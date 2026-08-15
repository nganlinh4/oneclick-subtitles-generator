//! Headless GPU acquisition.
//!
//! The compositor never creates a window or a surface. It asks the platform for any adapter that
//! can render offscreen — discrete, integrated, virtual or software — and fails closed with
//! [`CompositorError::NoAdapter`] when none exists.

use wgpu::{
    Backends, Device, DeviceDescriptor, DeviceType, ExperimentalFeatures, Instance,
    InstanceDescriptor, Limits, MemoryHints, PowerPreference, Queue, RequestAdapterOptions, Trace,
};

use crate::error::CompositorError;

/// Which adapters the compositor is allowed to consider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum AdapterSelection {
    /// Every backend the platform compiles in, preferring low power so a laptop preview does not
    /// wake the discrete GPU. Software adapters are accepted.
    #[default]
    Automatic,
    /// No backends at all.
    ///
    /// This is the fault-injection path: it drives the same code a machine with no usable GPU
    /// takes, so the "no adapter" failure is exercised on machines that do have one.
    None,
}

impl AdapterSelection {
    const fn backends(self) -> Backends {
        match self {
            Self::Automatic => Backends::all(),
            Self::None => Backends::empty(),
        }
    }
}

/// The broad class of the adapter that was acquired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum DeviceKind {
    /// A dedicated GPU.
    Discrete,
    /// A GPU sharing memory with the host.
    Integrated,
    /// A paravirtualised GPU.
    Virtual,
    /// A CPU implementation such as WARP or lavapipe.
    Software,
    /// A class the backend did not classify.
    Other,
}

impl DeviceKind {
    const fn from_wgpu(device_type: DeviceType) -> Self {
        match device_type {
            DeviceType::DiscreteGpu => Self::Discrete,
            DeviceType::IntegratedGpu => Self::Integrated,
            DeviceType::VirtualGpu => Self::Virtual,
            DeviceType::Cpu => Self::Software,
            DeviceType::Other => Self::Other,
        }
    }

    /// Whether composition runs on the CPU, which is correct but far slower.
    #[must_use]
    pub const fn is_software(self) -> bool {
        matches!(self, Self::Software)
    }
}

/// What the compositor is running on.
///
/// This is diagnostic detail, not a capability handle: it carries no pointers, no paths and no
/// driver-private identifiers beyond the names the backend already reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterProfile {
    name: String,
    backend: String,
    kind: DeviceKind,
}

impl AdapterProfile {
    /// The adapter name reported by the driver.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The graphics backend in use, such as `Vulkan` or `Dx12`.
    #[must_use]
    pub fn backend(&self) -> &str {
        &self.backend
    }

    /// The adapter class.
    #[must_use]
    pub const fn kind(&self) -> DeviceKind {
        self.kind
    }
}

/// An acquired device, queue and the profile of the adapter behind them.
#[derive(Debug)]
pub(crate) struct GpuContext {
    device: Device,
    queue: Queue,
    profile: AdapterProfile,
}

impl GpuContext {
    pub(crate) fn acquire(selection: AdapterSelection) -> Result<Self, CompositorError> {
        let instance = Instance::new(InstanceDescriptor {
            backends: selection.backends(),
            ..InstanceDescriptor::new_without_display_handle()
        });

        let adapter = pollster::block_on(instance.request_adapter(&RequestAdapterOptions {
            power_preference: PowerPreference::LowPower,
            force_fallback_adapter: false,
            compatible_surface: None,
            // Bucketed limits would make results depend on which bucket an adapter lands in.
            apply_limit_buckets: false,
        }))
        .map_err(|error| CompositorError::NoAdapter {
            reason: error.to_string(),
        })?;

        let info = adapter.get_info();
        let profile = AdapterProfile {
            name: info.name,
            backend: info.backend.to_string(),
            kind: DeviceKind::from_wgpu(info.device_type),
        };

        let (device, queue) = pollster::block_on(adapter.request_device(&DeviceDescriptor {
            label: Some("osg-compositor"),
            required_features: wgpu::Features::empty(),
            required_limits: Limits::downlevel_defaults(),
            experimental_features: ExperimentalFeatures::disabled(),
            memory_hints: MemoryHints::default(),
            trace: Trace::Off,
        }))
        .map_err(|error| CompositorError::DeviceUnavailable {
            reason: error.to_string(),
        })?;

        Ok(Self {
            device,
            queue,
            profile,
        })
    }

    pub(crate) const fn device(&self) -> &Device {
        &self.device
    }

    pub(crate) const fn queue(&self) -> &Queue {
        &self.queue
    }

    pub(crate) const fn profile(&self) -> &AdapterProfile {
        &self.profile
    }
}
