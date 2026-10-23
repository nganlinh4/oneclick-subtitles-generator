// The injected interaction guard and the vendored WebDriver click/scroll scripts.

import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { read } from './repositorySources.js';

/* global DOMException, URL */

const webdriverExecutorMethodScript = (executor, methodName) => {
  const methodStart = executor.indexOf(`async fn ${methodName}`);
  assert.ok(methodStart >= 0, `vendored WebDriver method is missing: ${methodName}`);
  const followingMethod = executor.indexOf('\n    async fn ', methodStart + 1);
  const method = executor.slice(
    methodStart,
    followingMethod < 0 ? executor.length : followingMethod,
  );
  const template = /let script = format!\(\s*r"([\s\S]*?)"\s*\);/u.exec(method)?.[1];
  assert.notEqual(template, undefined, `vendored WebDriver method has no executable script: ${methodName}`);
  return template
    .replaceAll('{js_var}', '__webdriverElement')
    .replaceAll('{{', '{')
    .replaceAll('}}', '}');
};

const webdriverElement = ({ rect, scrollIntoView = () => undefined }) => {
  const calls = { clicks: 0, focuses: 0 };
  return {
    calls,
    element: {
      isConnected: true,
      tagName: 'BUTTON',
      type: 'button',
      getBoundingClientRect: () => ({ ...rect }),
      scrollIntoView,
      click: () => { calls.clicks += 1; },
      focus: () => { calls.focuses += 1; },
    },
  };
};
test('the injected interaction guard refuses OS surfaces without disabling ordinary synthetic input', async () => {
  const source = read('apps', 'desktop', 'src-tauri', 'src', 'automation_window.rs');
  const match = /AUTOMATION_INTERACTION_GUARD_SCRIPT:\s*&str\s*=\s*r#"([\s\S]*?)"#;/u.exec(source);
  assert.notEqual(match, null, 'the compiled automation interaction script is missing');

  function Element() {}
  Object.defineProperty(Element.prototype, 'requestFullscreen', {
    configurable: true,
    value: () => Promise.resolve('unsafe fullscreen'),
  });
  Element.prototype.closest = () => null;
  function HTMLInputElement() {}
  HTMLInputElement.prototype = Object.create(Element.prototype);
  Object.defineProperty(HTMLInputElement.prototype, 'click', {
    configurable: true,
    value() { return 'ordinary click'; },
  });
  Object.defineProperty(HTMLInputElement.prototype, 'showPicker', {
    configurable: true,
    value() { return 'ordinary picker'; },
  });
  function HTMLVideoElement() {}
  HTMLVideoElement.prototype.requestPictureInPicture = () => Promise.resolve('unsafe picture');
  const listeners = new Map();
  const window_ = {
    location: { href: 'https://tauri.localhost/editor', origin: 'https://tauri.localhost' },
    open: () => ({ unsafe: true }),
    print: () => 'unsafe print',
    alert: () => 'unsafe alert',
    confirm: () => true,
    prompt: () => 'unsafe prompt',
    focus: () => 'unsafe focus',
    moveTo: () => 'unsafe move',
    moveBy: () => 'unsafe move',
    resizeTo: () => 'unsafe resize',
    resizeBy: () => 'unsafe resize',
    showOpenFilePicker: () => Promise.resolve('unsafe open picker'),
    showSaveFilePicker: () => Promise.resolve('unsafe save picker'),
    showDirectoryPicker: () => Promise.resolve('unsafe directory picker'),
    HTMLVideoElement,
    documentPictureInPicture: {
      requestWindow: () => Promise.resolve('unsafe picture window'),
    },
    navigator: {
      mediaDevices: {
        getUserMedia: () => Promise.resolve('unsafe microphone'),
        getDisplayMedia: () => Promise.resolve('unsafe screen picker'),
        selectAudioOutput: () => Promise.resolve('unsafe audio picker'),
      },
      share: () => Promise.resolve('unsafe share surface'),
      credentials: {
        get: () => Promise.resolve('unsafe credential chooser'),
        create: () => Promise.resolve('unsafe credential enrollment'),
      },
    },
    addEventListener: (type, listener, capture) => listeners.set(type, { listener, capture }),
  };

  const install = new Function('Element', 'HTMLInputElement', 'window', 'DOMException', 'URL', match[1]);
  install(Element, HTMLInputElement, window_, DOMException, URL);

  await assert.rejects(Element.prototype.requestFullscreen(), /interactive desktop surface/u);
  const file = Object.create(HTMLInputElement.prototype);
  file.type = 'file';
  assert.throws(() => file.click(), /interactive desktop surface/u);
  assert.throws(() => file.showPicker(), /interactive desktop surface/u);
  const text = Object.create(HTMLInputElement.prototype);
  text.type = 'text';
  assert.equal(text.click(), 'ordinary click');
  assert.equal(text.showPicker(), 'ordinary picker');
  assert.equal(window_.open('https://example.invalid'), null);
  await assert.rejects(window_.showOpenFilePicker(), /interactive desktop surface/u);
  await assert.rejects(window_.showSaveFilePicker(), /interactive desktop surface/u);
  await assert.rejects(window_.showDirectoryPicker(), /interactive desktop surface/u);
  await assert.rejects(
    HTMLVideoElement.prototype.requestPictureInPicture(),
    /interactive desktop surface/u,
  );
  await assert.rejects(
    window_.documentPictureInPicture.requestWindow(),
    /interactive desktop surface/u,
  );
  for (const name of ['getUserMedia', 'getDisplayMedia', 'selectAudioOutput']) {
    await assert.rejects(window_.navigator.mediaDevices[name](), /interactive desktop surface/u);
  }
  await assert.rejects(window_.navigator.share(), /interactive desktop surface/u);
  await assert.rejects(window_.navigator.credentials.get(), /interactive desktop surface/u);
  await assert.rejects(window_.navigator.credentials.create(), /interactive desktop surface/u);
  for (const name of [
    'print', 'alert', 'confirm', 'prompt',
    'focus', 'moveTo', 'moveBy', 'resizeTo', 'resizeBy',
  ]) {
    assert.throws(() => window_[name](), /interactive desktop surface/u, name);
  }

  const click = listeners.get('click');
  assert.equal(click.capture, true);
  const external = Object.create(Element.prototype);
  external.href = 'tel:+15551234567';
  external.target = '';
  external.hasAttribute = () => false;
  external.closest = (selector) => (selector === 'a[href]' ? external : null);
  const calls = [];
  click.listener({
    target: external,
    preventDefault: () => calls.push('prevented'),
    stopImmediatePropagation: () => calls.push('stopped'),
  });
  assert.deepEqual(calls, ['prevented', 'stopped']);

  for (const [label, target, download] of [
    ['named browsing context', 'report-window', false],
    ['browser download', '_self', true],
  ]) {
    const anchor = Object.create(Element.prototype);
    anchor.href = 'https://tauri.localhost/report';
    anchor.target = target;
    anchor.hasAttribute = (name) => name === 'download' && download;
    anchor.closest = (selector) => (selector === 'a[href]' ? anchor : null);
    const surfaceCalls = [];
    click.listener({
      target: anchor,
      preventDefault: () => surfaceCalls.push('prevented'),
      stopImmediatePropagation: () => surfaceCalls.push('stopped'),
    });
    assert.deepEqual(surfaceCalls, ['prevented', 'stopped'], label);
  }

  const internal = Object.create(Element.prototype);
  internal.href = 'https://tauri.localhost/settings';
  internal.target = '';
  internal.hasAttribute = () => false;
  internal.closest = (selector) => (selector === 'a[href]' ? internal : null);
  const internalCalls = [];
  click.listener({
    target: internal,
    preventDefault: () => internalCalls.push('prevented'),
    stopImmediatePropagation: () => internalCalls.push('stopped'),
  });
  assert.deepEqual(internalCalls, [], 'same-origin in-app navigation remains synthetic and usable');
});

test('visible WebDriver click targets preserve root and nested scroll positions', () => {
  const executor = read(
    'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'platform', 'executor.rs',
  );
  const scripts = [
    ['element click', webdriverExecutorMethodScript(executor, 'click_element')],
    ['pointer origin', webdriverExecutorMethodScript(executor, 'get_element_center')],
  ];

  for (const [label, script] of scripts) {
    const scroll = { documentTop: 420, nestedTop: 73 };
    const scrollCalls = [];
    const target = webdriverElement({
      rect: { left: 100, top: 120, width: 80, height: 40 },
      scrollIntoView: (options) => {
        scrollCalls.push(JSON.parse(JSON.stringify(options)));
        scroll.documentTop = 0;
        scroll.nestedTop = 0;
      },
    });
    const window = {
      __webdriverElement: target.element,
      innerWidth: 1_000,
      innerHeight: 800,
    };

    const result = runInNewContext(script, { window });
    assert.deepEqual(scrollCalls, [], `${label} scrolled an already-visible control`);
    assert.deepEqual(
      scroll,
      { documentTop: 420, nestedTop: 73 },
      `${label} moved document or nested scroll state`,
    );
    if (label === 'element click') {
      assert.deepEqual(target.calls, { clicks: 1, focuses: 1 });
    } else {
      assert.deepEqual({ x: result.x, y: result.y }, { x: 140, y: 140 });
    }
  }
});

test('offscreen WebDriver targets use nearest scrolling and re-resolve after scroll', () => {
  const executor = read(
    'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'platform', 'executor.rs',
  );
  const scripts = [
    ['element click', webdriverExecutorMethodScript(executor, 'click_element')],
    ['pointer origin', webdriverExecutorMethodScript(executor, 'get_element_center')],
  ];

  for (const [label, script] of scripts) {
    const scrollCalls = [];
    const replacement = webdriverElement({
      rect: { left: 20, top: 600, width: 80, height: 40 },
    });
    let window;
    const original = webdriverElement({
      rect: { left: 20, top: 1_200, width: 80, height: 40 },
      scrollIntoView: (options) => {
        scrollCalls.push(JSON.parse(JSON.stringify(options)));
        window.__webdriverElement = replacement.element;
      },
    });
    window = {
      __webdriverElement: original.element,
      innerWidth: 1_000,
      innerHeight: 800,
    };

    const result = runInNewContext(script, { window });
    assert.deepEqual(scrollCalls, [{
      behavior: 'instant',
      block: 'nearest',
      inline: 'nearest',
    }], `${label} did not use one bounded nearest scroll`);
    assert.deepEqual(original.calls, { clicks: 0, focuses: 0 }, `${label} used the stale node`);
    if (label === 'element click') {
      assert.deepEqual(replacement.calls, { clicks: 1, focuses: 1 });
    } else {
      assert.deepEqual({ x: result.x, y: result.y }, { x: 60, y: 620 });
    }
  }
});
