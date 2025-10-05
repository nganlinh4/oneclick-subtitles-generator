// Cleanup duplicate keys in JSON locale files, preserving the FIRST occurrence of each key.
// Usage: node scripts/cleanup-locale.js <path1> <path2> ...
// Overwrites files in-place (no backups).

const fs = require('fs');
const path = require('path');

function cleanupFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  const lines = original.split(/\r?\n/);

  const startIdx = lines.findIndex(l => l.trim().startsWith('{'));
  const endIdx = (() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().endsWith('}')) return i;
    }
    return lines.length - 1;
  })();
  if (startIdx === -1 || endIdx <= startIdx) {
    console.error(`[cleanup] Skipping ${filePath}: not a simple JSON object`);
    return false;
  }

  const seen = new Set();
  const kept = [];

  // Keep head up to and including the '{' line
  for (let i = 0; i <= startIdx; i++) kept.push(lines[i]);

  // Process body lines
  for (let i = startIdx + 1; i < endIdx; i++) {
    const line = lines[i];
    const m = line.match(/^[\s\t]*"([^"]+)"\s*:/);
    if (m) {
      const key = m[1];
      if (!seen.has(key)) {
        seen.add(key);
        kept.push(line);
      } else {
        // duplicate -> drop
      }
    } else {
      // Non key line (likely blank) -> keep
      if (line.trim() !== '') kept.push(line);
    }
  }

  // Ensure last property has no trailing comma
  // Find last non-empty line before '}'
  let lastIdx = kept.length - 1;
  while (lastIdx >= 0 && kept[lastIdx].trim() === '') lastIdx--;
  if (lastIdx >= 0) {
    const lastLine = kept[lastIdx];
    // If the next line in original was the closing brace or we'll append it now, normalize comma
    const trimmed = lastLine.replace(/,\s*$/, '');
    kept[lastIdx] = trimmed;
  }

  // Append closing '}' and anything after
  kept.push(lines[endIdx]);
  for (let i = endIdx + 1; i < lines.length; i++) kept.push(lines[i]);

  const cleaned = kept.join('\n');

  fs.writeFileSync(filePath, cleaned, 'utf8');
  console.log(`[cleanup] Cleaned ${filePath}`);
  return true;
}

function listJsonFiles(targetPath) {
  const stats = fs.statSync(targetPath);
  if (stats.isDirectory()) {
    const files = [];
    const entries = fs.readdirSync(targetPath);
    for (const entry of entries) {
      const full = path.join(targetPath, entry);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        files.push(...listJsonFiles(full));
      } else if (st.isFile() && full.toLowerCase().endsWith('.json')) {
        files.push(full);
      }
    }
    return files;
  }
  if (stats.isFile() && targetPath.toLowerCase().endsWith('.json')) return [targetPath];
  return [];
}

function main() {
  const targets = process.argv.slice(2);
  if (!targets.length) {
    console.error('Usage: node scripts/cleanup-locale.js <fileOrDir> [more files/dirs ...]');
    process.exit(1);
  }
  let ok = true;
  for (const t of targets) {
    try {
      const full = path.resolve(t);
      const files = listJsonFiles(full);
      if (!files.length) {
        console.warn(`[cleanup] No JSON files under ${full}`);
        continue;
      }
      for (const f of files) {
        const res = cleanupFile(f);
        ok = ok && res;
      }
    } catch (e) {
      ok = false;
      console.error(`[cleanup] Error processing ${t}:`, e.message);
    }
  }
  process.exit(ok ? 0 : 2);
}

main();

