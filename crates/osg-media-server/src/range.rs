//! Single-range parsing and bounded, interruptible streaming of registered bytes.

use std::fs::File;
use std::io::{self, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use crate::request::{HttpRequest, parse_decimal};
use crate::response::{
    common_media_headers, cors_headers, respond_empty, respond_text, write_response_head,
};
use crate::{CloneableEntry, CloneableSource, STALLED_WRITE_DEADLINE, STREAM_BUFFER_BYTES};

pub(crate) fn serve_entry(
    stream: &mut TcpStream,
    request: &HttpRequest,
    origin: Option<&str>,
    entity_tag: &str,
    entry: &CloneableEntry,
    stopping: &AtomicBool,
) {
    let byte_length = match &entry.source {
        CloneableSource::File { file, modified } => match file.metadata() {
            Ok(metadata)
                if metadata.is_file()
                    && metadata.len() == entry.byte_length
                    && metadata.modified().ok() == *modified =>
            {
                metadata.len()
            }
            _ => {
                let _ = respond_text(
                    stream,
                    request.is_head(),
                    409,
                    "Conflict",
                    "Media changed on disk",
                    &cors_headers(origin),
                );
                return;
            }
        },
        CloneableSource::Image(bytes) => {
            let Ok(byte_length) = u64::try_from(bytes.len()) else {
                return;
            };
            if byte_length != entry.byte_length || byte_length == 0 {
                return;
            }
            byte_length
        }
    };
    let Ok(range_header) = request.unique_header("range") else {
        let _ = respond_text(
            stream,
            request.is_head(),
            400,
            "Bad Request",
            "Bad request",
            &cors_headers(origin),
        );
        return;
    };
    let Ok(range) = parse_range(range_header, byte_length) else {
        let mut headers = common_media_headers(origin, entity_tag, entry);
        headers.push(("Content-Range", format!("bytes */{byte_length}")));
        let _ = respond_empty(stream, 416, "Range Not Satisfiable", &headers);
        return;
    };
    let (start, end, status, reason) = match range {
        Some((start, end)) => (start, end, 206, "Partial Content"),
        None => (0, byte_length - 1, 200, "OK"),
    };
    let response_length = end - start + 1;
    let mut headers = common_media_headers(origin, entity_tag, entry);
    if status == 206 {
        headers.push((
            "Content-Range",
            format!("bytes {start}-{end}/{byte_length}"),
        ));
    }

    if write_response_head(stream, status, reason, response_length, &headers).is_err()
        || request.is_head()
    {
        return;
    }
    let result = match &entry.source {
        CloneableSource::File { file, .. } => {
            write_file_range(stream, file, start, response_length, stopping)
        }
        CloneableSource::Image(bytes) => {
            write_memory_range(stream, bytes, start, response_length, stopping)
        }
    };
    let _ = result;
}

pub(crate) fn write_memory_range(
    stream: &mut TcpStream,
    bytes: &[u8],
    offset: u64,
    length: u64,
    stopping: &AtomicBool,
) -> io::Result<()> {
    let start =
        usize::try_from(offset).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let length =
        usize::try_from(length).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let end = start
        .checked_add(length)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    write_all_interruptible(stream, &bytes[start..end], stopping)
}

pub(crate) fn write_file_range(
    stream: &mut TcpStream,
    file: &File,
    mut offset: u64,
    mut remaining: u64,
    stopping: &AtomicBool,
) -> io::Result<()> {
    let mut buffer = vec![0_u8; STREAM_BUFFER_BYTES].into_boxed_slice();
    while remaining != 0 {
        if stopping.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "media server is stopping",
            ));
        }
        let requested = usize::try_from(remaining.min(STREAM_BUFFER_BYTES as u64))
            .expect("the bounded stream chunk fits usize");
        let read = loop {
            match positioned_read(file, &mut buffer[..requested], offset) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                result => break result?,
            }
        };
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "registered media ended during streaming",
            ));
        }
        write_all_interruptible(stream, &buffer[..read], stopping)?;
        let read = u64::try_from(read).expect("read length fits u64");
        offset += read;
        remaining -= read;
    }
    Ok(())
}

pub(crate) fn write_all_interruptible(
    stream: &mut TcpStream,
    mut bytes: &[u8],
    stopping: &AtomicBool,
) -> io::Result<()> {
    let mut progress_deadline = Instant::now() + STALLED_WRITE_DEADLINE;
    while !bytes.is_empty() {
        if stopping.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "media server is stopping",
            ));
        }
        match stream.write(bytes) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
            Ok(written) => {
                bytes = &bytes[written..];
                progress_deadline = Instant::now() + STALLED_WRITE_DEADLINE;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                if Instant::now() >= progress_deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "media client stopped receiving",
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn positioned_read(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    use std::os::unix::fs::FileExt;

    file.read_at(buffer, offset)
}

#[cfg(windows)]
pub(crate) fn positioned_read(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    use std::os::windows::fs::FileExt;

    file.seek_read(buffer, offset)
}

pub(crate) fn parse_range(value: Option<&str>, byte_length: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    if byte_length == 0 {
        return Err(());
    }
    let (unit, value) = value.split_once('=').ok_or(())?;
    if !unit.eq_ignore_ascii_case("bytes") || value.contains(',') {
        return Err(());
    }
    let (start, end) = value.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = parse_decimal(end).ok_or(())?;
        if suffix == 0 {
            return Err(());
        }
        return Ok(Some((byte_length.saturating_sub(suffix), byte_length - 1)));
    }
    let start = parse_decimal(start).ok_or(())?;
    if start >= byte_length {
        return Err(());
    }
    let end = if end.is_empty() {
        byte_length - 1
    } else {
        parse_decimal(end).ok_or(())?.min(byte_length - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some((start, end)))
}
