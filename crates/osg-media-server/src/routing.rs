//! Per-request authorization and dispatch to the preflight, asset, and frame handlers.

use std::net::TcpStream;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use uuid::Uuid;

use crate::auth::{valid_host, valid_token};
use crate::frames;
use crate::images::purge_expired_images;
use crate::range::serve_entry;
use crate::request::HttpRequest;
use crate::response::{cors_headers, respond_empty, respond_text};
use crate::{CloneableEntry, MediaSource, ServerContext, TOKEN_HEADER};

pub(crate) fn handle_request(
    context: &ServerContext,
    stream: &mut TcpStream,
    request: &HttpRequest,
    stopping: &AtomicBool,
) {
    let Ok(origin) = request.unique_header("origin") else {
        let _ = respond_text(
            stream,
            request.is_head(),
            400,
            "Bad Request",
            "Bad request",
            &[],
        );
        return;
    };
    if origin.is_some_and(|value| !context.allowed_origins.contains(value)) {
        let _ = respond_text(
            stream,
            request.is_head(),
            403,
            "Forbidden",
            "Forbidden",
            &[],
        );
        return;
    }
    let Ok(token_header) = request.unique_header(TOKEN_HEADER) else {
        let _ = respond_text(
            stream,
            request.is_head(),
            400,
            "Bad Request",
            "Bad request",
            &[],
        );
        return;
    };
    if !valid_host(context, request) || !valid_token(context, request, token_header) {
        let _ = respond_text(
            stream,
            request.is_head(),
            403,
            "Forbidden",
            "Forbidden",
            &[],
        );
        return;
    }

    match request.method.as_str() {
        "OPTIONS" => handle_options(stream, request, origin),
        "GET" | "HEAD" if frames::is_frame_target(request.path()) => {
            frames::handle_frame_request(context, stream, request, origin, stopping);
        }
        "GET" | "HEAD" => handle_asset_request(context, stream, request, origin, stopping),
        _ => {
            let mut headers = cors_headers(origin);
            headers.push(("Allow", "GET, HEAD, OPTIONS".to_owned()));
            let _ = respond_text(
                stream,
                request.is_head(),
                405,
                "Method Not Allowed",
                "Method not allowed",
                &headers,
            );
        }
    }
}

pub(crate) fn handle_options(stream: &mut TcpStream, request: &HttpRequest, origin: Option<&str>) {
    let private_network = request.unique_header("access-control-request-private-network");
    let Ok(private_network) = private_network else {
        let _ = respond_text(
            stream,
            false,
            400,
            "Bad Request",
            "Bad request",
            &cors_headers(origin),
        );
        return;
    };
    let mut headers = cors_headers(origin);
    headers.push((
        "Access-Control-Allow-Methods",
        "GET, HEAD, OPTIONS".to_owned(),
    ));
    headers.push((
        "Access-Control-Allow-Headers",
        "Range, X-OSG-Media-Token".to_owned(),
    ));
    headers.push(("Access-Control-Max-Age", "600".to_owned()));
    if private_network == Some("true") {
        headers.push(("Access-Control-Allow-Private-Network", "true".to_owned()));
    }
    let _ = respond_empty(stream, 204, "No Content", &headers);
}

pub(crate) fn handle_asset_request(
    context: &ServerContext,
    stream: &mut TcpStream,
    request: &HttpRequest,
    origin: Option<&str>,
    stopping: &AtomicBool,
) {
    let Some(id) = asset_id(&request.target) else {
        let _ = respond_text(
            stream,
            request.is_head(),
            404,
            "Not Found",
            "Media not found",
            &cors_headers(origin),
        );
        return;
    };
    let entry = {
        let Ok(mut assets) = context.assets.write() else {
            let _ = respond_text(
                stream,
                request.is_head(),
                500,
                "Internal Server Error",
                "Media registry unavailable",
                &cors_headers(origin),
            );
            return;
        };
        let now = Instant::now();
        purge_expired_images(&mut assets, now);
        assets.get_mut(&id).map(|entry| {
            if let MediaSource::Image { last_accessed, .. } = &mut entry.source {
                *last_accessed = now;
            }
            CloneableEntry::from(&*entry)
        })
    };
    let Some(entry) = entry else {
        let _ = respond_text(
            stream,
            request.is_head(),
            404,
            "Not Found",
            "Media not found",
            &cors_headers(origin),
        );
        return;
    };
    serve_entry(stream, request, origin, &id.to_string(), &entry, stopping);
}

pub(crate) fn asset_id(target: &str) -> Option<Uuid> {
    let path = target.split_once('?').map_or(target, |(path, _)| path);
    let id = path.strip_prefix("/asset/")?;
    if id.contains('/') || id.is_empty() {
        return None;
    }
    Uuid::parse_str(id).ok()
}
