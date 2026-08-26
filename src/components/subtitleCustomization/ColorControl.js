import {
  useCallback, useEffect, useId, useRef, useState,
} from 'react';

const COLOR_PATTERN = /^(?:#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8})$/iu;

export const isSubtitleColor = value => typeof value === 'string' && COLOR_PATTERN.test(value);

const pickerColor = (value) => {
  if (!isSubtitleColor(value)) return '#000000';
  const hex = value.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    return `#${[...hex.slice(0, 3)].map(character => character.repeat(2)).join('')}`;
  }
  return `#${hex.slice(0, 6)}`;
};

/**
 * A colour has to be typed through invalid intermediate strings (`#`, `#7`, ...). Those drafts do
 * not belong in the strict native scene: publishing each keystroke made the authority reject and
 * reset the field before a customer could finish typing. Keep the draft local and commit exactly
 * one validated value on blur/Enter. The native colour picker already emits complete values and
 * therefore commits immediately.
 */
const ColorControl = ({
  id, value, onChange, placeholder, ariaLabel,
}) => {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const [draft, setDraft] = useState(value);
  const suppressBlurCommitRef = useRef(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = useCallback((inputValue) => {
    const candidate = String(inputValue).trim();
    if (isSubtitleColor(candidate)) {
      setDraft(candidate);
      if (candidate !== value) onChange(candidate);
    } else {
      setDraft(value);
    }
  }, [onChange, value]);

  return (
    <div className="color-control">
      <input
        id={`${controlId}-picker`}
        type="color"
        value={pickerColor(value)}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          onChange(next);
        }}
        className="color-picker"
        aria-label={ariaLabel}
      />
      <input
        id={controlId}
        type="text"
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onFocus={() => {
          // A missing synthetic blur must not leave suppression armed for the next real edit.
          suppressBlurCommitRef.current = false;
        }}
        onBlur={(event) => {
          if (suppressBlurCommitRef.current) {
            suppressBlurCommitRef.current = false;
            return;
          }
          // Read the public control at the commit boundary. A same-tick final keystroke followed by
          // Enter can blur before React has installed the next render's callback; closing over
          // `draft` would then validate the previous value and leave a convincing but inert local
          // draft on screen. The DOM value is the exact text the customer just committed.
          commit(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            // Enter is the commit command. Do not make its result depend on the embedded WebView
            // delivering a second synthetic blur event after `HTMLElement.blur()`.
            commit(event.currentTarget.value);
            suppressBlurCommitRef.current = true;
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            suppressBlurCommitRef.current = true;
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
        className="color-input"
        aria-invalid={!isSubtitleColor(draft)}
      />
    </div>
  );
};

export default ColorControl;
