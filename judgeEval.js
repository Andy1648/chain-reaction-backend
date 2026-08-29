// judgeEval.js — evaluation harness for the Category Blitz AI judge (JOB 25).
// The judge (haikuValidator.validate) FAILS OPEN — it only ever REJECTS on a genuine model "no", and
// accepts on everything else. So its whole value is "does it correctly reject clear non-answers while
// never rejecting a reasonable one?". This harness runs the judge over a labeled fixture and reports
// precision/recall on the REJECT class (the decision that matters), plus accuracy and the exact miss
// list, so a prompt or model change can be measured instead of guessed.
//
// PURE: runEval takes the fixture + a judgeFn(category, answer) -> Promise<boolean> (true=accept), so
// it runs against the real model (model mode), a deterministic stub (CI), or any experiment, with no
// coupling to fetch/env. The metric math is what the unit test pins.

// Confusion matrix is framed on the REJECT class (positive = "should be rejected", i.e. expected===false):
//   tp = correctly rejected a bad answer      fn = wrongly ACCEPTED a bad answer (judge too soft)
//   fp = wrongly rejected a good answer        tn = correctly accepted a good answer
// A false-positive (fp) is the worst outcome for feel (a valid answer told it's wrong); a false-negative
// (fn) just lets a junk answer through (cheap in a party game). The report surfaces both lists.
async function runEval(fixture, judgeFn) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  const falseRejects = []; // good answers the judge wrongly rejected (fp) — the feel-breakers
  const falseAccepts = []; // bad answers the judge wrongly accepted (fn)
  for (const item of fixture) {
    const accepted = await judgeFn(item.category, item.answer); // true = accept
    const shouldAccept = item.expected === true;
    if (shouldAccept) {
      if (accepted) tn += 1;
      else {
        fp += 1;
        falseRejects.push(item);
      }
    } else {
      if (!accepted) tp += 1;
      else {
        fn += 1;
        falseAccepts.push(item);
      }
    }
  }
  const total = fixture.length;
  const denom = (a, b) => (a + b === 0 ? 1 : a + b); // avoid /0; a metric with no support reads 1.0
  const precisionReject = tp / denom(tp, fp); // of everything rejected, how much SHOULD be rejected
  const recallReject = tp / denom(tp, fn); // of everything that should be rejected, how much was
  const accuracy = (tp + tn) / (total || 1);
  const f1 =
    precisionReject + recallReject === 0
      ? 0
      : (2 * precisionReject * recallReject) / (precisionReject + recallReject);
  return { total, tp, fp, tn, fn, precisionReject, recallReject, f1, accuracy, falseRejects, falseAccepts };
}

// Pretty one-block report for the CLI / model runs.
function formatReport(r) {
  const pct = (x) => (x * 100).toFixed(1) + '%';
  const lines = [
    `JUDGE EVAL — ${r.total} cases`,
    `  reject precision ${pct(r.precisionReject)}  ·  reject recall ${pct(r.recallReject)}  ·  F1 ${pct(r.f1)}  ·  accuracy ${pct(r.accuracy)}`,
    `  tp(correct reject)=${r.tp}  tn(correct accept)=${r.tn}  fp(WRONG reject)=${r.fp}  fn(let junk in)=${r.fn}`,
  ];
  if (r.falseRejects.length) {
    lines.push('  FALSE REJECTS (valid answers wrongly rejected — the feel-breakers):');
    for (const m of r.falseRejects) lines.push(`    - "${m.answer}" in "${m.category}" (${m.note || ''})`);
  }
  if (r.falseAccepts.length) {
    lines.push('  FALSE ACCEPTS (clear non-answers let through):');
    for (const m of r.falseAccepts) lines.push(`    - "${m.answer}" in "${m.category}" (${m.note || ''})`);
  }
  return lines.join('\n');
}

module.exports = { runEval, formatReport };
