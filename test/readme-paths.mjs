// README.md parsing for the E9 README gate (test/unit/e9-readme.test.mjs), shared with the red-controls copy-scope
// guard (test/unit/red-controls-copy-scope.test.mjs). There is ONE copy of each pattern. The gate checks what README
// states against the tree; the guard derives from the same extraction which repository paths the gate reads, so every
// E9 control's scratch copy holds them. A path form read here but missed by the guard would let a new README row
// re-break the E9 controls (QA CS-1 and L-1 on 3a78169: the locations-table paths, and the link regex kept twice).
import assert from 'node:assert/strict';

// Fenced code blocks: the language, optional labels (for example "sh opt-in-tailnet"), the heading above them, and
// their lines with 1-based line numbers.
export function fencedBlocks(lines) {
  const out = [];
  let open = null;
  let heading = null;
  lines.forEach((line, n) => {
    const h = !open && line.match(/^(#{1,6}) (.*)$/);
    if (h) heading = h[2];
    // Info string: the language, then optional labels (for example "sh opt-in-tailnet").
    const f = line.match(/^(`{3,})([^`]*)$/);
    if (open) {
      if (f && f[1].length >= open.fence.length && f[2].trim() === '') { out.push(open); open = null; } else open.lines.push({ text: line, line: n + 1 });
    } else if (f) {
      const [lang = '', ...labels] = f[2].trim().split(/\s+/);
      open = { fence: f[1], lang, labels, heading, start: n + 1, lines: [] };
    }
  });
  return out;
}

export const SHELL = new Set(['sh', 'shell', 'bash', 'console']);

// A command is every non-blank, non-comment line of a shell block; "# exit N" at the end of a line gives its
// expected exit code.
export function commandsOf(blocks) {
  return blocks.filter((b) => SHELL.has(b.lang)).flatMap((b) => b.lines
    .filter((l) => l.text.trim() && !l.text.trim().startsWith('#'))
    .map((l) => {
      const m = l.text.match(/^(.*?)\s+#\s*(.*)$/);
      const cmd = (m ? m[1] : l.text).trim();
      const exit = m && /^exit (\d+)\b/.test(m[2]) ? Number(m[2].match(/^exit (\d+)/)[1]) : 0;
      return { cmd, expectedExit: exit, line: l.line, block: b.heading, labels: b.labels, blockStart: b.start };
    }));
}

// Shell-words for simple command lines (quotes removed; placeholders kept).
export const words = (cmd) => [...cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

// The README text outside fenced blocks (fence lines included in the block).
export const proseOf = (lines, blocks) => lines.filter((_, n) => !blocks.some((b) => n + 1 >= b.start && n + 1 <= b.start + b.lines.length + 1)).join('\n');

// Every Markdown link target (not an image) in a text.
export const linkTargets = (text) => [...text.matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => m[2]);
// The repository file a link target names: none for an external link (scheme:) or a same-file anchor.
export const linkFile = (target) => (/^[a-z]+:/i.test(target) ? '' : target.split('#')[0]);

// The rows of the table whose header row is exactly `headerRow`.
export function tableAfterHeader(lines, headerRow) {
  const i = lines.findIndex((l) => l.trim() === headerRow);
  assert.ok(i >= 0, `README table with header ${headerRow} exists`);
  const rows = [];
  for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j += 1) {
    rows.push(lines[j].slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim()));
  }
  return rows;
}
export const code = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

export const LOCATIONS_HEADER = '| Path | Contents |';
// The locations table's paths, without a trailing slash.
export const locationPaths = (lines) => tableAfterHeader(lines, LOCATIONS_HEADER).map(([cell]) => code(cell)[0].replace(/\/$/, ''));

// Paths named in backticks anywhere that look like repository files.
export const fileRefs = (text) => [...text.matchAll(/`((?:src|test|scripts|docs|fixtures)\/[^`\s<>*]+)`/g)].map((m) => m[1]);

// A command's node script, directly or through an npm script.
export const NODE_SCRIPT = /^scripts\/[\w.-]+\.mjs$/;
export const npmScriptName = (argv) => (argv[0] === 'test' ? 'test' : argv[0] === 'run' ? argv[1] : null);
export const npmBody = (pkg, name) => (pkg.scripts[name] ?? '').replace(/^(?:[A-Z_]+=\S*\s+)+/, '');
export function scriptFileOf(cmd, pkg) {
  const w = words(cmd);
  if (w[0] === 'node' && NODE_SCRIPT.test(w[1] ?? '')) return w[1];
  if (w[0] === 'npm') {
    const name = npmScriptName(w.slice(1));
    const body = name ? npmBody(pkg, name) : '';
    if (body.startsWith('node scripts/')) return body.split(/\s+/)[1];
  }
  return null;
}

// The quick start: its block's heading, and the directories its commands create (`mkdir -p`). What it produces lies
// beneath them, so no tree or copy holds it (the locations table documents both kinds).
export const QUICK_START = 'Quick start (five minutes)';
export const producedRoots = (commands) => commands.filter((c) => c.block === QUICK_START).map((c) => words(c.cmd)).filter((w) => w[0] === 'mkdir').flatMap((w) => w.slice(1).filter((a) => !a.startsWith('-')).map((a) => a.replace(/\/$/, '')));
// The quick start runs in a directory populated with these entries.
export const QUICK_START_INPUTS = ['package.json', 'package-lock.json', 'src', 'fixtures', 'scripts', 'README.md'];
// The browser suites whose test tags the README cites.
export const BROWSER_SUITES = ['p11-responsive', 'p11-code-copy', 'p12-print', 'p13-accessibility', 'p14-network'].map((f) => `test/browser/${f}.test.mjs`);

// Every repository path the gate reads, by form; each form is the gate's own extraction above. A locations-table
// path beneath a directory the quick start creates is produced, not read from the tree, and is left out.
export function readmePaths(readme, pkg) {
  const lines = readme.split('\n');
  const blocks = fencedBlocks(lines);
  const commands = commandsOf(blocks);
  const produced = producedRoots(commands);
  return {
    links: linkTargets(proseOf(lines, blocks)).map(linkFile).filter(Boolean),
    locations: locationPaths(lines).filter((p) => !produced.some((r) => p === r || p.startsWith(`${r}/`))),
    fileRefs: fileRefs(readme),
    scripts: commands.map((c) => scriptFileOf(c.cmd, pkg)).filter(Boolean),
    fixed: ['README.md', 'package.json', 'src/cli.mjs', ...QUICK_START_INPUTS, ...BROWSER_SUITES],
  };
}
