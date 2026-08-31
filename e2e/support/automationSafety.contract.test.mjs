import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

/* global DOMException, URL */

const E2E_ROOT = join(import.meta.dirname, '..');
const REPOSITORY_ROOT = join(E2E_ROOT, '..');
const read = (...parts) => readFileSync(join(REPOSITORY_ROOT, ...parts), 'utf8');
const CANONICAL_E2E_FRONTEND_BUILD = 'node scripts/build-e2e-frontend.js';
const CANONICAL_E2E_BUILD = 'node scripts/build-e2e-binary.js';

const MANAGED_STAGING_ENVIRONMENT = Object.freeze([
  'OSG_E2E_CACHE_ROOT',
  'OSG_E2E_CACHE_ROOT_ID',
  'OSG_E2E_STAGING_ROOT',
  'OSG_E2E_STAGING_LEASE_ID',
  'OSG_E2E_STAGING_LEASE_OWNER_PID',
  'OSG_E2E_STAGING_LEASE_OWNER_CREATED_UTC',
  'OSG_E2E_RUN_ROOT_AUTHORIZATION',
]);

const assertManagedStagingNativeContract = (source) => {
  for (const variable of MANAGED_STAGING_ENVIRONMENT) {
    assert.ok(source.includes(`"${variable}"`), `native guard does not require ${variable}`);
  }
  for (const marker of [
    '.osg-development-cache.json',
    '.osg-cache-entry.json',
    '.osg-cache-lease',
    '.osg-e2e-staging-parent',
    '.osg-e2e-staging-authority.json',
    '.osg-e2e-authority',
  ]) {
    assert.ok(source.includes(marker), `native guard does not validate ${marker}`);
  }
  assert.ok(source.includes('data root is not one ordinary direct child of the managed staging lane'));
  assert.ok(source.includes('the isolated run does not match its exact active managed staging lease'));
  assert.ok(source.includes('verify_live_process_creation_identity('));
  assert.ok(source.includes('managed staging lease owner PID was reused'));
  assert.ok(source.includes('Duration::from_secs(5)'));
  assert.doesNotMatch(source, /validate_harness_environment\([\s\S]*?std::env::temp_dir\(\)/u);
};

const assertFreshFrontendBeforeCargo = (build, source = read('scripts', 'build-e2e-binary.js')) => {
  assert.equal(build, CANONICAL_E2E_BUILD, (
    'the canonical E2E binary must use the exact frontend-then-Cargo command chain'
  ));
  const lease = source.indexOf('lease = acquireE2eLease(');
  const frontend = source.indexOf('const frontend = buildFrontend(', lease);
  const cargo = source.indexOf("command: 'cargo'", frontend);
  const publication = source.indexOf('const published = publishApplication(', cargo);
  const verification = source.indexOf('const application = verifyApplication(', publication);
  const release = source.indexOf('releaseE2eLease(', verification);
  assert.ok(
    lease >= 0
      && frontend > lease
      && cargo > frontend
      && publication > cargo
      && verification > publication
      && release > verification,
    'the canonical E2E binary must lease, build frontend, build Cargo, publish, verify, then release',
  );
  assert.match(source, /TAURI_CONFIG:\s*tauriOverride/u);
  // frontendDist must go through the shared override helper: Tauri parses an absolute Windows
  // path as a URL, which embeds nothing, so only the validated relative form is acceptable.
  assert.match(
    source,
    /frontendDist:\s*tauriFrontendDistOverride\(repository,\s*frontend\.snapshotRoot\)/u,
  );
  assert.match(source, /cacheRoot:\s*lease\.frontendCacheRoot/u);
  assert.match(source, /'--target-dir',\s*cargoTargetDir/u);
  assert.match(source, /applicationsCacheRoot:\s*lease\.appPublicationRoot/u);
  assert.match(source, /readAndVerifyE2eApplicationReceipt/u);
  assert.doesNotMatch(source, /target[/\\]e2e-automation/u);
};

const assertStableE2eFrontendBuild = (build, source = read('scripts', 'build-e2e-frontend.js')) => {
  assert.equal(build, CANONICAL_E2E_FRONTEND_BUILD, (
    'the E2E frontend must use the exact reproducible-metadata-then-Vite command chain'
  ));
  assert.match(source, /collectStrictReproducibleGitInfo/u);
  assert.match(source, /publishFrontendSnapshot/u);
  assert.match(source, /OSG_E2E_VERSION_MODULE/u);
  assert.doesNotMatch(source, /syncTreeContent|src[/\\]config[/\\]version\.js/u);
};

const assertCanonicalApplicationBinarySource = (source) => {
  assert.match(
    source,
    /export const E2E_APPLICATIONS_CACHE_ROOT = join\(DEVELOPMENT_CACHE_ROOT, 'apps', 'e2e'\);/u,
  );
  assert.match(source, /readAndVerifyE2eApplicationReceipt\(\{\s*applicationsCacheRoot: E2E_APPLICATIONS_CACHE_ROOT,\s*\}\)/su);
  assert.match(source, /export const BUILT_APPLICATION_DIRECTORY = publicationAtModuleLoad\?\.applicationRoot[\s\S]*?UNPUBLISHED_APPLICATION_DIRECTORY/u);
  assert.match(source, /export const APPLICATION_BINARY = stagedApplicationOverride[\s\S]*?publicationAtModuleLoad\?\.binaryPath[\s\S]*?BUILT_APPLICATION_DIRECTORY/u);
  assert.match(source, /const current = readVerifiedCurrentPublishedApplication\(\);/u);
  assert.match(source, /readCleanGitSourceProvenance/u);
  assert.match(source, /source\.commit !== currentSource\.commit/u);
  assert.match(source, /source\.tree !== currentSource\.tree/u);
  assert.match(source, /assertApplicationLaunchSource\(binary\);/u);
  assert.match(source, /assertStagedApplicationBinary\(stagedApplicationOverride\)/u);
  assert.doesNotMatch(
    source,
    /REPOSITORY_ROOT[\s\S]{0,120}'target'[\s\S]{0,120}'e2e-automation'/u,
    'the hidden harness must not retain a repository-target binary fallback',
  );
};

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

const journeySources = () => readdirSync(join(E2E_ROOT, 'journeys'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.journey.js'))
  .map((entry) => ({
    name: entry.name,
    source: readFileSync(join(E2E_ROOT, 'journeys', entry.name), 'utf8'),
  }));

const sourceFilesBelow = (root) => {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:js|mjs)$/u.test(entry.name) && !/\.test\.m?js$/u.test(entry.name)) files.push(path);
    }
  };
  visit(root);
  return files;
};

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

test('every active E2E launch route reaches the guarded embedded-driver configuration', () => {
  const package_ = JSON.parse(read('e2e', 'package.json'));
  const rootPackage = JSON.parse(read('package.json'));
  const desktopPackage = JSON.parse(read('apps', 'desktop', 'package.json'));
  const scripts = Object.entries(package_.scripts);
  for (const [name, command] of [
    ...Object.entries(rootPackage.scripts),
    ...Object.entries(desktopPackage.scripts),
  ]) {
    assert.doesNotMatch(
      command,
      /test-installed-windows|test-signed-updater-windows|test-native-picker-evidence/u,
      `${name} exposes a CI-only interactive desktop smoke as a local package command`,
    );
  }
  for (const [name, command] of scripts) {
    assert.doesNotMatch(
      command,
      /diagnostics[\\/]direct-driver/u,
      `${name} resurrects the retired external-driver harness`,
    );
    assert.doesNotMatch(
      command,
      /\bwdio\s+run\b/u,
      `${name} bypasses the leased isolated parent runner`,
    );
  }
  assert.equal(package_.scripts.recon,
    'node run-isolated.mjs journeys/reconnaissance.journey.js');
  assert.equal('probe:restore' in package_.scripts, false,
    'a stale nonexistent restore probe remained an advertised launch route');
  const defaultBuild = package_.scripts.test.indexOf('node ../scripts/build-e2e-binary.js');
  const defaultJourney = package_.scripts.test.indexOf(
    'node run-isolated.mjs journeys/startup.journey.js journeys/defaultFont.journey.js',
  );
  assert.ok(
    defaultBuild >= 0 && defaultJourney > defaultBuild,
    'the default real-binary test must publish an exact managed application before launching journeys',
  );

  const config = read('e2e', 'wdio.conf.js');
  assert.equal(
    config.match(/^\s*driverProvider:\s*'embedded'/gmu)?.length ?? 0,
    2,
    'both the launcher and worker must select the embedded provider',
  );
  assert.match(
    config,
    /'tauri:options':\s*\{[\s\S]*?driverProvider:\s*'embedded'[\s\S]*?\},\s*'wdio:tauriServiceOptions'/u,
  );
  assert.match(
    config,
    /'wdio:tauriServiceOptions':\s*\{[\s\S]*?driverProvider:\s*'embedded'[\s\S]*?embeddedPort:/u,
  );
  assert.match(config, /assertAutomationDialogGuard\(APPLICATION_BINARY\)/u);
  const receiptVerification = config.indexOf('readInheritedApplicationLease({');
  const leasedVerification = config.indexOf(
    'assertAutomationDialogGuard(APPLICATION_BINARY)',
    receiptVerification,
  );
  const applicationCapability = config.indexOf('application: APPLICATION_BINARY');
  assert.ok(
    receiptVerification >= 0
      && leasedVerification > receiptVerification
      && applicationCapability > leasedVerification,
    'the child must validate inherited immutable provenance before the service can spawn',
  );
  assert.match(config, /leasedPublication\.binaryPath, APPLICATION_BINARY/u);
  assert.match(config, /leasedPublication\.applicationRoot, BUILT_APPLICATION_DIRECTORY/u);
  assert.match(config, /basename\(leasedPublication\.applicationRoot\) !== leasedPublication\.applicationHash/u);
  assert.match(
    config,
    /readInheritedApplicationLease/u,
    'workers and private damaged-install copies must validate the outer-owned publication lease',
  );
  assert.doesNotMatch(
    config,
    /cachedRealVideo|cachedSourceSwitchVideo|verifiedLongSyntheticMedia|copyFileSync/u,
    'every WDIO config load, including damaged-install runs, must remain persistent-cache read-only',
  );
  assert.match(config, /process\.env\.OSG_E2E_MEDIA_SELECTION \?\? null/u);
  assert.match(
    config,
    /onComplete:[\s\S]*?downloadFixtureOrigin\.close\(\)/u,
    'launcher-owned network resources must remain live through session teardown',
  );
  assert.match(config, /Object\.assign\(process\.env,\s*isolationEnvironment\(runRoot\)\)/u);
  assert.match(config, /await waitForAutomationWindowIsolation\(\)/u);
  assert.match(
    config,
    /if \(!canReuseRunRoot\(\{ environment: process\.env, workerProcess: isWdioWorker \}\)\)[\s\S]*?throw new Error[\s\S]*?const runRoot = process\.env\.OSG_E2E_DATA_ROOT[\s\S]*?attachRunRootCaches\(\{ root: runRoot \}\)/u,
    'the child must refuse instead of creating an unleased run root',
  );

  const isolatedRunner = read('e2e', 'run-isolated.mjs');
  const maintenanceBatch = isolatedRunner.indexOf('createE2eCacheMaintenanceBatch()');
  const outerLease = isolatedRunner.indexOf('cacheMaintenance.withLeases(', maintenanceBatch);
  const outerVerify = isolatedRunner.indexOf('readVerifiedCurrentPublishedApplication()', outerLease);
  const supervisedLaunch = isolatedRunner.indexOf('runSupervisedSync({', outerVerify);
  const evidenceFinalization = isolatedRunner.indexOf('finalizeWorkflowEvidence({', supervisedLaunch);
  assert.ok(
    maintenanceBatch >= 0
      && outerLease > maintenanceBatch
      && outerVerify > outerLease
      && supervisedLaunch > outerVerify
      && evidenceFinalization > supervisedLaunch,
    'the batched runner must own app/staging/evidence leases through supervised WDIO and final evidence',
  );

  const multiProcessRunner = read('e2e', 'support', 'twoProcessScenario.js');
  assert.match(multiProcessRunner, /OSG_E2E_REUSE_ROOT:\s*'1'/u);
  assert.match(
    multiProcessRunner,
    /OSG_E2E_RUN_ROOT_AUTHORIZATION:\s*runRootAuthorization\(root\)/u,
  );

  for (const [runner, commandPattern] of [
    [isolatedRunner, /\[WDIO,\s*'run',\s*CONFIG,\s*'--spec'/u],
    [read('e2e', 'support', 'twoProcessScenario.js'), /\[WDIO,\s*'run',\s*'wdio\.conf\.js',\s*'--spec'/u],
    [read('e2e', 'scenarios', 'damagedFontPayload.mjs'), /\[WDIO,\s*'run',\s*'wdio\.conf\.js',\s*'--spec'/u],
  ]) {
    assert.match(runner, /runSupervisedSync\(\{/u, 'a child launch may outlive its lease owner');
    assert.match(runner, commandPattern, 'a child launch bypasses wdio.conf.js');
  }
  assert.match(
    read('e2e', 'scenarios', 'damagedFontPayload.mjs'),
    /withScenarioLeases\([\s\S]*?beginWorkflowEvidence\([\s\S]*?runSupervisedSync\([\s\S]*?finalizeWorkflowEvidence\(/u,
    'damaged-install app, staging, and evidence must remain leased through supervised finalization',
  );
  const twoProcessScenario = read('e2e', 'support', 'twoProcessScenario.js');
  assert.match(
    twoProcessScenario,
    /runScenarioAttemptWithEvidence[\s\S]*?resetWorkflowEvidence\(workflow, \{[\s\S]*?applicationHash: publication\.applicationHash,[\s\S]*?binaryPath: publication\.binaryPath[\s\S]*?withScenarioLeases[\s\S]*?runScenarioAttemptWithEvidence\(\{[\s\S]*?publication/u,
  );
  for (const [label, source, expected] of [
    ['two-process support', twoProcessScenario, 2],
    ['multi-window ASR', read('e2e', 'scenarios', 'multiWindowAsrPersistence.mjs'), 0],
    ['long-media recovery', read('e2e', 'scenarios', 'longMediaOperationRecovery.mjs'), 0],
  ]) {
    const resets = [...source.matchAll(/resetWorkflowEvidence\(workflow, \{([\s\S]*?)\}\)/gu)];
    assert.equal(resets.length, expected, `${label} has an unexpected evidence-reset surface`);
    for (const reset of resets) {
      assert.match(reset[1], /applicationHash: publication\.applicationHash/u, label);
      assert.match(reset[1], /binaryPath: publication\.binaryPath/u, label);
    }
  }
  assert.match(
    twoProcessScenario,
    /runScenarioAttemptWithEvidence[\s\S]*?resetWorkflowEvidence[\s\S]*?operation\(\)[\s\S]*?preserveRunRootEvidence[\s\S]*?finalizeWorkflowEvidence/u,
    'scenario evidence must begin before staging and preserve the root before finalization',
  );
  for (const file of ['multiWindowAsrPersistence.mjs', 'longMediaOperationRecovery.mjs']) {
    assert.match(
      read('e2e', 'scenarios', file),
      /runScenarioAttemptWithEvidence\(\{[\s\S]*?operation:\s*\(\)\s*=>[\s\S]*?copyFileSync/u,
      `${file} must begin its durable attempt before custom fixture staging`,
    );
  }
  assert.match(
    isolatedRunner,
    /beginWorkflowEvidence\(\{[\s\S]*?applicationHash: publication\.applicationHash,[\s\S]*?binaryPath: publication\.binaryPath/u,
  );
  const damagedFont = read('e2e', 'scenarios', 'damagedFontPayload.mjs');
  assert.match(
    damagedFont,
    /describeStagedApplicationDerivative\(\{[\s\S]*?expectedPath: damaged\.path,[\s\S]*?beginWorkflowEvidence\(\{[\s\S]*?applicationHash: publication\.applicationHash,[\s\S]*?applicationDerivative: derivative,[\s\S]*?binaryPath: binary/u,
  );
  for (const file of [
    'nativeToolsInstall.mjs',
    'settingsNarrationModelManagement.mjs',
    'settingsToolsRemoveAndFactoryReset.mjs',
    'multiWindowAsrPersistence.mjs',
    'longMediaOperationRecovery.mjs',
  ]) {
    const source = read('e2e', 'scenarios', file);
    const calls = [...source.matchAll(/runScenarioProcesses\(\{([\s\S]*?)\n\s*\}\);/gu)];
    assert.ok(calls.length > 0, `${file} has no supervised scenario call`);
    for (const call of calls) {
      assert.match(call[1], /\bpublication\b/u, `${file} dropped publication provenance`);
    }
  }

  const installedSmoke = read('scripts', 'test-installed-windows.ps1');
  const installerPackageReceipt = read('scripts', 'installer-package-receipt.js');
  const updaterSmoke = read('scripts', 'test-signed-updater-windows.ps1');
  assert.ok(
    installedSmoke.indexOf("if ($env:CI -ne 'true')")
      < installedSmoke.indexOf('Start-Process -FilePath $installer'),
    'the installed-app desktop smoke must refuse local execution before launching anything',
  );
  assert.match(installerPackageReceipt, /readCleanGitSourceProvenance\(\{ repositoryRoot \}\)/u);
  const installStart = installedSmoke.indexOf('$installed = Install-Application');
  const postInstallReceipt = installedSmoke.indexOf('if ($PublishPackageReceipt) {', installStart);
  const firstApplicationLaunch = installedSmoke.indexOf('$first = Start-And-WaitForReadiness');
  const preInstallConsumptionReceipt = installedSmoke.indexOf("} else {\n  $receiptJson = & node");
  const installerLaunch = installedSmoke.indexOf('Start-Process -FilePath $installer');
  const cleanPublicationOutputs = installedSmoke.indexOf(
    "throw 'Installer package receipt publication paths must be clean'",
  );
  const requiredSigningKey = installedSmoke.indexOf(
    "throw 'Installer package receipt publication requires the Tauri updater signing key'",
  );
  const postInstallReceiptFailure = installedSmoke.indexOf(
    "throw 'Installed application payload does not match the signed immutable installer package receipt'",
  );
  const signingKeyCapture = installedSmoke.indexOf(
    '$receiptSigningPrivateKey = $env:TAURI_SIGNING_PRIVATE_KEY',
  );
  const initialSigningEnvironmentClear = installedSmoke.indexOf(
    '\nClear-ReceiptSigningEnvironment\n', signingKeyCapture,
  );
  const publicationSigningRestore = installedSmoke.indexOf(
    '$env:TAURI_SIGNING_PRIVATE_KEY = $receiptSigningPrivateKey', postInstallReceipt,
  );
  const postPublicationSigningClear = installedSmoke.indexOf(
    '\n    Clear-ReceiptSigningEnvironment\n', publicationSigningRestore,
  );
  assert.ok(
    installedSmoke.indexOf('if ($PublishPackageReceipt)') >= 0
      && installerLaunch >= 0
      && installedSmoke.indexOf('if ($PublishPackageReceipt)') < installerLaunch
      && cleanPublicationOutputs >= 0
      && cleanPublicationOutputs < installerLaunch
      && requiredSigningKey >= 0
      && requiredSigningKey < installerLaunch,
    'receipt publication must require clean outputs and the updater signing key before installing',
  );
  assert.ok(
    signingKeyCapture >= 0
      && initialSigningEnvironmentClear > signingKeyCapture
      && initialSigningEnvironmentClear < installerLaunch
      && publicationSigningRestore > installStart
      && postPublicationSigningClear > publicationSigningRestore
      && postPublicationSigningClear < firstApplicationLaunch
      && installedSmoke.includes('Remove-Item Env:\\TAURI_SIGNING_PRIVATE_KEY_PASSWORD'),
    'the installer and application must never inherit the updater receipt-signing secret',
  );
  assert.ok(
    installStart >= 0
      && postInstallReceipt > installStart
      && installedSmoke.indexOf('--publish true', postInstallReceipt) > postInstallReceipt
      && firstApplicationLaunch > postInstallReceipt
      && postInstallReceiptFailure > postInstallReceipt
      && postInstallReceiptFailure < firstApplicationLaunch,
    'publication mode must inventory and authenticate the complete generated install before app launch',
  );
  assert.ok(
    preInstallConsumptionReceipt >= 0
      && preInstallConsumptionReceipt < installedSmoke.indexOf('Start-Process -FilePath $installer'),
    'consumption mode must authenticate the source-bound package receipt before installing',
  );
  assert.match(installedSmoke, /publisher = 'osg-installed-production-evidence'/u);
  assert.match(installedSmoke, /installerSha256 = \$installerSha256/u);
  assert.match(installedSmoke, /journeys = @\('installedGolden'\)/u);
  assert.ok(
    updaterSmoke.indexOf("$env:GITHUB_ACTIONS -ne 'true'")
      < updaterSmoke.indexOf('$server = Start-Process'),
    'the updater desktop smoke must refuse local execution before launching anything',
  );
});

test('the fast E2E profile has one canonical nonshipping build and cannot replace release', () => {
  const cargo = read('Cargo.toml');
  const desktopCargo = read('apps', 'desktop', 'src-tauri', 'Cargo.toml');
  const rootPackage = JSON.parse(read('package.json'));
  const environment = read('e2e', 'support', 'environment.js');
  const inventory = JSON.parse(read('e2e', 'inventory.json'));
  const releaseProfile = /\[profile\.release\]([\s\S]*?)(?=\n\[|$)/u.exec(cargo)?.[1] ?? '';
  const e2eProfile = /\[profile\.e2e\]([\s\S]*?)(?=\n\[|$)/u.exec(cargo)?.[1] ?? '';
  assert.match(releaseProfile, /codegen-units\s*=\s*1/u);
  assert.match(releaseProfile, /lto\s*=\s*"fat"/u);
  assert.match(releaseProfile, /opt-level\s*=\s*"z"/u);
  assert.match(e2eProfile, /inherits\s*=\s*"release"/u);
  assert.match(e2eProfile, /codegen-units\s*=\s*16/u);
  assert.match(e2eProfile, /incremental\s*=\s*true/u);
  assert.match(e2eProfile, /lto\s*=\s*false/u);
  assert.match(e2eProfile, /opt-level\s*=\s*2/u);
  assert.match(desktopCargo, /crate-type\s*=\s*\["rlib"\]/u);
  assert.doesNotMatch(desktopCargo, /crate-type\s*=\s*\[[^\]]*(?:staticlib|cdylib)/u);

  const build = rootPackage.scripts['build:e2e-binary'];
  const binaryBuilder = read('scripts', 'build-e2e-binary.js');
  assertFreshFrontendBeforeCargo(build);
  assert.equal(
    rootPackage.scripts['build:frontend:e2e'],
    undefined,
    'a frontend-only E2E command could publish bytes that no guarded binary consumes',
  );
  assertStableE2eFrontendBuild(CANONICAL_E2E_FRONTEND_BUILD);
  assert.equal(
    rootPackage.scripts['test:e2e-frontend-publication'],
    'node --test scripts/e2e-build-metadata.test.js scripts/e2e-frontend-snapshot.test.js '
      + 'scripts/build-e2e-frontend.test.js',
    'the immutable frontend publication regressions must remain directly runnable',
  );
  for (const required of [
    /'-p',\s*'osg-desktop'/u,
    /'--bin',\s*'osg-desktop'/u,
    /'--profile',\s*CARGO_PROFILE/u,
    /'--features',\s*'e2e-automation'/u,
    /'--target',\s*TARGET_TRIPLE/u,
    /'--target-dir',\s*cargoTargetDir/u,
    /'--jobs',\s*'1'/u,
    /'--locked'/u,
  ]) assert.match(binaryBuilder, required, `E2E build command is missing ${required}`);
  assert.doesNotMatch(binaryBuilder, /--release|profile\.release/u);
  assertCanonicalApplicationBinarySource(environment);
  const applicationLease = read('e2e', 'support', 'applicationLease.js');
  const cacheMaintenance = read('e2e', 'support', 'cacheMaintenance.js');
  const evidenceLease = read('e2e', 'support', 'evidenceLease.js');
  const workflowEvidence = read('e2e', 'support', 'workflowEvidence.js');
  const isolatedRunner = read('e2e', 'run-isolated.mjs');
  const staging = read('e2e', 'support', 'stageApplication.js');
  assert.match(applicationLease, /acquireManagedE2eLease/u);
  assert.match(applicationLease, /releaseManagedE2eLease/u);
  assert.match(applicationLease, /applicationsCacheRoot = E2E_APPLICATIONS_CACHE_ROOT/u);
  assert.match(applicationLease, /lease\.assetCacheRoot, E2E_ASSET_CACHE_ROOT/u);
  assert.match(applicationLease, /protectApplication:\s*true/u);
  assert.match(applicationLease, /protectE2e:\s*false/u);
  assert.match(staging, /applicationLease[\s\S]*?stagingLease[\s\S]*?readVerifiedPublishedApplication\(\)[\s\S]*?copyVerifiedTree[\s\S]*?readVerifiedPublishedApplication\(\)/u);
  assert.match(environment, /export const E2E_ASSET_CACHE_ROOT = join\(DEVELOPMENT_CACHE_ROOT, 'assets', 'e2e'\);/u);
  assert.match(environment, /export const EVIDENCE_CACHE_ROOT = join\(DEVELOPMENT_CACHE_ROOT, 'evidence'\);/u);
  assert.match(workflowEvidence, /WORKFLOW_EVIDENCE_ROOT = evidenceRootForProcess\(\)/u);
  assert.match(workflowEvidence, /defaultEvidenceRoot = \(\) => join\(developmentCacheRoot\(\), 'evidence'\)/u);
  assert.match(workflowEvidence, /if \(requested === undefined\) return defaultEvidenceRoot\(\)/u);
  assert.doesNotMatch(workflowEvidence, /from '.\/environment\.js'/u);
  assert.match(evidenceLease, /'-Lane', 'evidence'/u);
  assert.match(evidenceLease, /'-LeaseOperation', 'Release'/u);
  assert.match(evidenceLease, /'-Action', 'Prune', '-Apply', '-Confirm:\$false', '-ProtectUnit', 'apps-e2e'/u);
  assert.match(
    isolatedRunner,
    /createE2eCacheMaintenanceBatch\(\)[\s\S]*?cacheMaintenance\.withLeases\([\s\S]*?beginWorkflowEvidence\([\s\S]*?runSupervisedSync\([\s\S]*?finalizeWorkflowEvidence\(/u,
    'the runner must retain every cache lease from provenance through supervised evidence finalization',
  );
  assert.match(
    cacheMaintenance,
    /withApplicationLease\([\s\S]*?if \(!preflightComplete\) \{[\s\S]*?prune\(\)[\s\S]*?withStaging\([\s\S]*?withEvidence\([\s\S]*?operation\([\s\S]*?cacheMaintenance: 'external'[\s\S]*?cacheMaintenance: 'external'[\s\S]*?cacheMaintenance: 'external'/u,
    'one reviewed batch must retain all three leases while suppressing only their duplicate prunes',
  );
  assert.match(
    cacheMaintenance,
    /settleWithPostPrune\([\s\S]*?operation: run[\s\S]*?if \(applicationAcquired\) prune\(\)/u,
    'the boundary prune must run only after the full reverse lease unwind',
  );
  for (const child of [
    'native-tools', 'engine-packages', 'real-media', 'source-switch-media',
    'four-window-asr-media',
  ]) {
    assert.match(
      environment,
      new RegExp(`E2E_ASSET_CACHE_ROOT,\\s*'${child}'`, 'u'),
      `${child} is not rooted in the managed external asset lane`,
    );
  }
  assert.doesNotMatch(
    environment,
    /REPOSITORY_ROOT,\s*'target',\s*'e2e-(?:native-tools|engine-packages|real-media|source-switch-media|asr-media)'/u,
  );
  assert.doesNotMatch(workflowEvidence, /REPOSITORY_ROOT,\s*'target',\s*'workflow-evidence'/u);
  assert.equal(
    inventory.binary.e2e,
    'npm run build:e2e-binary publishes the guarded nonshipping E2E application into the managed '
      + 'external cache; every launch holds the apps/e2e cache lease while re-verifying '
      + 'receipts/current.json, its immutable manifest, exact inventory and every file digest, '
      + 'with no repository-target fallback',
  );

  for (const workflow of ['rewrite-ci.yml', 'updater-smoke.yml']) {
    assert.doesNotMatch(
      read('.github', 'workflows', workflow),
      /e2e-automation|--profile e2e/u,
      `${workflow} substituted the hidden-test profile for a release build`,
    );
  }
});

test('the canonical E2E command rejects stale or post-Cargo frontend builds', () => {
  assert.doesNotThrow(() => assertFreshFrontendBeforeCargo(
    CANONICAL_E2E_BUILD,
  ));
  for (const weakened of [
    'cargo build --profile e2e',
    'cargo build --profile e2e && npm run build:frontend:e2e',
    'npm run build:vite && cargo build --profile e2e',
  ]) {
    assert.throws(() => assertFreshFrontendBeforeCargo(weakened), /exact frontend-then-Cargo/u);
  }
  assert.doesNotThrow(() => assertStableE2eFrontendBuild(
    CANONICAL_E2E_FRONTEND_BUILD,
  ));
  for (const weakened of [
    'npm run build:vite',
    'npm run generate:version && npm run build:vite',
    'npm run build:vite && npm run generate:version -- --reproducible',
  ]) {
    assert.throws(() => assertStableE2eFrontendBuild(weakened), /exact reproducible-metadata/u);
  }
  assert.throws(() => assertFreshFrontendBeforeCargo(
    `echo ${CANONICAL_E2E_BUILD} && cargo build`,
  ), /exact frontend-then-Cargo/u);
  const environment = read('e2e', 'support', 'environment.js');
  assert.throws(() => assertCanonicalApplicationBinarySource(environment.replace(
    'publicationAtModuleLoad?.binaryPath',
    "join(REPOSITORY_ROOT, 'target', 'release', 'osg-desktop.exe')",
  )), /APPLICATION_BINARY/u);
});

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

test('no unattended journey can activate fullscreen, move a native window, or open another app', () => {
  const forbidden = [
    /requestFullscreen\s*\(/u,
    /webkitRequestFullScreen\s*\(/u,
    /webkitRequestFullscreen\s*\(/u,
    /mozRequestFullScreen\s*\(/u,
    /msRequestFullscreen\s*\(/u,
    /fullscreenWindow\s*\(/u,
    /maximizeWindow\s*\(/u,
    /minimizeWindow\s*\(/u,
    /setWindowRect\s*\(/u,
    /setWindowPosition\s*\(/u,
    /setWindowSize\s*\(/u,
    /showOpenFilePicker\s*\(/u,
    /showSaveFilePicker\s*\(/u,
    /showDirectoryPicker\s*\(/u,
    /showPicker\s*\(/u,
    /window\.open\s*\(/u,
    /openExternal\s*\(/u,
    /input\s*\[\s*type\s*=\s*['"]?file/iu,
    /\.hidden-file-input\b/u,
  ];
  for (const { name, source } of journeySources()) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${name} contains unattended native-surface action ${pattern}`);
    }
  }

  const fullscreenJourney = read('e2e', 'journeys', 'mainPreviewControlsAndFullscreen.journey.js');
  assert.match(fullscreenJourney, /executed:\s*false/u);
  assert.match(fullscreenJourney, /assert\.equal\(state\.fullscreen\.active,\s*false/u);
});

test('the compiled automation boundary owns dialogs, off-screen placement, and isolated data', () => {
  const dialogPaths = read('apps', 'desktop', 'src-tauri', 'src', 'dialog_paths.rs');
  const automationWindow = read('apps', 'desktop', 'src-tauri', 'src', 'automation_window.rs');
  const application = read('apps', 'desktop', 'src-tauri', 'src', 'lib.rs');
  const legacyImport = read('apps', 'desktop', 'src-tauri', 'src', 'legacy_import.rs');
  const desktopState = read('apps', 'desktop', 'src-tauri', 'src', 'state.rs');
  const externalLinks = read('apps', 'desktop', 'src-tauri', 'src', 'external_links.rs');
  const providers = read('apps', 'desktop', 'src-tauri', 'src', 'providers.rs');
  const download = read('apps', 'desktop', 'src-tauri', 'src', 'download.rs');
  const downloadPlan = read('crates', 'osg-download', 'src', 'plan.rs');
  const updater = read('apps', 'desktop', 'src-tauri', 'src', 'updater.rs');
  const isolatedRunner = read('e2e', 'run-isolated.mjs');
  const environment = read('e2e', 'support', 'environment.js');
  const automationEnvironment = read('e2e', 'support', 'automationEnvironment.js');
  const capability = JSON.parse(read('apps', 'desktop', 'src-tauri', 'capabilities', 'main.json'));
  const productionConfig = read('apps', 'desktop', 'src-tauri', 'tauri.conf.json');

  assert.match(dialogPaths, /#\[cfg\(feature = "e2e-automation"\)\][\s\S]*?fn staged_media_selection/u);
  assert.match(dialogPaths, /automation_dialog_refused\(\)/u);
  assert.match(automationWindow, /window\s*\.set_focusable\(false\)/u);
  assert.match(automationWindow, /window\s*\.set_position\(/u);
  assert.match(automationWindow, /virtual_desktop_bounds/u);
  assert.match(automationWindow, /AUTOMATION_BROWSER_ARGUMENTS:\s*&str\s*=\s*"--mute-audio"/u);
  assert.match(automationWindow, /AUTOMATION_INTERACTION_GUARD_SCRIPT/u);
  assert.match(automationWindow, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/u);
  assertManagedStagingNativeContract(automationWindow);
  for (const variable of MANAGED_STAGING_ENVIRONMENT.slice(0, -1)) {
    assert.match(environment, new RegExp(`${variable}:`, 'u'));
  }
  const wdio = read('e2e', 'wdio.conf.js');
  const stagingAuthority = wdio.indexOf('managedStagingEnvironment(runRoot)');
  const driverBinding = wdio.indexOf('createGuardedWebDriverBinding({');
  assert.ok(stagingAuthority >= 0 && driverBinding > stagingAuthority);
  assert.match(
    automationWindow,
    /for child in \[\s*"data", "cache", "logs", "webview", "evidence", "input", "output",?\s*\]/u,
  );
  assert.match(automationWindow, /input\[type="file"\]/u);
  assert.match(automationWindow, /requestFullscreen/u);
  assert.doesNotMatch(productionConfig, /--mute-audio|OSG_E2E/u);
  assert.match(application, /#\[cfg\(not\(feature = "e2e-automation"\)\)\][\s\S]*?tauri_plugin_window_state/u);
  const runStart = application.indexOf('pub fn run() {');
  const preflight = application.indexOf('automation_window::require_harness_environment()', runStart);
  const ciFixture = application.indexOf('ci_updater_fixture::initialize_from_process_arguments()', runStart);
  const builder = application.indexOf('let builder = tauri::Builder::default()', runStart);
  assert.ok(runStart >= 0 && preflight > runStart && preflight < ciFixture && preflight < builder);
  assert.match(application, /let browser_arguments = Some\(automation_window::automation_browser_arguments\(\)\)/u);
  assert.doesNotMatch(
    automationWindow,
    /remote-debugging|append_automation_browser_arguments/u,
    'the automation browser argument set must be closed rather than extending ambient arguments',
  );
  assert.match(application, /initialization_script\(\s*automation_window::AUTOMATION_INTERACTION_GUARD_SCRIPT/u);
  assert.match(
    externalLinks,
    /#\[cfg\(feature = "e2e-automation"\)\][\s\S]*?The automation build refused to open another desktop application\./u,
  );
  assert.match(
    providers,
    /youtube_oauth_authorize[\s\S]*?#\[cfg\(feature = "e2e-automation"\)\][\s\S]*?The automation build refused to open another desktop application\./u,
  );
  assert.match(
    updater,
    /if cfg!\(any\(\s*feature = "unsigned-local-build",\s*feature = "e2e-automation"\s*\)\)[\s\S]*?UpdateChannelState::Disabled/u,
  );
  assert.match(isolatedRunner, /scrubAutomationEnvironment\(environment\)/u);
  assert.match(automationEnvironment, /!key\.startsWith\('WEBVIEW2_'\)/u);
  assert.match(automationEnvironment, /!key\.startsWith\('OSG_E2E_'\)/u);
  assert.match(environment, /export \{ scrubAutomationEnvironment \} from '.\/automationEnvironment\.js'/u);
  assert.deepEqual(
    capability.permissions.filter((permission) => permission.startsWith('core:window:')),
    ['core:window:allow-show'],
    'the WebView may reveal its already-isolated surface, but may not focus, move, maximize, or fullscreen it',
  );
  assert.deepEqual(
    capability.permissions.filter((permission) => /^(?:dialog|opener):/u.test(permission)),
    [],
    'the WebView must not call the native dialog or external-opener plugins directly',
  );
  for (const source of [
    read('crates', 'osg-asr', 'src', 'process.rs'),
    read('crates', 'osg-download', 'src', 'process.rs'),
    read('crates', 'osg-media', 'src', 'process.rs'),
    read('crates', 'osg-speech', 'src', 'session.rs'),
  ]) {
    assert.match(source, /const CREATE_NO_WINDOW:\s*u32\s*=\s*0x0800_0000/u);
    assert.match(source, /\.creation_flags\(CREATE_NO_WINDOW\)/u);
  }

  const automationAuthorityVariables = [
    '__WDIO_TAURI_APP_BINARY__',
    '__WDIO_TAURI_EMBEDDED__',
    'OSG_E2E_REUSE_ROOT',
    'OSG_E2E_CACHE_ROOT',
    'OSG_E2E_CACHE_ROOT_ID',
    'OSG_E2E_RUN_ROOT_AUTHORIZATION',
    'OSG_E2E_STAGING_LEASE_ID',
    'OSG_E2E_STAGING_LEASE_OWNER_CREATED_UTC',
    'OSG_E2E_STAGING_LEASE_OWNER_PID',
    'OSG_E2E_STAGING_ROOT',
    'OSG_E2E_WEBDRIVER_AUTHORIZATION',
    'OSG_E2E_WEBDRIVER_IDENTITY',
    'OSG_E2E_WEBDRIVER_RUN_ROOT',
    'REMOTE_WEBDRIVER_URL',
    'TAURI_WEBDRIVER_PORT',
    'WDIO_EMBEDDED_SERVER',
    'WDIO_WORKER_ID',
  ];
  const nativeChildLaunchers = [
    {
      label: 'downloader',
      source: read('crates', 'osg-download', 'src', 'process.rs'),
      construction: 'let mut command = Command::new(request.binary);',
      removal: 'remove_automation_authority_environment(&mut command);',
      spawn: 'let child = spawn_group(&mut command)?;',
      behaviorTest: 'fn downloader_process_drops_automation_authority()',
    },
    {
      label: 'media tool',
      source: read('crates', 'osg-media', 'src', 'process.rs'),
      construction: 'let mut command = Command::new(binary.path());',
      removal: 'remove_automation_authority_environment(&mut command);',
      spawn: 'let child = spawn_group(&mut command, tool)?;',
      behaviorTest: 'fn media_tool_process_drops_automation_authority()',
    },
    {
      label: 'speech worker',
      source: read('crates', 'osg-speech', 'src', 'worker.rs'),
      construction: 'let mut command = Command::new(native_process_path(self.program.executable())?);',
      removal: 'remove_automation_authority_environment(&mut command);',
      spawn: 'let child = spawn_group(&mut command)?;',
      behaviorTest: 'fn speech_worker_drops_automation_authority()',
    },
  ];
  for (const launcher of nativeChildLaunchers) {
    for (const variable of automationAuthorityVariables) {
      assert.match(
        launcher.source,
        new RegExp(`"${variable}"`, 'u'),
        `${launcher.label} does not remove ${variable}`,
      );
    }
    const construction = launcher.source.indexOf(launcher.construction);
    const removal = launcher.source.indexOf(launcher.removal, construction);
    const spawn = launcher.source.indexOf(launcher.spawn, removal);
    assert.ok(
      construction >= 0 && removal > construction && spawn > removal,
      `${launcher.label} must drop automation authority before its native process can spawn`,
    );
    assert.ok(
      launcher.source.includes(launcher.behaviorTest)
        && /command\s*\.get_envs\(\)\s*\.any\(\|\(key, value\)\|/u.test(launcher.source)
        && /value\.is_none\(\)/u.test(launcher.source),
      `${launcher.label} lacks a behavior test for inherited automation authority`,
    );
  }

  const asrProgram = read('crates', 'osg-asr', 'src', 'program.rs');
  const asrProcess = read('crates', 'osg-asr', 'src', 'process.rs');
  assert.match(
    asrProgram,
    /pub\(crate\) fn command\(&self\) -> Command[\s\S]*?apply_sanitized_environment\(&mut command\);[\s\S]*?command/u,
    'the ASR command must sanitize its inherited environment before it is returned to the spawner',
  );
  const asrSanitizer = asrProgram.match(
    /fn apply_sanitized_environment\(command: &mut Command\) \{[\s\S]*?\n\}/u,
  )?.[0] ?? '';
  assert.match(asrSanitizer, /command\.env_clear\(\);/u, 'ASR must clear its ambient environment');
  for (const variable of automationAuthorityVariables) {
    assert.doesNotMatch(
      asrSanitizer,
      new RegExp(`"${variable}"`, 'u'),
      `ASR must not re-add ${variable} after clearing inherited state`,
    );
  }
  assert.match(
    asrProcess,
    /let mut command = program\.command\(\);[\s\S]*?\.creation_flags\(CREATE_NO_WINDOW\)[\s\S]*?\.spawn\(\)/u,
    'the ASR spawner must only launch the sanitized WorkerProgram command',
  );
  assert.match(environment, /WEBVIEW2_USER_DATA_FOLDER:\s*join\(root, 'webview'\)/u);
  assert.match(environment, /OSG_E2E_FIXTURE_ROOT:\s*root/u);
  assert.match(environment, /OSG_E2E_OFFSCREEN_WINDOW:\s*'1'/u);
  assert.match(
    legacyImport,
    /let local_data = match crate::harness_data_root\(\)[\s\S]*?Some\(root\) => root\.join\("data"\)[\s\S]*?None => app[\s\S]*?app_local_data_dir/u,
    'legacy-import locking must not bypass the isolated native data root',
  );
  assert.match(
    desktopState,
    /#\[cfg\(feature = "e2e-automation"\)\]\s*pub\(crate\) type DesktopCredentialBackend = Arc<SessionCredentialBackend>;/u,
    'automation credentials must remain process-memory-only and never reach the OS keyring',
  );
  assert.match(
    desktopState,
    /#\[cfg\(feature = "e2e-automation"\)\]\s*let credentials\s*=\s*CredentialService::new\([\s\S]*SessionCredentialBackend::new\(\)/u,
    'automation state must instantiate the in-memory credential backend',
  );

  const inspectStart = download.indexOf('pub(crate) async fn download_inspect(');
  const cookieGuard = download.indexOf(
    'let cookies = resolve_browser_cookie_source(request.cookie_source)?;',
    inspectStart,
  );
  const engineResolution = download.indexOf('let engine = runtime.engine()', inspectStart);
  const engineInspection = download.indexOf(
    'engine.inspect(&url, inspection_cookies, &control)', inspectStart,
  );
  assert.ok(inspectStart >= 0, 'download_inspect is missing');
  assert.ok(
    cookieGuard > inspectStart && cookieGuard < engineResolution && cookieGuard < engineInspection,
    'automation must resolve cookie authority before resolving or invoking the downloader',
  );
  assert.match(
    download,
    /#\[cfg\(feature = "e2e-automation"\)\]\s*fn resolve_browser_cookie_source\([\s\S]*?if request == CookieSourceRequest::None[\s\S]*?AUTOMATION_COOKIE_FILE_ENV[\s\S]*?AutomationCookieFile::new[\s\S]*?AUTOMATION_BROWSER_PROFILE_ENV[\s\S]*?refused access to a live browser profile[\s\S]*?AutomationBrowserProfile::new/u,
    'the E2E binary must substitute only a typed file or disposable browser-profile authority',
  );
  assert.match(
    downloadPlan,
    /#\[cfg\(feature = "e2e-automation"\)\][\s\S]*?pub struct AutomationCookieFile\(PathBuf\)[\s\S]*?join\("input"\)[\s\S]*?!file\.starts_with\(&input\)[\s\S]*?AutomationCookieFile\(<redacted>\)/u,
    'the automation cookie authority must stay under fixture input and redact its path',
  );
  assert.match(
    downloadPlan,
    /pub struct AutomationBrowserProfile[\s\S]*?browser: BrowserCookieSource[\s\S]*?join\("input"\)[\s\S]*?!profile\.starts_with\(&input\)[\s\S]*?AutomationBrowserProfile[\s\S]*?"<redacted>"/u,
    'the automation browser authority must stay under fixture input and redact its path',
  );
});

test('the managed-staging native contract fails closed when one cross-language field drifts', () => {
  const source = read('apps', 'desktop', 'src-tauri', 'src', 'automation_window.rs');
  assertManagedStagingNativeContract(source);
  for (const variable of MANAGED_STAGING_ENVIRONMENT) {
    assert.throws(
      () => assertManagedStagingNativeContract(source.replaceAll(variable, `${variable}_DRIFTED`)),
      new RegExp(variable, 'u'),
    );
  }
});

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

test('the compiled WebDriver server is identified, session-bound, and has no interactive window route', () => {
  const cargo = read('apps', 'desktop', 'src-tauri', 'Cargo.toml');
  const cargoLock = read('Cargo.lock');
  const application = read('apps', 'desktop', 'src-tauri', 'src', 'lib.rs');
  const automationWindow = read('apps', 'desktop', 'src-tauri', 'src', 'automation_window.rs');
  const plugin = read('vendor', 'tauri-plugin-wdio-webdriver', 'src', 'lib.rs');
  const server = read('vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'mod.rs');
  const router = read('vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'router.rs');
  const sessions = read(
    'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'handlers', 'session.rs',
  );
  const status = read(
    'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'handlers', 'mod.rs',
  );
  const windows = read(
    'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'handlers', 'window.rs',
  );
  const executor = read(
    'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'platform', 'executor.rs',
  );
  const navigation = read(
    'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'handlers', 'navigation.rs',
  );
  const config = read('e2e', 'wdio.conf.js');
  const installedService = read(
    'e2e', 'node_modules', '@wdio', 'tauri-service', 'dist', 'esm', 'index.js',
  );
  const installedNativeUtils = read(
    'e2e', 'node_modules', '@wdio', 'native-utils', 'dist', 'esm', 'index.js',
  );
  const vendoredLicense = read('vendor', 'tauri-plugin-wdio-webdriver', 'LICENSE');

  assert.match(
    cargo,
    /tauri-plugin-wdio-webdriver\s*=\s*\{\s*path\s*=\s*"\.\.\/\.\.\/\.\.\/vendor\/tauri-plugin-wdio-webdriver",\s*optional\s*=\s*true\s*\}/u,
  );
  assert.match(cargo, /^production\s*=\s*\["tauri\/custom-protocol"\]\s*$/mu);
  assert.match(
    cargo,
    /^e2e-automation\s*=\s*\[[\s\S]*?"dep:tauri-plugin-wdio-webdriver"[\s\S]*?"dep:tauri-plugin-wdio"[\s\S]*?\]\s*$/mu,
  );
  const automationFeature = /^e2e-automation\s*=\s*\[([\s\S]*?)^\]\s*$/mu.exec(cargo)?.[1];
  assert.notEqual(automationFeature, undefined, 'the automation feature declaration is missing');
  assert.match(automationFeature, /"tauri\/custom-protocol"/u);
  assert.doesNotMatch(
    automationFeature,
    /unsigned-local-build|tauri\/devtools/u,
    'the hidden automation graph may not compile a DevTools window surface',
  );
  assert.match(
    application,
    /#\[cfg\(all\(feature = "production", feature = "e2e-automation"\)\)\]\s*compile_error!\("the production and e2e-automation channels are mutually exclusive"\);/u,
    'a production feature graph must be structurally unable to include automation hooks',
  );
  assert.match(
    application,
    /#\[cfg\(all\(feature = "unsigned-local-build", feature = "e2e-automation"\)\)\]\s*compile_error!\("the unsigned-local-build and e2e-automation channels are mutually exclusive"\);/u,
    'an automation feature graph must be structurally unable to include DevTools',
  );
  assert.match(
    application,
    /#\[cfg\(all\(feature = "ci-updater-fixture", feature = "e2e-automation"\)\)\]\s*compile_error!\("the ci-updater-fixture and e2e-automation channels are mutually exclusive"\);/u,
    'an automation feature graph must be structurally unable to inherit fixture browser arguments',
  );
  assert.match(cargo, /\[features\]\s*default = \[\]\s*production = \["tauri\/custom-protocol"\]/u);
  assert.match(
    cargo,
    /e2e-automation = \[[\s\S]*?"dep:tauri-plugin-wdio-webdriver"[\s\S]*?"dep:tauri-plugin-wdio"[\s\S]*?\]/u,
  );
  assert.equal(
    createHash('sha256').update(vendoredLicense).digest('hex'),
    '20c84663dbfa685b230f362509fdbaea7819f5da166afea9857c4d96dcc7e0bc',
    'the exact upstream MIT license must remain in the vendored source snapshot',
  );
  const lockedPlugin = /\[\[package\]\]\s*name = "tauri-plugin-wdio-webdriver"[\s\S]*?(?=\n\[\[package\]\]|$)/u
    .exec(cargoLock)?.[0];
  assert.notEqual(lockedPlugin, undefined, 'the vendored automation plugin is absent from Cargo.lock');
  assert.doesNotMatch(
    lockedPlugin,
    /\n(?:source|checksum) = /u,
    'Cargo.lock must resolve the patched plugin as a local path package',
  );
  assert.match(application, /#\[cfg\(feature = "e2e-automation"\)\][\s\S]*?init_with_window_guard/u);
  assert.match(plugin, /IDENTITY_ENV_VAR:\s*&str\s*=\s*"OSG_E2E_WEBDRIVER_IDENTITY"/u);
  assert.match(plugin, /value\.len\(\)\s*==\s*64/u);
  assert.doesNotMatch(plugin, /unwrap_or\(DEFAULT_PORT\)|DEFAULT_PORT:\s*u16/u);
  assert.match(server, /pub fn enforce_window_guard/u);
  assert.match(router, /from_fn_with_state\([\s\S]*?enforce_native_window_guard::<R>/u);
  assert.doesNotMatch(router, /\.route\(\s*"\/wdio\/eval"/u, 'sessionless eval is forbidden');
  assert.doesNotMatch(router, /\.route\(\s*"\/session\/\{session_id\}\/print"/u);
  assert.equal(
    existsSync(join(REPOSITORY_ROOT, 'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'handlers', 'direct_eval.rs')),
    false,
    'the unauthenticated direct-eval handler must not remain as dormant vendored code',
  );
  assert.equal(
    existsSync(join(REPOSITORY_ROOT, 'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'handlers', 'print.rs')),
    false,
    'the native print handler must not remain as dormant vendored code',
  );
  assert.match(
    executor,
    /el\.tagName === 'INPUT' && el\.type === 'file'[\s\S]*refuses file-input activation/u,
    'standard element click must not activate a native file input',
  );
  assert.ok(
    (executor.match(/refuses file-input mutation/gu)?.length ?? 0) >= 2,
    'clear and send-keys must both refuse file-input mutation',
  );
  assert.doesNotMatch(
    navigation,
    /executor\.(?:navigate|go_back|go_forward|refresh)\s*\(/u,
    'WebDriver navigation must not bypass the product external-surface guard',
  );
  assert.match(navigation, /refuses top-level navigation/u);
  assert.match(navigation, /refuses history navigation/u);
  assert.match(navigation, /refuses document reload/u);

  // Every W3C window route is named here. Context switching and reads do not touch HWND state;
  // creation is already an unsupported stub, close only destroys the existing isolated window,
  // and every surface mutation is an explicit refusal handler.
  for (const route of [
    '/session/{session_id}/window',
    '/session/{session_id}/window/new',
    '/session/{session_id}/window/handles',
    '/session/{session_id}/window/rect',
    '/session/{session_id}/window/maximize',
    '/session/{session_id}/window/minimize',
    '/session/{session_id}/window/fullscreen',
  ]) {
    assert.match(router, new RegExp(route.replaceAll(/[{}]/gu, '\\$&'), 'u'), `missing route audit: ${route}`);
  }
  assert.match(windows, /Creating new windows is not supported in this context/u);
  assert.match(windows, /window\s*\.destroy\(\)/u);
  assert.doesNotMatch(windows, /window\s*\.(?:show|set_focusable|set_position|maximize|minimize|set_fullscreen)\s*\(/u);
  assert.doesNotMatch(
    windows,
    /executor\.(?:set_window_rect|maximize_window|minimize_window|fullscreen_window)\s*\(/u,
  );
  for (const refusal of ['position and size', 'maximization', 'minimization', 'fullscreen']) {
    assert.match(windows, new RegExp(`refuses native-window ${refusal}`, 'u'));
  }
  assert.match(sessions, /state\.authorizes\(received_authorization\)/u);
  const sessionCreate = sessions.indexOf('pub async fn create');
  const authorizationExtraction = sessions.indexOf('extract_authorization(', sessionCreate);
  const authorizationCheck = sessions.indexOf('state.authorizes(', authorizationExtraction);
  const windowWait = sessions.indexOf('wait_for_window(', authorizationCheck);
  const webviewEvaluation = sessions.indexOf('.evaluate_js(', windowWait);
  const sessionAllocation = sessions.indexOf('sessions.create(', webviewEvaluation);
  assert.ok(
    sessionCreate >= 0
      && authorizationExtraction > sessionCreate
      && authorizationCheck > authorizationExtraction
      && windowWait > authorizationCheck
      && webviewEvaluation > windowWait
      && sessionAllocation > webviewEvaluation,
    'authorization must succeed before the server waits on, evaluates, or allocates a WebView session',
  );
  assert.match(sessions, /"osg:e2eAuthorization"/u);
  assert.match(sessions, /"setWindowRect":\s*false/u);
  assert.match(sessions, /"osg:e2eIdentity":\s*state\.identity\.as_str\(\)/u);
  assert.match(sessions, /"osg:e2eProcessId":\s*std::process::id\(\)/u);
  assert.doesNotMatch(status, /authorization/iu, 'the public status endpoint must not reveal session authorization');
  assert.match(config, /'osg:e2eAuthorization':\s*webdriverBinding\.authorization/u);
  assert.match(config, /beforeSession:[\s\S]*?verifyGuardedWebDriverStatus/u);
  assert.match(config, /assertGuardedWebDriverSession\(\s*browser\.capabilities/u);
  assert.match(config, /beforeCommand:[\s\S]*?assertWebDriverCommandIsNonInteractive/u);
  assert.match(config, /captureBackendLogs:\s*true/u);
  assert.match(config, /backendLogLevel:\s*'trace'/u);
  assert.match(config, /^\s*logLevel:\s*'warn'/mu);
  assert.match(config, /logLevels:\s*\{\s*'tauri-service:service':\s*'trace'\s*\}/u);
  assert.match(
    config,
    /const handle = await browser\.getWindowHandle\(\);\s*await browser\.switchToWindow\(handle\);/u,
    'the one existing browsing context must be explicit before any journey command',
  );
  assert.match(
    installedService,
    /if \(isEmbedded\) \{[\s\S]*?return originalExecute\(script, \.\.\.args\);/u,
    'embedded browser.execute must use the authenticated W3C session, not direct eval',
  );
  assert.match(
    installedService,
    /userSwitchedWindowCache\.has\(browser\.sessionId \|\| 'default'\)[\s\S]*?return;/u,
    'the pinned service must suppress its direct-eval focus discovery after the explicit switch',
  );
  assert.equal(
    installedService.match(/Skipping auto-focus: user has explicitly switched windows/gu)?.length,
    1,
    'focus suppression must be logged once at its transition, never once per WebDriver command',
  );
  const focusTransition = installedService.slice(
    installedService.indexOf('function suppressActiveWindowFocus('),
    installedService.indexOf('function isInternalWindowSwitch('),
  );
  const focusRecovery = installedService.slice(
    installedService.indexOf('async function ensureActiveWindowFocus('),
    installedService.indexOf('async function getCurrentWebviewWindowLabel('),
  );
  assert.match(focusTransition, /Skipping auto-focus/u);
  assert.doesNotMatch(focusRecovery, /Skipping auto-focus/u);
  assert.match(
    installedNativeUtils,
    /const waitUntilWindowAvailable = async \(browser\)[\s\S]*?browser\.getWindowHandles\(\)/u,
    'service initialization must use a standard authenticated W3C route',
  );

  assert.match(automationWindow, /window\.set_skip_taskbar\(true\)/u);
  assert.match(automationWindow, /window\.is_focused\(\)\?/u);
  assert.match(automationWindow, /window\.is_fullscreen\(\)/u);
  assert.match(automationWindow, /window\.is_maximized\(\)/u);
  assert.match(application, /WindowEvent::Moved\(_\)[\s\S]*?WindowEvent::Focused\(true\)[\s\S]*?automation_window::isolate/u);
  assert.match(
    application,
    /#\[cfg\(not\(feature = "e2e-automation"\)\)\]\s*if has_saved_main_window_state\(app\)/u,
    'automation may not even read the live window-state profile',
  );
  const isolateStart = automationWindow.indexOf('pub(crate) fn isolate(');
  const nonFocusable = automationWindow.indexOf('.set_focusable(false)', isolateStart);
  const visibilityRead = automationWindow.indexOf('let was_visible =', isolateStart);
  const repairHide = automationWindow.indexOf('window.hide()?', visibilityRead);
  const unfullscreen = automationWindow.indexOf('window.set_fullscreen(false)?', repairHide);
  const unmaximize = automationWindow.indexOf('window.unmaximize()?', unfullscreen);
  const moveOffscreen = automationWindow.indexOf('window.set_position(', unmaximize);
  const repairShow = automationWindow.indexOf('window.show()?', moveOffscreen);
  assert.ok(
    isolateStart >= 0
      && nonFocusable > isolateStart
      && visibilityRead > nonFocusable
      && repairHide > visibilityRead
      && unfullscreen > repairHide
      && unmaximize > unfullscreen
      && moveOffscreen > unmaximize
      && repairShow > moveOffscreen,
    'a hostile window state must become non-focusable, hide, normalize, move fully off-screen, and only then reappear',
  );
});

test('all owned automation processes are hidden and all runtime sources refuse desktop surfaces', () => {
  const runtimeFiles = [
    ...sourceFilesBelow(join(E2E_ROOT, 'journeys')),
    ...sourceFilesBelow(join(E2E_ROOT, 'scenarios')),
    ...sourceFilesBelow(join(E2E_ROOT, 'support')),
    join(E2E_ROOT, 'run-isolated.mjs'),
    join(E2E_ROOT, 'wdio.conf.js'),
  ];
  const forbiddenCalls = [
    /requestFullscreen\s*\(/u,
    /fullscreenWindow\s*\(/u,
    /maximizeWindow\s*\(/u,
    /minimizeWindow\s*\(/u,
    /newWindow\s*\(/u,
    /setWindowRect\s*\(/u,
    /setWindowPosition\s*\(/u,
    /setWindowSize\s*\(/u,
    /showOpenFilePicker\s*\(/u,
    /showSaveFilePicker\s*\(/u,
    /showDirectoryPicker\s*\(/u,
    /window\.open\s*\(/u,
    /openExternal\s*\(/u,
    /browser\.tauri\.execute\s*\(/u,
  ];

  for (const path of new Set(runtimeFiles)) {
    const source = readFileSync(path, 'utf8');
    for (const pattern of forbiddenCalls) {
      assert.doesNotMatch(source, pattern, `${path} contains interactive call ${pattern}`);
    }
    const childCalls = source.match(/\b(?:execFileSync|execSync|spawnSync|spawn)\s*\(/gu)?.length ?? 0;
    const hiddenOptions = source.match(/windowsHide:\s*true/gu)?.length ?? 0;
    assert.ok(
      hiddenOptions >= childCalls,
      `${path} starts ${childCalls} child process(es) but supplies only ${hiddenOptions} hidden options`,
    );
  }

  const main = read('apps', 'desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /cfg_attr\(not\(debug_assertions\), windows_subsystem = "windows"\)/u);
  const config = read('e2e', 'wdio.conf.js');
  assert.match(config, /saveScreenshot\(/u, 'failure evidence must come from the WebView compositor');
  assert.doesNotMatch(config, /desktopCapturer|PrintWindow|BitBlt|computer-use/iu);
});
