#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const root = path.resolve(__dirname, '..');
const readFrom = (repositoryRoot, relative) => (
  fs.readFileSync(path.join(repositoryRoot, relative), 'utf8')
);

const identifiers = (source) => source
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const quotedValues = (source) => [...source.matchAll(/"([A-Za-z0-9:_-]+)"/g)]
  .map((match) => match[1]);

const uniqueSorted = (values) => [...new Set(values)].sort();

const requireMatch = (value, label) => {
  if (!value) throw new Error(`Could not parse ${label}`);
  return value;
};

const assertExactSet = (leftLabel, left, rightLabel, right) => {
  const leftValues = uniqueSorted(left);
  const rightValues = uniqueSorted(right);
  const missing = leftValues.filter((value) => !rightValues.includes(value));
  const extra = rightValues.filter((value) => !leftValues.includes(value));
  if (missing.length || extra.length) {
    throw new Error([
      `${leftLabel} and ${rightLabel} differ.`,
      missing.length ? `Missing from ${rightLabel}: ${missing.join(', ')}` : '',
      extra.length ? `Only in ${rightLabel}: ${extra.join(', ')}` : '',
    ].filter(Boolean).join('\n'));
  }
};

const INTENTIONALLY_UNWIRED_COMMANDS = new Map();

const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs']);

const resolveSourceImport = (fromFile, specifier) => {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const extension = path.extname(base);
  const candidates = extension
    ? (sourceExtensions.has(extension) ? [base] : [])
    : [
        base,
        `${base}.js`,
        `${base}.jsx`,
        `${base}.mjs`,
        `${base}.cjs`,
        path.join(base, 'index.js'),
        path.join(base, 'index.jsx'),
        path.join(base, 'index.mjs'),
        path.join(base, 'index.cjs'),
      ];
  return candidates.find((candidate) => (
    fs.existsSync(candidate) && fs.statSync(candidate).isFile()
  )) ?? null;
};

const parseSource = (filename) => parser.parse(fs.readFileSync(filename, 'utf8'), {
  sourceType: 'unambiguous',
  plugins: ['jsx', 'dynamicImport', 'importMeta'],
});

const literalImport = (node) => (
  node?.type === 'StringLiteral' ? node.value : null
);

const directBridgeNames = new Set(['invokeDesktop', 'invokeCommand']);

const analyzeFrontendCommandReachability = ({
  repositoryRoot,
  commands,
  entry = 'src/index.js',
}) => {
  const commandSet = new Set(commands);
  const references = new Map(commands.map((command) => [command, new Set()]));
  const directInvocations = new Map();
  const visited = new Set();
  const pending = [path.resolve(repositoryRoot, entry)];

  while (pending.length > 0) {
    const filename = pending.pop();
    if (visited.has(filename)) continue;
    if (!fs.existsSync(filename) || !sourceExtensions.has(path.extname(filename))) {
      throw new Error(`Production import graph contains an unreadable source module: ${filename}`);
    }
    visited.add(filename);
    const ast = parseSource(filename);
    const relative = path.relative(repositoryRoot, filename).replaceAll('\\', '/');
    const enqueue = (specifier) => {
      const resolved = resolveSourceImport(filename, specifier);
      if (resolved !== null && !visited.has(resolved)) pending.push(resolved);
    };

    traverse(ast, {
      ImportDeclaration(pathRef) {
        enqueue(pathRef.node.source.value);
      },
      ExportNamedDeclaration(pathRef) {
        if (pathRef.node.source !== null) enqueue(pathRef.node.source.value);
      },
      ExportAllDeclaration(pathRef) {
        enqueue(pathRef.node.source.value);
      },
      CallExpression(pathRef) {
        const { node } = pathRef;
        if (node.callee.type === 'Import') enqueue(literalImport(node.arguments[0]));
        if (node.callee.type === 'Identifier'
            && node.callee.name === 'require'
            && node.arguments.length === 1) {
          enqueue(literalImport(node.arguments[0]));
        }
        if (node.callee.type === 'Identifier'
            && directBridgeNames.has(node.callee.name)
            && node.arguments[0]?.type === 'StringLiteral') {
          const command = node.arguments[0].value;
          const locations = directInvocations.get(command) ?? new Set();
          locations.add(relative);
          directInvocations.set(command, locations);
        }
      },
      ImportExpression(pathRef) {
        enqueue(literalImport(pathRef.node.source));
      },
      StringLiteral(pathRef) {
        if (commandSet.has(pathRef.node.value)) references.get(pathRef.node.value).add(relative);
      },
    });
  }

  return Object.freeze({ visited, references, directInvocations });
};

const assertFrontendCommandReachability = ({ commands, analysis }) => {
  const registered = new Set(commands);
  for (const [command, locations] of analysis.directInvocations) {
    if (!registered.has(command)) {
      throw new Error(
        `Reachable frontend module invokes an unregistered Tauri command: ${command} (${[...locations].join(', ')})`,
      );
    }
  }

  const dormant = commands.filter((command) => analysis.references.get(command)?.size === 0);
  const unclassified = dormant.filter((command) => !INTENTIONALLY_UNWIRED_COMMANDS.has(command));
  if (unclassified.length > 0) {
    throw new Error(
      `Registered Tauri commands are unreachable from src/index.js: ${unclassified.join(', ')}`,
    );
  }
  for (const [command, reason] of INTENTIONALLY_UNWIRED_COMMANDS) {
    if (!registered.has(command)) {
      throw new Error(`Stale intentionally-unwired command classification: ${command}`);
    }
    if (analysis.references.get(command)?.size > 0) {
      throw new Error(`Reachable command must leave the intentionally-unwired classification: ${command}`);
    }
    if (typeof reason !== 'string' || reason.length < 40) {
      throw new Error(`Intentionally-unwired command lacks a concrete rationale: ${command}`);
    }
  }
  return dormant;
};

const run = (repositoryRoot = root) => {
  const read = (relative) => readFrom(repositoryRoot, relative);

  const lib = read('apps/desktop/src-tauri/src/lib.rs');
  const handlerBody = requireMatch(
    lib.match(/tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1],
    'the Tauri invoke handler'
  );
  const handlerCommands = identifiers(handlerBody);

  const build = read('apps/desktop/src-tauri/build.rs');
  const manifestBody = requireMatch(
    build.match(/const COMMANDS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/)?.[1],
    'the build-time command manifest'
  );
  const manifestCommands = quotedValues(manifestBody);

  const permissions = read('apps/desktop/src-tauri/permissions/app.toml');
  const allowedCommands = [...permissions.matchAll(/commands\.allow\s*=\s*\[([\s\S]*?)\]/g)]
    .flatMap((match) => quotedValues(match[1]));
  const customPermissions = [...permissions.matchAll(/identifier\s*=\s*"([A-Za-z0-9_-]+)"/g)]
    .map((match) => match[1]);

  assertExactSet('invoke handler', handlerCommands, 'build manifest', manifestCommands);
  assertExactSet('invoke handler', handlerCommands, 'custom command permissions', allowedCommands);

  const capability = JSON.parse(read('apps/desktop/src-tauri/capabilities/main.json'));
  const capabilityPermissions = capability.permissions || [];
  for (const permission of customPermissions) {
    if (!capabilityPermissions.includes(permission)) {
      throw new Error(`Main capability is missing custom permission: ${permission}`);
    }
  }

  const forbidden = ['core:default', 'core:event:allow-listen'];
  for (const permission of forbidden) {
    if (capabilityPermissions.includes(permission)) {
      throw new Error(`Main capability grants forbidden permission: ${permission}`);
    }
  }

  const tauriConfig = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'));
  const bundleIdentifier = tauriConfig.identifier;
  if (typeof bundleIdentifier !== 'string'
      || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleIdentifier)
      || bundleIdentifier.endsWith('.app')) {
    throw new Error('Tauri must use a stable reverse-domain bundle identifier that does not end in .app');
  }
  const nativeDropEnabled = tauriConfig.app?.windows?.some(
    (window) => window.dragDropEnabled === true
  );
  if (nativeDropEnabled && !capabilityPermissions.includes('core:event:deny-listen')) {
    throw new Error('Native drag/drop requires core:event:deny-listen to keep raw paths out of the WebView');
  }

  const analysis = analyzeFrontendCommandReachability({
    repositoryRoot,
    commands: handlerCommands,
  });
  const intentionallyUnwired = assertFrontendCommandReachability({
    commands: handlerCommands,
    analysis,
  });

  console.log(
    `Tauri command contract passed: ${handlerCommands.length} commands, ${customPermissions.length} custom permissions, ${analysis.visited.size} reachable frontend modules, ${intentionallyUnwired.length} explicitly classified delivery commands.`,
  );
};

if (require.main === module) run();

module.exports = {
  INTENTIONALLY_UNWIRED_COMMANDS,
  analyzeFrontendCommandReachability,
  assertFrontendCommandReachability,
  run,
};
