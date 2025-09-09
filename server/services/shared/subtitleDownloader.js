/**
 * Service to discover and download the best available subtitle via yt-dlp
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { SUBTITLES_DIR } = require('../../config');
const { getYtDlpPath, getYtDlpArgs } = require('./ytdlpUtils');

const SITE_SUBS_DIR = path.join(SUBTITLES_DIR, 'site-extracted');
if (!fs.existsSync(SITE_SUBS_DIR)) {
  fs.mkdirSync(SITE_SUBS_DIR, { recursive: true });
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const ytDlpPath = getYtDlpPath();
    const proc = spawn(ytDlpPath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
    });
  });
}

function isYouTube(url) {
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}

async function getInfoJson(url, useCookies = false) {
  const yt = isYouTube(url);
  const clients = yt ? ['android', 'ios', 'web'] : [null];
  let lastErr;
  for (const client of clients) {
    try {
      const args = [
        ...getYtDlpArgs(useCookies),
        '--no-warnings',
        '--dump-single-json',
        '--no-playlist',
      ];
      if (yt && client) {
        args.push('--extractor-args', `youtube:player_client=${client}`);
      }
      args.push(url);
      const { stdout } = await runYtDlp(args);
      return JSON.parse(stdout);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Failed to get info JSON');
}

function expandLangPrefs(prefs) {
  const out = [];
  const seen = new Set();
  for (const p of prefs || []) {
    const variants = [p, p.split('-')[0]].filter(Boolean);
    for (const v of variants) {
      const key = v.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(key); }
    }
  }
  return out.length ? out : ['en-us', 'en', 'en-gb'];
}

function buildLangCandidates(info, preferredLangs) {
  const subs = info.subtitles || {};
  const auto = info.automatic_captions || {};
  const manualKeys = Object.keys(subs);
  const autoKeys = Object.keys(auto);

  // Detect original language candidates conservatively
  const originalSet = new Set();
  const addLang = (code) => {
    if (!code) return;
    const lc = String(code).toLowerCase();
    originalSet.add(lc);
    if (lc.includes('-')) originalSet.add(lc.split('-')[0]);
  };
  if (info.language) addLang(info.language);
  if (info.original_language) addLang(info.original_language);
  if (Array.isArray(info.audio_languages)) {
    for (const a of info.audio_languages) addLang(a);
  }

  const lcMapManual = new Map(manualKeys.map(k => [k.toLowerCase(), k]));
  const lcMapAuto = new Map(autoKeys.map(k => [k.toLowerCase(), k]));

  const seen = new Set();
  const candidates = [];

  // 1) Manual in original language first
  for (const lc of originalSet) {
    const key = lcMapManual.get(lc);
    if (key && !seen.has(key)) { candidates.push({ lang: key, source: 'manual' }); seen.add(key); }
  }
  // 2) Auto in original language
  for (const lc of originalSet) {
    const key = lcMapAuto.get(lc);
    if (key && !seen.has(key)) { candidates.push({ lang: key, source: 'auto' }); seen.add(key); }
  }
  // 3) Manual by user preference (excluding originals)
  for (const pref of preferredLangs) {
    const p = String(pref).toLowerCase();
    const key = lcMapManual.get(p) || (p.includes('-') ? lcMapManual.get(p.split('-')[0]) : undefined);
    if (key && !seen.has(key)) { candidates.push({ lang: key, source: 'manual' }); seen.add(key); }
  }
  // 4) Auto by user preference (excluding originals)
  for (const pref of preferredLangs) {
    const p = String(pref).toLowerCase();
    const key = lcMapAuto.get(p) || (p.includes('-') ? lcMapAuto.get(p.split('-')[0]) : undefined);
    if (key && !seen.has(key)) { candidates.push({ lang: key, source: 'auto' }); seen.add(key); }
  }
  // Do not add arbitrary remaining languages; only original and preferred
  return candidates;
}

function parseSrtTime(t) {
  const m = t.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
  if (!m) return 0;
  return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (+m[4]);
}
function formatSrtTime(ms) {
  if (ms < 0) ms = 0;
  const z = (n, w) => String(n).padStart(w, '0');
  const h = Math.floor(ms / 3600000); ms %= 3600000;
  const m = Math.floor(ms / 60000); ms %= 60000;
  const s = Math.floor(ms / 1000); const msr = ms % 1000;
  return `${z(h,2)}:${z(m,2)}:${z(s,2)},${z(msr,3)}`;
}
function deflapSrt(content) {
  // Split blocks by blank lines
  const blocks = content.replace(/\r\n/g, '\n').split(/\n\s*\n+/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    let idx = 0;
    // Optional numeric index line
    if (/^\d+$/.test(lines[0])) idx = 1;
    const timeLine = lines[idx] || '';
    const tm = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!tm) continue;
    const start = parseSrtTime(tm[1]);
    const end = parseSrtTime(tm[2]);
    const text = lines.slice(idx + 1).join('\n');
    cues.push({ start, end, text });
  }
  // Sort and deflap
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  const GAP = 1; // 1ms minimal gap
  const MIN_DUR = 500; // ensure at least 500ms visible
  for (let i = 1; i < cues.length; i++) {
    const prev = cues[i - 1];
    const cur = cues[i];
    if (cur.start < prev.end + GAP) {
      cur.start = prev.end + GAP;
      if (cur.end <= cur.start) cur.end = cur.start + MIN_DUR;
    }
  }
  // Rebuild SRT
  return cues.map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.text}\n`).join('\n');
}

async function downloadSubtitleOnce(url, lang, id, useCookies = false, client = null) {
  const outTemplate = path.join(SITE_SUBS_DIR, `${id}.%(ext)s`);
  const yt = isYouTube(url);
  const args = [
    ...getYtDlpArgs(useCookies),
    '--skip-download',
    '--write-sub', '--write-auto-sub',
    '--sub-langs', lang,
    '--sub-format', 'srt',
    '--convert-subs', 'srt',
    '--no-playlist',
    '--sleep-requests', '1',
    '-o', outTemplate,
    url,
  ];
  if (yt && client) {
    args.splice(args.indexOf('-o'), 0, '--extractor-args', `youtube:player_client=${client}`);
  }
  await runYtDlp(args);
  const files = fs.readdirSync(SITE_SUBS_DIR).filter(f => f.startsWith(id + '.') && f.endsWith('.srt'));
  if (!files.length) throw new Error('Subtitle file not found after download');
  const exact = files.find(f => f.toLowerCase().includes(`.${lang.toLowerCase()}.`));
  const pick = exact || files[0];
  const content = fs.readFileSync(path.join(SITE_SUBS_DIR, pick), 'utf8');
  return { fileName: pick, content };
}

async function tryDownloadSubtitle(url, lang, id, useCookies = false) {
  const yt = isYouTube(url);
  const clients = yt ? ['android', 'ios', 'web'] : [null];
  let lastErr;
  for (const client of clients) {
    try {
      return await downloadSubtitleOnce(url, lang, id, useCookies, client);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Failed to download subtitle');
}

async function downloadBestSubtitle(url, preferredLangs = [], useCookies = false) {
  const info = await getInfoJson(url, useCookies);
  const id = info.id || String(Date.now());
  const prefs = expandLangPrefs(preferredLangs);
  const candidates = buildLangCandidates(info, prefs);
  if (!candidates.length) {
    return { success: false, reason: 'NO_SUBS' };
  }
  let lastErr;
  for (const cand of candidates) {
    try {
      const { fileName, content } = await tryDownloadSubtitle(url, cand.lang, id, useCookies);
      const normalized = deflapSrt(content);
      return { success: true, id, lang: cand.lang, source: cand.source, fileName, content: normalized };
    } catch (e) {
      lastErr = e;
      // continue to next candidate
    }
  }
  return { success: false, reason: 'DOWNLOAD_FAILED', error: lastErr ? lastErr.message : 'Unknown error' };
}

module.exports = { downloadBestSubtitle };

