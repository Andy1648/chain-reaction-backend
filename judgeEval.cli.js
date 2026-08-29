// judgeEval.cli.js — run the AI-judge eval against the REAL Haiku model and print precision/recall.
// This is NOT part of `npm test` (it needs a key + spends a little credit). Run:
//   ANTHROPIC_API_KEY=sk-... node judgeEval.cli.js
// Use it to check the judge PROMPT before/after a change: a drop in reject-precision (more false
// rejects — valid answers wrongly rejected) is the regression that most hurts game feel.
const { validate, isEnabled } = require('./haikuValidator');
const { runEval, formatReport } = require('./judgeEval');
const fixture = require('./judgeEvalFixture');

(async () => {
  if (!isEnabled()) {
    console.error('ANTHROPIC_API_KEY is not set — set it to run the model eval. (The unit suite runs keyless.)');
    process.exit(2);
  }
  // The judge fails open on the rate cap (10/min per player); use a unique playerId per call and a
  // small delay so the whole fixture is genuinely judged rather than silently rate-limited-through.
  let i = 0;
  const judgeFn = async (category, answer) => {
    i += 1;
    const verdict = await validate(category, answer, `eval-${i}`);
    await new Promise((r) => setTimeout(r, 150));
    return verdict;
  };
  const report = await runEval(fixture, judgeFn);
  console.log(formatReport(report));
})();
