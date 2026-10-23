// WebDriver timeout messages: stable strings, and failures that read fresh state separately.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { E2E_ROOT, read, sourceFilesBelow } from './repositorySources.js';

const TIMEOUT_STRING_IDENTIFIER_ALLOWLIST = new Map([
  // These two helpers receive a customer-readable message parameter. Their call sites are kept
  // separate from timeout polling so the caught failure can append the final observed state.
  [join(E2E_ROOT, 'journeys', 'editorCueCrudAndHistory.journey.js'), new Set(['message'])],
]);

const identifierStart = /[$A-Z_a-z]/u;
const identifierPart = /[$\w]/u;

const skipQuotedValue = (source, start) => {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
};

const skipTrivia = (source, start) => {
  let index = start;
  while (index < source.length) {
    if (/\s/u.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    break;
  }
  return index;
};

const readTimeoutMessageValue = (source, valueStart) => {
  let cursor = valueStart;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  while (cursor < source.length) {
    if (source.startsWith('//', cursor)) {
      const newline = source.indexOf('\n', cursor + 2);
      cursor = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2);
      cursor = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source[cursor] === '\'' || source[cursor] === '"' || source[cursor] === '`') {
      cursor = skipQuotedValue(source, cursor);
      continue;
    }
    if (source[cursor] === '(') parentheses += 1;
    else if (source[cursor] === ')') parentheses -= 1;
    else if (source[cursor] === '[') brackets += 1;
    else if (source[cursor] === ']') brackets -= 1;
    else if (source[cursor] === '{') braces += 1;
    else if (source[cursor] === '}') {
      if (braces === 0 && brackets === 0 && parentheses === 0) break;
      braces -= 1;
    } else if (
      source[cursor] === ','
      && braces === 0
      && brackets === 0
      && parentheses === 0
    ) break;
    cursor += 1;
  }
  return cursor;
};

const timeoutMessageValues = (source) => {
  const values = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source[index] === '\'' || source[index] === '"' || source[index] === '`') {
      const propertyStart = index;
      const propertyEnd = skipQuotedValue(source, index);
      const propertyName = source.slice(propertyStart + 1, propertyEnd - 1);
      const colon = skipTrivia(source, propertyEnd);
      if (propertyName === 'timeoutMsg' && source[colon] === ':') {
        const valueStart = skipTrivia(source, colon + 1);
        const valueEnd = readTimeoutMessageValue(source, valueStart);
        values.push({ expression: source.slice(valueStart, valueEnd).trim(), index: valueStart });
        index = valueEnd;
        continue;
      }
      index = propertyEnd;
      continue;
    }
    if (!identifierStart.test(source[index])) {
      index += 1;
      continue;
    }

    const tokenStart = index;
    index += 1;
    while (index < source.length && identifierPart.test(source[index])) index += 1;
    if (source.slice(tokenStart, index) !== 'timeoutMsg') continue;

    const colon = skipTrivia(source, index);
    if (source[colon] !== ':') {
      let previous = tokenStart - 1;
      while (previous >= 0 && /\s/u.test(source[previous])) previous -= 1;
      if ((source[previous] === '{' || source[previous] === ',')
        && (source[colon] === ',' || source[colon] === '}')) {
        values.push({ expression: 'timeoutMsg', index: tokenStart });
      }
      continue;
    }
    const valueStart = skipTrivia(source, colon + 1);
    const cursor = readTimeoutMessageValue(source, valueStart);
    values.push({ expression: source.slice(valueStart, cursor).trim(), index: valueStart });
    index = cursor;
  }
  return values;
};

const enclosingParentheses = (expression) => {
  if (!expression.startsWith('(') || !expression.endsWith(')')) return false;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === '\'' || expression[index] === '"' || expression[index] === '`') {
      index = skipQuotedValue(expression, index) - 1;
      continue;
    }
    if (expression[index] === '(') depth += 1;
    else if (expression[index] === ')') depth -= 1;
    if (depth === 0 && index < expression.length - 1) return false;
  }
  return depth === 0;
};

const topLevelStringParts = (expression) => {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === '\'' || expression[index] === '"' || expression[index] === '`') {
      index = skipQuotedValue(expression, index) - 1;
      continue;
    }
    if ('([{'.includes(expression[index])) depth += 1;
    else if (')]}'.includes(expression[index])) depth -= 1;
    else if (expression[index] === '+' && depth === 0) {
      parts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (parts.length === 0) return null;
  parts.push(expression.slice(start).trim());
  return parts;
};

const staticStringExpression = (source, expression, expressionIndex, allowedIdentifiers, seen = new Set()) => {
  const value = expression.trim();
  if (value.length === 0) return false;
  if (enclosingParentheses(value)) {
    return staticStringExpression(source, value.slice(1, -1), expressionIndex + 1, allowedIdentifiers, seen);
  }
  const stringParts = topLevelStringParts(value);
  if (stringParts !== null) {
    return stringParts.every((part) => (
      staticStringExpression(source, part, expressionIndex, allowedIdentifiers, seen)
    ));
  }
  if (value[0] === '\'' || value[0] === '"' || value[0] === '`') {
    return skipQuotedValue(value, 0) === value.length;
  }
  if (!/^[$A-Z_a-z][$\w]*$/u.test(value) || seen.has(value)) return false;

  const nextSeen = new Set(seen).add(value);
  const prefix = source.slice(0, expressionIndex);
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${value.replaceAll('$', '\\$')}\\s*=`, 'gu');
  let binding = null;
  for (const match of prefix.matchAll(declaration)) binding = match;
  if (binding !== null) {
    const initializerStart = skipTrivia(prefix, binding.index + binding[0].length);
    const initializer = timeoutMessageValues(`timeoutMsg: ${prefix.slice(initializerStart)};`)[0]?.expression
      ?.replace(/;\s*$/u, '') ?? '';
    return staticStringExpression(
      source,
      initializer,
      initializerStart,
      allowedIdentifiers,
      nextSeen,
    );
  }
  if (new RegExp(`\\b(?:async\\s+)?function\\s+${value.replaceAll('$', '\\$')}\\s*\\(`, 'u').test(source)) {
    return false;
  }
  return allowedIdentifiers.has(value);
};

const unsafeTimeoutMessages = (source, allowedIdentifiers = new Set()) => (
  timeoutMessageValues(source).filter(({ expression, index }) => (
    !staticStringExpression(source, expression, index, allowedIdentifiers)
  ))
);

const matchingCallParenthesis = (source, opening) => {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source[index] === '\'' || source[index] === '"' || source[index] === '`') {
      index = skipQuotedValue(source, index) - 1;
      continue;
    }
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const waitUntilCallSpans = (source) => {
  const spans = [];
  const call = /\bwaitUntil\s*\(/gu;
  for (const match of source.matchAll(call)) {
    const opening = source.indexOf('(', match.index);
    const closing = matchingCallParenthesis(source, opening);
    if (closing > opening) spans.push({ opening, closing });
  }
  return spans;
};

const staleWaitUntilTimeoutMessages = (source) => {
  const calls = waitUntilCallSpans(source);
  return timeoutMessageValues(source).flatMap((message) => {
    const call = calls.filter(({ opening, closing }) => (
      opening < message.index && message.index < closing
    )).at(-1);
    if (call === undefined || !message.expression.startsWith('`')) return [];
    const interpolations = [...message.expression.matchAll(/\$\{([^}]+)\}/gu)]
      .map(match => match[1]);
    const identifiers = new Set(interpolations.flatMap((expression) => (
      [...expression.matchAll(/\b[$A-Z_a-z][$\w]*\b/gu)].map(match => match[0])
    )));
    const predicate = source.slice(call.opening, message.index);
    const mutableIdentifiers = [...identifiers].filter((identifier) => {
      const escaped = identifier.replaceAll('$', '\\$');
      return new RegExp(`\\b${escaped}\\s*=(?!=)`, 'u').test(predicate);
    });
    return mutableIdentifiers.length === 0 ? [] : [{ ...message, mutableIdentifiers }];
  });
};
test('every WebDriver timeout option is a stable string and failures read fresh state separately', () => {
  const ownedSources = [
    ...sourceFilesBelow(join(E2E_ROOT, 'journeys')),
    ...sourceFilesBelow(join(E2E_ROOT, 'support')),
    ...sourceFilesBelow(join(E2E_ROOT, 'scenarios')),
    join(E2E_ROOT, 'run-isolated.mjs'),
    join(E2E_ROOT, 'wdio.conf.js'),
  ];
  for (const file of ownedSources) {
    const source = readFileSync(file, 'utf8');
    const unsafe = unsafeTimeoutMessages(
      source,
      TIMEOUT_STRING_IDENTIFIER_ALLOWLIST.get(file),
    );
    assert.deepEqual(
      unsafe,
      [],
      `${file} passes a non-static string to WebdriverIO's string-only timeoutMsg option: ${unsafe.map(({ expression }) => expression).join(', ')}`,
    );
    const stale = staleWaitUntilTimeoutMessages(source);
    assert.deepEqual(
      stale,
      [],
      `${file} snapshots state that its waitUntil predicate later mutates: ${stale.map(({ mutableIdentifiers }) => mutableIdentifiers.join(',')).join(';')}`,
    );
  }
  const engines = read('e2e', 'support', 'engines.js');
  assert.match(engines, /state = await engineState\(id\);\s*throw new Error\(timeoutMessage\(state\)/u);
});

test('the timeout-message classifier rejects every executable value shape', () => {
  for (const expression of [
    '() => "callback"',
    'async () => "callback"',
    'function () { return "callback"; }',
    'async function () { return "callback"; }',
    'messageFactory()',
    'messageFactory.call(null)',
    'new String("message")',
    'callback',
  ]) {
    const declaration = expression === 'callback'
      ? 'const callback = function () { return "callback"; };\n'
      : '';
    const source = `${declaration}browser.waitUntil(check, { timeoutMsg: ${expression} });`;
    assert.equal(
      unsafeTimeoutMessages(source).length,
      1,
      `unsafe timeout message escaped classification: ${expression}`,
    );
  }
  for (const source of [
    'const timeoutMsg = () => "callback"; browser.waitUntil(check, { timeoutMsg });',
    'function timeoutMsg() { return "callback"; } browser.waitUntil(check, { timeoutMsg });',
    'browser.waitUntil(check, { "timeoutMsg": function () { return "callback"; } });',
    "browser.waitUntil(check, { 'timeoutMsg': messageFactory() });",
  ]) {
    assert.equal(
      unsafeTimeoutMessages(source).length,
      1,
      `unsafe timeout property shape escaped classification: ${source}`,
    );
  }

  const legitimate = [
    '"literal"',
    "'literal'",
    '`static template`',
    '`template with a diagnostic ${JSON.stringify(last)}`',
    '("parenthesized literal")',
    '"static " + `concatenation`',
  ];
  const source = legitimate
    .map((expression) => `browser.waitUntil(check, { timeoutMsg: ${expression} });`)
    .concat(['browser.waitUntil(check, { "timeoutMsg": "quoted key" });'])
    .join('\n');
  assert.deepEqual(unsafeTimeoutMessages(source), []);

  const stale = 'let final = null; browser.waitUntil(async () => { final = await inspect(); '
    + 'return final.ready; }, { timeoutMsg: `never ready: ${JSON.stringify(final)}` });';
  assert.equal(staleWaitUntilTimeoutMessages(stale).length, 1);
  assert.deepEqual(staleWaitUntilTimeoutMessages(
    'browser.waitUntil(check, { timeoutMsg: `stable target ${target}` });',
  ), []);
});
