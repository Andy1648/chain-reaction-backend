// judgeEval.test.js — pins the eval harness math + fixture integrity (JOB 25). Keyless & deterministic:
// the real-model run is a separate CLI (judgeEval.cli.js), never the unit suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runEval, formatReport } = require('./judgeEval');
const fixture = require('./judgeEvalFixture');

test('runEval computes the reject-class confusion matrix + metrics exactly', async () => {
  // A synthetic fixture with one of each outcome, and a mock judge with KNOWN verdicts:
  const synthetic = [
    { category: 'c', answer: 'good-accepted', expected: true }, // judge accepts -> tn
    { category: 'c', answer: 'good-rejected', expected: true }, // judge rejects -> fp
    { category: 'c', answer: 'bad-rejected', expected: false }, // judge rejects -> tp
    { category: 'c', answer: 'bad-accepted', expected: false }, // judge accepts -> fn
  ];
  const mock = async (_cat, answer) => answer === 'good-accepted' || answer === 'bad-accepted';
  const r = await runEval(synthetic, mock);
  assert.equal(r.total, 4);
  assert.equal(r.tp, 1);
  assert.equal(r.fp, 1);
  assert.equal(r.tn, 1);
  assert.equal(r.fn, 1);
  assert.equal(r.precisionReject, 0.5); // tp/(tp+fp)
  assert.equal(r.recallReject, 0.5); // tp/(tp+fn)
  assert.equal(r.accuracy, 0.5); // (tp+tn)/total
  assert.equal(r.falseRejects[0].answer, 'good-rejected');
  assert.equal(r.falseAccepts[0].answer, 'bad-accepted');
});

test('a perfect judge scores 100% and an all-accept judge scores 0% reject-recall', async () => {
  const perfect = async (_c, a) => !a.startsWith('bad'); // accepts good*, rejects bad*
  const synthetic = [
    { category: 'c', answer: 'good1', expected: true },
    { category: 'c', answer: 'bad1', expected: false },
  ];
  const p = await runEval(synthetic, perfect);
  assert.equal(p.accuracy, 1);
  assert.equal(p.precisionReject, 1);
  assert.equal(p.recallReject, 1);

  const allAccept = async () => true;
  const q = await runEval(synthetic, allAccept);
  assert.equal(q.recallReject, 0); // never rejects the bad one
  assert.equal(q.fp, 0); // ...but also never wrongly rejects a good one (fail-open safety)
});

test('the fixture is well-formed and covers both classes', () => {
  assert.ok(fixture.length >= 30, 'fixture should be a meaningful size');
  for (const c of fixture) {
    assert.equal(typeof c.category, 'string');
    assert.ok(c.category.length > 0);
    assert.equal(typeof c.answer, 'string');
    assert.ok(c.answer.length > 0);
    assert.equal(typeof c.expected, 'boolean');
  }
  const accepts = fixture.filter((c) => c.expected).length;
  const rejects = fixture.length - accepts;
  assert.ok(accepts >= 10 && rejects >= 10, 'both accept and reject classes must be well-represented');
});

test('runEval iterates the full real fixture without throwing (stub judge)', async () => {
  const stub = async () => true; // trivial fail-open stub
  const r = await runEval(fixture, stub);
  assert.equal(r.total, fixture.length);
  assert.equal(typeof formatReport(r), 'string');
});
