use serde::Serialize;
use std::fmt;
use std::sync::Arc;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FfmpegProgress {
    pub frame: Option<u64>,
    pub frames_per_second: Option<f64>,
    pub total_size_bytes: Option<u64>,
    pub output_time_us: u64,
    pub speed: Option<f64>,
    pub fraction: Option<f64>,
    pub finished: bool,
}

#[derive(Clone)]
pub struct ProgressSink(Arc<dyn Fn(FfmpegProgress) + Send + Sync + 'static>);

impl ProgressSink {
    pub fn new(callback: impl Fn(FfmpegProgress) + Send + Sync + 'static) -> Self {
        Self(Arc::new(callback))
    }

    pub(crate) fn emit(&self, progress: FfmpegProgress) {
        (self.0)(progress);
    }
}

impl fmt::Debug for ProgressSink {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProgressSink(<callback>)")
    }
}

#[derive(Debug, Default)]
pub(crate) struct FfmpegProgressParser {
    current: FfmpegProgress,
    expected_duration_us: Option<u64>,
}

impl FfmpegProgressParser {
    pub(crate) fn new(expected_duration_us: Option<u64>) -> Self {
        Self {
            expected_duration_us: expected_duration_us.filter(|duration| *duration > 0),
            ..Self::default()
        }
    }

    pub(crate) fn push_line(&mut self, line: &str) -> Option<FfmpegProgress> {
        let (key, value) = line.trim().split_once('=')?;
        match key {
            "frame" => self.current.frame = value.trim().parse().ok(),
            "fps" => self.current.frames_per_second = finite_float(value),
            "total_size" => self.current.total_size_bytes = value.trim().parse().ok(),
            "out_time_us" => {
                self.current.output_time_us = value.trim().parse().unwrap_or_default();
            }
            // FFmpeg historically reports microseconds in out_time_ms despite
            // the name. Prefer out_time_us whenever the build provides it.
            "out_time_ms" if self.current.output_time_us == 0 => {
                self.current.output_time_us = value.trim().parse().unwrap_or_default();
            }
            "out_time" if self.current.output_time_us == 0 => {
                self.current.output_time_us = parse_clock_us(value).unwrap_or_default();
            }
            "speed" => {
                self.current.speed = finite_float(value.trim_end_matches('x'));
            }
            "progress" => {
                self.current.finished = value == "end";
                self.current.fraction = self.expected_duration_us.map(|duration| {
                    if self.current.finished {
                        1.0
                    } else {
                        let millionths = u128::from(self.current.output_time_us)
                            .saturating_mul(1_000_000)
                            .checked_div(u128::from(duration))
                            .unwrap_or_default()
                            .min(1_000_000);
                        f64::from(u32::try_from(millionths).unwrap_or(1_000_000)) / 1_000_000.0
                    }
                });
                return Some(self.current.clone());
            }
            _ => {}
        }
        None
    }
}

fn finite_float(value: &str) -> Option<f64> {
    let value = value.trim().parse::<f64>().ok()?;
    value.is_finite().then_some(value)
}

fn parse_clock_us(value: &str) -> Option<u64> {
    let mut parts = value.trim().split(':');
    let hours = parts.next()?.parse::<u64>().ok()?;
    let minutes = parts.next()?.parse::<u64>().ok()?;
    let seconds_us = parse_seconds_us(parts.next()?)?;
    if parts.next().is_some() || minutes >= 60 || seconds_us >= 60_000_000 {
        return None;
    }
    Some(
        hours
            .saturating_mul(3_600_000_000)
            .saturating_add(minutes.saturating_mul(60_000_000))
            .saturating_add(seconds_us),
    )
}

fn parse_seconds_us(value: &str) -> Option<u64> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let mut microseconds = whole.parse::<u64>().ok()?.checked_mul(1_000_000)?;
    let mut fraction_us = 0_u64;
    for index in 0..6 {
        fraction_us *= 10;
        fraction_us += u64::from(
            fraction
                .as_bytes()
                .get(index)
                .copied()
                .unwrap_or(b'0')
                .saturating_sub(b'0'),
        );
    }
    if fraction
        .as_bytes()
        .get(6)
        .is_some_and(|digit| *digit >= b'5')
    {
        fraction_us += 1;
    }
    microseconds = microseconds.checked_add(fraction_us)?;
    Some(microseconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_machine_progress_without_regex_or_locale_assumptions() {
        let mut parser = FfmpegProgressParser::new(Some(10_000_000));
        for line in ["frame=42", "fps=25.0", "out_time_us=2500000", "speed=1.5x"] {
            assert_eq!(parser.push_line(line), None);
        }
        let progress = parser.push_line("progress=continue").unwrap();
        assert_eq!(progress.frame, Some(42));
        assert_eq!(progress.output_time_us, 2_500_000);
        assert_eq!(progress.fraction, Some(0.25));
    }

    #[test]
    fn completion_is_pinned_to_one() {
        let mut parser = FfmpegProgressParser::new(Some(10_000_000));
        parser.push_line("out_time=00:00:09.900000");
        let progress = parser.push_line("progress=end").unwrap();
        assert!(progress.finished);
        assert_eq!(progress.fraction, Some(1.0));
    }
}
