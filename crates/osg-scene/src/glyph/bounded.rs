//! Bounded reading
//!
//! Validation runs after a value exists, which is too late for a sequence: a hostile descriptor
//! would have allocated whatever it declared before anything looked at it. These readers stop at the
//! bound instead, so the largest allocation a refused descriptor can cause is the bound itself.
//! Strings are bounded by validation rather than here, because a self-describing format hands them
//! over borrowed from the input that already exists.

use core::marker::PhantomData;

use serde::de::{Error as _, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

use super::limits::{MAX_CLUSTER_CODE_POINTS, MAX_FACE_PROBES, MAX_GLYPH_COUNT, MAX_PIXEL_BYTES};
use super::wire::{AtlasGlyph, FaceProbe};

struct BoundedSeq<T> {
    limit: usize,
    what: &'static str,
    marker: PhantomData<T>,
}

impl<T> BoundedSeq<T> {
    const fn new(limit: usize, what: &'static str) -> Self {
        Self {
            limit,
            what,
            marker: PhantomData,
        }
    }
}

impl<'de, T: Deserialize<'de>> Visitor<'de> for BoundedSeq<T> {
    type Value = Vec<T>;

    fn expecting(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(formatter, "at most {} {}", self.limit, self.what)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        // The hint comes from the input, so it may only ever shrink the reservation.
        let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(self.limit));
        while let Some(value) = sequence.next_element()? {
            if values.len() == self.limit {
                return Err(A::Error::custom(format_args!(
                    "more than {} {}",
                    self.limit, self.what
                )));
            }
            values.push(value);
        }
        Ok(values)
    }
}

struct BoundedBytes;

impl<'de> Visitor<'de> for BoundedBytes {
    type Value = Vec<u8>;

    fn expecting(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(formatter, "at most {MAX_PIXEL_BYTES} atlas pixel bytes")
    }

    fn visit_bytes<E: serde::de::Error>(self, bytes: &[u8]) -> Result<Self::Value, E> {
        if bytes.len() > MAX_PIXEL_BYTES {
            return Err(E::custom(format_args!(
                "more than {MAX_PIXEL_BYTES} atlas pixel bytes"
            )));
        }
        Ok(bytes.to_vec())
    }

    fn visit_seq<A: SeqAccess<'de>>(self, sequence: A) -> Result<Self::Value, A::Error> {
        BoundedSeq::new(MAX_PIXEL_BYTES, "atlas pixel bytes").visit_seq(sequence)
    }
}

pub(super) fn deserialize_probes<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<FaceProbe>, D::Error> {
    deserializer.deserialize_seq(BoundedSeq::new(MAX_FACE_PROBES, "face probes"))
}

pub(super) fn deserialize_code_points<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<u32>, D::Error> {
    deserializer.deserialize_seq(BoundedSeq::new(
        MAX_CLUSTER_CODE_POINTS,
        "cluster code points",
    ))
}

pub(super) fn deserialize_glyphs<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<AtlasGlyph>, D::Error> {
    deserializer.deserialize_seq(BoundedSeq::new(MAX_GLYPH_COUNT, "atlas glyphs"))
}

pub(super) fn deserialize_pixels<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<u8>, D::Error> {
    deserializer.deserialize_byte_buf(BoundedBytes)
}
