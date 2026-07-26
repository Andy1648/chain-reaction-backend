// gen9-convert.test.js
// Run with: node --test gen9-convert.test.js  (or npm test)
//
// Validates gen9-convert.js's clean.json -> {categoryAnswers/gen9.js, categoryPacks.js}
// propagation, and specifically the fix for the post-cull breakage: a cross-pack
// duplicate category (same name in two packs) used to hit a hard die() and abort the
// whole convert. It now resolves to one pack when the two accept-lists are the same
// SET of answers, and only errors when they genuinely differ.
//
// Two groups:
//   A) HERMETIC — a tiny synthetic clean.json fixture run through convert via a
//      temp cwd + --out temp dir. Always runs (no dependency on gitignored data),
//      so it holds in CI where gen9.clean.json is absent.
//   B) RECONCILIATION — runs the REAL ./gen9.clean.json through convert (dry run to
//      a temp dir) and reconciles counts (534 entries -> 533 unique after one
//      cross-pack dedup) with the July batch present. Skipped when the gitignored
//      clean.json is not on disk (fresh checkout / CI).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = __dirname;
const CONVERT = path.join(REPO_ROOT, 'gen9-convert.js');
const REAL_CLEAN = path.join(REPO_ROOT, 'gen9.clean.json');

// Fresh, unique temp dir per call so parallel runs never collide.
let mkdtempCounter = 0;
function tmpDir(tag) {
  const base = path.join(os.tmpdir(), `gen9-convert-test-${process.pid}-${tag}-${mkdtempCounter++}`);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

// Run convert with a chosen cwd (where it looks for ./gen9.clean.json) and --out dir.
function runConvert(cwd, outDir) {
  return spawnSync(process.execPath, [CONVERT, '--out', outDir], {
    cwd,
    encoding: 'utf8',
  });
}

// Load a generated module by absolute path, bypassing require's cache (each run
// writes a fresh file at a fresh path anyway, but be defensive).
function loadFresh(absPath) {
  delete require.cache[require.resolve(absPath)];
  return require(absPath);
}

// ---------------------------------------------------------------------------
// GROUP A — hermetic fixture
// ---------------------------------------------------------------------------

test('cross-pack duplicate with identical answer SET is deduped (first pack wins)', () => {
  const cwd = tmpDir('dedup-in');
  const out = tmpDir('dedup-out');
  // "Shared" appears in both packs with the SAME answers in a DIFFERENT order.
  const fixture = {
    alpha: [
      { category: 'Solo A', answers: ['x', 'y'] },
      { category: 'Shared', answers: ['p', 'q', 'r'] },
    ],
    beta: [
      { category: 'Solo B', answers: ['z'] },
      { category: 'Shared', answers: ['r', 'q', 'p'] },
    ],
  };
  fs.writeFileSync(path.join(cwd, 'gen9.clean.json'), JSON.stringify(fixture));

  const res = runConvert(cwd, out);
  assert.equal(res.status, 0, `convert should succeed, got:\n${res.stderr}`);
  assert.match(res.stderr, /Deduped 1 cross-pack duplicate/);

  const answers = loadFresh(path.join(out, 'gen9.js'));
  const packs = loadFresh(path.join(out, 'categoryPacks.js'));

  // 3 unique categories from 4 entries.
  assert.equal(Object.keys(answers).length, 3);
  assert.equal(Object.keys(packs).length, 3);

  // "Shared" resolved to the FIRST pack (alpha, first in clean.json key order).
  assert.equal(packs['Shared'], 'alpha');
  // Answers preserved (as a Set) from the kept occurrence.
  assert.ok(answers['Shared'] instanceof Set);
  assert.deepEqual([...answers['Shared']].sort(), ['p', 'q', 'r']);

  // Output shape: every gen9.js value is a Set; every packs value is a string pack id.
  for (const v of Object.values(answers)) assert.ok(v instanceof Set);
  for (const v of Object.values(packs)) assert.equal(typeof v, 'string');
});

test('cross-pack duplicate with DIFFERENT answer sets is a hard error (nothing written)', () => {
  const cwd = tmpDir('conflict-in');
  const out = tmpDir('conflict-out');
  const fixture = {
    alpha: [{ category: 'Shared', answers: ['p', 'q'] }],
    beta: [{ category: 'Shared', answers: ['p', 'DIFFERENT'] }],
  };
  fs.writeFileSync(path.join(cwd, 'gen9.clean.json'), JSON.stringify(fixture));

  const res = runConvert(cwd, out);
  assert.notEqual(res.status, 0, 'convert must fail on a genuine answer-set conflict');
  assert.match(res.stderr, /DIFFERENT answer sets/);
  // No output files written on the fatal path.
  assert.equal(fs.existsSync(path.join(out, 'gen9.js')), false);
  assert.equal(fs.existsSync(path.join(out, 'categoryPacks.js')), false);
});

test('no duplicate keys, and pack grouping matches clean.json', () => {
  const cwd = tmpDir('group-in');
  const out = tmpDir('group-out');
  const fixture = {
    alpha: [
      { category: 'A1', answers: ['a'] },
      { category: 'A2', answers: ['b'] },
    ],
    beta: [{ category: 'B1', answers: ['c'] }],
  };
  fs.writeFileSync(path.join(cwd, 'gen9.clean.json'), JSON.stringify(fixture));

  const res = runConvert(cwd, out);
  assert.equal(res.status, 0, res.stderr);

  const packs = loadFresh(path.join(out, 'categoryPacks.js'));
  assert.deepEqual(packs, { A1: 'alpha', A2: 'alpha', B1: 'beta' });

  // Guard against duplicate physical key lines in the emitted text (an object would
  // silently collapse them; the file text would not).
  const gen9Text = fs.readFileSync(path.join(out, 'gen9.js'), 'utf8');
  for (const key of ['A1', 'A2', 'B1']) {
    const hits = gen9Text.split(`${JSON.stringify(key)}: new Set(`).length - 1;
    assert.equal(hits, 1, `key ${key} should appear exactly once in gen9.js`);
  }
});

// ---------------------------------------------------------------------------
// GROUP B — reconciliation against the real (gitignored) gen9.clean.json
// ---------------------------------------------------------------------------

test('reconciles real gen9.clean.json: counts derive from the pool, every category converts', (t) => {
  if (!fs.existsSync(REAL_CLEAN)) {
    t.skip('gen9.clean.json not present (gitignored / fresh checkout)');
    return;
  }

  const clean = JSON.parse(fs.readFileSync(REAL_CLEAN, 'utf8'));

  // Derive ALL expectations from the pool itself — no hardcoded batch counts or
  // category-name lists, so this test never needs editing when a batch lands.
  let entryCount = 0;
  const occurrences = new Map(); // category -> [{ pack, answers }] in clean key order
  const packOfFirst = new Map(); // category -> first pack it appears in
  for (const pack of Object.keys(clean)) {
    for (const e of clean[pack]) {
      entryCount++;
      if (!occurrences.has(e.category)) occurrences.set(e.category, []);
      occurrences.get(e.category).push({ pack, answers: e.answers });
      if (!packOfFirst.has(e.category)) packOfFirst.set(e.category, pack);
    }
  }

  // A cross-pack duplicate whose occurrences share the SAME answer set is deduped by
  // convert to one (first-pack) entry. A duplicate with DIFFERING sets makes convert
  // exit non-zero — so if convert succeeds below, every dup was identical and the
  // unique count is exactly the number of distinct category names.
  const sameSet = (a, b) => {
    const sa = new Set(a);
    const sb = new Set(b);
    return sa.size === sb.size && [...sa].every((x) => sb.has(x));
  };
  let identicalDupDrops = 0;
  for (const occ of occurrences.values()) {
    if (occ.length > 1 && occ.every((o) => sameSet(o.answers, occ[0].answers))) {
      identicalDupDrops += occ.length - 1;
    }
  }
  const expectedUnique = occurrences.size; // distinct category names
  // The entry -> unique gap must be fully explained by identical-answer dedups
  // (i.e. no differing-set cross-pack duplicates lurking, which convert would reject).
  assert.equal(
    entryCount - expectedUnique,
    identicalDupDrops,
    'entry->unique gap must be explained only by identical-answer cross-pack dedups'
  );

  const out = tmpDir('real-out');
  const res = runConvert(REPO_ROOT, out);
  assert.equal(res.status, 0, `convert should succeed on real data, got:\n${res.stderr}`);

  const answers = loadFresh(path.join(out, 'gen9.js'));
  const packs = loadFresh(path.join(out, 'categoryPacks.js'));

  // Counts reconcile with the pool.
  assert.equal(Object.keys(answers).length, expectedUnique);
  assert.equal(Object.keys(packs).length, expectedUnique);

  // EVERY category in clean.json appears in BOTH outputs, in its first-occurrence
  // pack. This covers the whole batch generically — there is no per-batch name list
  // to keep in sync.
  for (const [cat, firstPack] of packOfFirst) {
    assert.ok(cat in answers, `gen9.js missing category: ${cat}`);
    assert.ok(cat in packs, `categoryPacks.js missing category: ${cat}`);
    assert.equal(packs[cat], firstPack, `wrong pack for: ${cat}`);
    assert.ok(answers[cat] instanceof Set, `not a Set: ${cat}`);
  }

  // Any cross-pack duplicate resolves to its FIRST-occurrence pack (asserted
  // generically, so e.g. a name shared by two packs stays in the earlier one).
  for (const [cat, occ] of occurrences) {
    if (occ.length > 1) assert.equal(packs[cat], packOfFirst.get(cat), `dup ${cat} not in first pack`);
  }

  // Output shape matches the committed structure: gen9.js is a flat map of Sets,
  // categoryPacks.js is a flat map of pack-id strings.
  for (const v of Object.values(answers)) assert.ok(v instanceof Set);
  for (const v of Object.values(packs)) assert.equal(typeof v, 'string');
});
