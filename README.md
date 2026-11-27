# diff-speed-20261126

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/rren7975-cell/diff-speed-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/rren7975-cell/diff-speed-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A faster drop-in for make.fun's own makefun-diff 1.0.0. For every case's input
`{ old, new }` it returns exactly the patch makefun-diff returns — the
`makefun-diff/1` format, same edit script, same hunks, same bytes — but
computed in about half the house baseline's time.

## How it works

The reference rule, step for step: lines are cut after every `\n` (a last
line with no `\n` is a line too); the common prefix is kept, then the common
suffix of what is left; between them Myers's greedy search runs, deletion
winning ties, no edge-diagonal pruning; the first path to reach both ends is
the script; hunks show up to 3 kept lines around each change run, runs at
most 6 kept lines apart share a hunk, deletions before insertions, `%` after
a line with no trailing newline.

The speed comes from the representation, not a different algorithm:

- **Line interning.** Each text is split once and every distinct line is
  mapped to a small integer id (two ids per distinct line text: with and
  without its `\n`, so id equality is line equality, `\n` included). All
  later comparisons are integer compares.
- **Flat Myers search.** The search keeps one `Int32Array` of furthest-old
  positions per diagonal and snapshots each step's window for the backtrack.
  Nothing is allocated inside the hot loop, and the two working buffers
  alternate.
- **Sentinel-terminated id arrays.** Each side's array carries a distinct end
  sentinel, so the snake loop (`while (a[nx+1] === b[ny+1])`) needs no bounds
  checks.
- **No behavioural shortcuts.** No anchors, no heuristics, no pruning that
  could change the chosen path: the search explores exactly the diagonals the
  reference explores, in the same order, with the same tie-break.

## How to run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

`main.ts` reads every case from `cases.json`, answers each with `run()` from
`solve.js`, and writes `answers.json`. Node 22, standard library only, no
network, deterministic (the same bytes on every run, twice in a row).

## Verification (practice set)

All 4 practice cases reproduce `practice/reference/expected.json` byte for
byte. On this machine the entry runs the practice set in ~0.85 s wall against
the house baseline's ~1.64 s wall, measured side by side with the same driver
shape.
