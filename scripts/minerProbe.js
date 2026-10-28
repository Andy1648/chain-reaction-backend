#!/usr/bin/env node
// scripts/minerProbe.js - BLIND PROBE for MINER's deck (Andy's Blitz rule: a real player gets < ~5 rejected
// guesses a round). A prober who has never seen the lists writes the guesses players would type; this reports
// ONLY the misses (never the list), so the prober stays blind.
//
//   node scripts/minerProbe.js guesses.json            guesses.json = { "<list name>": ["guess", ...], ... }
//   node scripts/minerProbe.js --apply additions.json  additions.json = { "<list name>": ["valid answer", ...] }
//
// --apply adds each valid miss to blitzLists.json's answers (skipping any that already score) AND to
// blitzCanon.json (the canon must cover every answer exactly once - categoryBlitzBot.test.js): a new answer
// joins as a new member at 45% down the list - the GOLD band, the same depth MINER gives a real answer nobody
// ranked - and two additions that are one answer ("oj simpson" / "o.j. simpson") become one member + alias.
// MINER and Category Blitz judge with the same list, so the answer counts in both.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const apply = args[0] === '--apply';
const file = apply ? args[1] : args[0];
if (!file) {
  console.error('usage: minerProbe.js guesses.json | --apply additions.json');
  process.exit(2);
}
const input = JSON.parse(fs.readFileSync(file, 'utf8'));
const LISTS_PATH = path.join(__dirname, '..', 'blitzLists.json');
const CANON_PATH = path.join(__dirname, '..', 'blitzCanon.json');
const BL = require('../blitzLists');

if (!apply) {
  const out = {};
  let total = 0;
  let missed = 0;
  for (const [cat, guesses] of Object.entries(input)) {
    if (!BL.listFor(cat)) {
      out[cat] = { error: 'no such list' };
      continue;
    }
    const misses = guesses.filter((g) => !BL.onList(cat, g));
    total += guesses.length;
    missed += misses.length;
    out[cat] = { guesses: guesses.length, misses };
  }
  console.log(JSON.stringify({ total, missed, rate: total ? +(missed / total).toFixed(3) : 0, byList: out }, null, 1));
} else {
  const raw = JSON.parse(fs.readFileSync(LISTS_PATH, 'utf8'));
  const canon = JSON.parse(fs.readFileSync(CANON_PATH, 'utf8'));
  let added = 0;
  for (const [cat, answers] of Object.entries(input)) {
    const entry = raw.find((c) => c.name === cat);
    const members = canon[cat];
    if (!entry || !members) throw new Error(`no such list: ${cat}`);
    const junk = new Set((entry.junk || []).map(BL.answerKey));
    const fresh = new Map(); // same-answer key -> the member this run added for it
    for (const a of answers) {
      const t = String(a).trim().toLowerCase();
      if (!t || BL.onList(cat, t) || entry.answers.includes(t)) continue;
      if (junk.has(BL.answerKey(t))) {
        console.warn(`skip "${t}" on ${cat}: it is one of the list's own junk answers`);
        continue;
      }
      entry.answers.push(t);
      added += 1;
      const key = BL.sameAnswerKey(cat, t);
      if (fresh.has(key)) {
        fresh.get(key).aliases.push(t);
      } else {
        const m = { canon: t, aliases: [] };
        members.splice(Math.floor(members.length * 0.45), 0, m);
        fresh.set(key, m);
      }
    }
  }
  fs.writeFileSync(LISTS_PATH, `${JSON.stringify(raw, null, 1)}\n`);
  fs.writeFileSync(CANON_PATH, `${JSON.stringify(canon, null, 1)}\n`);
  console.log(`added ${added} answers`);
}
