// Canonical filesystem paths for separation and containment checks (N-V21-2, N-V21-6, N-V21-7).
// Two spellings of the same directory must compare equal: a symlink, and, on a case-insensitive
// volume (APFS by default), a case variant. fs.realpathSync follows symlinks but keeps the case as
// written; fs.realpathSync.native returns the filesystem's own spelling.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Whether the volume holding `dir` (an existing directory) ignores case: its own path
// with one letter's case flipped resolves back to it. With no letter to flip, assume it does (the
// side that refuses more).
export function caseInsensitiveAt(dir) {
  const flipped = dir.replace(/[a-z]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  if (flipped === dir) return true;
  try {
    // Compare canonical forms: `dir` may reach the volume through a symlink (/var -> /private/var).
    return realpathSync.native(flipped) === realpathSync.native(dir);
  } catch {
    return false;
  }
}

// The canonical form of `p`: its nearest existing ancestor as the filesystem spells it, plus the
// missing remainder. A missing remainder cannot be canonicalized by the filesystem, so on a
// case-insensitive volume it is case-folded: two spellings of it name the same future directory.
export function canonicalPath(p) {
  let dir = resolve(p);
  const rest = [];
  while (!existsSync(dir) && dirname(dir) !== dir) { rest.unshift(basename(dir)); dir = dirname(dir); }
  const base = realpathSync.native(dir);
  const fold = rest.length > 0 && caseInsensitiveAt(base);
  return join(base, ...(fold ? rest.map((s) => s.toLowerCase()) : rest));
}

// The nearest existing directory at or above `p`, canonical.
export function existingAncestor(p) {
  let dir = resolve(p);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return realpathSync.native(dir);
}
