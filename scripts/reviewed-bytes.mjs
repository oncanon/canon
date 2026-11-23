#!/usr/bin/env node
// Recovers the SHA-256 of prototype bytes exactly as the builder reviewed them,
// from the builder session transcript (a local JSONL file), so the P15 use-time
// recheck survives later edits to the untracked prototype. Only digests and
// sizes are produced; no prototype bytes are written anywhere.
//
//   node scripts/reviewed-bytes.mjs <transcript.jsonl>
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Review reads, identified by the exact command shape the builder used:
// - editorial.css: awk '{print NR": "$0}' <file> | fold -w 4000   (format 'awk-fold')
// - index.njk, base.njk: cat -n <file>                            (format 'cat-n')
// Both source files end with a newline (cycle-1 `wc -l` counts equal line counts).
const READS = [
  { file: 'src/assets/editorial.css', format: 'awk-fold', match: (cmd) => cmd.includes('fold -w 4000') && cmd.includes('editorial.css') },
  { file: 'src/index.njk', format: 'cat-n', match: (cmd) => /cat -n \$P\/src\/index\.njk(\s|$)/.test(cmd) && !cmd.includes('base.njk') },
  // This read's tool result is wrapped in an "Exit code 1" error (a later command in
  // the same shell line failed); the numbered cat -n lines are unaffected.
  { file: 'src/_includes/layouts/base.njk', format: 'cat-n', match: (cmd) => /cat -n \$P\/src\/_includes\/layouts\/base\.njk/.test(cmd) },
];

function rebuild(output, format) {
  const lines = [];
  for (const line of output.split('\n')) {
    if (format === 'cat-n') {
      const m = line.match(/^\s*(\d+)\t([\s\S]*)$/);
      if (m && Number(m[1]) === lines.length + 1) lines.push(m[2]);
      continue;
    }
    const m = line.match(/^(\d+): ([\s\S]*)$/);
    if (m && Number(m[1]) === lines.length + 1) lines.push(m[2]);
    else if (lines.length) lines[lines.length - 1] += line; // fold continuation
  }
  return `${lines.join('\n')}\n`;
}

export async function recoverReviewedDigests(transcriptPath) {
  const records = (await readFile(transcriptPath, 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const results = [];
  for (const read of READS) {
    let use = null;
    let result = null;
    for (const rec of records) {
      for (const c of Array.isArray(rec.message?.content) ? rec.message.content : []) {
        if (c.type === 'tool_use' && !use && read.match(String(c.input?.command ?? ''))) use = { id: c.id, at: rec.timestamp };
        if (c.type === 'tool_result' && use && c.tool_use_id === use.id && !result) {
          result = { at: rec.timestamp, text: Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('') : String(c.content) };
        }
      }
    }
    if (!result) {
      results.push({ file: read.file, found: false });
      continue;
    }
    const bytes = Buffer.from(rebuild(result.text, read.format), 'utf8');
    // `text` stays in memory for the P15 copy check; the CLI prints digests only.
    Object.defineProperty(results[results.push({ file: read.file, found: true, toolUseId: use.id, readAt: result.at, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) - 1], 'text', { value: bytes.toString('utf8'), enumerable: false });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await recoverReviewedDigests(process.argv[2]), null, 2));
}
