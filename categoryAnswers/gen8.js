// gen8.js  [cb-category-refine]
// Hand-curated bounded accept-lists for the 12 categories added to replace the
// weak/redundant/open-ended ones cut from the active pool. Same format as the
// other categoryAnswers/* files: one Set of lowercase answers per category,
// answers <=3 words, named/bounded sets. Seed lists; the Haiku judge covers the
// long tail. Keys MUST match the entries appended to CATEGORIES in
// categoryBlitzLogic.js exactly (note "Pokémon starters" keeps its accent).
module.exports = {
  "Pokémon starters": new Set(["bulbasaur", "charmander", "squirtle", "chikorita", "cyndaquil", "totodile", "treecko", "torchic", "mudkip", "turtwig", "chimchar", "piplup", "snivy", "tepig", "oshawott", "chespin", "fennekin", "froakie", "rowlet", "litten", "popplio", "grookey", "scorbunny", "sobble", "sprigatito", "fuecoco", "quaxly"]),
  "Video game consoles": new Set(["nes", "snes", "n64", "gamecube", "wii", "wii u", "switch", "switch 2", "ps1", "ps2", "ps3", "ps4", "ps5", "xbox", "xbox 360", "xbox one", "xbox series x", "game boy", "gameboy advance", "ds", "3ds", "psp", "ps vita", "sega genesis", "dreamcast", "steam deck", "atari"]),
  "Mario Kart items": new Set(["banana", "green shell", "red shell", "blue shell", "mushroom", "triple mushroom", "star", "bullet bill", "lightning", "boo", "bob-omb", "fire flower", "boomerang flower", "super horn", "golden mushroom", "coin", "blooper", "fake item box", "piranha plant", "mega mushroom"]),
  "Minecraft blocks": new Set(["dirt", "stone", "cobblestone", "grass block", "sand", "gravel", "oak planks", "obsidian", "diamond ore", "gold ore", "iron ore", "coal ore", "netherrack", "glowstone", "tnt", "crafting table", "furnace", "chest", "bedrock", "glass", "wool", "sandstone", "quartz", "redstone", "bookshelf"]),
  "Video game villains": new Set(["bowser", "ganondorf", "ganon", "dr eggman", "sephiroth", "wario", "ridley", "mother brain", "albert wesker", "handsome jack", "glados", "pyramid head", "kefka", "dr wily", "king k rool", "m bison", "shao kahn", "vaas", "nemesis", "bowser jr"]),
  "Battle royale games": new Set(["fortnite", "pubg", "apex legends", "warzone", "fall guys", "free fire", "naraka bladepoint", "hyper scape", "spellbreak", "realm royale", "knives out", "h1z1", "the finals", "super people", "ring of elysium", "blackout"]),
  "Taylor Swift albums": new Set(["taylor swift", "fearless", "speak now", "red", "1989", "reputation", "lover", "folklore", "evermore", "midnights", "the tortured poets department", "ttpd", "red taylors version", "1989 taylors version", "fearless taylors version"]),
  "Stranger Things characters": new Set(["eleven", "mike", "dustin", "lucas", "will", "max", "steve", "nancy", "jonathan", "hopper", "joyce", "robin", "eddie", "vecna", "demogorgon", "billy", "erica", "murray", "dr brenner", "argyle"]),
  "Continents": new Set(["africa", "antarctica", "asia", "australia", "oceania", "europe", "north america", "south america"]),
  "Oceans": new Set(["atlantic", "pacific", "indian", "arctic", "southern", "antarctic"]),
  "Wonders of the World": new Set(["great pyramid of giza", "hanging gardens of babylon", "statue of zeus", "temple of artemis", "mausoleum at halicarnassus", "colossus of rhodes", "lighthouse of alexandria", "great wall of china", "petra", "christ the redeemer", "machu picchu", "chichen itza", "colosseum", "taj mahal"]),
  "Donut types": new Set(["glazed", "jelly", "boston cream", "old fashioned", "cruller", "sprinkle", "chocolate", "maple", "powdered", "cinnamon", "bear claw", "fritter", "long john", "frosted", "twist", "custard", "bavarian cream", "double chocolate"]),
};
