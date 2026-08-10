'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  analyzeFrontendCommandReachability,
} = require('./check-tauri-command-contract');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');

const FORBIDDEN_TRANSPORTS = Object.freeze([
  {
    id: 'browser-oauth-provider',
    pattern: /https?:\/\/(?:accounts\.google\.com\/o\/oauth2(?:\/v2)?\/auth|oauth2\.googleapis\.com\/token)(?:[/?#"'`\s]|$)/gi,
    message: 'browser OAuth provider endpoint',
  },
  {
    id: 'browser-oauth-secret-storage',
    pattern: /(?:localStorage|sessionStorage)(?:\?\.|\.)setItem\s*\(\s*["'`]youtube_(?:client_id|client_secret|oauth_token)["'`]/gi,
    message: 'browser OAuth credential or token persistence',
  },
  {
    id: 'direct-gemini-provider',
    pattern: /(?:generativelanguage|aiplatform)\.googleapis\.com/gi,
    message: 'direct Gemini provider origin',
  },
  {
    id: 'legacy-localhost-service',
    pattern: /(?:https?|wss?):\/\/localhost(?::\d+)?/gi,
    message: 'localhost service origin',
  },
  {
    id: 'legacy-loopback-websocket',
    pattern: /wss?:\/\/127\.0\.0\.1(?::\d+)?/gi,
    message: 'loopback WebSocket origin',
  },
  {
    id: 'legacy-fixed-loopback-port',
    pattern: /127\.0\.0\.1:(?:3031|3032|3033|3035|3036|3037|3038|8000)\b/gi,
    message: 'retired fixed loopback service port',
  },
  {
    id: 'webview-capability-byte-fetch',
    pattern: /\bfetch\s*\(\s*(?:[A-Za-z_$][\w$]*\.)?(?:audioSrc|audioUrl|currentSource|outputPath|playbackUrl)\b/gi,
    message: 'WebView byte fetch of a host-issued media capability',
  },
  {
    id: 'webview-capability-xhr',
    pattern: /\.open\s*\(\s*["'`](?:GET|HEAD)["'`]\s*,\s*(?:[A-Za-z_$][\w$]*\.)?(?:audioSrc|audioUrl|currentSource|outputPath|playbackUrl)\b/gi,
    message: 'WebView XHR of a host-issued media capability',
  },
  {
    id: 'legacy-api-route',
    pattern: /["'`]\/api(?:\/|(?=["'`]))/g,
    message: 'legacy /api route',
  },
  {
    id: 'direct-provider-image',
    pattern: /https?:\/\/(?:(?:[A-Za-z0-9-]+\.)+genius\.com(?:[/:]|$)|genius\.com\/[^"'`\s?#]+\.(?:avif|gif|jpe?g|png|webp)(?:[?#][^"'`\s]*)?|(?:[A-Za-z0-9-]+\.)*(?:ytimg\.com|ggpht\.com)(?:[/:]|$)|img\.youtube\.com(?:[/:]|$))/gi,
    message: 'direct Genius/YouTube image origin',
  },
]);

const FORBIDDEN_WEB_ARTIFACTS = Object.freeze(new Map([
  ['oauth2callback.html', {
    id: 'browser-oauth-callback-artifact',
    message: 'retired browser OAuth callback artifact',
  }],
]));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function walkWebArtifacts(directory) {
  const files = [];
  const pending = [directory];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && /\.(?:css|html|js|mjs)$/.test(entry.name)) {
        files.push(candidate);
      }
    }
  }

  return files.sort();
}

function countMatches(source, pattern) {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(source) !== null) count += 1;
  pattern.lastIndex = 0;
  return count;
}

function inspectReachableWebViewTransports(repositoryRoot = REPOSITORY_ROOT) {
  const analysis = analyzeFrontendCommandReachability({
    repositoryRoot,
    commands: [],
  });
  const violations = [];
  const patterns = [
    { id: 'raw-fetch', pattern: /\bfetch\s*\(/g },
    { id: 'raw-xhr', pattern: /\bnew\s+XMLHttpRequest\s*\(/g },
  ];
  for (const file of analysis.visited) {
    const source = fs.readFileSync(file, 'utf8');
    for (const transport of patterns) {
      const count = countMatches(source, transport.pattern);
      if (count > 0) {
        violations.push({
          file: path.relative(repositoryRoot, file).replaceAll('\\', '/'),
          id: transport.id,
          count,
        });
      }
    }
  }
  return { moduleCount: analysis.visited.size, violations };
}

function assertReachableWebViewTransportBoundary(repositoryRoot = REPOSITORY_ROOT) {
  const report = inspectReachableWebViewTransports(repositoryRoot);
  const details = report.violations
    .map(({ file, id, count }) => `${file}: ${id} (${count})`)
    .join('; ');
  invariant(
    report.violations.length === 0,
    `Reachable frontend bypasses the guarded browser transport: ${details}`,
  );
  return report;
}

function inspectProductionTransport(buildDirectory) {
  invariant(fs.existsSync(buildDirectory), `Production build directory is missing: ${buildDirectory}`);
  invariant(fs.statSync(buildDirectory).isDirectory(),
    `Production build path is not a directory: ${buildDirectory}`);

  const files = walkWebArtifacts(buildDirectory);
  invariant(
    files.some((file) => /\.(?:js|mjs)$/.test(file)),
    `Production build contains no JavaScript artifacts: ${buildDirectory}`,
  );

  const violations = [];
  for (const file of files) {
    const relativeFile = path.relative(buildDirectory, file).replaceAll('\\', '/');
    const forbiddenArtifact = FORBIDDEN_WEB_ARTIFACTS.get(path.basename(file).toLowerCase());
    if (forbiddenArtifact) {
      violations.push({
        file: relativeFile,
        id: forbiddenArtifact.id,
        message: forbiddenArtifact.message,
        count: 1,
      });
    }

    const source = fs.readFileSync(file, 'utf8');
    for (const transport of FORBIDDEN_TRANSPORTS) {
      const count = countMatches(source, transport.pattern);
      if (count > 0) {
        violations.push({
          file: relativeFile,
          id: transport.id,
          message: transport.message,
          count,
        });
      }
    }
  }

  return { fileCount: files.length, violations };
}

function assertProductionTransportBoundary(buildDirectory) {
  const report = inspectProductionTransport(buildDirectory);
  const details = report.violations
    .map(({ file, message, count }) => `${file}: ${message} (${count})`)
    .join('; ');
  invariant(
    report.violations.length === 0,
    `Production web artifacts cross the native transport boundary: ${details}`,
  );
  return report;
}

function parseArguments(argv) {
  let buildDirectory = path.join(REPOSITORY_ROOT, 'build');
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--build-directory') {
      const value = argv[index + 1];
      invariant(value && !value.startsWith('--'), '--build-directory requires a path');
      buildDirectory = path.resolve(REPOSITORY_ROOT, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { buildDirectory };
}

function main() {
  try {
    const { buildDirectory } = parseArguments(process.argv.slice(2));
    const report = assertProductionTransportBoundary(buildDirectory);
    const sourceReport = assertReachableWebViewTransportBoundary();
    console.log(
      `Production transport boundary passed (${report.fileCount} web artifacts; ${sourceReport.moduleCount} reachable source modules).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  FORBIDDEN_TRANSPORTS,
  FORBIDDEN_WEB_ARTIFACTS,
  assertProductionTransportBoundary,
  assertReachableWebViewTransportBoundary,
  inspectProductionTransport,
  inspectReachableWebViewTransports,
  parseArguments,
};
