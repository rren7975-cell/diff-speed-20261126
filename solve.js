// Fast drop-in for makefun-diff 1.0.0: returns make.fun's own patch of { old, new }
// (the makefun-diff/1 format), byte for byte identical to the house baseline,
// but computed on interned line ids with a flat Int32Array Myers search instead
// of the baseline's per-step path objects.
//
// The algorithm is the reference's own rule, step for step:
//   * lines are cut after every "\n"; a last line with no "\n" is a line too;
//   * common prefix, then common suffix of what is left;
//   * Myers's greedy search: d = 0, 1, 2, ...; k = -d..d step 2; the furthest
//     point on k is one old line past the (d-1)-point on k-1 (a deletion) or one
//     new line past the (d-1)-point on k+1 (an insertion), whichever lies further
//     into the old text, the deletion winning a tie; a move past either text's
//     end is no candidate; from that point the path follows every line equal in
//     both as far as it goes; the first path to reach both ends is the script.
//   * the patch: header line, then hunks of up to 3 kept lines around each
//     change run, runs at most 6 kept lines apart sharing a hunk, deletions
//     before insertions inside a run, "%" after a line with no trailing "\n".
//
// Speed comes from four places: lines are interned once per case to small
// integers (two ids per distinct line text: with and without its "\n", so
// equality of ids is equality of lines); the search keeps one Int32Array of
// furthest-old positions per d and snapshots it into one flat, reused buffer
// for the backtrack, with no allocation inside the hot loop; the id arrays
// carry distinct end sentinels so the snake loop needs no bounds checks; and
// the patch is built from the interned runs without re-tokenizing.

/** The patch's first word. */
const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

/**
 * Intern the lines of one text. `parts` is text.split('\n'); line i < last is
 * parts[i] + '\n', and the last part is a line only when non-empty (then it
 * has no '\n'). Each distinct part gets one base id; the id is base*2 when
 * the line carries its '\n' and base*2+1 when it does not, so two lines share
 * an id exactly when they are the same code units, '\n' included. The
 * returned array is one longer than the line count, with a sentinel id that
 * no line can hold (and a different one for the other text), so a snake loop
 * can compare a[x+1] === b[y+1] past either text's end without a bounds check.
 */
function internLines(parts, map, sentinel) {
  const last = parts.length - 1;
  const count = last + (parts[last] !== '' ? 1 : 0);
  const ids = new Int32Array(count + 1);
  for (let i = 0; i < last; i++) {
    const s = parts[i];
    let base = map.get(s);
    if (base === undefined) {
      base = map.size;
      map.set(s, base);
    }
    ids[i] = base * 2;
  }
  if (parts[last] !== '') {
    const s = parts[last];
    let base = map.get(s);
    if (base === undefined) {
      base = map.size;
      map.set(s, base);
    }
    ids[last] = base * 2 + 1;
  }
  ids[count] = sentinel;
  return ids;
}

/**
 * The edit runs of the trimmed middles a[0..n) into b[0..m): [[kind, count]]
 * with kind 0 = keep, 1 = delete, 2 = insert, consecutive runs of one kind
 * merged, in order. `a` and `b` carry distinct end sentinels at index n, m.
 */
function editRuns(a, n, b, m) {
  const KEEP = 0;
  const DELETE = 1;
  const INSERT = 2;
  const NONE = -2; // no path reaches this diagonal yet (oldPos is always >= -1)

  const maxEdit = n + m;
  // V holds, per diagonal k (index k + maxEdit), the oldPos reached at the
  // current d: the index of the last old line consumed, -1 for none. Two
  // buffers alternate so no array is allocated inside the loop; a diagonal
  // outside the previous step's window still reads NONE, because a step d'
  // only ever writes diagonals with |k| <= d'.
  let v = new Int32Array(2 * maxEdit + 1).fill(NONE);
  let next = new Int32Array(2 * maxEdit + 1).fill(NONE);
  const off = maxEdit;
  // Snapshots: snaps[d] is the V window of step d over diagonals -d..d.
  // Per-step slices: one flat buffer that grows by doubling turned out to
  // cost more in allocation/GC than the small slices it replaced.
  const snaps = [];
  // d = 0: the path from (-1, -1) follows equal lines on diagonal 0.
  let x = -1;
  let y = -1;
  while (a[x + 1] === b[y + 1]) {
    x++;
    y++;
  }
  v[off] = x;
  snaps.push(new Int32Array([x]));
  if (x + 1 >= n && y + 1 >= m) return [];
  let D = -1;
  let kFinal = 0;
  for (let d = 1; d <= maxEdit; d++) {
    // Clear this step's window first: the buffer still holds the window of
    // two steps ago, and a diagonal with no path this step must read NONE,
    // both in the forward search and in the backtrack's snapshots.
    next.fill(NONE, off - d, off + d + 1);
    let done = false;
    // idx walks the diagonals: idx = off + k - 1 (the deletion's source),
    // so v[idx] is the deletion candidate and v[idx + 2] the insertion's.
    let idx = off - d - 1;
    for (let k = -d; k <= d; k += 2, idx += 2) {
      const down = v[idx];
      const right = v[idx + 2];
      // Further into the old text wins; the deletion wins a tie; -2 means
      // that move is no candidate (no path, or past the text's end).
      const xDel = down !== NONE && down + 1 < n ? down + 1 : NONE;
      const xIns = right !== NONE && right - k < m ? right : NONE;
      if (xDel === NONE && xIns === NONE) continue;
      let nx = xDel >= xIns ? xDel : xIns;
      let ny = nx - k;
      while (a[nx + 1] === b[ny + 1]) {
        nx++;
        ny++;
      }
      next[off + k] = nx;
      if (nx + 1 >= n && ny + 1 >= m) {
        D = d;
        kFinal = k;
        done = true;
        break;
      }
    }
    snaps.push(next.subarray(off - d, off + d + 1).slice());
    const tmp = v;
    v = next;
    next = tmp;
    if (done) break;
  }
  if (D < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Backtrack from (D, kFinal), rebuilding the runs in reverse.
  // snaps[d] covers diagonals -d..d, diagonal k at index k + d.
  const at = (d, k) => snaps[d][k + d];
  const rev = []; // [kind, count] pairs, latest first
  let k = kFinal;
  for (let d = D; d >= 1; d--) {
    const down = at(d - 1, k - 1);
    const right = at(d - 1, k + 1);
    const xDel = down !== NONE && down + 1 < n ? down + 1 : NONE;
    const xIns = right !== NONE && right - k < m ? right : NONE;
    const isDeletion = xDel >= xIns;
    const xPre = isDeletion ? down + 1 : right;
    const snake = at(d, k) - xPre;
    if (snake > 0) rev.push([KEEP, snake]);
    rev.push([isDeletion ? DELETE : INSERT, 1]);
    k = isDeletion ? k - 1 : k + 1;
  }
  const firstSnake = at(0, 0) + 1;
  if (firstSnake > 0) rev.push([KEEP, firstSnake]);
  // Reverse and merge consecutive runs of one kind.
  const runs = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const [kind, count] = rev[i];
    const lastRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (lastRun !== undefined && lastRun[0] === kind) lastRun[1] += count;
    else runs.push([kind, count]);
  }
  return runs;
}

/** make.fun's own patch of input.old into input.new. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const map = new Map();
  const aParts = input.old.split('\n');
  const bParts = input.new.split('\n');
  const a = internLines(aParts, map, -1);
  const b = internLines(bParts, map, -2);
  const n = a.length - 1;
  const m = b.length - 1;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push([0, prefix]);
  // Copy the trimmed middles into fresh arrays carrying their own end
  // sentinels: a subarray view of the full arrays would let a snake run past
  // the middle's end into the suffix lines.
  const midN = n - prefix - suffix;
  const midM = m - prefix - suffix;
  const aMid = new Int32Array(midN + 1);
  aMid.set(a.subarray(prefix, n - suffix));
  aMid[midN] = -1;
  const bMid = new Int32Array(midM + 1);
  bMid.set(b.subarray(prefix, m - suffix));
  bMid[midM] = -2;
  const mid = editRuns(aMid, midN, bMid, midM);
  for (const r of mid) {
    const lastRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (lastRun !== undefined && lastRun[0] === r[0]) lastRun[1] += r[1];
    else runs.push([r[0], r[1]]);
  }
  if (suffix > 0) {
    const lastRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (lastRun !== undefined && lastRun[0] === 0) lastRun[1] += suffix;
    else runs.push([0, suffix]);
  }

  // The change runs: each a stretch of deletions and insertions between two
  // kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const [kind, count] of runs) {
    if (kind === 0) {
      o += count;
      p += count;
      continue;
    }
    let c = changes.length > 0 ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === 1) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.length > 0 ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  // A line as the patch writes it: its op, the line, a newline, and "%" on a
  // line of its own when it had none. Lines are read back from the split
  // parts: line i of a text is parts[i] + "\n", except a non-empty last part,
  // which is the final line with no "\n".
  const lastA = aParts.length - 1;
  const lastB = bParts.length - 1;
  const writtenA = (op, i) => (i < lastA ? `${op}${aParts[i]}\n` : `${op}${aParts[i]}\n%\n`);
  const writtenB = (op, i) => (i < lastB ? `${op}${bParts[i]}\n` : `${op}${bParts[i]}\n%\n`);

  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(writtenA('=', at));
      for (let i = 0; i < c.dels; i++) out.push(writtenA('-', c.o + i));
      for (let i = 0; i < c.ins; i++) out.push(writtenB('+', c.p + i));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(writtenA('=', at));
  }
  return out.join('');
}
