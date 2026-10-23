//! Managed native tools: verified install, removal and hot activation of reviewed tool packages.

mod commands;
mod durable;
mod operations;
mod runtime;
mod types;

pub(crate) use self::commands::{
    native_tool_cancel, native_tool_install, native_tool_remove, native_tools_catalog,
    native_tools_status,
};
pub(crate) use self::types::{NativeToolActivator, NativeToolRuntime};

const SCHEMA_VERSION: u32 = 1;
const OPERATION_SCOPE: &str = "native-tool-operations";
const PENDING_REMOVAL_SCOPE: &str = "native-tool-pending-removal";
const PENDING_REMOVAL_VALUE: u32 = 1;

#[cfg(test)]
mod tests;
