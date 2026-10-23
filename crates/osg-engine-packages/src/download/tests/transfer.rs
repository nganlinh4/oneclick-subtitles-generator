//! Real-socket transfer tests: interrupted downloads resume by exact range, a changed upstream
//! object is never spliced onto earlier bytes, and cancellation does not wait for a stalled read.

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use url::Url;

use super::super::http::transfer;
use super::*;

/// How the fake origin answers one request, given the requested range start.
#[derive(Clone, Copy)]
enum Reply {
    /// Serves the range, but closes the socket after `limit` body bytes.
    Truncated { limit: usize },
    /// Serves the range completely.
    Complete,
    /// Sends headers and `prefix` body bytes, then stalls.
    Stall { prefix: usize },
}

struct Origin {
    url: Url,
    requests: mpsc::Receiver<(Option<String>, Option<String>)>,
}

fn origin(body: &'static [u8], etag: &'static str, replies: Vec<Reply>) -> Origin {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!(
        "http://{}/asset.bin",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let (sender, requests) = mpsc::channel();
    thread::spawn(move || {
        for reply in replies {
            let Ok((stream, _)) = listener.accept() else {
                return;
            };
            let (range, if_range) = read_request(&stream);
            let _ = sender.send((range.clone(), if_range));
            serve(stream, body, etag, range.as_deref(), reply);
        }
    });
    Origin { url, requests }
}

fn read_request(stream: &TcpStream) -> (Option<String>, Option<String>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let (mut range, mut if_range) = (None, None);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            return (range, if_range);
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("range: ") {
            range = Some(value.trim().to_owned());
        } else if lower.starts_with("if-range: ") {
            if_range = Some(line[10..].trim().to_owned());
        }
    }
}

fn serve(mut stream: TcpStream, body: &[u8], etag: &str, range: Option<&str>, reply: Reply) {
    let (start, end) = range
        .and_then(|value| value.strip_prefix("bytes="))
        .and_then(|value| value.split_once('-'))
        .map(|(start, end)| {
            (
                start.parse::<usize>().unwrap(),
                end.parse::<usize>().unwrap(),
            )
        })
        .unwrap();
    let slice = &body[start..=end];
    let _ = write!(
        stream,
        "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\nETag: {etag}\r\nConnection: close\r\n\r\n",
        slice.len(),
        body.len()
    );
    match reply {
        Reply::Complete => {
            let _ = stream.write_all(slice);
        }
        Reply::Truncated { limit } => {
            let _ = stream.write_all(&slice[..limit]);
        }
        Reply::Stall { prefix } => {
            let _ = stream.write_all(&slice[..prefix]);
            let _ = stream.flush();
            thread::sleep(Duration::from_secs(10));
        }
    }
    let _ = stream.flush();
}

fn plain_client() -> Client {
    // Exercise real HTTP privately; the public fetcher still admits only reviewed HTTPS.
    Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap()
}

fn request<'a>(
    target: &'a Path,
    resume_from: u64,
    etag: Option<&'a str>,
    cancellation: &'a CancellationToken,
) -> FetchRequest<'a> {
    FetchRequest {
        target,
        resume_from,
        etag,
        cancellation,
        progress: &|_| {},
    }
}

const BODY: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

#[test]
fn an_interrupted_download_resumes_from_the_exact_byte_it_reached() {
    let origin = origin(
        BODY,
        "\"v1\"",
        vec![Reply::Truncated { limit: 10 }, Reply::Complete],
    );
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("asset.partial");
    let cancellation = CancellationToken::default();
    let client = plain_client();

    let first = transfer(
        &client,
        &origin.url,
        BODY.len() as u64,
        request(&target, 0, None, &cancellation),
    );
    assert!(matches!(
        first,
        Err(PackageError::Network | PackageError::IncompleteDownload)
    ));
    let kept = fs::metadata(&target).unwrap().len();
    assert_eq!(kept, 10, "the bytes received before the cut are kept");

    let etag = transfer(
        &client,
        &origin.url,
        BODY.len() as u64,
        request(&target, kept, Some("\"v1\""), &cancellation),
    )
    .unwrap();
    assert_eq!(etag.as_deref(), Some("\"v1\""));
    assert_eq!(fs::read(&target).unwrap(), BODY);

    let (first_range, _) = origin.requests.recv().unwrap();
    let (resumed_range, if_range) = origin.requests.recv().unwrap();
    assert_eq!(first_range.as_deref(), Some("bytes=0-35"));
    assert_eq!(resumed_range.as_deref(), Some("bytes=10-35"));
    assert_eq!(if_range.as_deref(), Some("\"v1\""));
}

#[test]
fn a_changed_upstream_object_is_never_spliced_onto_a_partial_download() {
    let origin = origin(BODY, "\"v2\"", vec![Reply::Complete]);
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("asset.partial");
    fs::write(&target, &BODY[..10]).unwrap();
    let cancellation = CancellationToken::default();
    assert_eq!(
        transfer(
            &plain_client(),
            &origin.url,
            BODY.len() as u64,
            request(&target, 10, Some("\"v1\""), &cancellation),
        ),
        Err(PackageError::InvalidResume)
    );
    assert_eq!(fs::read(&target).unwrap(), &BODY[..10]);
}

#[test]
fn cancellation_interrupts_a_stalled_transfer_promptly() {
    let origin = origin(BODY, "\"v1\"", vec![Reply::Stall { prefix: 4 }]);
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("asset.partial");
    let cancellation = CancellationToken::default();
    let canceller = cancellation.clone();
    let started = Instant::now();
    let timer = thread::spawn(move || {
        thread::sleep(Duration::from_millis(500));
        canceller.cancel();
    });
    assert_eq!(
        transfer(
            &plain_client(),
            &origin.url,
            BODY.len() as u64,
            request(&target, 0, None, &cancellation),
        ),
        Err(PackageError::Cancelled)
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "cancel waited {:?} for a stalled read",
        started.elapsed()
    );
    timer.join().unwrap();
    // The partial bytes stay resumable.
    let mut kept = Vec::new();
    fs::File::open(&target)
        .unwrap()
        .read_to_end(&mut kept)
        .unwrap();
    assert_eq!(kept, &BODY[..4]);
}
