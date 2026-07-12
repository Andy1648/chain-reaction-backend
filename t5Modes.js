// t5Modes.js
// [T5] Registry for the T5 experimental game modes, so roomManager.js and
// server.js each need only tiny generic hooks instead of per-mode branches.
// Each mode is fully self-contained in its own t5*Mode.js file (pure logic +
// orchestrator); deleting a mode = delete its file(s) + its line here + its
// test entry in package.json.
//
// Plugin shape (see t5FuseMode.js for the reference implementation):
//   gameType     - the wire id used by set_game_type / room.gameType
//   minPlayers   - minimum players for start_game
//   logic        - { createGame(players, difficultyKey, solo, selectedPacks) }
//                  (consumed by roomManager's generic logicForGameType path)
//   start(room, helpers)                      - kick off round/turn 1
//   handleSubmit(room, connectionId, text, helpers) - a submit_word/answer
//   handleLeave(room, connectionId, helpers)  - a player left mid-game
// `helpers` is roomManager's injected facilities object; plugins never
// require roomManager (no cycles) and only use the room's standard timer
// slots, so every existing cleanup path tears them down unchanged.

const fuseMode = require('./t5FuseMode');

const MODES = {};
for (const mode of [fuseMode]) {
  MODES[mode.gameType] = mode;
}

// Error codes the T5 modes can return that server.js's humanizeError doesn't
// already cover. Looked up by humanizeError before its generic fallback.
const ERROR_MESSAGES = {
  not_holding_bomb: "You're not holding the bomb.",
};

module.exports = { MODES, ERROR_MESSAGES };
