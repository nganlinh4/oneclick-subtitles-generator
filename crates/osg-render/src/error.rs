use thiserror::Error;

pub type Result<T> = std::result::Result<T, RenderError>;

/// Why a render request is not a render plan.
///
/// Errors are intentionally categorical. Native paths, input text and process arguments must never
/// be retained in a displayable error. The crate validates a contract and nothing else, so
/// [`Self::InvalidRequest`] is the only thing it can refuse with; every failure of the export
/// itself is `osg_export::ExportError`'s to name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum RenderError {
    #[error("the render request is invalid")]
    InvalidRequest,
}
