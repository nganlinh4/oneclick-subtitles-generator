use super::*;

fn chunk(id: [u8; 4], body: &[u8]) -> Vec<u8> {
    let mut bytes = id.to_vec();
    bytes.extend_from_slice(&u32::try_from(body.len()).unwrap().to_le_bytes());
    bytes.extend_from_slice(body);
    if !body.len().is_multiple_of(2) {
        bytes.push(0);
    }
    bytes
}

fn riff(chunks: &[Vec<u8>]) -> Vec<u8> {
    let body = chunks.concat();
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&u32::try_from(body.len() + 4).unwrap().to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(&body);
    bytes
}

fn fmt_body(format: WavFormat) -> Vec<u8> {
    encode(format, &[]).unwrap()[20..36].to_vec()
}

fn mono16k() -> WavFormat {
    WavFormat::pcm16(16_000, 1)
}

#[test]
fn encode_round_trips_through_parse() {
    let samples = [1_u8, 0, 2, 0, 3, 0];
    let wav = encode(mono16k(), &samples).unwrap();
    assert_eq!(wav.len(), 44 + samples.len());
    let layout = parse_header(&wav, wav.len() as u64).unwrap();
    assert_eq!(layout.format, mono16k());
    assert_eq!(layout.format.byte_rate, 32_000);
    assert_eq!(layout.data_chunk, 36);
    assert_eq!(layout.data_offset, 44);
    assert_eq!(layout.declared_len, wav.len() as u64);
    assert_eq!(layout.samples(&wav), Some(samples.as_slice()));
}

#[test]
fn unknown_and_odd_sized_chunks_before_data_are_skipped() {
    let wav = riff(&[
        chunk(*b"LIST", b"odd"),
        chunk(*b"fmt ", &fmt_body(mono16k())),
        chunk(*b"data", &[9, 9]),
    ]);
    let layout = parse_header(&wav, wav.len() as u64).unwrap();
    assert_eq!(layout.samples(&wav), Some([9_u8, 9].as_slice()));
}

#[test]
fn data_may_extend_past_a_header_prefix_but_not_past_the_file() {
    let wav = encode(mono16k(), &[0; 1_000]).unwrap();
    let layout = parse_header(&wav[..64], wav.len() as u64).unwrap();
    assert_eq!(layout.data_len, 1_000);
    assert_eq!(layout.samples(&wav[..64]), None);
    assert_eq!(
        parse_header(&wav[..64], wav.len() as u64 - 1),
        Err(WavError::ChunkBounds)
    );
}

#[test]
fn truncated_and_malformed_headers_are_rejected_without_panicking() {
    let valid = encode(mono16k(), &[0; 8]).unwrap();
    let mut short_fmt = valid.clone();
    short_fmt[16..20].copy_from_slice(&8_u32.to_le_bytes());
    let mut oversized_chunk = valid.clone();
    oversized_chunk[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
    let mut oversized_data = valid.clone();
    oversized_data[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
    let data_first = riff(&[
        chunk(*b"data", &[0, 0]),
        chunk(*b"fmt ", &fmt_body(mono16k())),
    ]);
    let no_data = riff(&[chunk(*b"fmt ", &fmt_body(mono16k()))]);
    let mut wrong_form = valid.clone();
    wrong_form[8..12].copy_from_slice(b"WEBP");

    let cases: &[(&str, &[u8], WavError)] = &[
        ("empty", &[], WavError::Signature),
        ("riff only", b"RIFF", WavError::Signature),
        ("eleven bytes", &valid[..11], WavError::Signature),
        ("wrong form", &wrong_form, WavError::Signature),
        ("header only", &valid[..12], WavError::MissingData),
        ("partial chunk header", &valid[..19], WavError::MissingData),
        ("fmt cut short", &valid[..30], WavError::ChunkBounds),
        ("fmt under 16 bytes", &short_fmt, WavError::Format),
        (
            "chunk size overflow",
            &oversized_chunk,
            WavError::ChunkBounds,
        ),
        ("data past the file", &oversized_data, WavError::ChunkBounds),
        ("data before fmt", &data_first, WavError::MissingFormat),
        ("no data chunk", &no_data, WavError::MissingData),
    ];
    for (name, bytes, expected) in cases {
        assert_eq!(
            parse_header(bytes, bytes.len() as u64),
            Err(*expected),
            "{name}"
        );
    }
    assert_eq!(
        parse_header(&valid, valid.len() as u64 - 1),
        Err(WavError::ChunkBounds),
        "prefix longer than the file"
    );
}

#[test]
fn every_truncation_of_a_valid_file_is_handled() {
    let valid = riff(&[
        chunk(*b"LIST", b"metadata"),
        chunk(*b"fmt ", &fmt_body(mono16k())),
        chunk(*b"data", &[1, 2, 3, 4]),
    ]);
    for length in 0..valid.len() {
        let prefix = &valid[..length];
        let _ = parse_header(prefix, length as u64);
    }
    assert!(parse_header(&valid, valid.len() as u64).is_ok());
}

#[test]
fn samples_can_be_rewrapped_in_the_original_header() {
    let wav = riff(&[
        chunk(*b"LIST", b"keep"),
        chunk(*b"fmt ", &fmt_body(mono16k())),
        chunk(*b"data", &[1, 0, 2, 0, 3, 0, 4, 0]),
    ]);
    let layout = parse_header(&wav, wav.len() as u64).unwrap();
    let half = layout.with_samples(&wav, &[1, 0, 2, 0]).unwrap();
    let reparsed = parse_header(&half, half.len() as u64).unwrap();
    assert_eq!(reparsed.declared_len, half.len() as u64);
    assert_eq!(reparsed.samples(&half), Some([1_u8, 0, 2, 0].as_slice()));
    assert!(half.windows(4).any(|window| window == b"keep"));
    assert_eq!(layout.with_samples(&wav[..10], &[0, 0]), None);
}

#[test]
fn the_signature_check_needs_the_full_form_type() {
    assert!(has_signature(b"RIFF\0\0\0\0WAVE"));
    assert!(!has_signature(b"RIFF\0\0\0\0WAV"));
    assert!(!has_signature(b"RIFX\0\0\0\0WAVE"));
}
