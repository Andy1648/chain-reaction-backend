// scripts/wb-smoke.js — post-deploy Word Bomb smoke test against a live server (BACKEND RULE).
// Creates a private room, adds a MEDIUM bot, starts Word Bomb, and plays real words containing the
// fragment on its own turns until a word is ACCEPTED and the turn has passed to the bot and back.
// Exit 0 = healthy, 1 = failed. Usage: node scripts/wb-smoke.js [wss://url] [timeoutSec=90]
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const URL = process.argv[2] || 'wss://chain-reaction-backend-i6kx.onrender.com';
const LIMIT_MS = Number(process.argv[3] || 90) * 1000;
const WORDS = fs.readFileSync(path.join(__dirname, '..', 'botWords.txt'), 'utf8')
  .split(/\s+/).filter((w) => w.length >= 4 && w.length <= 9 && /^[a-z]+$/.test(w));

const ws = new WebSocket(URL);
const send = (type, payload = {}) => ws.send(JSON.stringify({ type, payload }));
const log = { accepted: [], rejected: [], botTurns: 0, myTurns: 0, errors: [], difficulty: null, fuse: null };
let me = null;
let started = false;
const used = new Set();
const finish = (ok, why) => {
  console.log(JSON.stringify({ ok, why, url: URL, ...log }, null, 2));
  try { ws.close(); } catch { /* closed */ }
  process.exit(ok ? 0 : 1);
};
setTimeout(() => finish(false, 'timeout'), LIMIT_MS);

ws.on('open', () => send('create_room', { name: 'zzsmoke', isPublic: false }));
ws.on('error', (e) => finish(false, `socket error: ${e.message}`));
ws.on('message', (raw) => {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  const p = m.payload || {};
  if (m.type === 'error') log.errors.push(p.message || p);
  if (m.type === 'room_created') {
    send('set_game_type', { gameType: 'word-bomb' });
    send('add_bot', { difficulty: 'medium' });
  }
  if (m.type === 'room_update') {
    me = me || p.hostId;
    log.difficulty = p.difficultyKey;
    if (!started && (p.players || []).some((x) => x.isBot)) { started = true; send('start_game'); }
  }
  if (m.type === 'turn_update') {
    if (log.fuse == null) log.fuse = p.timerSeconds;
    for (const w of p.usedWords || []) used.add(String(w).toLowerCase());
    if (p.currentPlayerId === me) {
      log.myTurns += 1;
      if (log.accepted.length && log.botTurns > 0) finish(true, 'accepted a word and the turn went to the bot and back');
      const combo = String(p.combo || '').toLowerCase();
      const w = WORDS.find((x) => x.includes(combo) && !used.has(x));
      if (w) { used.add(w); setTimeout(() => send('submit_word', { word: w, combo }), 400); }
    } else if (p.currentPlayerId) {
      log.botTurns += 1;
    }
  }
  if (m.type === 'word_result') (p.accepted ? log.accepted : log.rejected).push(p.word);
  if (m.type === 'game_over') finish(log.accepted.length > 0, 'game over');
});
