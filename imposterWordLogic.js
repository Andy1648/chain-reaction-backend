// imposterWordLogic.js
// Pure game-state logic for Imposter Word - a SOCIAL-DEDUCTION party mode.
// Every player is shown the SAME real category except one - the imposter -
// who is told only "You are the IMPOSTER. Blend in." The imposter has to
// reverse-engineer the category from everyone else's answers and bluff their
// way through. After a timed answer phase, everyone votes on who they think
// the imposter is. The imposter scores for surviving; the table scores for
// catching them. The highest cumulative score after a fixed number of rounds
// wins.
//
// This module is completely standalone and is PURE logic only - it has NO
// timers, NO networking, and NO AI/dictionary calls. Answers are judged by
// the human players (via the vote), never by an algorithm, so any text that
// clears the basic length/dedup rules is accepted as-is. The room manager
// owns the wall-clock phase timers; this file is just the rules operating on
// a plain game object.

const TOTAL_ROUNDS = 5;
const MIN_PLAYERS_TO_START = 3;

// Hard cap on submitted answer length (input hardening). Imposter answers are
// short phrases; 80 chars is generous for anything a human would type.
const MAX_ANSWER_LENGTH = 80;

// Per-difficulty phase lengths in seconds, as { answer, vote }. Harder
// difficulties give less time to think (and less time to deliberate the
// vote). Falls back to 'medium' for an unknown key.
const TIME_BY_DIFFICULTY = {
  easy: { answer: 40, vote: 30 },
  medium: { answer: 30, vote: 20 },
  hard: { answer: 20, vote: 15 },
};

// Category pairs. The `real` is what the non-imposters are shown; the `fake`
// is a related-but-different category included purely as informational/flavor
// so each pair reads as a tight thematic match. The imposter never sees the
// fake - they get the generic "blend in" notice. The two halves of every pair
// are deliberately CLOSE enough that answers could plausibly overlap; that
// overlap is exactly what lets the imposter hide, and what makes the table
// second-guess each other. Generic trivia is banned on purpose - every pair
// should make the table react.
const CATEGORY_PAIRS = [
  // Oddly specific shared experiences
  { real: 'Things your mom yelled from downstairs', fake: 'Things your dad yelled from the car' },
  { real: "Excuses you gave for not doing homework", fake: 'Excuses you gave for being late' },
  { real: 'Things you pretend to understand', fake: 'Things you pretend to like' },
  { real: 'Things you google at 3am', fake: 'Things you google at work' },
  { real: 'Sounds you hear in a school hallway', fake: 'Sounds you hear in a hospital' },
  { real: 'Things in your junk drawer', fake: 'Things under your bed' },
  { real: 'Things you say when you stub your toe', fake: 'Things you say when you drop your phone' },
  { real: 'Lies on your resume', fake: 'Lies on a dating profile' },
  { real: 'Things the weird kid did in class', fake: 'Things the class clown did' },
  { real: "Thoughts during an exam you didn't study for", fake: 'Thoughts during a job interview' },
  { real: 'Things you say to your dog that you mean for yourself', fake: 'Things you say to a baby' },
  { real: 'Reasons you left a group chat', fake: 'Reasons you left a party early' },
  { real: 'Things you do when you hear footsteps coming', fake: 'Things you do when the teacher walks by' },
  { real: 'Things you whisper in a library', fake: 'Things you whisper at a funeral' },
  { real: 'Excuses to leave a conversation', fake: 'Excuses to skip a meeting' },
  { real: 'Things you say to seem busy', fake: 'Things you say to seem smart' },
  { real: 'Things you rehearse before a phone call', fake: 'Things you rehearse before texting your crush' },
  { real: 'Things you blame on the dog', fake: 'Things you blame on your sibling' },
  { real: 'Things you panic-clean before guests arrive', fake: 'Things you hide before your mom visits' },
  { real: 'Things you say when the teacher asks why you were absent', fake: 'Things you say when the boss asks why you were late' },
  { real: 'Reasons you cancelled plans', fake: 'Reasons you ignored a text' },
  { real: 'Things you do to avoid eye contact', fake: 'Things you do to look busy in an elevator' },
  { real: 'Things you say to wrap up a phone call', fake: 'Things you say to end an awkward hug' },
  { real: 'Things you keep meaning to throw away', fake: 'Things you keep just in case' },
  { real: 'Things you do when the power goes out', fake: 'Things you do when the wifi goes down' },

  // Specific pop culture
  { real: 'SpongeBob characters', fake: 'Fairly OddParents characters' },
  { real: 'Minecraft mobs', fake: 'Terraria enemies' },
  { real: 'Things Shrek would say', fake: 'Things Donkey would say' },
  { real: 'GTA crimes', fake: 'Things you can do in Sims' },
  { real: 'Fortnite dances', fake: 'TikTok dances' },
  { real: 'Mario power-ups', fake: 'Sonic power-ups' },
  { real: 'Things in a Disney movie', fake: 'Things in a Pixar movie' },
  { real: 'Drake songs', fake: 'Kanye songs' },
  { real: 'Netflix shows you binged', fake: 'Netflix shows you quit after one episode' },
  { real: 'Pokemon types', fake: 'Yu-Gi-Oh card types' },
  { real: 'Star Wars planets', fake: 'Star Trek planets' },
  { real: 'Marvel villains', fake: 'DC villains' },
  { real: 'Things in a Harry Potter book', fake: 'Things in a Lord of the Rings book' },
  { real: 'Among Us tasks', fake: 'Fall Guys obstacles' },
  { real: 'Mario Kart items', fake: 'Crash Team Racing items' },
  { real: 'Things a Sims character says', fake: 'Things an Animal Crossing villager says' },
  { real: 'Zelda items', fake: 'Metroid power-ups' },
  { real: 'Things in a Wes Anderson movie', fake: 'Things in a Tim Burton movie' },
  { real: 'Things a Bond villain has', fake: 'Things a Bond gadget does' },
  { real: 'Friends episode plots', fake: 'Seinfeld episode plots' },
  { real: 'Things in a Studio Ghibli film', fake: 'Things in a Pixar short' },
  { real: 'Roblox game genres', fake: 'Minecraft server types' },
  { real: 'Things you find in a Mario level', fake: 'Things you find in a Sonic level' },
  { real: 'Taylor Swift song subjects', fake: 'Olivia Rodrigo song subjects' },

  // Absurd but answerable
  { real: "Things you shouldn't microwave", fake: "Things you shouldn't put in a blender" },
  { real: 'Worst first date ideas', fake: 'Worst job interview ideas' },
  { real: "Things that shouldn't be a sport but someone tried", fake: "Things that are a sport but shouldn't be" },
  { real: 'Foods that are suspicious', fake: 'Foods that look alive' },
  { real: "Things a villain would have in their fridge", fake: 'Things a hero would have in their fridge' },
  { real: 'Reasons your WiFi is slow', fake: "Reasons your car won't start" },
  { real: 'Things that are technically legal but feel illegal', fake: "Things that feel legal but aren't" },
  { real: "Animals that look like they're plotting something", fake: 'Animals that look permanently confused' },
  { real: 'Things you could win in a fight against', fake: 'Things that would win in a fight against you' },
  { real: 'Bad superpowers to have', fake: 'Superpowers that sound cool but are useless' },
  { real: 'Things that are bigger than they should be', fake: 'Things that are smaller than they should be' },
  { real: 'Worst things to hear from a surgeon', fake: 'Worst things to hear from a pilot' },
  { real: 'Things a haunted house would have', fake: 'Things a cursed object would do' },
  { real: 'Bad names for a boat', fake: 'Bad names for a racehorse' },
  { real: 'Things you do not want to find in your soup', fake: 'Things you do not want to find in your bed' },
  { real: 'Reasons a wizard would be fired', fake: 'Reasons a knight would be fired' },
  { real: 'Things a dragon would hoard', fake: 'Things a goblin would steal' },
  { real: 'Worst things to say at a wedding', fake: 'Worst things to say at a funeral' },
  { real: 'Things that should not glow but do', fake: 'Things that should glow but do not' },
  { real: 'Reasons aliens would skip Earth', fake: 'Reasons aliens would visit Earth' },
  { real: 'Things a robot would not understand about humans', fake: 'Things a cat does not understand about humans' },
  { real: 'Worst gifts to give a vampire', fake: 'Worst gifts to give a werewolf' },
  { real: 'Things that are oddly satisfying', fake: 'Things that are oddly stressful' },
  { real: 'Things you would NOT want on a rollercoaster', fake: 'Things you would NOT want on a plane' },

  // Niche knowledge that's still fun
  { real: "McDonald's menu items", fake: 'Burger King menu items' },
  { real: 'Things in a CVS receipt', fake: 'Things in an Amazon package' },
  { real: 'Things a gym bro says', fake: 'Things a yoga instructor says' },
  { real: 'Gas station purchases at 2am', fake: 'Walmart purchases at 2am' },
  { real: "Things in a teacher's desk", fake: "Things in a principal's office" },
  { real: 'Smells in a middle school', fake: 'Smells in a college dorm' },
  { real: 'Things on a diner menu', fake: 'Things on a hospital cafeteria menu' },
  { real: 'Things a barista shouts', fake: 'Things a bartender shouts' },
  { real: 'Items at a dollar store', fake: 'Items at a thrift store' },
  { real: 'Things in a hotel minibar', fake: 'Things in an airplane snack cart' },
  { real: 'Things a real estate agent says', fake: 'Things a car salesman says' },
  { real: 'Things in a first aid kit', fake: 'Things in a survival kit' },
  { real: 'Things in a kid\'s lunchbox', fake: 'Things in a hiker\'s backpack' },
  { real: 'Things a flight attendant says', fake: 'Things a tour guide says' },
  { real: 'Toppings at a frozen yogurt bar', fake: 'Toppings at a salad bar' },
  { real: 'Things in a dentist\'s office', fake: 'Things in a barbershop' },
  { real: 'Things you smell at a county fair', fake: 'Things you smell at a baseball game' },
  { real: 'Things a tech support person says', fake: 'Things a customer service rep says' },
  { real: 'Things at a farmers market', fake: 'Things at a flea market' },
  { real: 'Things in a hardware store', fake: 'Things in a craft store' },
  { real: 'Things a sports commentator says', fake: 'Things a nature documentary narrator says' },
  { real: 'Things on an IKEA showroom floor', fake: 'Things in a model home' },
  { real: 'Things in a vending machine', fake: 'Things at a concession stand' },
  { real: 'Things a museum tour guide points at', fake: 'Things an aquarium guide points at' },
  { real: 'Things you find in a grandma\'s purse', fake: 'Things you find in a dad\'s glovebox' },
  { real: 'Things a motivational poster says', fake: 'Things a fortune cookie says' },
  { real: 'Things on a road trip playlist', fake: 'Things on a workout playlist' },
  { real: 'Things you bring to a potluck', fake: 'Things you bring to a picnic' },
  { real: 'Things a wedding DJ plays', fake: 'Things a prom DJ plays' },

  // Scenario / vibe overlaps (curated batch) - two places or events whose
  // associations overlap hard, so the imposter can hide in the shared vibe.
  { real: 'A wedding', fake: 'A funeral' },
  { real: 'Disneyland', fake: 'Hell' },
  { real: 'A first date', fake: 'A job interview' },
  { real: 'The DMV', fake: 'Purgatory' },
  { real: 'IKEA', fake: "A maze you can't escape" },
  { real: 'A gym', fake: 'A nightclub' },
  { real: 'An aquarium', fake: 'A sushi restaurant' },
  { real: 'Prom', fake: 'A funeral' },
  { real: 'A petting zoo', fake: 'A Tinder date' },
  { real: 'A hospital', fake: 'A prison' },
  { real: "Grandma's house", fake: 'A haunted house' },
  { real: 'Going to the dentist', fake: 'Medieval torture' },
  { real: 'A camping trip', fake: 'The apocalypse' },
  { real: 'A baby shower', fake: 'A cult' },
  { real: 'Black Friday', fake: 'A zombie apocalypse' },
  { real: 'Thanksgiving dinner', fake: 'A political debate' },

  // Expansion batch - same rules: tight, reactable overlaps, school-appropriate.
  // Oddly specific / Gen-Z
  { real: 'Tabs open on your laptop right now', fake: 'Tabs playing audio you cannot find' },
  { real: 'Things in your camera roll', fake: 'Things in your screenshots folder' },
  { real: 'Things you do during a fire drill', fake: 'Things you do during a tornado drill' },
  { real: 'Reasons your phone is at one percent', fake: 'Reasons your storage is full' },
  { real: 'Things you say when you walk into the wrong class', fake: 'Things you say when you wave at the wrong person' },
  { real: 'Things you say when the group project does nothing', fake: 'Things you say when you carried the team' },
  { real: 'Things you do to look busy at work', fake: 'Things you do to look busy in class' },
  { real: 'Things you say to seem fine at the doctor', fake: 'Things you say to seem fine at the dentist' },
  // Specific pop culture
  { real: 'Stranger Things characters', fake: 'Wednesday characters' },
  { real: 'Anime main characters', fake: 'Anime villains' },
  { real: 'Things in a Pokemon game', fake: 'Things in a Digimon game' },
  { real: 'Roblox games', fake: 'Minecraft minigames' },
  { real: 'Billie Eilish song subjects', fake: 'Lana Del Rey song subjects' },
  { real: 'Things in a Fast and Furious movie', fake: 'Things in a Mission Impossible movie' },
  { real: 'Squid Game games', fake: 'Field day games' },
  { real: 'Things in a horror movie', fake: 'Things in a true crime documentary' },
  // Absurd but answerable
  { real: 'Things a final boss would say', fake: 'Things a tutorial NPC would say' },
  { real: 'Bad names for a pet snake', fake: 'Bad names for a guard dog' },
  { real: 'Reasons a superhero would call in sick', fake: 'Reasons a villain would take a day off' },
  { real: 'Things that would ruin a magic trick', fake: 'Things that would ruin a wedding' },
  { real: 'Things a ghost would complain about', fake: 'Things a zombie would complain about' },
  { real: 'Worst things to bring to a sleepover', fake: 'Worst things to bring to a campout' },
  { real: 'Things a dragon would post online', fake: 'Things a wizard would post online' },
  { real: 'Things you do not want your pilot to Google', fake: 'Things you do not want your surgeon to Google' },
  // Niche knowledge that's still fun
  { real: 'Things at a school book fair', fake: 'Things at a science fair' },
  { real: "Things in a nurse's office", fake: "Things in a guidance counselor's office" },
  { real: 'Things a lunch lady says', fake: 'Things a bus driver says' },
  { real: 'Things at a car dealership', fake: 'Things at a furniture store' },
  { real: 'Things you smell at a nail salon', fake: 'Things you smell at a hair salon' },
  { real: 'Things at a movie theater counter', fake: 'Things in a gas station fridge' },
  // Scenario / vibe overlaps
  { real: 'A middle school dance', fake: 'A wedding reception' },
  { real: 'A group project', fake: 'A hostage negotiation' },
  { real: 'A school assembly', fake: 'A cult meeting' },
  { real: 'A haunted corn maze', fake: 'A family reunion' },
  // ---- night/content-expand batch ----
  // Generated + machine-filtered by imposterPairsExpand.js: well-formed,
  // real != fake, deduped vs all of the above (4 candidates were dropped as
  // dups). Each is a tight, reactable overlap — close enough for the imposter to
  // hide, distinct enough for the table to catch a wrong-side answer.
  // Oddly specific / relatable
  { real: "Things you do when you can't sleep", fake: "Things you do when you're bored in class" },
  { real: 'Things in your school backpack', fake: 'Things in your gym bag' },
  { real: 'Things you say when you lose a game', fake: 'Things you say when you win a game' },
  { real: 'Things you forget to pack for a trip', fake: 'Things you forget at school' },
  { real: 'Things you hide from your parents', fake: 'Things you hide from your roommate' },
  { real: 'Things you say to get out of chores', fake: 'Things you say to skip the gym' },
  { real: 'Things you keep in your car', fake: 'Things you keep in your locker' },
  { real: 'Things you do in a waiting room', fake: 'Things you do in a long line' },
  { real: 'Things people do at a red light', fake: 'Things people do in an elevator' },
  // Specific pop culture
  { real: 'Pixar movies', fake: 'DreamWorks movies' },
  { real: 'Things in a Zelda game', fake: 'Things in a Mario game' },
  { real: 'Taylor Swift songs', fake: 'Olivia Rodrigo songs' },
  { real: 'Things in Stranger Things', fake: 'Things in a horror movie' },
  { real: 'SpongeBob locations', fake: 'Simpsons locations' },
  { real: 'Disney sidekicks', fake: 'Disney villains' },
  // Absurd but answerable
  { real: 'Worst superpowers', fake: 'Useless inventions' },
  { real: 'Things a villain monologues about', fake: 'Things a coach yells at halftime' },
  { real: "Things in a dragon's hoard", fake: "Things in a pirate's treasure" },
  { real: 'Things a robot would misunderstand', fake: 'Things an alien would misunderstand' },
  { real: 'Reasons the wifi is down', fake: 'Reasons the bus is late' },
  { real: "Things you'd ban as president", fake: "Things you'd ban as a teacher" },
  // Niche knowledge that's still fun
  { real: 'Greek gods', fake: 'Roman gods' },
  { real: 'Things on a Monopoly board', fake: 'Things in the game of Life' },
  { real: 'Planets in the solar system', fake: 'Moons in the solar system' },
  { real: 'Constellations', fake: 'Zodiac signs' },
  { real: 'Countries in Africa', fake: 'Countries in South America' },
  { real: 'Dog breeds', fake: 'Cat breeds' },
  { real: 'Types of clouds', fake: 'Types of storms' },
  { real: 'Famous paintings', fake: 'Famous sculptures' },
  // Scenario / vibe overlaps
  { real: 'Sounds at a carnival', fake: 'Sounds at an arcade' },
  { real: 'Smells at a campsite', fake: 'Smells at a barbecue' },
  { real: 'Things at a wedding', fake: 'Things at a prom' },
  { real: 'Things at a birthday party', fake: "Things at a New Year's party" },
  { real: 'Things you see at the beach', fake: 'Things you see at a pool' },
  { real: 'Things at a concert', fake: 'Things at a festival' },
  { real: 'Things on a road trip', fake: 'Things on a camping trip' },
  { real: 'Things in a hospital', fake: "Things in a dentist's office" },
  { real: 'Things at an airport', fake: 'Things at a train station' },
  { real: 'Things in a haunted house', fake: 'Things in a graveyard' },
  { real: 'Things at a sleepover', fake: 'Things at summer camp' },
  { real: 'Things in a science classroom', fake: 'Things in an art classroom' },
  { real: 'Things at a football game', fake: 'Things at a basketball game' },
  { real: 'Things in a movie theater', fake: 'Things at a bowling alley' },
  { real: 'Things in a kitchen', fake: 'Things in a garage' },
  { real: 'Things at a zoo', fake: 'Things at an aquarium' },
  { real: 'Things in a barbershop', fake: 'Things in a nail salon' },
  { real: 'Things in a gym', fake: 'Things in a locker room' },
];

/**
 * Picks a random category pair. If `excludeSet` (a Set of already-used pair
 * `real` strings) is given, the result is guaranteed not to be one of them, so
 * pairs never repeat across rounds. Falls back to the full list in the
 * (impossible at 5 rounds) case that every pair has been used.
 */
function pickRandomPair(excludeSet) {
  const pool = excludeSet
    ? CATEGORY_PAIRS.filter((p) => !excludeSet.has(p.real))
    : CATEGORY_PAIRS;
  const choices = pool.length ? pool : CATEGORY_PAIRS;
  return choices[Math.floor(Math.random() * choices.length)];
}

/**
 * Highest cumulative score wins. On a tie, the first player reaching that
 * score (by player order) is the winner. Returns null only if there are no
 * players at all.
 */
function determineWinner(game) {
  let winnerId = null;
  let best = -1;
  game.players.forEach((p) => {
    if (p.score > best) {
      best = p.score;
      winnerId = p.id;
    }
  });
  return winnerId;
}

/**
 * Creates a fresh Imposter Word game. One player (chosen by a random starting
 * index into the play order) is the imposter for round 1; the imposter slot
 * rotates one seat per round so everyone gets a turn over the game. Each
 * player tracks their own per-round answers, their current vote, and a
 * cumulative score plus caught/survived tallies across all rounds.
 */
function createGame(players, difficultyKey) {
  const timing = TIME_BY_DIFFICULTY[difficultyKey] || TIME_BY_DIFFICULTY.medium;
  const normalizedKey = TIME_BY_DIFFICULTY[difficultyKey] ? difficultyKey : 'medium';

  const order = players.map((p) => p.id);
  const imposterIndex = Math.floor(Math.random() * order.length);
  const imposterId = order[imposterIndex];

  const firstPair = pickRandomPair();
  const imposterCategory = 'You are the IMPOSTER. Blend in.';

  return {
    status: 'answering', // 'answering' | 'voting' | 'reveal' | 'between_rounds' | 'finished'
    difficultyKey: normalizedKey,
    rounds: TOTAL_ROUNDS,
    currentRound: 1,
    answerPhaseSeconds: timing.answer,
    votePhaseSeconds: timing.vote,
    order, // player ids in player order, used to rotate the imposter each round
    imposterIndex, // random starting index into `order`
    imposterId,
    currentPair: firstPair,
    currentCategory: firstPair.real, // what non-imposters see
    imposterCategory, // the literal blend-in notice the imposter sees
    usedCategoryPairs: new Set([firstPair.real]), // so pairs never repeat
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      score: 0, // cumulative across all rounds
      answers: [], // answers for the CURRENT round only (cleared each round)
      vote: null, // suspectId this player voted for this round (or null)
      wasImposter: p.id === imposterId, // true for THIS round's imposter
      caughtCount: 0, // rounds where this player correctly voted the imposter
      survivedCount: 0, // rounds this player (as imposter) survived the vote
    })),
    winnerId: null,
  };
}

/**
 * Records an answer from any player during the answer phase - there are no
 * turns, everyone answers at once. Validates phase, membership, length,
 * per-player answer cap, and per-player-per-round uniqueness. There is NO
 * algorithmic correctness check: the human vote is the only judge, so any text
 * that clears these basic rules is accepted exactly as typed (trimmed).
 *
 * Returns { accepted: true, answer, playerId, answerCount } on success
 *      or { accepted: false, reason, playerId } on failure, where reason is
 *         one of 'wrong_phase' | 'not_in_game' | 'too_short' | 'max_answers'
 *         | 'already_said'.
 */
function submitAnswer(game, playerId, rawAnswer) {
  if (game.status !== 'answering') {
    return { accepted: false, reason: 'wrong_phase', playerId };
  }

  const player = game.players.find((p) => p.id === playerId);
  if (!player) {
    return { accepted: false, reason: 'not_in_game', playerId };
  }

  const answer = rawAnswer.trim();
  const normalized = answer.toLowerCase();

  // Answers can legitimately be short, so the floor is just 2 characters.
  if (answer.length < 2) {
    return { accepted: false, reason: 'too_short', playerId };
  }

  // ...and capped (input hardening). There is NO algorithmic validation in
  // this mode - without a cap, 3 multi-KB blobs per player would be accepted
  // verbatim and broadcast to the whole room at the vote reveal.
  if (answer.length > MAX_ANSWER_LENGTH) {
    return { accepted: false, reason: 'too_long', playerId };
  }

  // Each player gets at most 3 answers per round.
  if (player.answers.length >= 3) {
    return { accepted: false, reason: 'max_answers', playerId };
  }

  // Only THIS player's answers for THIS round block a resubmission - two
  // different players naming the same thing is fine (and is in fact the whole
  // point of the overlap), and the same word is fair game again next round.
  if (player.answers.some((a) => a.toLowerCase() === normalized)) {
    return { accepted: false, reason: 'already_said', playerId };
  }

  player.answers.push(answer);

  return { accepted: true, answer, playerId, answerCount: player.answers.length };
}

/**
 * Records a vote during the voting phase. A player can't vote for themselves,
 * the voter and suspect must both be in the game, and re-voting is allowed -
 * a later vote simply overwrites the earlier one so a player can change their
 * mind. Sets the voter's `.vote` to the suspect id.
 *
 * Returns { accepted: true, voterId } on success
 *      or { accepted: false, reason } on failure, where reason is one of
 *         'wrong_phase' | 'not_in_game' | 'cannot_vote_self' | 'invalid_suspect'.
 */
function submitVote(game, voterId, suspectId) {
  if (game.status !== 'voting') {
    return { accepted: false, reason: 'wrong_phase' };
  }

  const voter = game.players.find((p) => p.id === voterId);
  if (!voter) {
    return { accepted: false, reason: 'not_in_game' };
  }

  if (voterId === suspectId) {
    return { accepted: false, reason: 'cannot_vote_self' };
  }

  const suspect = game.players.find((p) => p.id === suspectId);
  if (!suspect) {
    return { accepted: false, reason: 'invalid_suspect' };
  }

  // Overwrite any prior vote so a player can change their mind freely.
  voter.vote = suspectId;

  return { accepted: true, voterId };
}

/**
 * Helper: how many players have cast a (non-null) vote, out of the total. The
 * room manager can use this to decide whether to end the vote phase early once
 * everyone has voted.
 */
function countVotes(game) {
  const voted = game.players.filter((p) => p.vote !== null).length;
  return { voted, total: game.players.length };
}

/**
 * Closes the answer phase and opens voting. Flips status to 'voting' and
 * returns every player's answers (revealed now that answering is over), so the
 * table can read them and hunt for the imposter. Players with no answers are
 * still included.
 */
function endAnswerPhase(game) {
  game.status = 'voting';
  return {
    answers: game.players.map((p) => ({
      playerId: p.id,
      playerName: p.name,
      answers: [...p.answers],
    })),
    timerSeconds: game.votePhaseSeconds,
  };
}

/**
 * Closes the voting phase and resolves the round. Tallies every player's vote
 * and decides whether the imposter was caught: the imposter is caught ONLY if
 * they received STRICTLY MORE votes than any other single player (a clear
 * plurality). Ties, or no votes at all, mean the imposter SURVIVES - the game
 * deliberately favors the imposter for drama.
 *
 * Scoring: a surviving imposter gets +3 score and +1 survivedCount. If the
 * imposter is caught instead, every player who voted for them gets +1 score
 * and +1 caughtCount. Flips status to 'reveal'.
 *
 * Returns the full round resolution for the reveal screen.
 */
function endVotePhase(game) {
  const imposter = game.players.find((p) => p.id === game.imposterId);

  // Tally votes per suspect.
  const tally = {};
  game.players.forEach((p) => {
    if (p.vote !== null) {
      tally[p.vote] = (tally[p.vote] || 0) + 1;
    }
  });

  const imposterVotes = tally[game.imposterId] || 0;
  // The imposter is caught only with a strict plurality: more votes than any
  // OTHER single player. Any tie or zero votes lets the imposter survive.
  let maxOtherVotes = 0;
  Object.keys(tally).forEach((suspectId) => {
    if (suspectId !== game.imposterId && tally[suspectId] > maxOtherVotes) {
      maxOtherVotes = tally[suspectId];
    }
  });
  const imposterCaught = imposterVotes > 0 && imposterVotes > maxOtherVotes;

  if (imposterCaught) {
    // The table wins: everyone who fingered the imposter scores.
    game.players.forEach((p) => {
      if (p.vote === game.imposterId) {
        p.score += 1;
        p.caughtCount += 1;
      }
    });
  } else if (imposter) {
    // The imposter slips away: they score big for surviving.
    imposter.score += 3;
    imposter.survivedCount += 1;
  }

  game.status = 'reveal';

  return {
    imposterId: game.imposterId,
    imposterName: imposter ? imposter.name : null,
    imposterCaught,
    votes: game.players
      .filter((p) => p.vote !== null)
      .map((p) => ({ voterId: p.id, suspectId: p.vote })),
    realCategory: game.currentCategory,
    imposterCategory: game.imposterCategory,
    scores: game.players.map((p) => ({ id: p.id, name: p.name, score: p.score })),
  };
}

/**
 * Advances to the next round, or ends the game if the last round just
 * finished. When advancing: bumps the round counter, rotates the imposter one
 * seat forward in `order`, picks a fresh (non-repeating) pair, resets every
 * player's per-round answers and vote, re-stamps wasImposter, and flips status
 * back to 'answering'. Returns the new round info, or null when the game is
 * over (status set to 'finished' and winnerId resolved).
 */
function startNextRound(game) {
  if (game.currentRound >= game.rounds) {
    game.status = 'finished';
    game.winnerId = determineWinner(game);
    return null;
  }

  game.currentRound += 1;

  // Rotate the imposter one seat forward so the role goes around the table.
  game.imposterIndex = (game.imposterIndex + 1) % game.order.length;
  game.imposterId = game.order[game.imposterIndex];

  // Pick a brand-new pair we haven't used yet this game.
  const pair = pickRandomPair(game.usedCategoryPairs);
  game.currentPair = pair;
  game.currentCategory = pair.real;
  game.usedCategoryPairs.add(pair.real);

  game.players.forEach((p) => {
    p.answers = [];
    p.vote = null;
    p.wasImposter = p.id === game.imposterId;
  });

  game.status = 'answering';

  return {
    round: game.currentRound,
    totalRounds: game.rounds,
    timerSeconds: game.answerPhaseSeconds,
  };
}

/**
 * Returns the final results: the winner and the full scoreboard sorted by
 * cumulative score (highest first), with ties broken by player order.
 */
function getResults(game) {
  const finalScores = game.players
    .map((p, index) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      caughtCount: p.caughtCount,
      survivedCount: p.survivedCount,
      _order: index, // stable tiebreaker by player order
    }))
    .sort((a, b) => b.score - a.score || a._order - b._order)
    .map(({ _order, ...rest }) => rest);

  return {
    winnerId: game.winnerId,
    finalScores,
  };
}

module.exports = {
  CATEGORY_PAIRS,
  TOTAL_ROUNDS,
  MIN_PLAYERS_TO_START,
  TIME_BY_DIFFICULTY,
  createGame,
  submitAnswer,
  submitVote,
  countVotes,
  endAnswerPhase,
  endVotePhase,
  startNextRound,
  getResults,
  pickRandomPair,
};
