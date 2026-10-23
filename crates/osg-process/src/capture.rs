use std::collections::VecDeque;
use std::io::Read;

/// Longest line handed to a line observer; the rest of an oversized line is dropped.
const LINE_LIMIT: usize = 4 * 1024;
const READ_CHUNK: usize = 8 * 1024;

/// Which part of a stream to retain when it exceeds its bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureMode {
    /// Keep the first `n` bytes (machine output such as JSON).
    Head(usize),
    /// Keep the last `n` bytes (diagnostics, where the end explains the failure).
    Tail(usize),
}

/// Receives each captured line without its line feed.
pub type LineObserver<'a> = &'a mut dyn FnMut(&[u8]);

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Capture {
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

/// Drains `reader` to its end so the child never blocks on a full pipe, retaining at most the
/// mode's bound and handing each line (without its `\n`) to `on_line`.
pub fn capture_stream(
    mut reader: impl Read,
    mode: CaptureMode,
    mut on_line: Option<LineObserver<'_>>,
) -> std::io::Result<Capture> {
    let mut retained = Retained::new(mode);
    let mut line = Vec::new();
    let mut buffer = [0_u8; READ_CHUNK];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        retained.push(chunk);
        if let Some(observer) = on_line.as_deref_mut() {
            for &byte in chunk {
                if byte == b'\n' {
                    observer(&line);
                    line.clear();
                } else if line.len() < LINE_LIMIT {
                    line.push(byte);
                }
            }
        }
    }
    if let Some(observer) = on_line
        && !line.is_empty()
    {
        observer(&line);
    }
    Ok(retained.finish())
}

enum Retained {
    Head {
        bytes: Vec<u8>,
        limit: usize,
        truncated: bool,
    },
    Tail {
        bytes: VecDeque<u8>,
        limit: usize,
        truncated: bool,
    },
}

impl Retained {
    fn new(mode: CaptureMode) -> Self {
        match mode {
            CaptureMode::Head(limit) => Self::Head {
                bytes: Vec::with_capacity(limit.min(64 * 1024)),
                limit,
                truncated: false,
            },
            CaptureMode::Tail(limit) => Self::Tail {
                bytes: VecDeque::with_capacity(limit.min(64 * 1024)),
                limit,
                truncated: false,
            },
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        match self {
            Self::Head {
                bytes,
                limit,
                truncated,
            } => {
                let kept = chunk.len().min(limit.saturating_sub(bytes.len()));
                bytes.extend_from_slice(&chunk[..kept]);
                *truncated |= kept < chunk.len();
            }
            Self::Tail {
                bytes,
                limit,
                truncated,
            } => {
                bytes.extend(chunk);
                let excess = bytes.len().saturating_sub(*limit);
                if excess > 0 {
                    bytes.drain(..excess);
                    *truncated = true;
                }
            }
        }
    }

    fn finish(self) -> Capture {
        match self {
            Self::Head {
                bytes, truncated, ..
            } => Capture { bytes, truncated },
            Self::Tail {
                bytes, truncated, ..
            } => Capture {
                bytes: bytes.into(),
                truncated,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(input: &[u8], mode: CaptureMode) -> (Capture, Vec<Vec<u8>>) {
        let mut lines = Vec::new();
        let mut observer = |line: &[u8]| lines.push(line.to_vec());
        let capture = capture_stream(input, mode, Some(&mut observer)).unwrap();
        (capture, lines)
    }

    #[test]
    fn head_keeps_the_start_and_reports_truncation() {
        let (capture, _) = lines_of(b"abcdef", CaptureMode::Head(4));
        assert_eq!(capture.bytes, b"abcd");
        assert!(capture.truncated);
        let (capture, _) = lines_of(b"abc", CaptureMode::Head(4));
        assert_eq!(capture.bytes, b"abc");
        assert!(!capture.truncated);
    }

    #[test]
    fn tail_keeps_the_end_across_chunks() {
        let mut input = vec![b'x'; READ_CHUNK * 3];
        input.extend_from_slice(b"TAIL");
        let capture = capture_stream(input.as_slice(), CaptureMode::Tail(6), None).unwrap();
        assert_eq!(capture.bytes, b"xxTAIL");
        assert!(capture.truncated);
        assert_eq!(
            capture_stream(&b""[..], CaptureMode::Tail(0), None).unwrap(),
            Capture::default()
        );
    }

    #[test]
    fn every_line_is_observed_including_an_unterminated_last_line() {
        let (_, lines) = lines_of(b"one\r\ntwo\n\nlast", CaptureMode::Head(0));
        assert_eq!(
            lines,
            [
                b"one\r".to_vec(),
                b"two".to_vec(),
                Vec::new(),
                b"last".to_vec()
            ]
        );
    }

    #[test]
    fn oversized_lines_are_bounded() {
        let mut input = vec![b'y'; LINE_LIMIT * 2];
        input.push(b'\n');
        let (_, lines) = lines_of(&input, CaptureMode::Head(0));
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), LINE_LIMIT);
    }
}
