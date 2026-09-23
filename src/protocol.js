// Protocol engine: measures, baseline calibration, reward / inhibit rules,
// hold-to-reward, and optional auto-thresholding toward a target reward rate.
// Pure logic, no DOM. Call evaluate() at a fixed analysis rate (10 Hz in the app).

import { BANDS, WINDOW, bandAmplitude, peakFrequency } from './dsp.js';

export const TRIAD = [[7, 8.5], [19, 21], [31.5, 33.5]];

export const MEASURES = [
  ...BANDS.map(b => ({ k: b.k, label: b.k[0].toUpperCase() + b.k.slice(1), range: `${b.lo}–${b.hi} Hz`, unit: 'µV', color: b.color })),
  { k: 'theta_beta', label: 'Theta / Beta', range: 'ratio', unit: '' },
  { k: 'alpha_theta', label: 'Alpha / Theta', range: 'ratio', unit: '' },
  { k: 'alpha_hi', label: 'Upper alpha', range: 'peak to +2 Hz', unit: 'µV' },
  { k: 'iaf', label: 'Alpha peak', range: '7–13 Hz', unit: 'Hz' },
  { k: 'asym', label: 'Alpha R / L', range: 'AF8 ÷ AF7', unit: '' },
  { k: 'triad', label: 'Resonance triad', range: '7.6 · 20 · 32.6 Hz', unit: 'µV' },
  // Absolute: the target is a fixed percentage, not a share of baseline. Read from the pulse.
  { k: 'coherence', label: 'Heart coherence', range: 'pulse · absolute %', unit: '%', absolute: true, heart: true, defaultThreshold: 60 }
];
export const MEASURE_BY_KEY = Object.fromEntries(MEASURES.map(m => [m.k, m]));

// Mean PSD across the given per-channel spectra.
export function compositeSpectrum(spectra) {
  if (!spectra.length) return null;
  const out = new Float64Array(WINDOW / 2 + 1);
  for (const s of spectra) for (let k = 0; k < out.length; k++) out[k] += s[k];
  for (let k = 0; k < out.length; k++) out[k] /= spectra.length;
  return out;
}

export const needsHeart = (protocol) => protocol.rules.some(r => MEASURE_BY_KEY[r.measure]?.heart);
export const needsEeg = (protocol) => protocol.rules.some(r => !MEASURE_BY_KEY[r.measure]?.heart);

// spectra: Map(channel -> PSD). selected: channel names feeding the composite.
// bands: standard BANDS, or personalBands(iaf) to anchor every edge to the alpha peak.
export function computeFeatures(spectra, selected, bands = BANDS) {
  const chosen = selected.map(name => spectra.get(name)).filter(Boolean);
  if (!chosen.length || chosen.length !== selected.length) return null;
  const spectrum = compositeSpectrum(chosen);
  const f = { spectrum };
  for (const b of bands) f[b.k] = bandAmplitude(spectrum, b.lo, b.hi);
  const alpha = bands.find(b => b.k === 'alpha');
  const peak = alpha.lo + 2; // the alpha peak sits 2 Hz above the band's lower edge
  f.alpha_hi = bandAmplitude(spectrum, peak, peak + 2);
  f.theta_beta = f.theta / Math.max(0.01, f.beta);
  f.alpha_theta = f.alpha / Math.max(0.01, f.theta);
  f.iaf = peakFrequency(spectrum, 7, 13);
  f.triad = TRIAD.reduce((sum, [lo, hi]) => sum + bandAmplitude(spectrum, lo, hi), 0) / TRIAD.length;
  const left = spectra.get('AF7'), right = spectra.get('AF8');
  f.asym = left && right
    ? bandAmplitude(right, alpha.lo, alpha.hi) / Math.max(0.01, bandAmplitude(left, alpha.lo, alpha.hi))
    : null;
  return f;
}

// mode: 'up' rewards at or above threshold, 'down' rewards at or below. threshold is % of baseline.
export const rule = (measure, mode, threshold) => ({ measure, mode, threshold });

export const PRESETS = [
  { id: 'calm', name: 'Calm focus', blurb: 'Raise alpha. The classic relaxed-attention starting point.', eyes: 'open or closed',
    rules: [rule('alpha', 'up', 105)], holdSec: 0 },
  { id: 'sharpen', name: 'Sharpen', blurb: 'Raise beta while keeping theta down. Gamma guard rejects jaw and brow tension.', eyes: 'open',
    rules: [rule('beta', 'up', 105), rule('theta', 'down', 100), rule('gamma', 'down', 140)], holdSec: 0.5 },
  { id: 'settle', name: 'Settle', blurb: 'Lower the theta/beta ratio: less drift, steadier engagement.', eyes: 'open',
    rules: [rule('theta_beta', 'down', 95)], holdSec: 0.5 },
  { id: 'deep', name: 'Deep', blurb: 'Let theta rise over alpha with eyes closed. Delta guard catches dozing.', eyes: 'closed',
    rules: [rule('alpha_theta', 'down', 95), rule('delta', 'down', 130)], holdSec: 1 },
  { id: 'peak', name: 'Alpha peak', blurb: 'Nudge your dominant alpha frequency upward.', eyes: 'open or closed',
    rules: [rule('iaf', 'up', 101)], holdSec: 1 },
  { id: 'balance', name: 'Balance', blurb: 'Shift frontal alpha toward the right forehead. Needs AF7 and AF8.', eyes: 'open',
    rules: [rule('asym', 'up', 103)], holdSec: 1 },
  { id: 'triad', name: 'Resonance', blurb: 'Three narrow lines at 7.63, 19.99 and 32.57 Hz, trained together.', eyes: 'open or closed',
    rules: [rule('triad', 'up', 105)], holdSec: 0 },
  { id: 'breath', name: 'Breath coherence', blurb: 'Follow the pacer at your resonance rate. Reward when your heart rhythm becomes a smooth, slow wave. Needs a pulse (Muse 2, Muse S, or the simulator).', eyes: 'open or closed',
    rules: [rule('coherence', 'up', 60)], holdSec: 0, pacer: true },
  { id: 'heartmind', name: 'Heart & mind', blurb: 'Paced breathing and alpha together: reward needs a coherent heart rhythm and alpha above baseline.', eyes: 'open or closed',
    rules: [rule('alpha', 'up', 105), rule('coherence', 'up', 50)], holdSec: 1, pacer: true }
];

export const DEFAULT_PROTOCOL = {
  presetId: 'calm',
  name: 'Calm focus',
  rules: PRESETS[0].rules.map(r => ({ ...r })),
  holdSec: 0,
  difficulty: { mode: 'manual', rate: 0.65 }
};

export function normalizeProtocol(p = {}) {
  const rules = Array.isArray(p.rules) ? p.rules
    .filter(r => r && MEASURE_BY_KEY[r.measure] && (r.mode === 'up' || r.mode === 'down'))
    .map(r => ({ measure: r.measure, mode: r.mode, threshold: clamp(Number(r.threshold) || 100, 10, 400) })) : [];
  return {
    presetId: p.presetId ?? null,
    name: String(p.name || 'Custom').slice(0, 40),
    rules,
    holdSec: clamp(Number(p.holdSec) || 0, 0, 10),
    difficulty: {
      mode: p.difficulty?.mode === 'auto' ? 'auto' : 'manual',
      rate: clamp(Number(p.difficulty?.rate) || 0.65, 0.2, 0.95)
    }
  };
}

export function describeProtocol(p) {
  if (!p.rules.length) return 'No rules enabled';
  const parts = p.rules.map(r => `${MEASURE_BY_KEY[r.measure].label} ${r.mode === 'up' ? '↑' : '↓'}`);
  const hold = p.holdSec > 0 ? `${p.holdSec.toFixed(1)} s hold` : 'instant reward';
  return `${parts.join(' · ')} · ${hold}`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const FEATURE_KEYS = MEASURES.map(m => m.k);
const SMOOTH_TAU = 0.4;        // s, EMA on features before rules see them
const PROVISIONAL_TAU = 15;    // s, drifting baseline used before calibration
const AUTO_WINDOW = 300;       // samples of trailing history per rule (30 s at 10 Hz)
const AUTO_MIN = 50;

export class ProtocolEngine {
  constructor(protocol = DEFAULT_PROTOCOL) {
    this.setProtocol(protocol);
  }

  setProtocol(protocol) {
    this.protocol = normalizeProtocol(protocol);
    this.resetBaseline();
  }

  // Rule, hold or difficulty edits keep the baseline: calibration captures every measure.
  updateProtocol(protocol) {
    this.protocol = normalizeProtocol(protocol);
    this.history.clear();
    this.autoThreshold.clear();
    this.resetReward();
  }

  resetBaseline() {
    this.baseline = null;
    this.provisional = null;
    this.calibration = null;
    this.smooth = null;
    this.history = new Map();
    this.autoThreshold = new Map();
    this.resetReward();
  }

  resetReward() {
    this.holdElapsed = 0;
    this.reward = false;
  }

  get calibrated() { return this.baseline !== null; }

  beginCalibration() {
    this.baseline = null;
    this.history.clear();
    this.autoThreshold.clear();
    this.calibration = Object.fromEntries(FEATURE_KEYS.map(k => [k, []]));
    this.resetReward();
  }

  // Returns false when too little clean signal was collected.
  finishCalibration() {
    const samples = this.calibration;
    this.calibration = null;
    if (!samples) return false;
    // Absolute measures need no baseline; every relative one needs clean samples.
    const needed = this.protocol.rules.filter(r => !MEASURE_BY_KEY[r.measure].absolute).map(r => r.measure);
    if (needed.some(k => samples[k].length < 10)) return false;
    this.baseline = {};
    for (const k of FEATURE_KEYS) this.baseline[k] = samples[k].length ? median(samples[k]) : null;
    return true;
  }

  thresholdFor(r) {
    return this.protocol.difficulty.mode === 'auto' && this.autoThreshold.has(r.measure)
      ? this.autoThreshold.get(r.measure)
      : r.threshold;
  }

  // features: from computeFeatures, or null when no spectrum is available.
  // valid: false while the signal is unusable (artifact, bad contact, break, pause).
  evaluate(features, dt, { valid = true } = {}) {
    const usable = valid && !!features;
    if (usable) this.track(features, dt);

    const reference = this.baseline || this.provisional;
    const rows = this.protocol.rules.map(r => {
      const absolute = MEASURE_BY_KEY[r.measure].absolute;
      const now = this.smooth?.[r.measure] ?? null;
      const base = absolute ? null : reference?.[r.measure] ?? null;
      const pct = now === null ? null : absolute ? now * 100 : base ? (now / base) * 100 : null;
      if (usable && pct !== null && (this.calibrated || absolute)) this.adapt(r, pct);
      const target = this.thresholdFor(r);
      const pass = usable && pct !== null && (r.mode === 'up' ? pct >= target : pct <= target);
      const margin = pct === null ? -1 : r.mode === 'up' ? pct / target - 1 : 1 - pct / target;
      return { ...r, now, base, pct, target, pass, margin };
    });

    const allPass = rows.length > 0 && rows.every(r => r.pass);
    const was = this.reward;
    if (allPass) this.holdElapsed += dt;
    else this.holdElapsed = 0;
    const holdSec = this.protocol.holdSec;
    this.reward = allPass && this.holdElapsed >= holdSec;

    const worst = rows.length ? Math.min(...rows.map(r => r.margin)) : -1;
    return {
      rows,
      allPass,
      reward: this.reward,
      edge: this.reward === was ? null : this.reward ? 'on' : 'off',
      holdProgress: holdSec > 0 ? clamp(this.holdElapsed / holdSec, 0, 1) : allPass ? 1 : 0,
      index: usable && rows.length ? 0.5 + 0.5 * Math.tanh(worst * 3) : 0,
      passing: rows.filter(r => r.pass).length,
      usable,
      calibrated: this.calibrated
    };
  }

  track(features, dt) {
    const a = 1 - Math.exp(-dt / SMOOTH_TAU);
    const b = 1 - Math.exp(-dt / PROVISIONAL_TAU);
    this.smooth ??= {};
    this.provisional ??= {};
    for (const k of FEATURE_KEYS) {
      const v = features[k];
      // An explicit null means the source stopped (e.g. the pulse was lost): drop the stale reading.
      if (v === null && k in features) { delete this.smooth[k]; continue; }
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      this.smooth[k] = this.smooth[k] === undefined ? v : this.smooth[k] + (v - this.smooth[k]) * a;
      this.provisional[k] = this.provisional[k] === undefined ? v : this.provisional[k] + (v - this.provisional[k]) * b;
      if (this.calibration) this.calibration[k].push(v);
    }
  }

  // Move each rule's threshold toward the quantile that yields the target pass rate.
  adapt(r, pct) {
    if (this.protocol.difficulty.mode !== 'auto') return;
    let h = this.history.get(r.measure);
    if (!h) this.history.set(r.measure, h = []);
    h.push(pct);
    if (h.length > AUTO_WINDOW) h.shift();
    if (h.length < AUTO_MIN) return;
    const perRule = Math.pow(this.protocol.difficulty.rate, 1 / this.protocol.rules.length);
    const goal = quantile(h, r.mode === 'up' ? 1 - perRule : perRule);
    const current = this.autoThreshold.get(r.measure) ?? r.threshold;
    this.autoThreshold.set(r.measure, current + (goal - current) * 0.05);
  }
}
