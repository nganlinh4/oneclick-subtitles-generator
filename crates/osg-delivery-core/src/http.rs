//! The bounded HTTPS client and a response body whose reads never block cancellation.

use std::io::Read;
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel};
use std::thread;
use std::time::Duration;

use reqwest::blocking::Client;
use url::Url;

use crate::url_policy::redirect_allowed;
use crate::{CancellationToken, DeliveryError, Result};

pub const USER_AGENT: &str = "OneClickSubtitlesGenerator/2";
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Bounds each send and each body read; a stalled transfer fails instead of hanging.
pub const IO_TIMEOUT: Duration = Duration::from_secs(30);
const CHUNK_BYTES: usize = 256 * 1024;
const CANCEL_POLL: Duration = Duration::from_millis(100);

/// An HTTPS-only, proxy-free client whose redirects must satisfy `allowed(initial, target)`.
pub fn client(allowed: fn(&Url, &Url) -> bool) -> Result<Client> {
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if redirect_allowed(attempt.url(), attempt.previous(), allowed) {
            attempt.follow()
        } else {
            attempt.error("untrusted delivery redirect")
        }
    });
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(IO_TIMEOUT)
        .https_only(true)
        .no_proxy()
        .redirect(policy)
        .build()
        .map_err(|_| DeliveryError::Network)
}

enum Message {
    Data(Vec<u8>),
    End,
    Failed,
}

/// Reads a response body on a helper thread so the caller can observe cancellation every
/// 100 ms even while a read is stalled. Dropping the body detaches the helper, which exits
/// after its current (timeout-bounded) read; it never touches the caller's output file.
#[derive(Debug)]
pub struct CancellableBody {
    receiver: Receiver<Message>,
}

impl CancellableBody {
    pub fn spawn(reader: impl Read + Send + 'static) -> Result<Self> {
        let (sender, receiver) = sync_channel(2);
        thread::Builder::new()
            .name("osg-delivery-body".to_owned())
            .spawn(move || pump(reader, &sender))
            .map_err(|_| DeliveryError::Network)?;
        Ok(Self { receiver })
    }

    /// The next chunk of the body, `None` at its end, `Cancelled` within one poll interval of
    /// cancellation, or `Network` when the transfer fails.
    pub fn next_chunk(&mut self, cancellation: &CancellationToken) -> Result<Option<Vec<u8>>> {
        loop {
            cancellation.check()?;
            match self.receiver.recv_timeout(CANCEL_POLL) {
                Ok(Message::Data(chunk)) => return Ok(Some(chunk)),
                Ok(Message::End) => return Ok(None),
                Ok(Message::Failed) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(DeliveryError::Network);
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
    }
}

fn pump(mut reader: impl Read, sender: &SyncSender<Message>) {
    loop {
        let mut chunk = vec![0_u8; CHUNK_BYTES];
        let message = match reader.read(&mut chunk) {
            Ok(0) => Message::End,
            Ok(read) => {
                chunk.truncate(read);
                Message::Data(chunk)
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => Message::Failed,
        };
        let finished = !matches!(message, Message::Data(_));
        if sender.send(message).is_err() || finished {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, Cursor};
    use std::time::Instant;

    use super::*;

    struct Stalled;

    impl Read for Stalled {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            thread::sleep(Duration::from_secs(5));
            Ok(0)
        }
    }

    struct Broken;

    impl Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::ConnectionReset))
        }
    }

    #[test]
    fn bodies_stream_in_order_and_end() {
        let mut body = CancellableBody::spawn(Cursor::new(b"hello".to_vec())).unwrap();
        let token = CancellationToken::default();
        let mut collected = Vec::new();
        while let Some(chunk) = body.next_chunk(&token).unwrap() {
            collected.extend(chunk);
        }
        assert_eq!(collected, b"hello");
    }

    #[test]
    fn a_stalled_read_does_not_delay_cancellation() {
        let mut body = CancellableBody::spawn(Stalled).unwrap();
        let token = CancellationToken::default();
        let canceller = token.clone();
        let started = Instant::now();
        let timer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(200));
            canceller.cancel();
        });
        assert_eq!(body.next_chunk(&token), Err(DeliveryError::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(2));
        timer.join().unwrap();
    }

    #[test]
    fn read_failures_are_network_errors() {
        let mut body = CancellableBody::spawn(Broken).unwrap();
        assert_eq!(
            body.next_chunk(&CancellationToken::default()),
            Err(DeliveryError::Network)
        );
    }
}
