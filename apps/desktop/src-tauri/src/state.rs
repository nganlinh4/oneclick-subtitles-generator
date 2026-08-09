use std::sync::RwLock;

use osg_application::Session;

#[derive(Debug, Default)]
pub(crate) struct DesktopState {
    pub(crate) session: RwLock<Session>,
}
