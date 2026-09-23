import test from 'node:test';
import assert from 'node:assert/strict';
import { HeartMonitor, hrSeries, coherence, lockIn, rmssd, HRV_FS } from '../src/heart.js';
import { Pacer, ResonanceAssessment, pickResonance, normalizeBreath } from '../src/breath.js';
import { SimulatedHeart } from '../src/sim.js';

function run(sim, monitor, seconds, onBeat) {
  for (let i = 0; i < seconds * 10; i++) monitor.push(sim.generate(0.1));
}

test('beat detector recovers simulated beats with a steady delay', () => {
  const sim = new SimulatedHeart({ seed: 4 });
  const truth = [];
  const push = sim.beatTimes.push.bind(sim.beatTimes);
  sim.beatTimes.push = (t) => { truth.push(t); return push(t); };
  const hm = new HeartMonitor();
  run(sim, hm, 120);
  const detected = hm.beats.filter(b => b.ok).map(b => b.t);
  const offsets = truth.slice(4, -2).map(t => detected.reduce((best, x) => Math.abs(x - t - 0.35) < Math.abs(best - t - 0.35) ? x : best, Infinity) - t);
  const hits = offsets.filter(d => Math.abs(d - 0.35) < 0.05);
  assert.ok(hits.length / offsets.length > 0.95, `matched ${hits.length} of ${offsets.length}`);
  const s = hm.summary();
  assert.equal(s.state, 'ok');
  assert.ok(s.hr > 50 && s.hr < 80, `hr ${s.hr}`);
  assert.ok(s.rmssd > 5 && s.rmssd < 120, `rmssd ${s.rmssd}`);
});

test('dropped packets advance the pulse clock', () => {
  const hm = new HeartMonitor();
  hm.pushPacket(10, [1, 2, 3, 4, 5, 6]);
  hm.pushPacket(13, [1, 2, 3, 4, 5, 6]);
  assert.equal(hm.time, (6 + 12 + 6) / 64);
});

test('coherence is high for a slow sine and low for noise', () => {
  const n = 60 * HRV_FS;
  const sine = Float64Array.from({ length: n }, (_, i) => 65 + 6 * Math.sin(2 * Math.PI * 0.1 * i / HRV_FS));
  let seed = 3;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const noise = Float64Array.from({ length: n }, () => 65 + (rand() - 0.5) * 8);
  const c1 = coherence(sine), c2 = coherence(noise);
  assert.ok(c1.value > 0.9, `sine ${c1.value}`);
  assert.ok(Math.abs(c1.peakHz - 0.1) < 0.006);
  assert.ok(c2.value < 0.4, `noise ${c2.value}`);
  const { amp } = lockIn(sine, 0.1);
  assert.ok(Math.abs(amp - 6) < 0.3, `amp ${amp}`);
});

test('hrSeries interpolates beats and refuses holes; rmssd uses adjacent clean beats', () => {
  const beats = [];
  let t = 0;
  for (let i = 0; i < 80; i++) { const ibi = i % 2 ? 0.9 : 1.0; t += ibi; beats.push({ t, ibi, ok: true }); }
  const s = hrSeries(beats, t, 60);
  assert.equal(s.length, 60 * HRV_FS);
  assert.ok(s.every(v => v >= 60 && v <= 66.7 + 1e-9));
  assert.ok(Math.abs(rmssd(beats, 0, t) - 100) < 1e-6);
  const holed = beats.filter(b => b.t < t - 40 || b.t > t - 30);
  assert.equal(hrSeries(holed, t, 60), null);
});

test('simulated heart is coherent when paced at its resonance and not when breathing freely', () => {
  const sim = new SimulatedHeart({ seed: 9, resonanceBpm: 5.5 });
  sim.compliance = 1;
  const hm = new HeartMonitor();
  run(sim, hm, 90);
  const free = hm.summary().coherence;
  sim.setBreathing(5.5);
  run(sim, hm, 90);
  const paced = hm.summary();
  assert.ok(paced.coherence > 0.8, `paced ${paced.coherence}`);
  assert.ok(paced.coherence > free + 0.25, `free ${free} paced ${paced.coherence}`);
  assert.ok(Math.abs(paced.peakHz - 5.5 / 60) < 0.01);
});

test('resonance assessment finds the simulated resonance rate', () => {
  for (const [seed, bpm, expected] of [[21, 5.1, 5], [22, 6.4, 6.5], [23, 5.9, 6]]) {
    const sim = new SimulatedHeart({ seed, resonanceBpm: bpm });
    sim.compliance = 1;
    const hm = new HeartMonitor();
    run(sim, hm, 20);
    const a = new ResonanceAssessment({ stepSec: 60, settleSec: 15 });
    sim.setBreathing(a.rate);
    let done = null, guard = 0;
    while (!done && guard++ < 10000) {
      hm.push(sim.generate(0.1));
      for (const e of a.tick(0.1, hm.time, hm.beats)) e.type === 'rate' ? sim.setBreathing(e.rate) : (done = e);
    }
    assert.equal(done.results.length, 6);
    assert.equal(done.rate, expected, `seed ${seed}: ${done.results.map(r => `${r.rate}:${r.swing?.toFixed(1)}`).join(' ')}`);
  }
});

test('pickResonance breaks near-ties on coherence and ignores invalid segments', () => {
  assert.equal(pickResonance([
    { rate: 6, valid: true, swing: 10, coherence: 0.7 },
    { rate: 5.5, valid: true, swing: 9.7, coherence: 0.9 },
    { rate: 5, valid: false, swing: null }
  ]), 5.5);
  assert.equal(pickResonance([{ rate: 6, valid: false }]), null);
});

test('pacer keeps its place across rate changes and marks each half', () => {
  const p = new Pacer({ rate: 6, inhale: 0.4 });
  const edges = [];
  for (let i = 0; i < 199; i++) { const s = p.step(0.1); if (s.edge) edges.push(s.edge); }
  assert.deepEqual(edges, ['out', 'in', 'out']); // 20 s at 6/min: just under two cycles
  const before = p.phase;
  p.set({ rate: 4.5 });
  assert.equal(p.phase, before);
  const top = new Pacer({ rate: 6, inhale: 0.4 });
  let s;
  for (let i = 0; i < 40; i++) s = top.step(0.1);
  assert.ok(s.level > 0.99, 'full at the end of a 4 s inhale');
  assert.equal(normalizeBreath({ rate: 99, inhale: 0.7 }).rate, 10);
  assert.equal(normalizeBreath({ inhale: 0.7 }).inhale, 0.4);
});
