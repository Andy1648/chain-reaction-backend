// scripts/blitz-smoke.js — post-deploy Category Blitz smoke test against a live server (BACKEND RULE).
// Creates a private room with a MEDIUM bot, starts Category Blitz, and in the first round submits
// "zzzzzzzz" (must be rejected as not_on_list) and one real answer from the curated list (must score).
// Prints the round's category. Exit 0 = healthy. Usage: node scripts/blitz-smoke.js [wss://url]
const WebSocket = require('ws');
const BLITZ_LISTS = require('../blitzLists');

const URL = process.argv[2] || 'wss://chain-reaction-backend-i6kx.onrender.com';
const ws = new WebSocket(URL);
const send = (type, payload = {}) => ws.send(JSON.stringify({ type, payload }));
const out = { url: URL, category: null, junk: null, real: null, realWord: null, errors: [] };
let started = false;
let submitted = false;
const finish = (ok, why) => {
  console.log(JSON.stringify({ ok, why, ...out }, null, 2));
  try { ws.close(); } catch { /* closed */ }
  process.exit(ok ? 0 : 1);
};
setTimeout(() => finish(false, 'timeout'), 60000);

ws.on('open', () => send('create_room', { name: 'zzsmoke', isPublic: false }));
ws.on('error', (e) => finish(false, `socket error: ${e.message}`));
ws.on('message', (raw) => {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  const p = m.payload || {};
  if (m.type === 'error') out.errors.push(p.message || p);
  if (m.type === 'room_created') { send('set_game_type', { gameType: 'category-blitz' }); send('add_bot', { difficulty: 'medium' }); }
  if (m.type === 'room_update' && !started && (p.players || []).some((x) => x.isBot)) { started = true; send('start_game'); }
  if (m.type === 'round_start' && !submitted) {
    submitted = true;
    out.category = p.category;
    const list = BLITZ_LISTS.listFor(p.category);
    out.realWord = list && list.good && list.good[0];
    setTimeout(() => send('submit_answer', { answer: 'zzzzzzzz', category: p.category }), 4000);
    setTimeout(() => send('submit_answer', { answer: out.realWord, category: p.category }), 5000);
  }
  if (m.type === 'answer_result') {
    if (process.env.DEBUG) console.error(JSON.stringify(p));
    // a rejection does not echo the answer: the junk is the only thing this client submits that can fail
    const a = String(p.answer || p.word || '').toLowerCase();
    if (!p.accepted && !out.junk) out.junk = p.reason || p.code || 'rejected';
    else if (a === 'zzzzzzzz') out.junk = 'ACCEPTED';
    else if (out.realWord && a === out.realWord.toLowerCase()) out.real = 'accepted';
    if (out.junk && out.real) finish(out.junk === 'not_on_list' && out.real === 'accepted', 'junk rejected, real answer scored');
  }
});
