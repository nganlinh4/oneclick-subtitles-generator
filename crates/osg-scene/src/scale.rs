//! Resolution scaling for subtitle style values.
//!
//! Reproduces the shipped behaviour exactly, including its two surprises: sizes scale with
//! composition height while margins elsewhere use a fixed 1920x1080 percentage (so margins are
//! resolution-independent and sizes are not), and the result is rounded through JavaScript
//! `Number.prototype.toFixed(2)` semantics rather than Rust's default rounding.

const REFERENCE_HEIGHT: f64 = 1_080.0;
/// Enough decimals to see past any tie a double in this domain can actually produce.
const EXACT_DIGITS: usize = 25;

/// Round to two decimals the way `toFixed(2)` does: on the exact value of the double, half away
/// from zero. Rust's own two-decimal formatting rounds half to even, which disagrees whenever the
/// exact value lands on a tie — `0.125` becomes `0.13` here and `0.12` there.
fn round_to_two_decimals_like_javascript(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    // Rust prints the correctly-rounded decimal expansion of the exact double, so this string is
    // the same value `toFixed` inspects.
    let exact = format!("{:.*}", EXACT_DIGITS, value.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let keep: String = fraction.chars().take(2).collect();
    let rest = &fraction[keep.len().min(fraction.len())..];

    let mut digits: Vec<u8> = whole
        .bytes()
        .chain(keep.bytes())
        .map(|byte| byte - b'0')
        .collect();

    // Half away from zero: a remainder of exactly one half rounds up, as does anything above it.
    let rounds_up = match rest.as_bytes().first() {
        Some(&first) if first > b'5' => true,
        Some(&b'5') => true,
        _ => false,
    };
    if rounds_up {
        let mut index = digits.len();
        loop {
            if index == 0 {
                digits.insert(0, 1);
                break;
            }
            index -= 1;
            if digits[index] == 9 {
                digits[index] = 0;
            } else {
                digits[index] += 1;
                break;
            }
        }
    }

    let text: String = digits.iter().map(|digit| (digit + b'0') as char).collect();
    let split = text.len() - 2;
    let rounded: f64 = format!("{}.{}", &text[..split], &text[split..])
        .parse()
        .unwrap_or(value);
    if value.is_sign_negative() {
        -rounded
    } else {
        rounded
    }
}

/// Scale a style value authored against a 1080-high composition to `composition_height`.
#[must_use]
pub fn scale_subtitle_style_value(value: f64, composition_height: f64) -> f64 {
    round_to_two_decimals_like_javascript((value * composition_height) / REFERENCE_HEIGHT)
}
