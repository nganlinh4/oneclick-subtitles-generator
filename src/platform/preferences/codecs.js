// Value codecs for declared preferences. Each codec keeps the exact string format the key has
// always used in WebView storage, decodes damaged values to the declared default, and normalizes
// writes (throwing on values that cannot be represented).

const fail = (message) => { throw new TypeError(message); };

/** 'true'/'false'; anything else reads as the default. */
export const bool = (fallback) => Object.freeze({
  fallback,
  decode: (raw) => (raw === 'true' ? true : raw === 'false' ? false : fallback),
  normalize: (value) => (typeof value === 'boolean' ? value : fail('A boolean preference is required')),
  encode: (value) => String(value),
});

/** One of a closed set of strings. */
export const oneOf = (values, fallback) => {
  const allowed = new Set(values);
  if (!allowed.has(fallback)) fail('An enumerated preference default must be allowed');
  return Object.freeze({
    fallback,
    values: Object.freeze([...values]),
    decode: (raw) => (allowed.has(raw) ? raw : fallback),
    normalize: (value) => (allowed.has(value) ? value : fail('Unsupported preference value')),
    encode: (value) => value,
  });
};

const boundedNumber = (parse, round) => (fallback, { min = -Infinity, max = Infinity } = {}) => {
  const clamp = (value) => Math.min(max, Math.max(min, value));
  return Object.freeze({
    fallback,
    decode: (raw) => {
      const parsed = raw === null ? Number.NaN : parse(raw);
      return Number.isFinite(parsed) ? clamp(round(parsed)) : fallback;
    },
    normalize: (value) => {
      const parsed = typeof value === 'string' ? parse(value) : value;
      return Number.isFinite(parsed) ? clamp(round(parsed)) : fail('A finite number is required');
    },
    encode: (value) => String(value),
  });
};

/** A base-10 integer, clamped into range. */
export const int = boundedNumber((raw) => Number.parseInt(raw, 10), Math.round);

/** A finite decimal number, clamped into range. */
export const num = boundedNumber((raw) => Number.parseFloat(raw), (value) => value);

/** A bounded string stored verbatim. */
export const text = (fallback, { maxLength = 100_000, allowEmpty = true } = {}) => Object.freeze({
  fallback,
  decode: (raw) => (
    typeof raw === 'string' && raw.length <= maxLength && (allowEmpty || raw.length > 0)
      ? raw
      : fallback
  ),
  normalize: (value) => (
    typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
      ? value
      : fail('A bounded text preference is required')
  ),
  encode: (value) => value,
});

/** A JSON document accepted by `validate`. The default must be immutable or a factory. */
export const json = (fallback, validate = () => true) => {
  const fresh = () => (typeof fallback === 'function' ? fallback() : fallback);
  return Object.freeze({
    get fallback() { return fresh(); },
    decode: (raw) => {
      if (raw === null) return fresh();
      try {
        const parsed = JSON.parse(raw);
        return validate(parsed) ? parsed : fresh();
      } catch {
        return fresh();
      }
    },
    normalize: (value) => (validate(value) ? value : fail('An invalid JSON preference was refused')),
    encode: (value) => JSON.stringify(value),
  });
};
