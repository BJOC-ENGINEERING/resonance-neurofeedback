import test from 'node:test';
import assert from 'node:assert/strict';
import { FS, WINDOW, Channel, psd, assessQuality } from '../src/dsp.js';
import { ProtocolEngine, computeFeatures, normalizeProtocol, PRESETS, MEASURE_BY_KEY } from '../src/protocol.js';
import { SessionClock, formatClock, normalizeTimer } from '../src/session.js';
import { SimulatedEEG } from '../src/sim.js';

const DT = 0.1;
const features = (alpha, extra = {}) => ({ delta: 5, theta: 5, alpha, beta: 5, gamma: 2, theta_beta: 1, alpha_theta: alpha / 5, iaf: 10, asym: 1, triad: 3, ...extra });

function calibrated(protocol, alpha = 10) {
  const engine = new ProtocolEngine(protocol);
  engine.beginCalibration();
  for (let i = 0; i < 50; i++) engine.evaluate(features(alpha), DT);
  assert.equal(engine.finishCalibration(), true);
  return engine;
}

const settle = (engine, f, seconds = 3, opts) => {
  let r;
  for (let i = 0; i < seconds / DT; i++) r = engine.evaluate(f, DT, opts);
  return r;
};

test('presets reference known measures and survive normalization', () => {
  for (const p of PRESETS) {
    const n = normalizeProtocol(p);
    assert.equal(n.rules.length, p.rules.length, p.id);
    for (const r of n.rules) assert.ok(MEASURE_BY_KEY[r.measure]);
  }
  assert.equal(normalizeProtocol({ rules: [{ measure: 'nope', mode: 'up' }] }).rules.length, 0);
});

test('baseline is the calibration median and rules compare against it', () => {
  const engine = calibrated({ rules: [{ measure: 'alpha', mode: 'up', threshold: 110 }] });
  assert.equal(engine.baseline.alpha, 10);
  assert.equal(settle(engine, features(10.5)).reward, false);
  const up = settle(engine, features(12));
  assert.equal(up.reward, true);
  assert.ok(Math.abs(up.rows[0].pct - 120) < 1);
  assert.ok(up.index > 0.5);
});

test('inhibit rule blocks reward until it passes', () => {
  const engine = calibrated({ rules: [
    { measure: 'alpha', mode: 'up', threshold: 105 },
    { measure: 'gamma', mode: 'down', threshold: 130 }
  ] });
  const tense = settle(engine, features(12, { gamma: 4 }));
  assert.equal(tense.reward, false);
  assert.equal(tense.passing, 1);
  assert.equal(settle(engine, features(12, { gamma: 2 })).reward, true);
});

test('hold delays reward and any failure restarts it', () => {
  const engine = calibrated({ rules: [{ measure: 'alpha', mode: 'up', threshold: 105 }], holdSec: 2 });
  settle(engine, features(8), 3);
  let r, ticks = 0;
  do { r = engine.evaluate(features(14), DT); ticks++; } while (!r.reward && ticks < 100);
  assert.ok(ticks * DT >= 2 && ticks * DT < 3.5, `reward after ${ticks * DT}s`);
  assert.equal(r.edge, 'on');
  const lost = engine.evaluate(features(14), DT, { valid: false });
  assert.equal(lost.reward, false);
  assert.equal(lost.edge, 'off');
  assert.equal(lost.holdProgress, 0);
});

test('calibration fails without enough clean signal', () => {
  const engine = new ProtocolEngine({ rules: [{ measure: 'alpha', mode: 'up', threshold: 105 }] });
  engine.beginCalibration();
  for (let i = 0; i < 50; i++) engine.evaluate(features(10), DT, { valid: false });
  assert.equal(engine.finishCalibration(), false);
  assert.equal(engine.calibrated, false);
});

test('auto difficulty steers the reward rate toward its target', () => {
  const engine = calibrated({ rules: [{ measure: 'alpha', mode: 'up', threshold: 100 }], difficulty: { mode: 'auto', rate: 0.7 } });
  let rewarded = 0, total = 0;
  for (let i = 0; i < 3000; i++) {
    const alpha = 9 + 2 * Math.sin(i / 17) + Math.sin(i / 5.3);
    const r = engine.evaluate(features(alpha), DT);
    if (i >= 1500) { total++; if (r.reward) rewarded++; }
  }
  const rate = rewarded / total;
  assert.ok(rate > 0.58 && rate < 0.82, `reward rate ${rate.toFixed(2)}`);
});

test('session clock runs calibration, blocks and breaks on usable time only', () => {
  const clock = new SessionClock({ blocks: 2, blockSec: 10, breakSec: 5, calibrationSec: 5 });
  const seen = [];
  const run = (seconds, valid = true) => { for (let i = 0; i < seconds / DT; i++) seen.push(...clock.tick(DT, { valid }).map(e => e.type)); };
  clock.start();
  run(3, false);
  assert.equal(clock.phase, 'calibrating');
  assert.equal(clock.phaseElapsed, 0);
  run(5.1);
  assert.equal(clock.phase, 'training');
  clock.pause(); run(4); clock.resume();
  run(10.1);
  assert.equal(clock.phase, 'break');
  run(5.1, false);
  assert.equal(clock.block, 2);
  run(10.1);
  assert.equal(clock.phase, 'finished');
  assert.deepEqual(seen, ['calibrated', 'block-start', 'block-end', 'break-start', 'block-start', 'block-end', 'finished']);
  assert.ok(Math.abs(clock.usableElapsed - 20) < 0.5);
  assert.equal(formatClock(125), '2:05');
  assert.equal(normalizeTimer({ blocks: 99, blockSec: 'x' }).blocks, 20);
});

function runSim(sim, seconds) {
  const channels = new Map(sim.channels.map(n => [n, new Channel(n)]));
  let now = 0;
  for (let i = 0; i < seconds * 10; i++) {
    now += 100;
    const chunk = sim.generate(0.1);
    for (const [name, samples] of Object.entries(chunk)) channels.get(name).push(samples, now);
  }
  const spectra = new Map();
  for (const [name, ch] of channels) {
    ch.spectrum = psd(ch.latest(WINDOW));
    spectra.set(name, ch.spectrum);
  }
  return { channels, spectra, now };
}

test('simulator keeps the sample rate and shapes the spectrum by state', () => {
  const sim = new SimulatedEEG({ seed: 7 });
  let n = 0;
  for (let i = 0; i < 600; i++) n += sim.generate(1 / 60).TP9.length;
  assert.ok(Math.abs(n - FS * 10) <= 1, `${n} samples in 10 s`);

  const avg = (state, key) => {
    let sum = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = new SimulatedEEG({ seed });
      s.configure({ state, intensity: 1, stability: 1 });
      sum += computeFeatures(runSim(s, 8).spectra, ['AF7', 'AF8'])[key];
    }
    return sum / 6;
  };
  assert.ok(avg('calm', 'alpha') > avg('focus', 'alpha') * 1.3);
  assert.ok(avg('focus', 'beta') > avg('calm', 'beta') * 1.3);
});

test('clean simulated signal reads good; blinks and loose contact are flagged', () => {
  const clean = runSim(new SimulatedEEG({ seed: 3 }), 6);
  for (const [, ch] of clean.channels) assert.match(assessQuality(ch, clean.now).state, /good|fair/);

  const loose = new SimulatedEEG({ seed: 3 });
  loose.configure({ artifacts: { loose: true } });
  const l = runSim(loose, 6);
  assert.equal(assessQuality(l.channels.get('AF7'), l.now).state, 'bad');
  assert.match(assessQuality(l.channels.get('AF8'), l.now).state, /good|fair/);

  const blinky = new SimulatedEEG({ seed: 3 });
  blinky.configure({ artifacts: { blink: true } });
  const channels = new Map(blinky.channels.map(n => [n, new Channel(n)]));
  let flagged = false;
  for (let i = 0, now = 0; i < 200; i++) {
    now += 100;
    for (const [name, samples] of Object.entries(blinky.generate(0.1))) channels.get(name).push(samples, now);
    if (assessQuality(channels.get('AF7'), now).blink) flagged = true;
  }
  assert.ok(flagged, 'a blink was detected within 20 s');
});
