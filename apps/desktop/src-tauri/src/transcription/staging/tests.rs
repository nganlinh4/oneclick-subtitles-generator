mod cues;
mod failures;
mod ordering;

use osg_domain::TranscriptRevisionId;

use super::*;
use crate::transcription::planner::WindowRange;
use crate::transcription::projection::ProjectedWordResult;
use crate::transcription::projection::WordProjectionStatus;

fn make_test_word(text: &str, start_ms: i64, end_ms: i64) -> ProjectedWordResult {
    ProjectedWordResult {
        status: WordProjectionStatus::Accepted,
        text: text.to_owned(),
        raw_start_ns: (start_ms * 1_000_000).cast_unsigned(),
        raw_end_ns: (end_ms * 1_000_000).cast_unsigned(),
        project_start_ms: start_ms,
        project_end_ms: end_ms,
        speaker_id: Some("speaker_0".to_owned()),
        is_unaligned: false,
        alignment_status: "aligned".to_owned(),
    }
}

fn generate_permutations(items: &[usize]) -> Vec<Vec<usize>> {
    fn permute(k: usize, arr: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if k == 1 {
            out.push(arr.clone());
            return;
        }
        for i in 0..k {
            permute(k - 1, arr, out);
            if k % 2 == 1 {
                arr.swap(0, k - 1);
            } else {
                arr.swap(i, k - 1);
            }
        }
    }
    let mut out = Vec::new();
    let mut arr = items.to_vec();
    permute(items.len(), &mut arr, &mut out);
    out
}
