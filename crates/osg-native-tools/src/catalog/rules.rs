//! Reviewed source-URL, digest, version, and date rules shared by catalog parsing and dynamic
//! yt-dlp delivery validation.

use osg_delivery_core::identity::{is_git_revision, is_sha256_hex};
use url::Url;

use super::{
    ArtifactFormat, ExecutableRole, MAX_ARTIFACT_BYTES, MAX_INSTALLED_BYTES, NativeToolId,
    ToolDelivery,
};
use crate::path_security::validate_relative_path;
use crate::{NativeToolError, Result};

pub(super) fn valid_release_url(
    tool: NativeToolId,
    version: &str,
    asset: &str,
    value: &str,
) -> bool {
    let repository = match tool {
        NativeToolId::YtDlp => "yt-dlp/yt-dlp",
        NativeToolId::Deno => "denoland/deno",
        NativeToolId::MediaTools => {
            return version == "8.1.2"
                && asset == "ffmpeg-8.1.2-essentials_build.zip"
                && value
                    == "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip";
        }
    };
    let tag = if tool == NativeToolId::Deno {
        format!("v{version}")
    } else {
        version.to_string()
    };
    value == format!("https://github.com/{repository}/releases/download/{tag}/{asset}")
}

pub(super) fn valid_notice_url(tool: NativeToolId, revision: &str, value: &str) -> bool {
    let repository = match tool {
        NativeToolId::YtDlp => "yt-dlp/yt-dlp",
        NativeToolId::Deno => "denoland/deno",
        NativeToolId::MediaTools => return false,
    };
    let prefix = format!("https://raw.githubusercontent.com/{repository}/{revision}/");
    let Some(path) = value.strip_prefix(&prefix) else {
        return false;
    };
    validate_relative_path(path).is_ok() && strict_https(value, "raw.githubusercontent.com")
}

fn strict_https(value: &str, host: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.host_str() == Some(host)
            && url.port_or_known_default() == Some(443)
            && url.query().is_none()
            && url.fragment().is_none()
            && !url.path_segments().is_some_and(|segments| {
                segments
                    .into_iter()
                    .any(|segment| segment.eq_ignore_ascii_case("latest"))
            })
    })
}

pub(super) fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 40
        && !value.to_ascii_lowercase().contains("latest")
        && value.bytes().any(|byte| byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
        })
}

pub(crate) fn validate_dynamic_ytdlp_delivery(delivery: &ToolDelivery) -> Result<()> {
    let (asset, install_path) = match delivery.platform.as_str() {
        "windows-x86_64" => ("yt-dlp.exe", "bin/yt-dlp.exe"),
        "linux-x86_64" => ("yt-dlp_linux", "bin/yt-dlp"),
        "macos-aarch64" | "macos-x86_64" => ("yt-dlp_macos", "bin/yt-dlp"),
        _ => return Err(NativeToolError::InvalidCatalog),
    };
    if delivery.tool != NativeToolId::YtDlp
        || !valid_ytdlp_version(&delivery.version)
        || !is_git_revision(&delivery.source_revision)
        || delivery.asset != asset
        || delivery.format != ArtifactFormat::Raw
        || delivery.selective_extraction
        || delivery.size_bytes == 0
        || delivery.size_bytes > MAX_ARTIFACT_BYTES
        || !is_sha256_hex(&delivery.sha256)
        || !valid_dynamic_ytdlp_release_url(
            &delivery.version,
            &delivery.asset,
            &delivery.source_url,
        )
        || delivery.files.len() != 1
        || delivery.notices.len() != 2
    {
        return Err(NativeToolError::InvalidCatalog);
    }
    let file = &delivery.files[0];
    if file.source_path != asset
        || file.install_path != install_path
        || file.size_bytes != delivery.size_bytes
        || file.sha256 != delivery.sha256
        || file.role != Some(ExecutableRole::YtDlp)
    {
        return Err(NativeToolError::InvalidCatalog);
    }
    let expected_notices = [
        ("licenses/yt-dlp-LICENSE.txt", "LICENSE"),
        (
            "licenses/yt-dlp-THIRD-PARTY.txt",
            "THIRD_PARTY_LICENSES.txt",
        ),
    ];
    let mut installed_bytes = delivery.size_bytes;
    for (notice, (install_path, source_path)) in delivery.notices.iter().zip(expected_notices) {
        if notice.install_path != install_path
            || notice.size_bytes == 0
            || notice.size_bytes > 4 * 1024 * 1024
            || !is_sha256_hex(&notice.sha256)
            || !valid_notice_url(
                NativeToolId::YtDlp,
                &delivery.source_revision,
                &notice.source_url,
            )
            || !notice.source_url.ends_with(&format!("/{source_path}"))
        {
            return Err(NativeToolError::InvalidCatalog);
        }
        installed_bytes = installed_bytes
            .checked_add(notice.size_bytes)
            .filter(|bytes| *bytes <= MAX_INSTALLED_BYTES)
            .ok_or(NativeToolError::InvalidCatalog)?;
    }
    if installed_bytes != delivery.installed_bytes {
        return Err(NativeToolError::InvalidCatalog);
    }
    Ok(())
}

pub(crate) fn valid_ytdlp_version(value: &str) -> bool {
    let pieces = value.split('.').collect::<Vec<_>>();
    let date = pieces
        .iter()
        .take(3)
        .map(|piece| piece.parse::<u16>().ok())
        .collect::<Vec<_>>();
    let valid_date = pieces.len() >= 3
        && pieces[0].len() == 4
        && pieces[1].len() == 2
        && pieces[2].len() == 2
        && date[0].is_some_and(|year| (2020..=2200).contains(&year))
        && date[1].is_some_and(|month| (1..=12).contains(&month))
        && date[2].is_some_and(|day| (1..=31).contains(&day));
    let valid_channel_suffix = match pieces.as_slice() {
        [_, _, _] => true,
        [_, _, _, time] => {
            time.len() == 6
                && time.parse::<u32>().is_ok_and(|value| {
                    value / 10_000 <= 23 && (value / 100) % 100 <= 59 && value % 100 <= 59
                })
        }
        _ => false,
    };
    valid_date && date.iter().all(Option::is_some) && valid_channel_suffix
}

fn valid_dynamic_ytdlp_release_url(version: &str, asset: &str, value: &str) -> bool {
    ["yt-dlp/yt-dlp", "yt-dlp/yt-dlp-nightly-builds"]
        .into_iter()
        .any(|repository| {
            value == format!("https://github.com/{repository}/releases/download/{version}/{asset}")
        })
}

pub(super) fn valid_date(value: &str) -> bool {
    value.len() == 10
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 4 | 7) {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}
