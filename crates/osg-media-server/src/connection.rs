//! The accept loop, the fixed worker pool, and orderly connection shutdown.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::thread;

use crate::request::{RequestReadError, read_request};
use crate::response::respond_text;
use crate::routing::handle_request;
use crate::{
    ACCEPT_POLL_INTERVAL, MAX_CLOSE_DRAIN_BYTES, OVERLOAD_WRITE_TIMEOUT, ServerContext,
    WRITE_POLL_TIMEOUT,
};

pub(crate) fn accept_loop(
    listener: &TcpListener,
    sender: &SyncSender<TcpStream>,
    stopping: &AtomicBool,
) {
    while !stopping.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, address)) => {
                if !address.ip().is_loopback() {
                    let _ = stream.shutdown(Shutdown::Both);
                    continue;
                }
                match sender.try_send(stream) {
                    Ok(()) => {}
                    Err(TrySendError::Full(mut stream)) => {
                        let _ = stream.set_write_timeout(Some(OVERLOAD_WRITE_TIMEOUT));
                        let _ = write_static_busy(&mut stream);
                        close_without_reset(&mut stream);
                    }
                    Err(TrySendError::Disconnected(stream)) => {
                        let _ = stream.shutdown(Shutdown::Both);
                        break;
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(ACCEPT_POLL_INTERVAL);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) if stopping.load(Ordering::Acquire) => break,
            Err(_) => break,
        }
    }
}

pub(crate) fn worker_loop(
    context: &ServerContext,
    receiver: &Mutex<Receiver<TcpStream>>,
    stopping: &AtomicBool,
) {
    loop {
        let stream = match receiver.lock() {
            Ok(receiver) => receiver.recv(),
            Err(poisoned) => poisoned.into_inner().recv(),
        };
        let Ok(mut stream) = stream else {
            return;
        };
        if stopping.load(Ordering::Acquire) {
            let _ = stream.shutdown(Shutdown::Both);
            continue;
        }

        let _ = stream.set_nodelay(true);
        let _ = stream.set_write_timeout(Some(WRITE_POLL_TIMEOUT));
        match read_request(&mut stream, stopping) {
            Ok(request) => handle_request(context, &mut stream, &request, stopping),
            Err(RequestReadError::BadRequest) => {
                let _ = respond_text(&mut stream, false, 400, "Bad Request", "Bad request", &[]);
            }
            Err(RequestReadError::Timeout) => {
                let _ = respond_text(
                    &mut stream,
                    false,
                    408,
                    "Request Timeout",
                    "Request timeout",
                    &[],
                );
            }
            Err(RequestReadError::TooLarge) => {
                let _ = respond_text(
                    &mut stream,
                    false,
                    431,
                    "Request Header Fields Too Large",
                    "Request headers too large",
                    &[],
                );
            }
            Err(RequestReadError::Stopping | RequestReadError::Disconnected) => {}
        }
        close_without_reset(&mut stream);
    }
}

/// Closes a served connection without turning the close into a TCP reset.
///
/// A rejected request frequently leaves unread bytes in the socket receive buffer: the header
/// reader stops at [`crate::MAX_HEADER_BYTES`], and a client that already sent more than that never has
/// the remainder consumed. On Windows, closing a socket that still holds unread received data
/// emits RST rather than FIN, and the peer's stack then discards its own receive buffer — silently
/// destroying the response bytes this worker already wrote. Draining first lets the close complete
/// as an orderly FIN so the error response survives.
///
/// The drain is non-blocking, so a stalled peer costs nothing, and bounded by
/// [`MAX_CLOSE_DRAIN_BYTES`], so a hostile peer cannot pin a worker by streaming forever.
pub(crate) fn close_without_reset(stream: &mut TcpStream) {
    if stream.set_nonblocking(true).is_ok() {
        let mut sink = [0_u8; 4096];
        let mut drained = 0_usize;
        while drained < MAX_CLOSE_DRAIN_BYTES {
            match stream.read(&mut sink) {
                Ok(0) | Err(_) => break,
                Ok(read) => drained = drained.saturating_add(read),
            }
        }
        let _ = stream.set_nonblocking(false);
    }
    let _ = stream.shutdown(Shutdown::Both);
}

pub(crate) fn write_static_busy(stream: &mut TcpStream) -> io::Result<()> {
    stream.write_all(
        b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 20\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\nMedia server is busy",
    )
}
