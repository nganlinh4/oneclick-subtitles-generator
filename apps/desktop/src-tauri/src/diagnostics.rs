use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

const LOG_FILE_NAME: &str = "osg.log";
const PREVIOUS_LOG_FILE_NAME: &str = "osg.previous.log";
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;
const MAX_FIELD_BYTES: usize = 128;

static LOG: OnceLock<Mutex<File>> = OnceLock::new();

pub(crate) fn initialize(directory: &Path) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    let current = directory.join(LOG_FILE_NAME);
    rotate_if_needed(directory, &current)?;
    let file = OpenOptions::new().create(true).append(true).open(current)?;
    let _ = LOG.set(Mutex::new(file));
    record("app.start", &[]);
    Ok(())
}

pub(crate) fn record(event: &'static str, fields: &[(&'static str, String)]) {
    let Some(log) = LOG.get() else {
        return;
    };
    let mut entry = Map::new();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    entry.insert(
        "timestampMs".to_owned(),
        Value::String(timestamp.to_string()),
    );
    entry.insert("event".to_owned(), Value::String(event.to_owned()));
    for (key, value) in fields {
        entry.insert((*key).to_owned(), Value::String(sanitize(value)));
    }
    let Ok(mut encoded) = serde_json::to_vec(&Value::Object(entry)) else {
        return;
    };
    encoded.push(b'\n');
    if let Ok(mut file) = log.lock() {
        let _ = file.write_all(&encoded);
        let _ = file.flush();
    }
}

fn rotate_if_needed(directory: &Path, current: &Path) -> io::Result<()> {
    let Ok(metadata) = fs::metadata(current) else {
        return Ok(());
    };
    if metadata.len() < MAX_LOG_BYTES {
        return Ok(());
    }
    let previous = directory.join(PREVIOUS_LOG_FILE_NAME);
    if previous.exists() {
        fs::remove_file(&previous)?;
    }
    fs::rename(current, previous)
}

fn sanitize(value: &str) -> String {
    if value.is_empty()
        || value.len() > MAX_FIELD_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return "redacted".to_owned();
    }
    value.to_owned()
}

#[cfg(test)]
mod tests {
    use super::{MAX_FIELD_BYTES, sanitize};

    #[test]
    fn diagnostic_fields_accept_identifiers_and_redact_paths_or_secrets() {
        assert_eq!(sanitize("media-tools"), "media-tools");
        assert_eq!(sanitize("019c:completed"), "019c:completed");
        assert_eq!(sanitize("C:\\private\\tool.exe"), "redacted");
        assert_eq!(sanitize("token=value"), "redacted");
        assert_eq!(sanitize(&"a".repeat(MAX_FIELD_BYTES + 1)), "redacted");
    }
}
