// claude/llmSweep.js — emit the whole category corpus as JSONL for a model to review.
// CALLS NO API. It only prints; you pipe it to a file and feed that to whatever you like.
//
// WHY THIS EXISTS. claude/classErrorSweep.js is the keyword version of the same job, and it can
// only find what a word list can find: an answer that names a KIND, restates the category, or
// hedges. It cannot tell "ground beef" (a real pizza topping) from "stuffed crust" (not one),
// because nothing in the strings distinguishes them — you have to know what a topping IS. Across
// all 89 tier-1 categories it surfaces a handful of hits, and that is the honest ceiling.
//
// Reading the category and judging membership is a model's job. This script does the boring half:
// it emits every category as one compact line, capped so no single line is enormous, and prints
// what a full pass would cost before you spend it.
//
// Run:
//   node claude/llmSweep.js > sweep.jsonl        every category
//   node claude/llmSweep.js --tier 1             tier 1 only (the categories a stranger meets)
//   node claude/llmSweep.js --cap 40             at most 40 answers per line (default 60)
//   node claude/llmSweep.js --batch 25           also print batch boundaries + per-batch tokens
//   node claude/llmSweep.js --stats              print ONLY the cost estimate, no JSONL
//
// LINE SHAPE — one JSON object per line, newline-delimited:
//   {"category":"Pizza toppings","tier":1,"n":159,"answers":["pepperoni","sausage", ...]}
// `n` is the TRUE accept count; `answers` is capped at --cap, so a reviewer always knows whether
// they are seeing the whole list or a sample. A category with more than `cap` accepts emits
// SEVERAL lines, each with a `part` field, so nothing is silently dropped.
const blitz = require('../categoryBlitzLogic');
const CATEGORY_ANSWERS = require('../categoryAnswers');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : dflt;
};
const CAP = Math.max(1, flag('cap', 60));
const TIER = flag('tier', 0); // 0 = all tiers
const BATCH = flag('batch', 0); // 0 = no batching output
const statsOnly = args.includes('--stats');

// Token estimate. No tokenizer dependency on purpose — this is a budgeting number, not a billing
// one. ~4 characters per token is the usual English rule of thumb; short lowercase words in a JSON
// array run a little denser, so this reads slightly HIGH, which is the safe direction for a budget.
const CHARS_PER_TOKEN = 4;
const estTokens = (s) => Math.ceil(s.length / CHARS_PER_TOKEN);

const categories = blitz.CATEGORIES.filter((c) => !TIER || blitz.CATEGORY_TIER[c] === TIER).sort();

const lines = [];
for (const category of categories) {
  const set = CATEGORY_ANSWERS[category];
  if (!set) continue;
  const all = [...set].sort();
  const tier = blitz.CATEGORY_TIER[category] || 2;
  const parts = Math.ceil(all.length / CAP) || 1;
  for (let p = 0; p < parts; p++) {
    const answers = all.slice(p * CAP, (p + 1) * CAP);
    const row = { category, tier, n: all.length };
    if (parts > 1) {
      row.part = p + 1;
      row.parts = parts;
    }
    row.answers = answers;
    lines.push(JSON.stringify(row));
  }
}

const totalChars = lines.reduce((n, l) => n + l.length + 1, 0);
const totalTokens = estTokens(lines.join('\n'));
const answersEmitted = lines.reduce((n, l) => n + JSON.parse(l).answers.length, 0);

if (!statsOnly) {
  for (const l of lines) console.log(l);
}

// The estimate goes to STDERR so `> sweep.jsonl` stays clean JSONL.
const err = (s) => process.stderr.write(`${s}\n`);
err('');
err('--- llmSweep estimate (no API was called) ---');
err(`categories:        ${categories.length}${TIER ? ` (tier ${TIER} only)` : ' (all tiers)'}`);
err(`answers emitted:   ${answersEmitted}`);
err(`JSONL lines:       ${lines.length}   (cap ${CAP} answers/line)`);
err(`payload:           ${(totalChars / 1024).toFixed(1)} KiB`);
err(`INPUT tokens:      ~${totalTokens.toLocaleString()}  (~${CHARS_PER_TOKEN} chars/token)`);
// A review reply is short per category — a verdict plus the answers to drop.
const outPerLine = 120;
err(`OUTPUT tokens:     ~${(lines.length * outPerLine).toLocaleString()}  (assuming ~${outPerLine}/line of verdicts)`);
err('');
err('Add the prompt/system overhead of whatever harness you use; this is corpus only.');
if (BATCH) {
  const batches = Math.ceil(lines.length / BATCH);
  err(`batches:           ${batches} x ${BATCH} lines  (~${Math.ceil(totalTokens / batches).toLocaleString()} input tokens each)`);
}
err('Sanity: every category is covered, and a list longer than the cap is SPLIT across parts');
err('(part/parts fields) rather than truncated — no answer is silently dropped.');
