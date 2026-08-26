import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { actuateNativeRange, actuateNativeRangeInPage } from './nativeRange.js';

/* global URL */

const withFakePage = ({ node, Input = null }, operation) => {
  class FakeEvent {
    constructor(type, options) {
      this.type = type;
      Object.assign(this, options);
    }
  }
  const InputClass = Input ?? class FakeInput {
    constructor() {
      this.type = 'range';
      this.attributes = new Map([['min', '0'], ['max', '10'], ['step', '0.5']]);
      this.events = [];
      this.focusCalls = [];
      this.setterCalls = [];
      this._value = '0';
    }

    getAttribute(name) { return this.attributes.get(name) ?? null; }

    focus(options) {
      this.focusCalls.push(options);
      globalThis.document.activeElement = this;
    }

    dispatchEvent(event) {
      this.events.push(event);
      return true;
    }

    get value() { return this._value; }

    set value(next) {
      this.setterCalls.push(String(next));
      this._value = String(next);
    }
  };
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { HTMLInputElement: InputClass, Event: FakeEvent };
  globalThis.document = { activeElement: null, querySelector: () => node };
  try {
    return operation(InputClass);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
};

test('refuses a missing node and a non-range input before mutation', () => {
  withFakePage({ node: null }, () => {
    assert.deepEqual(actuateNativeRangeInPage('#missing', 2), {
      activated: false,
      reason: 'missingRangeControl',
    });
  });
  withFakePage({ node: null }, (Input) => {
    const node = new Input();
    node.type = 'text';
    globalThis.document.querySelector = () => node;
    assert.deepEqual(actuateNativeRangeInPage('#text', 2), {
      activated: false,
      reason: 'missingRangeControl',
    });
    assert.deepEqual(node.events, []);
  });
});

test('refuses a range when its native prototype setter is absent', () => {
  class SetterlessInput {
    constructor() {
      this.type = 'range';
      this.value = '0';
      this.attributes = new Map([['min', '0'], ['max', '10'], ['step', '1']]);
    }

    getAttribute(name) { return this.attributes.get(name) ?? null; }
  }
  const node = new SetterlessInput();
  withFakePage({ node, Input: SetterlessInput }, () => {
    assert.deepEqual(actuateNativeRangeInPage('#range', 2), {
      activated: false,
      reason: 'missingNativeSetter',
    });
  });
});

test('refuses malformed bounds, malformed steps, out-of-range and off-step targets', () => {
  withFakePage({ node: null }, (Input) => {
    const node = new Input();
    globalThis.document.querySelector = () => node;
    node.attributes.set('max', '0');
    assert.equal(actuateNativeRangeInPage('#range', 0).reason, 'invalidRangeBounds');
    node.attributes.set('max', '10');
    node.attributes.set('step', '0');
    assert.equal(actuateNativeRangeInPage('#range', 2).reason, 'invalidRangeStep');
    node.attributes.set('step', '0.5');
    assert.equal(actuateNativeRangeInPage('#range', -0.5).reason, 'targetOutOfRange');
    assert.equal(actuateNativeRangeInPage('#range', 10.5).reason, 'targetOutOfRange');
    assert.equal(actuateNativeRangeInPage('#range', 2.25).reason, 'targetOffStep');
    assert.equal(actuateNativeRangeInPage('#range', Number.NaN).reason, 'invalidTarget');
    assert.deepEqual(node.events, []);
  });
});

test('uses the prototype setter and emits exactly one bubbling composed input event', () => {
  withFakePage({ node: null }, (Input) => {
    const node = new Input();
    globalThis.document.querySelector = () => node;
    const result = actuateNativeRangeInPage('#range', 3.5);
    assert.deepEqual(result, {
      activated: true,
      reason: null,
      value: 3.5,
      minimum: 0,
      maximum: 10,
      step: 0.5,
      focused: true,
    });
    assert.equal(node.events.length, 1);
    assert.deepEqual(node.setterCalls, ['3.5']);
    assert.equal(node.events[0].type, 'input');
    assert.equal(node.events[0].bubbles, true);
    assert.equal(node.events[0].composed, true);
    assert.deepEqual(node.focusCalls, [{ preventScroll: true }]);
  });
});

test('accepts native decimal normalization without accepting a different range step', async () => {
  const normalizedDriver = {
    execute: async () => ({
      activated: true,
      reason: null,
      value: 1.2,
      minimum: 0,
      maximum: 4,
      step: 0.1,
      focused: true,
    }),
  };
  const result = await actuateNativeRange({
    driver: normalizedDriver,
    selector: '#duration',
    value: 1.2000000000000002,
    label: 'fractional duration',
  });
  assert.equal(result.value, 1.2);

  await assert.rejects(
    actuateNativeRange({
      driver: {
        execute: async () => ({ ...await normalizedDriver.execute(), value: 1.3 }),
      },
      selector: '#duration',
      value: 1.2000000000000002,
      label: 'wrong duration',
    }),
    /native range committed the wrong value/u,
  );
});

test('the WebView actuator survives function-only WebDriver serialization', () => {
  withFakePage({ node: null }, (Input) => {
    const node = new Input();
    globalThis.document.querySelector = () => node;
    const result = runInNewContext(
      `(${actuateNativeRangeInPage.toString()})('#range', 4.5)`,
      { document: globalThis.document, window: globalThis.window },
    );
    assert.equal(result.activated, true);
    assert.equal(result.value, 4.5);
    assert.deepEqual(node.setterCalls, ['4.5']);
    assert.equal(node.events.length, 1);
  });
});

test('public seek helpers use the shared range bridge and never assign media currentTime', () => {
  const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
  const cases = [
    ['material', read('../journeys/subtitleMaterialAndAnimation.journey.js'), 'const publicSeek =', 'const setPlaying ='],
    ['customization', read('../journeys/subtitleCustomizationPreview.journey.js'), 'const seekRenderPreviewWithPublicControl =', 'const applyPresetDuringPlayback ='],
    ['export', read('../journeys/exportAnimationParityMatrix.journey.js'), 'const seekThroughPublicControl =', 'const capturePhase ='],
  ];
  for (const [label, source, startNeedle, endNeedle] of cases) {
    const start = source.indexOf(startNeedle);
    const end = source.indexOf(endNeedle, start + startNeedle.length);
    assert.ok(start >= 0 && end > start, `${label}: public seek helper boundaries changed`);
    const helper = source.slice(start, end);
    assert.doesNotMatch(helper, /\.currentTime\s*=/u, `${label}: public seek bypasses the control`);
    if (label !== 'export') assert.match(helper, /actuateNativeRange/u);
  }
});
