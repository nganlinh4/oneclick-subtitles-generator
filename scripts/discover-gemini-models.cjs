/* Read-only discovery. Never print provider error bodies, request headers, or keys. */
const fs = require('node:fs');
const { parseEnv } = require('node:util');

async function main() {
  const file = fs.existsSync('.env') ? parseEnv(fs.readFileSync('.env', 'utf8')) : {};
  const seen = new Set();
  const observations = [];
  for (let index = 1; index <= 20; index += 1) {
    const slot = index === 1 ? 'GEMINI_API_KEY' : `GEMINI_API_KEY_${index}`;
    const key = (process.env[slot] ?? file[slot] ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const observation = { slot, status: 'pending', models: [] };
    try {
      let pageToken;
      do {
        const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
        url.searchParams.set('pageSize', '1000');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const response = await fetch(url, {
          headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) { observation.status = `http-${response.status}`; break; }
        const body = await response.json();
        observation.models.push(...(body.models ?? []).filter(model =>
          model.name?.startsWith('models/gemini-')
        ).map(model => ({
          id: model.name.slice(7),
          methods: model.supportedGenerationMethods,
          inputTokenLimit: model.inputTokenLimit,
          outputTokenLimit: model.outputTokenLimit,
        })));
        pageToken = body.nextPageToken;
        observation.status = 'ok';
      } while (pageToken);
    } catch { observation.status = 'transport-error'; }
    observations.push(observation);
  }
  if (!observations.length) throw new Error('No configured Gemini credentials');
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), credentialCount: seen.size, observations }, null, 2));
}

main().catch(() => { console.error('Gemini discovery failed'); process.exitCode = 1; });
