// Paced breathing and resonance-rate assessment. Pure logic, no DOM.
// Resonance breathing: at one personal rate, near 6 breaths a minute, breathing and the
// baroreflex reinforce each other and heart rate swings widest. The assessment finds that rate
// by pacing a descending series of rates and measuring the breath-locked heart-rate swing.

import { hrSeries, lockIn, coherence, coverage, HRV_FS } from './heart.js';

export const RESONANCE_RATES = [7, 6.5, 6, 5.5, 5, 4.5];
export const DEFAULT_BREATH = { pacer: false, byPreset: false, rate: 6, inhale: 0.4, resonance: null };

export function normalizeBreath(b = {}) {
  const rate = Number(b.rate);
  const r = b.resonance;
  return {
    pacer: !!b.pacer,
    byPreset: !!b.pacer && !!b.byPreset, // a preset switched it on, so leaving that preset switches it off
    rate: Number.isFinite(rate) ? Math.round(Math.max(3, Math.min(10, rate)) * 10) / 10 : DEFAULT_BREATH.rate,
    inhale: b.inhale === 0.5 ? 0.5 : 0.4,
    resonance: r && Number.isFinite(r.rate) && Array.isArray(r.results) ? r : null
  };
}

const ease = (p) => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, p)))) / 2;

// Continuous breathing guide. Changing the rate changes the speed, never the current position.
export class Pacer {
  constructor({ rate = 6, inhale = 0.4 } = {}) {
    this.rate = rate;
    this.inhale = inhale;
    this.phase = 0; // 0..1 through the cycle, inhale first
  }

  set({ rate = this.rate, inhale = this.inhale } = {}) {
    this.rate = rate;
    this.inhale = inhale;
  }

  reset() { this.phase = 0; }

  // Returns { inhaling, progress (within the half), level (0 empty .. 1 full), edge ('in' | 'out' | null) }.
  step(dt) {
    const before = this.phase;
    this.phase = (this.phase + dt * this.rate / 60) % 1;
    const wrapped = this.phase < before;
    const crossed = before < this.inhale && this.phase >= this.inhale;
    return { ...this.read(), edge: wrapped ? 'in' : crossed ? 'out' : null };
  }

  read() {
    const inhaling = this.phase < this.inhale;
    const progress = inhaling ? this.phase / this.inhale : (this.phase - this.inhale) / (1 - this.inhale);
    return { inhaling, progress, level: inhaling ? ease(progress) : 1 - ease(progress) };
  }
}

// Breath-locked heart-rate swing (peak to trough, bpm), coherence and coverage for one paced segment.
export function scoreSegment(beats, from, to, rateBpm) {
  const span = to - from;
  const series = span >= 20 ? hrSeries(beats, to, span) : null;
  const cover = coverage(beats, from, to);
  if (!series || cover < 0.6) return { rate: rateBpm, valid: false, swing: null, coherence: null, coverage: cover };
  const { amp } = lockIn(series, rateBpm / 60, HRV_FS);
  const c = coherence(series, HRV_FS);
  const mean = series.reduce((s, v) => s + v, 0) / series.length;
  return { rate: rateBpm, valid: true, swing: 2 * amp, coherence: c?.value ?? null, peakHz: c?.peakHz ?? null, hr: mean, coverage: cover };
}

// The widest breath-locked swing wins. Rates within 5% of it are a tie, broken by coherence.
export function pickResonance(results) {
  const valid = results.filter(r => r.valid && r.swing !== null);
  if (!valid.length) return null;
  const best = Math.max(...valid.map(r => r.swing));
  const close = valid.filter(r => r.swing >= best * 0.95);
  close.sort((a, b) => (b.coherence ?? 0) - (a.coherence ?? 0));
  return close[0].rate;
}

// Steps through the rates. Each step paces for stepSec; the first settleSec are not scored.
export class ResonanceAssessment {
  constructor({ rates = RESONANCE_RATES, stepSec = 120, settleSec = 20 } = {}) {
    this.rates = rates;
    this.stepSec = stepSec;
    this.settleSec = Math.min(settleSec, stepSec / 2);
    this.index = 0;
    this.elapsed = 0;
    this.stepStartedAt = null;
    this.results = [];
    this.done = false;
  }

  get rate() { return this.rates[Math.min(this.index, this.rates.length - 1)]; }
  get remaining() { return Math.max(0, this.stepSec - this.elapsed); }
  get totalSec() { return this.rates.length * this.stepSec; }
  get progress() { return Math.min(1, (this.index * this.stepSec + this.elapsed) / this.totalSec); }

  // now: pulse-clock seconds. beats: the pulse detector's beat list.
  tick(dt, now, beats) {
    if (this.done) return [];
    if (this.stepStartedAt === null) this.stepStartedAt = now;
    this.elapsed += dt;
    if (this.elapsed < this.stepSec) return [];
    this.results.push(scoreSegment(beats, this.stepStartedAt + this.settleSec, now, this.rate));
    this.index++;
    this.elapsed = 0;
    this.stepStartedAt = now;
    if (this.index < this.rates.length) return [{ type: 'rate', rate: this.rate, index: this.index }];
    this.done = true;
    return [{ type: 'done', rate: pickResonance(this.results), results: this.results }];
  }
}
