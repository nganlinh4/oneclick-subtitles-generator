//! Path-free failures at the D3D11/D3D12 boundary.

use osg_compositor::CompositorError;
use osg_decode::DecodeError;
use osg_encode::EncodeError;

/// Closed interop stages, safe to record in product diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InteropStage {
    AdapterIdentity,
    D3d11Device,
    DeviceManager,
    VideoProcessor,
    SharedTexture,
    SharedHandle,
    WgpuImport,
    Synchronization,
    GpuCopy,
}

/// The owned worker whose lifecycle failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerStage {
    Decode,
    Encode,
}

impl core::fmt::Display for WorkerStage {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(match self {
            Self::Decode => "decode",
            Self::Encode => "encode",
        })
    }
}

impl core::fmt::Display for InteropStage {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(match self {
            Self::AdapterIdentity => "matching the compositor adapter",
            Self::D3d11Device => "creating the video device",
            Self::DeviceManager => "attaching the Media Foundation device manager",
            Self::VideoProcessor => "processing the decoded surface",
            Self::SharedTexture => "allocating a shared video surface",
            Self::SharedHandle => "opening a shared video handle",
            Self::WgpuImport => "importing a video surface into the compositor",
            Self::Synchronization => "synchronizing the video devices",
            Self::GpuCopy => "copying a video surface on the GPU",
        })
    }
}

/// A native GPU video failure with no path, text, pixels or process address.
#[derive(Debug, thiserror::Error)]
pub enum GpuVideoError {
    #[error("the GPU video path failed while {stage}: 0x{code:08x}")]
    Interop { stage: InteropStage, code: u32 },
    #[error("the GPU video path requires the Direct3D 12 compositor backend")]
    BackendUnavailable,
    #[error("the GPU did not finish video work within the bounded wait")]
    GpuTimeout,
    #[error("the GPU video operation was cancelled")]
    Cancelled,
    #[error("the {worker} worker could not start: OS error {code}")]
    WorkerUnavailable { worker: WorkerStage, code: i32 },
    #[error("the {worker} worker stopped unexpectedly")]
    WorkerPanicked { worker: WorkerStage },
    #[error(transparent)]
    Decode(#[from] DecodeError),
    #[error(transparent)]
    Encode(#[from] EncodeError),
    #[error(transparent)]
    Compose(#[from] CompositorError),
}

#[cfg(windows)]
impl GpuVideoError {
    pub(crate) fn windows(stage: InteropStage, error: &windows::core::Error) -> Self {
        Self::Interop {
            stage,
            code: error.code().0.cast_unsigned(),
        }
    }

    pub(crate) const fn null(stage: InteropStage) -> Self {
        Self::Interop { stage, code: 0 }
    }

    /// A fence or keyed-mutex handshake failed without an HRESULT of its own.
    pub(crate) const fn synchronization() -> Self {
        Self::null(InteropStage::Synchronization)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAGES: [InteropStage; 9] = [
        InteropStage::AdapterIdentity,
        InteropStage::D3d11Device,
        InteropStage::DeviceManager,
        InteropStage::VideoProcessor,
        InteropStage::SharedTexture,
        InteropStage::SharedHandle,
        InteropStage::WgpuImport,
        InteropStage::Synchronization,
        InteropStage::GpuCopy,
    ];

    #[test]
    fn every_interop_stage_has_its_own_plain_description() {
        let descriptions = STAGES.map(|stage| stage.to_string());
        for (index, description) in descriptions.iter().enumerate() {
            assert!(!description.is_empty());
            assert!(
                description
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == ' ')
            );
            assert!(
                !descriptions[..index].contains(description),
                "{description}"
            );
        }
    }

    #[test]
    fn failures_render_only_closed_stages_and_numeric_codes() {
        let interop = GpuVideoError::Interop {
            stage: InteropStage::SharedHandle,
            code: 0x8007_0005,
        };
        assert_eq!(
            interop.to_string(),
            "the GPU video path failed while opening a shared video handle: 0x80070005"
        );
        let worker = GpuVideoError::WorkerUnavailable {
            worker: WorkerStage::Encode,
            code: 8,
        };
        assert_eq!(
            worker.to_string(),
            "the encode worker could not start: OS error 8"
        );
        assert_eq!(
            GpuVideoError::WorkerPanicked {
                worker: WorkerStage::Decode
            }
            .to_string(),
            "the decode worker stopped unexpectedly"
        );
    }

    #[cfg(windows)]
    #[test]
    fn failing_hresults_keep_their_unsigned_bit_pattern() {
        let error = windows::core::Error::from_hresult(windows::core::HRESULT(
            0x8000_4005_u32.cast_signed(),
        ));
        assert!(matches!(
            GpuVideoError::windows(InteropStage::GpuCopy, &error),
            GpuVideoError::Interop {
                stage: InteropStage::GpuCopy,
                code: 0x8000_4005
            }
        ));
        assert!(matches!(
            GpuVideoError::synchronization(),
            GpuVideoError::Interop {
                stage: InteropStage::Synchronization,
                code: 0
            }
        ));
    }
}
