import { strict as assert } from 'node:assert';

/* global document, window */

/**
 * Runs inside the real WebView. The embedded provider can dispatch pointer events, but those
 * untrusted events do not perform Chromium's native range-input default action. Keep the narrow
 * compatibility bridge here: one native value-setter call followed by one bubbling input event.
 */
export const actuateNativeRangeInPage = (selector, targetValue) => {
  // Keep every browser-side dependency inside this function: WebDriver serializes only this
  // function body, not module closures.
  const readFiniteAttribute = (element, name) => {
    const raw = element.getAttribute(name);
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const control = document.querySelector(selector);
  if (!(control instanceof window.HTMLInputElement) || control.type !== 'range') {
    return { activated: false, reason: 'missingRangeControl' };
  }

  const value = Number(targetValue);
  if (!Number.isFinite(value)) return { activated: false, reason: 'invalidTarget' };

  const minimum = readFiniteAttribute(control, 'min');
  const maximum = readFiniteAttribute(control, 'max');
  if (minimum === null || maximum === null || maximum <= minimum) {
    return { activated: false, reason: 'invalidRangeBounds' };
  }
  const step = readFiniteAttribute(control, 'step');
  if (step === null || step <= 0) return { activated: false, reason: 'invalidRangeStep' };
  if (value < minimum || value > maximum) {
    return { activated: false, reason: 'targetOutOfRange' };
  }

  const stepPosition = (value - minimum) / step;
  const stepTolerance = Math.max(1, Math.abs(stepPosition)) * Number.EPSILON * 16;
  if (Math.abs(stepPosition - Math.round(stepPosition)) > stepTolerance) {
    return { activated: false, reason: 'targetOffStep' };
  }

  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  if (typeof setter !== 'function') return { activated: false, reason: 'missingNativeSetter' };

  setter.call(control, String(value));
  const observed = Number(control.value);
  const valueTolerance = Math.max(1, Math.abs(value)) * Number.EPSILON * 16;
  if (!Number.isFinite(observed) || Math.abs(observed - value) > valueTolerance) {
    return { activated: false, reason: 'nativeValueMismatch' };
  }

  control.focus({ preventScroll: true });
  control.dispatchEvent(new window.Event('input', { bubbles: true, composed: true }));
  return {
    activated: true,
    reason: null,
    value: observed,
    minimum,
    maximum,
    step,
    focused: document.activeElement === control,
  };
};

/** Actuate a shipped native range input through the real WebView and fail with bounded evidence. */
export const actuateNativeRange = async ({ driver, selector, value, label = selector }) => {
  assert.equal(typeof driver?.execute, 'function', `${label}: WebView driver is unavailable`);
  assert.equal(typeof selector, 'string', `${label}: range selector must be a string`);
  assert.ok(selector.length > 0, `${label}: range selector is empty`);
  assert.ok(Number.isFinite(value), `${label}: target range value is not finite`);
  const result = await driver.execute(actuateNativeRangeInPage, selector, value);
  assert.equal(
    result?.activated,
    true,
    `${label}: native range actuation failed: ${JSON.stringify(result)}`,
  );
  assert.equal(result.reason, null, `${label}: native range returned a refusal reason`);
  // Chromium serializes a legal fractional step through the control's decimal value. A target
  // produced by arithmetic can therefore be `1.2000000000000002` while the native control
  // correctly commits `1.2`. The in-page actuator already rejects off-step targets and compares
  // the committed value with an IEEE-754-scaled tolerance; repeat that same contract after the
  // WebDriver serialization boundary instead of contradicting it with exact binary equality.
  const valueTolerance = Math.max(1, Math.abs(value)) * Number.EPSILON * 16;
  assert.ok(
    Number.isFinite(result.value) && Math.abs(result.value - value) <= valueTolerance,
    `${label}: native range committed the wrong value`,
  );
  return Object.freeze({ ...result });
};
