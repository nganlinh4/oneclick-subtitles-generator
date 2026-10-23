// Bounded, redacted test-failure records and their stable failure step names.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

import { safeSegment } from './paths.js';

const MAX_TEST_FAILURE_TITLE = 1_000;
const MAX_TEST_FAILURE_CONTEXT = 2_000;
const MAX_TEST_FAILURE_MESSAGE = 4_000;
const MAX_TEST_FAILURE_STACK = 16 * 1024;
export const workflowFailureStepForTest = (title) => {
  assert.equal(typeof title, 'string', 'failure evidence requires a test title');
  const readable = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '') || 'test';
  const digest = createHash('sha256').update(title).digest('hex').slice(0, 8);
  return safeSegment(`failure-${readable}-${digest}`, 'step');
};

// A failed provider request can echo the URL or authorization header that caused it. Preserve the
// exact assertion and stack around those values, but never turn immutable test evidence into a
// credential store. Work is capped before the regex pass as well as after it so a hostile Error
// object cannot make evidence serialization unbounded.
export const boundedFailureText = (value, maximum) => {
  const raw = value === undefined || value === null ? '' : String(value);
  const boundedInput = raw.slice(0, maximum * 4);
  const redacted = boundedInput
    .replace(/([?&][a-z0-9_.~-]{1,80}=)[^&\s#"'<>]*/giu, '$1[REDACTED]')
    .replace(/((?:authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|private[_-]?key|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|Bearer\s+[^\s,;]+|[^\s,;]+)/giu, '$1[REDACTED]')
    .replace(/\b(Bearer)\s+[a-z0-9._~+/=-]{8,}/giu, '$1 [REDACTED]')
    .replace(/\b(?:AIza[a-z0-9_-]{20,}|sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{16,}|AKIA[a-z0-9]{16}|xox[baprs]-[a-z0-9-]{16,}|eyJ[a-z0-9_-]{12,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})\b/giu, '[REDACTED]');
  return {
    value: redacted.slice(0, maximum),
    truncated: raw.length > maximum || redacted.length > maximum,
  };
};

export const boundedWorkflowTestFailure = ({
  test,
  error,
  capturedAt = new Date().toISOString(),
}) => {
  assert.doesNotThrow(() => new Date(capturedAt).toISOString(), 'capturedAt must be ISO-compatible');
  const title = boundedFailureText(test?.title ?? 'unknown test', MAX_TEST_FAILURE_TITLE);
  const parent = boundedFailureText(test?.parent ?? '', MAX_TEST_FAILURE_CONTEXT);
  const file = boundedFailureText(test?.file ?? '', MAX_TEST_FAILURE_CONTEXT);
  const uid = boundedFailureText(test?.uid ?? '', MAX_TEST_FAILURE_CONTEXT);
  const hook = boundedFailureText(test?.hook ?? '', 200);
  const name = boundedFailureText(error?.name ?? 'Error', 200);
  const message = boundedFailureText(error?.message ?? error ?? 'WebdriverIO test failed', MAX_TEST_FAILURE_MESSAGE);
  const stack = boundedFailureText(error?.stack ?? '', MAX_TEST_FAILURE_STACK);
  return {
    capturedAt: new Date(capturedAt).toISOString(),
    test: {
      title: title.value,
      parent: parent.value,
      file: file.value,
      uid: uid.value,
      hook: hook.value,
    },
    error: {
      name: name.value,
      message: message.value,
      stack: stack.value,
    },
    truncated: {
      title: title.truncated,
      parent: parent.truncated,
      file: file.truncated,
      uid: uid.truncated,
      hook: hook.truncated,
      name: name.truncated,
      message: message.truncated,
      stack: stack.truncated,
    },
  };
};
