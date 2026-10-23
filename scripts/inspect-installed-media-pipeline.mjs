import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { CdpClient, discoverTarget } from './inspect-installed-webview.mjs';
import { PIPELINE_EXPRESSION } from './installed-media-pipeline/expression.mjs';
import {
  assertMediaPipelineResult,
  summarizeMediaPipelineResult,
} from './installed-media-pipeline/guards.mjs';
import { DEFAULT_TIMEOUT_MS, invariant } from './installed-media-pipeline/shared.mjs';

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(/^--[a-z-]+$/.test(key ?? '') && value !== undefined,
      'Usage: inspect-installed-media-pipeline.mjs --port PORT --expected-source-name NAME');
    invariant(!values.has(key), `Duplicate argument: ${key}`);
    values.set(key, value);
  }
  invariant(values.size === 2, 'Only reviewed installed media-pipeline arguments are accepted');
  const port = Number(values.get('--port'));
  invariant(Number.isInteger(port) && port >= 1_024 && port <= 65_535,
    'DevTools port must be an unprivileged TCP port');
  const expectedSourceName = values.get('--expected-source-name');
  invariant(typeof expectedSourceName === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mp4$/.test(expectedSourceName),
  'Expected media-pipeline source name is invalid');
  return Object.freeze({ port, expectedSourceName });
}

const evaluate = async (client, expression) => {
  const evaluation = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  invariant(!evaluation.exceptionDetails,
    'Installed media-pipeline evaluation failed inside the WebView');
  return evaluation.result?.value;
};

async function runInstalledMediaPipeline(options) {
  const target = await discoverTarget(options.port);
  const client = new CdpClient(target.webSocketDebuggerUrl, DEFAULT_TIMEOUT_MS);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    const result = await evaluate(client, PIPELINE_EXPRESSION);
    assertMediaPipelineResult(result, options.expectedSourceName);
    return summarizeMediaPipelineResult(result);
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => runInstalledMediaPipeline(parseArguments(process.argv.slice(2))))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error
        ? error.message
        : 'Installed media pipeline inspection failed'}\n`);
      process.exitCode = 1;
    });
}
