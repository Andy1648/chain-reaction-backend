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

test('reconciles real gen9.clean.json: 534 entries -> 533 unique, July batch present', (t) => {
  if (!fs.existsSync(REAL_CLEAN)) {
    t.skip('gen9.clean.json not present (gitignored / fresh checkout)');
    return;
  }

  const clean = JSON.parse(fs.readFileSync(REAL_CLEAN, 'utf8'));
  let entryCount = 0;
  const perName = new Map(); // category -> count of packs it appears in
  const packOfFirst = new Map(); // category -> first pack in key order
  for (const pack of Object.keys(clean)) {
    for (const e of clean[pack]) {
      entryCount++;
      perName.set(e.category, (perName.get(e.category) || 0) + 1);
      if (!packOfFirst.has(e.category)) packOfFirst.set(e.category, pack);
    }
  }
  const crossPackDups = [...perName.values()].filter((n) => n > 1).length;
  const expectedUnique = perName.size;

  // Reflect the known state of this pool: 534 entries with exactly one cross-pack
  // duplicate ("Dwarf planets") -> 533 unique categories.
  assert.equal(entryCount, 534, 'expected 534 total entries in clean.json');
  assert.equal(crossPackDups, 1, 'expected exactly one cross-pack duplicate');
  assert.equal(expectedUnique, 533, 'expected 533 unique categories after dedup');

  const out = tmpDir('real-out');
  const res = runConvert(REPO_ROOT, out);
  assert.equal(res.status, 0, `convert should succeed on real data, got:\n${res.stderr}`);

  const answers = loadFresh(path.join(out, 'gen9.js'));
  const packs = loadFresh(path.join(out, 'categoryPacks.js'));

  // Counts reconcile with clean.json.
  assert.equal(Object.keys(answers).length, expectedUnique);
  assert.equal(Object.keys(packs).length, expectedUnique);

  // Every unique clean category is present exactly once in both outputs, grouped
  // into its first-occurrence pack.
  for (const [cat, firstPack] of packOfFirst) {
    assert.ok(cat in answers, `gen9.js missing category: ${cat}`);
    assert.equal(packs[cat], firstPack, `wrong pack for: ${cat}`);
    assert.ok(answers[cat] instanceof Set, `not a Set: ${cat}`);
  }

  // The one known cross-pack duplicate resolves to its first pack (world before science).
  assert.equal(packs['Dwarf planets'], 'world');

  // The 44-category July batch is all present as keys.
  const JULY_BATCH = [
    // science (21: 20 kept + Geological eras)
    'Types of telescopes', 'Laboratory safety gear', 'Human teeth', 'Scientific fields',
    'Parts of a flower', 'Taxonomic kingdoms', 'Parts of an atom', 'Human endocrine hormones',
    'Human muscles', 'Human infectious diseases', 'Dwarf planets', 'Types of blood cells',
    'Parts of the human brain', 'Scientific laws and principles', 'Human digestive system parts',
    'Types of chemical reactions', 'SI derived units', 'Types of blood vessels',
    'Taxonomic domains and phyla', 'Parts of a plant cell', 'Geological eras',
    // tech (10)
    'Programming paradigms', 'Cybersecurity terms', 'Database management systems',
    'Programming frameworks', 'Tech hardware brands', 'Internet protocols', 'Tech job titles',
    'Internet top-level domains', 'Web development languages', 'Tech input devices',
    // literature (6)
    'Fairy tales', 'Gothic novels', 'Beatrix Potter characters', 'C.S. Lewis books',
    'Agatha Christie detectives', 'Greek playwrights',
    // history (4)
    'Inca emperors', 'Mongol Khans', 'French monarchs', 'Historical peace treaties',
    // music (3)
    'Music production software', 'Electronic music genres', 'Famous music festivals',
  ];
  assert.equal(JULY_BATCH.length, 44);
  for (const cat of JULY_BATCH) {
    assert.ok(cat in answers, `July batch category missing from gen9.js: ${cat}`);
    assert.ok(cat in packs, `July batch category missing from categoryPacks.js: ${cat}`);
  }

  // Output shape matches the committed structure: gen9.js is a flat map of Sets,
  // categoryPacks.js is a flat map of pack-id strings.
  for (const v of Object.values(answers)) assert.ok(v instanceof Set);
  for (const v of Object.values(packs)) assert.equal(typeof v, 'string');
});
