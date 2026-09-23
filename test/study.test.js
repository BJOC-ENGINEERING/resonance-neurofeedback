import test from 'node:test';
import assert from 'node:assert/strict';
import { nextCondition, ShamFeedback, shamProfile, scorePvt, compareConditions, normalizeStudy } from '../src/study.js';
import { normalizeProtocol } from '../src/protocol.js';

test('permuted blocks give an exact sham share', () => {
  let study = normalizeStudy({ sham: 'third' });
  const seen = [];
  for (let i = 0; i < 30; i++) {
    const { condition, queue } = nextCondition(study);
    seen.push(condition);
    study = { ...study, queue };
  }
  assert.equal(seen.filter(c => c === 'sham').length, 10);
  for (let i = 0; i < 30; i += 3) assert.equal(seen.slice(i, i + 3).filter(c => c === 'sham').length, 1);
  assert.equal(nextCondition(normalizeStudy({})).condition, 'real');
});

test('sham feedback matches the requested reward share', () => {
  for (const [rate, holdSec] of [[0.5, 0], [0.65, 1], [0.3, 0]]) {
    const sham = new ShamFeedback({ rate, meanOn: 3, holdSec, seed: 5 });
    let on = 0, edges = 0;
    const n = 36000;
    for (let i = 0; i < n; i++) { const r = sham.step(0.1); on += r.reward; if (r.edge === 'on') edges++; }
    assert.ok(Math.abs(on / n - rate) < 0.06, `rate ${rate}: got ${on / n}`);
    assert.ok(edges > 50);
  }
});

test('sham profile follows real sessions, or the auto target', () => {
  const sessions = [
    { condition: 'real', stats: { totalDurationSeconds: 300, timeInZonePct: 40, trueInZonePct: 40 }, timeline: { stepSeconds: 2, reward: [1, 1, 0, 1, 1, 1, 0] } },
    { condition: 'sham', stats: { totalDurationSeconds: 300, timeInZonePct: 90, trueInZonePct: 20 } }
  ];
  const manual = normalizeProtocol({ rules: [{ measure: 'alpha', mode: 'up', threshold: 105 }] });
  assert.deepEqual(shamProfile(sessions, manual), { rate: 0.4, meanOn: 5 });
  const auto = normalizeProtocol({ ...manual, difficulty: { mode: 'auto', rate: 0.7 } });
  assert.equal(shamProfile([], auto).rate, 0.7);
});

test('PVT scoring counts lapses and false starts', () => {
  const s = scorePvt([250, 300, null, 520, 280]);
  assert.deepEqual(s, { n: 4, medianMs: 290, speed: 3.21, lapses: 1, falseStarts: 1 });
  assert.equal(scorePvt([null]).medianMs, null);
});

test('conditions compare true reward and before/after change', () => {
  const mk = (condition, zone, preRt, postRt, guess) => ({
    condition, stats: { trueInZonePct: zone },
    checkins: { pre: { calm: 3, alert: 4, pvt: { medianMs: preRt } }, post: { calm: 5, alert: 4, pvt: { medianMs: postRt } }, guess }
  });
  const c = compareConditions([mk('real', 60, 300, 280, 'real'), mk('real', 50, 310, 300, 'sham'), mk('sham', 40, 300, 305, 'sham'), { stats: {} }]);
  assert.equal(c.real.n, 2);
  assert.equal(c.real.trueZone.mean, 55);
  assert.equal(c.real.rt.mean, -15);
  assert.equal(c.sham.rt.mean, 5);
  assert.equal(c.real.calm.mean, 2);
  assert.deepEqual(c.guesses, { total: 3, correct: 2 });
});
