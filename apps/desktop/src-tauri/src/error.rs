use osg_application::ApplicationError;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    code: &'static str,
    message: String,
}

impl CommandError {
    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "internal",
            message: message.into(),
        }
    }

    pub(crate) fn invalid_path(message: impl Into<String>) -> Self {
        Self {
            code: "invalidPath",
            message: message.into(),
        }
    }
}

impl From<ApplicationError> for CommandError {
    fn from(error: ApplicationError) -> Self {
        Self {
            code: error.code().as_str(),
            message: error.to_string(),
        }
    }
}

pub(crate) type CommandResult<T> = Result<T, CommandError>;
