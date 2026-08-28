import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..');
const WINDOWS_EXECUTOR = join(
  REPOSITORY_ROOT,
  'vendor',
  'tauri-plugin-wdio-webdriver',
  'src',
  'platform',
  'windows.rs',
);

// Normalized so the mutation guards below stay independent of the checkout's line endings.
const readExecutor = () => readFileSync(WINDOWS_EXECUTOR, 'utf8').replaceAll('\r\n', '\n');

const rustStringConstant = (source, name) => (
  new RegExp(`const ${name}: &str = "([^"]*)";`, 'u').exec(source)?.[1]
);

/**
 * Rebuild the async-script wrapper the Windows executor sends to the WebView.
 *
 * The template is a Rust `format!` raw string, so named placeholders are substituted first and the
 * doubled braces that escape JavaScript's own braces are collapsed afterwards.
 */
const asyncScriptWrapper = (source, { script, argsJson = '[]', asyncId = 'test-async-id' }) => {
  const template = /let wrapper = format!\(\s*r"([\s\S]*?)"\s*\);/u.exec(source)?.[1];
  assert.notEqual(template, undefined, 'the vendored Windows async-script wrapper is missing');
  return template
    // Substituted tolerantly so a source that has no private channel at all still produces a
    // runnable wrapper, and fails on what it posts rather than on a missing constant.
    .replaceAll('{REPORT_KEY}', rustStringConstant(source, 'REPORT_KEY') ?? 'absentReportKey')
    .replaceAll('{HANDLER_NAME}', rustStringConstant(source, 'HANDLER_NAME') ?? 'absentHandler')
    .replaceAll('{async_id}', asyncId)
    .replaceAll('{args_json}', argsJson)
    .replaceAll('{script}', script)
    .replaceAll('{{', '{')
    .replaceAll('}}', '}');
};

/** Run one wrapper against a stubbed WebView2 message channel and collect what it posted. */
const postedMessages = (wrapper) => {
  const posted = [];
  const window = { chrome: { webview: { postMessage: (message) => posted.push(message) } } };
  runInNewContext(wrapper, { window, JSON, Array, Error, String });
  return posted;
};

/**
 * Every async-script report must leave the page as an OBJECT message.
 *
 * `window.chrome.webview.postMessage` is a shared broadcast, and a Tauri app always has wry's IPC
 * bridge listening on it. wry forwards a message to `tauri::ipc::protocol::handle_ipc_message` only
 * when `TryGetWebMessageAsString` succeeds, so a string report is parsed as an `invoke` envelope.
 * Tauri's envelope declares `error: CallbackFn(u32)`, which collides with a report's `error: null`
 * and makes Tauri eval `console.error("JSON error: invalid type: null, expected u32 at line 1
 * column N")` into the application under test -- polluting the console every journey asserts on.
 * An object message is invisible to that bridge while `WebMessageAsJson` still reads it natively.
 */
const assertPrivateAsyncReportChannel = (source) => {
  const reportKey = rustStringConstant(source, 'REPORT_KEY');
  const handlerName = rustStringConstant(source, 'HANDLER_NAME');

  const wrapper = asyncScriptWrapper(source, { script: 'var done = arguments[0]; done({ ok: 1 });' });
  const posted = postedMessages(wrapper);
  assert.equal(posted.length, 1, 'the async-script wrapper did not report exactly once');
  assert.equal(
    typeof posted[0],
    'object',
    'the async-script report is posted as a string, so Tauri parses it as an invoke envelope',
  );
  assert.notEqual(reportKey, undefined, 'the vendored Windows executor lost its REPORT_KEY constant');
  assert.notEqual(handlerName, undefined, 'the vendored Windows executor lost its HANDLER_NAME constant');
  assert.deepEqual(
    Object.keys(posted[0]),
    [reportKey],
    'the posted report object must carry exactly one private property',
  );
  assert.deepEqual(JSON.parse(posted[0][reportKey]), {
    handler: handlerName,
    id: 'test-async-id',
    result: { ok: 1 },
    error: null,
  });

  // A thrown script still reports through the same private channel.
  const failed = postedMessages(asyncScriptWrapper(source, {
    script: 'throw new Error("boom");',
  }));
  assert.equal(failed.length, 1);
  assert.equal(typeof failed[0], 'object');
  assert.equal(JSON.parse(failed[0][reportKey]).error, 'boom');

  // `done()` with no value must keep dropping `result` rather than sending an explicit null:
  // the native side already treats a missing result as JSON null.
  const empty = postedMessages(asyncScriptWrapper(source, {
    script: 'var done = arguments[0]; done();',
  }));
  assert.equal('result' in JSON.parse(empty[0][reportKey]), false);

  // The native reader must unwrap the same property, and must no longer accept a bare string
  // message -- a string report is exactly what Tauri's IPC bridge also consumes.
  assert.match(
    source,
    /fn report_from_web_message\(msg_text: &str\) -> Option<serde_json::Value> \{[\s\S]*?outer\.as_object\(\)\?\.get\(REPORT_KEY\)\?\.as_str\(\)\?/u,
    'the native reader does not unwrap the private report property',
  );
  assert.match(source, /super::report_from_web_message\(&msg_text\)/u);
  assert.doesNotMatch(
    source,
    /let inner_str: String = match serde_json::from_str\(&msg_text\)/u,
    'the native reader still accepts the bare-string report shape',
  );
};

test('the vendored Windows async-script channel stays invisible to Tauri IPC', () => {
  assertPrivateAsyncReportChannel(readExecutor());
});

test('the private-channel contract fails closed when the report shape regresses', () => {
  const source = readExecutor();

  // The exact regression this guards: stringifying the report puts it back on the shape Tauri's
  // envelope parser consumes.
  const stringified = source.replace(
    /window\.chrome\.webview\.postMessage\(\{\{\s*'\{REPORT_KEY\}': JSON\.stringify\(\{\{/u,
    'window.chrome.webview.postMessage(JSON.stringify({{\n                        _unused: ({{',
  );
  assert.ok(stringified !== source, 'the guarded postMessage call moved; update this contract');
  assert.throws(() => assertPrivateAsyncReportChannel(stringified));

  // Drifting the JavaScript property away from the constant the native reader unwraps must fail:
  // the report would then be posted under a name nothing on the native side ever reads.
  const drifted = source.replace("'{REPORT_KEY}': JSON.stringify", "'driftedKey': JSON.stringify");
  assert.ok(drifted !== source, 'the guarded report property moved; update this contract');
  assert.throws(() => assertPrivateAsyncReportChannel(drifted));

  // Reverting the native reader to the bare-string shape must fail even if the JS side is right.
  assert.throws(() => assertPrivateAsyncReportChannel(
    source.replace(
      'let Some(msg) = super::report_from_web_message(&msg_text) else {',
      'let inner_str: String = match serde_json::from_str(&msg_text) {\n'
        + '                    Ok(s) => s,\n'
        + '                    Err(_) => return Ok(()),\n'
        + '                };\n'
        + '                let Some(msg) = Some(Value::Null) else {',
    ),
  ));
});
