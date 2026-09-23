// Synthetic EEG: pink background, band rhythms that wax and wane, optional artifacts.
// It feeds the same buffers as the headset, so the demo exercises the real pipeline.

import { FS, CHANNELS } from './dsp.js';

export const SIM_STATES = {
  calm:     { label: 'Calm',     delta: 0.7, theta: 0.8, alpha: 1.6, beta: 0.7, gamma: 0.6 },
  focus:    { label: 'Focused',  delta: 0.6, theta: 0.6, alpha: 0.8, beta: 1.6, gamma: 1.0 },
  deep:     { label: 'Deep',     delta: 1.2, theta: 1.7, alpha: 0.9, beta: 0.5, gamma: 0.4 },
  restless: { label: 'Restless', delta: 1.0, theta: 1.4, alpha: 0.6, beta: 1.1, gamma: 1.5 },
  drowsy:   { label: 'Drowsy',   delta: 1.9, theta: 1.3, alpha: 0.7, beta: 0.4, gamma: 0.3 }
};

const COMPONENTS = {
  delta: { freqs: [1.6, 2.9], uv: 11 },
  theta: { freqs: [4.8, 6.4], uv: 8 },
  alpha: { freqs: [9.4, 10.3, 11.3], uv: 9 },
  beta:  { freqs: [15.5, 20, 25.5], uv: 4 },
  gamma: { freqs: [33, 39.5], uv: 2.2 },
  triad: { freqs: [7.63, 19.99, 32.57], uv: 0 }
};

// Temporal sites carry more posterior alpha; frontal sites a little more beta.
const SITE_GAIN = {
  TP9:  { delta: 0.9, theta: 0.9, alpha: 1.25, beta: 0.9, gamma: 1.0, triad: 1 },
  AF7:  { delta: 1.1, theta: 1.1, alpha: 0.85, beta: 1.1, gamma: 1.0, triad: 1 },
  AF8:  { delta: 1.1, theta: 1.1, alpha: 0.85, beta: 1.1, gamma: 1.0, triad: 1 },
  TP10: { delta: 0.9, theta: 0.9, alpha: 1.25, beta: 0.9, gamma: 1.0, triad: 1 },
  AUX:  { delta: 1.0, theta: 1.0, alpha: 1.0, beta: 1.0, gamma: 1.0, triad: 1 }
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ornstein–Uhlenbeck process with unit stationary variance.
class Wander {
  constructor(tau) { this.tau = tau; this.x = 0; }
  step(dt, gauss) {
    const k = dt / this.tau;
    this.x += -this.x * k + Math.sqrt(2 * k) * gauss();
    return this.x;
  }
}

class Pink {
  constructor() { this.b = new Float64Array(7); }
  next(white) {
    const b = this.b;
    b[0] = 0.99886 * b[0] + white * 0.0555179;
    b[1] = 0.99332 * b[1] + white * 0.0750759;
    b[2] = 0.96900 * b[2] + white * 0.1538520;
    b[3] = 0.86650 * b[3] + white * 0.3104856;
    b[4] = 0.55000 * b[4] + white * 0.5329522;
    b[5] = -0.7616 * b[5] - white * 0.0168980;
    const out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + white * 0.5362;
    b[6] = white * 0.115926;
    return out * 0.11;
  }
}

export class SimulatedEEG {
  constructor({ seed = 1, channels = CHANNELS.filter(c => c !== 'AUX') } = {}) {
    this.rand = mulberry32(seed);
    this.channels = channels;
    this.state = 'calm';
    this.intensity = 0.6;
    this.stability = 0.7;
    this.triad = 0;
    this.artifacts = { blink: false, emg: false, mains: false, loose: false };
    this.n = 0;
    this.carry = 0;
    this.spare = null;

    this.oscillators = [];
    for (const [band, c] of Object.entries(COMPONENTS)) {
      for (const f of c.freqs) {
        this.oscillators.push({ band, f, phase: this.rand() * 2 * Math.PI, env: new Wander(0.9 + this.rand() * 1.4), drift: new Wander(0.6) });
      }
    }
    this.tides = Object.fromEntries(Object.keys(COMPONENTS).map(b => [b, new Wander(6 + this.rand() * 5)]));
    this.lateral = new Wander(7);
    this.pink = Object.fromEntries(channels.map(c => [c, new Pink()]));
    this.looseWalk = 0;
    this.blinkAt = -1;
    this.nextBlink = 2 + this.rand() * 4;
    this.emgUntil = 0;
    this.nextEmg = 5 + this.rand() * 6;
    this.emgPrev = Object.fromEntries(channels.map(c => [c, 0]));
  }

  gauss = () => {
    if (this.spare !== null) { const s = this.spare; this.spare = null; return s; }
    let u = 0;
    while (u === 0) u = this.rand();
    const r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * this.rand();
    this.spare = r * Math.sin(th);
    return r * Math.cos(th);
  };

  configure({ state, intensity, stability, triad, artifacts } = {}) {
    if (state && SIM_STATES[state]) this.state = state;
    if (Number.isFinite(intensity)) this.intensity = Math.max(0, Math.min(1, intensity));
    if (Number.isFinite(stability)) this.stability = Math.max(0, Math.min(1, stability));
    if (Number.isFinite(triad)) this.triad = Math.max(0, Math.min(1, triad));
    if (artifacts) Object.assign(this.artifacts, artifacts);
  }

  // Seconds of signal to synthesise. Returns { channel: Float32Array }.
  generate(dtSeconds) {
    const exact = Math.max(0, dtSeconds) * FS + this.carry;
    const count = Math.floor(exact);
    this.carry = exact - count;
    const out = Object.fromEntries(this.channels.map(c => [c, new Float32Array(count)]));
    const dt = 1 / FS;
    const profile = SIM_STATES[this.state];
    const swing = 0.18 + (1 - this.stability) * 0.55;

    for (let i = 0; i < count; i++, this.n++) {
      const t = this.n / FS;

      const tide = {};
      for (const band in this.tides) tide[band] = Math.max(0.15, 1 + this.tides[band].step(dt, this.gauss) * swing * 0.6);
      const lateral = 1 + this.lateral.step(dt, this.gauss) * 0.12;

      const bandSum = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, triad: 0 };
      for (const o of this.oscillators) {
        o.phase += 2 * Math.PI * (o.f + o.drift.step(dt, this.gauss) * 1.1) * dt;
        const level = o.band === 'triad'
          ? 6 * this.triad
          : COMPONENTS[o.band].uv * (1 + (profile[o.band] - 1) * this.intensity);
        const env = Math.max(0, 1 + o.env.step(dt, this.gauss) * swing);
        bandSum[o.band] += Math.sin(o.phase) * level * env * tide[o.band];
      }

      let blink = 0;
      if (this.artifacts.blink) {
        if (t >= this.nextBlink) { this.blinkAt = t; this.nextBlink = t + 3 + this.rand() * 5; }
        const since = t - this.blinkAt;
        if (this.blinkAt >= 0 && since < 0.5) blink = 210 * Math.exp(-(((since - 0.16) / 0.07) ** 2));
      }
      if (this.artifacts.emg && t >= this.nextEmg) {
        this.emgUntil = t + 0.8 + this.rand() * 1.2;
        this.nextEmg = this.emgUntil + 5 + this.rand() * 7;
      }
      const clench = this.artifacts.emg && t < this.emgUntil;
      const mains = this.artifacts.mains ? 14 * Math.sin(2 * Math.PI * 50 * t) : 0;
      if (this.artifacts.loose) this.looseWalk = this.looseWalk * 0.9995 + this.gauss() * 9;

      for (const name of this.channels) {
        const gain = SITE_GAIN[name];
        let v = this.pink[name].next(this.gauss()) * 14 + mains;
        for (const band in bandSum) {
          const side = band === 'alpha' && name === 'AF8' ? lateral : 1;
          v += bandSum[band] * gain[band] * side;
        }
        if (blink) v += blink * (name === 'AF7' || name === 'AF8' ? 1 : 0.12);
        if (clench) {
          const w = this.gauss() * (name.startsWith('TP') ? 42 : 26);
          v += w - this.emgPrev[name];
          this.emgPrev[name] = w;
        }
        if (this.artifacts.loose && name === 'AF7') v = v * 0.2 + this.looseWalk + this.gauss() * 70;
        out[name][i] = v;
      }
    }
    return out;
  }
}

// Synthetic pulse: heart rate follows breathing (respiratory sinus arrhythmia), with a personal
// resonance rate where the swing is widest. Beats come from integral pulse-frequency modulation and
// are rendered as a 64 Hz PPG waveform, so the demo runs through the real beat detector.
export class SimulatedHeart {
  static FS = 64;

  constructor({ seed = 7, restHr = 64, resonanceBpm = null } = {}) {
    this.rand = mulberry32(seed);
    this.restHr = restHr;
    // Personal resonance somewhere between 5 and 6.5 breaths a minute unless given.
    this.resonanceHz = (resonanceBpm ?? 5 + this.rand() * 1.5) / 60;
    this.paced = null;           // breaths per minute while following a pacer, else null
    this.compliance = 0.7;       // 0..1, how closely paced breathing keeps time with the guide
    this.t = 0;
    this.carry = 0;
    this.breathPhase = 0;
    this.spontaneous = new Wander(5);
    this.lf = new Wander(9);
    this.hf = new Wander(1.5);
    this.jitter = new Wander(3);
    this.heartPhase = 0.5;
    this.beatTimes = [];
    this.spare = null;
  }

  gauss = () => {
    if (this.spare !== null) { const s = this.spare; this.spare = null; return s; }
    let u = 0;
    while (u === 0) u = this.rand();
    const r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * this.rand();
    this.spare = r * Math.sin(th);
    return r * Math.cos(th);
  };

  // rateBpm: follow a pacer at this rate; null: breathe freely near 14 breaths a minute.
  setBreathing(rateBpm) { this.paced = Number.isFinite(rateBpm) ? rateBpm : null; }

  // Heart-rate swing amplitude (bpm) for breathing at f Hz: a vagal floor plus the resonance peak.
  rsaAmplitude(f) { return 2 + 6 / (1 + ((f - this.resonanceHz) / 0.012) ** 2); }

  generate(dtSeconds) {
    const fs = SimulatedHeart.FS;
    const exact = Math.max(0, dtSeconds) * fs + this.carry;
    const count = Math.floor(exact);
    this.carry = exact - count;
    const out = new Float32Array(count);
    const dt = 1 / fs;
    for (let i = 0; i < count; i++) {
      const breathHz = this.paced !== null
        ? this.paced / 60
        : Math.max(0.15, 0.24 + this.spontaneous.step(dt, this.gauss) * 0.05);
      // Free breathing is irregular; paced breathing keeps close time with the guide.
      this.breathPhase += 2 * Math.PI * breathHz * dt + this.jitter.step(dt, this.gauss) * (this.paced !== null ? 0.0004 + (1 - this.compliance) * 0.006 : 0.003);
      const lag = -Math.atan((breathHz - this.resonanceHz) / 0.012);
      const hr = this.restHr + this.lf.step(dt, this.gauss) * 2.2 + this.hf.step(dt, this.gauss) * 1.2 + this.rsaAmplitude(breathHz) * Math.sin(this.breathPhase + lag);

      const before = this.heartPhase;
      this.heartPhase += hr / 60 * dt;
      if (this.heartPhase >= 1) {
        this.heartPhase -= 1;
        this.beatTimes.push(this.t + dt * (1 - before) / (1 - before + this.heartPhase));
        if (this.beatTimes.length > 64) this.beatTimes.shift();
      }

      let pulse = 0;
      for (let k = this.beatTimes.length - 1; k >= 0; k--) {
        const tau = this.t - this.beatTimes[k] - 0.2; // pulse transit to the forehead
        if (tau > 1.2) break;
        if (tau < 0) continue;
        pulse += Math.exp(-(((tau - 0.1) / 0.06) ** 2)) + 0.35 * Math.exp(-(((tau - 0.38) / 0.08) ** 2));
      }
      const baseline = 0.4 * Math.sin(this.breathPhase) + this.gauss() * 0.03;
      out[i] = 52000 - 900 * (pulse + baseline);
      this.t += dt;
    }
    return out;
  }
}
