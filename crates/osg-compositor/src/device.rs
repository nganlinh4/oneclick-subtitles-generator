//! Headless GPU acquisition.
//!
//! The compositor never creates a window or a surface. It asks the platform for any adapter that
//! can render offscreen — discrete, integrated, virtual or software — and fails closed with
//! [`CompositorError::NoAdapter`] when none exists.

use wgpu::{
    Adapter, Backends, Device, DeviceDescriptor, DeviceType, ExperimentalFeatures, Instance,
    InstanceDescriptor, Limits, MemoryHints, PowerPreference, Queue, RequestAdapterOptions, Trace,
};

use crate::error::CompositorError;
use crate::size::MAX_FRAME_DIMENSION;

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
/// This carries no pointers, no paths and no driver-private identifiers beyond the names the
/// backend already reports. Alongside those names it carries the one capability number the
/// compositor's own bounds depend on — [`AdapterProfile::max_texture_dimension_2d`] — because a
/// composition larger than that must be refused rather than attempted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterProfile {
    name: String,
    backend: String,
    kind: DeviceKind,
    max_texture_dimension_2d: u32,
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

    /// The longest 2D texture edge the acquired device will allocate.
    ///
    /// This is the device's granted `max_texture_dimension_2d`, never larger than
    /// [`crate::MAX_FRAME_DIMENSION`]. A composition, a decoded source frame or a glyph atlas with
    /// an edge past it is refused with [`CompositorError::DeviceTextureLimit`] before any texture
    /// is created, because `wgpu` validates that dimension by panicking.
    #[must_use]
    pub const fn max_texture_dimension_2d(&self) -> u32 {
        self.max_texture_dimension_2d
    }
}

/// The limits the compositor asks a device for.
///
/// [`Limits::downlevel_defaults`] caps `max_texture_dimension_2d` at 2048, which is below 1440p,
/// 4K and 8K — three of the four output sizes the product offers — and below the 4096-pixel glyph
/// atlas the baker may hand over. Every *other* limit in that profile is generous enough for this
/// crate (the widest readback, 8K RGBA8 at a 256-byte row alignment, is 127 MiB against a 256 MiB
/// `max_buffer_size`), so exactly one limit is raised, and only as far as two facts allow: what
/// this adapter reports it can do, and what the compositor would ever allocate.
///
/// Asking for the adapter's own resolution rather than a fixed number is what keeps an adapter that
/// genuinely stops at 2048 usable: it still yields a device, and the sizes it cannot take become a
/// typed refusal instead of a failed device request that would take every size down with it.
fn required_limits(adapter: &Adapter) -> Limits {
    let mut limits = Limits::downlevel_defaults();
    limits.max_texture_dimension_2d = adapter
        .limits()
        .max_texture_dimension_2d
        .min(MAX_FRAME_DIMENSION);
    limits
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
        let (device, queue) = pollster::block_on(adapter.request_device(&DeviceDescriptor {
            label: Some("osg-compositor"),
            required_features: wgpu::Features::empty(),
            required_limits: required_limits(&adapter),
            experimental_features: ExperimentalFeatures::disabled(),
            memory_hints: MemoryHints::default(),
            trace: Trace::Off,
        }))
        .map_err(|error| CompositorError::DeviceUnavailable {
            reason: error.to_string(),
        })?;

        // The device's own answer, not the adapter's and not what was asked for, because the
        // granted limit is the one `create_texture` will validate against.
        let profile = AdapterProfile {
            name: info.name,
            backend: info.backend.to_string(),
            kind: DeviceKind::from_wgpu(info.device_type),
            max_texture_dimension_2d: device.limits().max_texture_dimension_2d,
        };

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
