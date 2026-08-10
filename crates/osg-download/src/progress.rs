use serde::Serialize;

const DOWNLOAD_PREFIX: &str = "OSG_PROGRESS\t";
const POSTPROCESS_PREFIX: &str = "OSG_POSTPROCESS\t";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadPhase {
    Downloading,
    DownloadFinished,
    PostProcessing,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DownloadProgress {
    pub phase: DownloadPhase,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub bytes_per_second: Option<u64>,
    pub eta_seconds: Option<u64>,
    pub fraction: Option<f64>,
}

pub trait ProgressSink: Send + Sync {
    fn on_progress(&self, progress: &DownloadProgress);
}

impl<F> ProgressSink for F
where
    F: Fn(&DownloadProgress) + Send + Sync,
{
    fn on_progress(&self, progress: &DownloadProgress) {
        self(progress);
    }
}

pub(crate) fn parse_progress(line: &str) -> Option<DownloadProgress> {
    if let Some(status) = line.strip_prefix(POSTPROCESS_PREFIX) {
        if status.trim().is_empty() {
            return None;
        }
        return Some(DownloadProgress {
            phase: DownloadPhase::PostProcessing,
            downloaded_bytes: None,
            total_bytes: None,
            bytes_per_second: None,
            eta_seconds: None,
            fraction: None,
        });
    }

    let values = line.strip_prefix(DOWNLOAD_PREFIX)?;
    let mut fields = values.split('\t');
    let phase = match fields.next()? {
        "downloading" => DownloadPhase::Downloading,
        "finished" => DownloadPhase::DownloadFinished,
        _ => return None,
    };
    let downloaded_bytes = parse_number(fields.next()?);
    let reported_total = parse_number(fields.next()?);
    let estimated_total = parse_number(fields.next()?);
    let bytes_per_second = parse_number(fields.next()?);
    let eta_seconds = parse_number(fields.next()?);
    if fields.next().is_some() {
        return None;
    }
    let total_bytes = reported_total.or(estimated_total);
    let fraction = downloaded_bytes
        .zip(total_bytes)
        .and_then(progress_fraction);
    Some(DownloadProgress {
        phase,
        downloaded_bytes,
        total_bytes,
        bytes_per_second,
        eta_seconds,
        fraction,
    })
}

fn parse_number(value: &str) -> Option<u64> {
    let value = value.trim();
    if value.is_empty() || matches!(value, "NA" | "N/A" | "None" | "null") {
        return None;
    }
    if let Ok(integer) = value.parse::<u64>() {
        return Some(integer);
    }
    let (whole, fractional) = value.split_once('.')?;
    if whole.is_empty()
        || fractional.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fractional.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let whole = whole.parse::<u64>().ok()?;
    if fractional.as_bytes()[0] >= b'5' {
        whole.checked_add(1)
    } else {
        Some(whole)
    }
}

#[allow(clippy::cast_precision_loss)]
fn progress_fraction((downloaded, total): (u64, u64)) -> Option<f64> {
    (total > 0).then(|| (downloaded as f64 / total as f64).clamp(0.0, 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_machine_progress_without_human_localization() {
        let progress =
            parse_progress("OSG_PROGRESS\tdownloading\t500\t1000\tNA\t250.4\t2").unwrap();
        assert_eq!(progress.phase, DownloadPhase::Downloading);
        assert_eq!(progress.downloaded_bytes, Some(500));
        assert_eq!(progress.bytes_per_second, Some(250));
        assert_eq!(progress.fraction, Some(0.5));
    }

    #[test]
    fn falls_back_to_estimated_total_and_handles_postprocessing() {
        let progress = parse_progress("OSG_PROGRESS\tdownloading\t25\tNA\t100\tNA\tNA").unwrap();
        assert_eq!(progress.total_bytes, Some(100));
        assert_eq!(progress.fraction, Some(0.25));
        assert_eq!(
            parse_progress("OSG_POSTPROCESS\tstarted").unwrap().phase,
            DownloadPhase::PostProcessing
        );
    }

    #[test]
    fn ignores_hostile_or_unstructured_output() {
        assert!(parse_progress("[download] 12.5% of C:/secret").is_none());
        assert!(parse_progress("OSG_PROGRESS\tdownloading\t1\t2\t3").is_none());
        assert!(parse_progress("OSG_PROGRESS\tpwned\t1\t2\t3\t4\t5").is_none());
    }
}
