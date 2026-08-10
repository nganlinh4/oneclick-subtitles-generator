use crate::options::{SegmentStrategy, SegmentationOptions};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Word {
    pub(crate) text: String,
    pub(crate) start_ms: u64,
    pub(crate) end_ms: u64,
}

pub(crate) fn segment_words(
    words: &[Word],
    options: &SegmentationOptions,
    join_without_spaces: bool,
) -> Vec<Segment> {
    if words.is_empty() {
        return Vec::new();
    }
    let joiner = if join_without_spaces { "" } else { " " };
    match options.strategy() {
        SegmentStrategy::Sentence => sentence_segments(words, options, joiner),
        SegmentStrategy::Word | SegmentStrategy::Character => {
            limited_segments(words, options, joiner)
        }
    }
}

fn sentence_segments(words: &[Word], options: &SegmentationOptions, joiner: &str) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut start = 0;
    for (index, word) in words.iter().enumerate() {
        let is_last = index + 1 == words.len();
        let pause = words
            .get(index + 1)
            .map_or(0, |next| next.start_ms.saturating_sub(word.end_ms));
        if is_last || pause >= u64::from(options.pause_threshold_ms()) || ends_sentence(&word.text)
        {
            append_balanced(
                &mut segments,
                &words[start..=index],
                options.max_words(),
                joiner,
            );
            start = index + 1;
        }
    }
    segments
}

fn limited_segments(words: &[Word], options: &SegmentationOptions, joiner: &str) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut start = 0;
    for (index, word) in words.iter().enumerate() {
        let is_last = index + 1 == words.len();
        let pause = words
            .get(index + 1)
            .map_or(0, |next| next.start_ms.saturating_sub(word.end_ms));
        let word_limit = options.max_words().is_some_and(|limit| {
            options.strategy() == SegmentStrategy::Word && index + 1 - start >= usize::from(limit)
        });
        let char_limit = options.strategy() == SegmentStrategy::Character
            && words.get(index + 1).is_some_and(|next| {
                let current = joined_character_count(&words[start..=index], joiner);
                let separator = usize::from(!joiner.is_empty());
                current + separator + next.text.chars().count()
                    > usize::from(options.max_characters())
            });
        if is_last || pause >= u64::from(options.pause_threshold_ms()) || word_limit || char_limit {
            segments.push(to_segment(&words[start..=index], joiner));
            start = index + 1;
        }
    }
    segments
}

fn append_balanced(output: &mut Vec<Segment>, words: &[Word], max_words: Option<u8>, joiner: &str) {
    let Some(max_words) = max_words.map(usize::from) else {
        output.push(to_segment(words, joiner));
        return;
    };
    if words.len() <= max_words {
        output.push(to_segment(words, joiner));
        return;
    }
    let line_count = words.len().div_ceil(max_words);
    let base = words.len() / line_count;
    let extra = words.len() % line_count;
    let mut offset = 0;
    for line in 0..line_count {
        let count = base + usize::from(line < extra);
        output.push(to_segment(&words[offset..offset + count], joiner));
        offset += count;
    }
}

fn to_segment(words: &[Word], joiner: &str) -> Segment {
    Segment {
        start_ms: words[0].start_ms,
        end_ms: words[words.len() - 1].end_ms,
        text: words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>()
            .join(joiner),
    }
}

fn joined_character_count(words: &[Word], joiner: &str) -> usize {
    words
        .iter()
        .map(|word| word.text.chars().count())
        .sum::<usize>()
        + joiner.chars().count() * words.len().saturating_sub(1)
}

fn ends_sentence(text: &str) -> bool {
    text.trim_end().ends_with(['.', '?', '!', '。', '？', '！'])
}

pub(crate) fn to_srt(segments: &[Segment]) -> String {
    let mut output = String::new();
    for (index, segment) in segments.iter().enumerate() {
        use std::fmt::Write as _;
        let _ = writeln!(output, "{}", index + 1);
        let _ = writeln!(
            output,
            "{} --> {}",
            format_srt_time(segment.start_ms),
            format_srt_time(segment.end_ms)
        );
        let _ = writeln!(output, "{}\n", segment.text);
    }
    output
}

fn format_srt_time(milliseconds: u64) -> String {
    let hours = milliseconds / 3_600_000;
    let minutes = milliseconds / 60_000 % 60;
    let seconds = milliseconds / 1_000 % 60;
    let millis = milliseconds % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, start_ms: u64, end_ms: u64) -> Word {
        Word {
            text: text.to_owned(),
            start_ms,
            end_ms,
        }
    }

    #[test]
    fn sentence_strategy_preserves_punctuation_pause_and_balancing() {
        let words = vec![
            word("one", 0, 100),
            word("two", 120, 220),
            word("three", 240, 340),
            word("four.", 360, 460),
            word("again", 1_500, 1_700),
        ];
        let options =
            SegmentationOptions::new(SegmentStrategy::Sentence, 60, Some(3), 800).unwrap();
        let segments = segment_words(&words, &options, false);
        assert_eq!(
            segments
                .iter()
                .map(|item| item.text.as_str())
                .collect::<Vec<_>>(),
            ["one two", "three four.", "again"]
        );
    }

    #[test]
    fn cjk_and_character_limits_do_not_insert_spaces() {
        let words = vec![
            word("你", 0, 100),
            word("好", 100, 200),
            word("世", 200, 300),
            word("界。", 300, 400),
        ];
        let options =
            SegmentationOptions::new(SegmentStrategy::Character, 11, Some(7), 800).unwrap();
        assert_eq!(segment_words(&words, &options, true)[0].text, "你好世界。");
    }

    #[test]
    fn srt_uses_unbounded_hours_and_millisecond_times() {
        let srt = to_srt(&[Segment {
            start_ms: 90_000_001,
            end_ms: 90_001_250,
            text: "hello".to_owned(),
        }]);
        assert!(srt.contains("25:00:00,001 --> 25:00:01,250"));
    }
}
