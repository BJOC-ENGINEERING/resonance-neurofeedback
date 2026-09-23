// Pulse and heart-rate variability from PPG. Pure logic, no DOM.
// PPG (64 Hz) -> band-pass -> beat times -> inter-beat intervals (IBIs) -> HR, RMSSD, coherence.
// Times are seconds on the pulse stream's own sample clock.

export const PPG_FS = 64;
export const HRV_FS = 4;               // Hz, resampled heart-rate series
export const COHERENCE_WINDOW = 60;    // s of heart rate behind each coherence reading
const MIN_COHERENCE_WINDOW = 30;
const PEAK_HALF_WIDTH = 0.03;          // Hz either side of the dominant rhythm
const HISTORY_SEC = 900;

// RBJ biquad. type: 'lowpass' | 'highpass'.
function biquad(type, f0, fs, q = Math.SQRT1_2) {
  const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), a = Math.sin(w) / (2 * q);
  const b = type === 'lowpass' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + a;
  const k = { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: -2 * c / a0, a2: (1 - a) / a0 };
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = k.b0 * x + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

const median = (v) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Streaming beat detector. Blood volume rises as reflected light falls, so the signal is inverted.
export class PulseDetector {
  constructor(fs = PPG_FS) {
    this.fs = fs;
    this.reset();
  }

  reset() {
    this.hp = biquad('highpass', 0.5, this.fs);
    this.lp = biquad('lowpass', 3.5, this.fs);
    this.n = 0;
    this.y1 = 0; this.y2 = 0;
    this.env = 0;
    this.pending = null;
    this.lastBeat = null;
    this.accepted = [];      // recent accepted IBIs, for the plausibility check
    this.rejectRun = 0;
    this.beats = [];         // { t, ibi, ok }
    this.lastSampleAt = -Infinity;
    this.warm = 0;
  }

  get time() { return this.n / this.fs; }

  // Advance the clock over a gap in the stream without inventing samples.
  skip(count) {
    this.n += count;
    this.pending = null;
    this.lastBeat = null;
  }

  push(samples) {
    const out = [];
    const decay = Math.pow(0.5, 1 / (2 * this.fs));
    for (const x of samples) {
      if (!Number.isFinite(x)) { this.n++; continue; }
      const y = -this.lp(this.hp(x));
      const t = this.n / this.fs;
      this.n++;
      this.warm++;
      this.env = Math.max(this.env * decay, Math.abs(y));
      // Local maximum at the previous sample, refined by a parabola through its neighbours.
      if (this.warm > this.fs * 2 && this.y1 > this.y2 && this.y1 >= y && this.y1 > this.env * 0.45) {
        const denom = this.y2 - 2 * this.y1 + y;
        const shift = denom ? Math.max(-0.5, Math.min(0.5, 0.5 * (this.y2 - y) / denom)) : 0;
        const tp = t - (1 - shift) / this.fs;
        const refractory = this.accepted.length >= 3 ? Math.min(1, Math.max(0.3, 0.6 * median(this.accepted))) : 0.3;
        if ((this.lastBeat === null || tp - this.lastBeat >= refractory) && (!this.pending || this.y1 > this.pending.v)) {
          this.pending = { t: tp, v: this.y1 };
        }
      }
      if (this.pending && t - this.pending.t > 0.25) {
        const beat = this.commit(this.pending.t);
        if (beat) out.push(beat);
        this.pending = null;
      }
      this.y2 = this.y1; this.y1 = y;
    }
    if (samples.length) this.lastSampleAt = this.time;
    return out;
  }

  commit(t) {
    const prev = this.lastBeat;
    this.lastBeat = t;
    if (prev === null) return null;
    const ibi = t - prev;
    // Plausible if close to the last clean interval (heart rate changes gradually, even across a
    // deep breath) or to the recent median. Missed or doubled beats land near 2× or 0.5× and fail both.
    const med = median(this.accepted);
    const last = this.accepted[this.accepted.length - 1];
    const ok = ibi >= 0.33 && ibi <= 1.8 && (this.accepted.length < 3
      || Math.abs(ibi - last) / last <= 0.2 || Math.abs(ibi - med) / med <= 0.25);
    if (ok) {
      this.accepted.push(ibi);
      if (this.accepted.length > 7) this.accepted.shift();
      this.rejectRun = 0;
    } else if (++this.rejectRun >= 4) {
      // Several implausible beats in a row: the reference is probably wrong, so relearn it.
      this.accepted = [];
      this.rejectRun = 0;
    }
    const beat = { t, ibi, ok };
    this.beats.push(beat);
    while (this.beats.length && this.beats[0].t < t - HISTORY_SEC) this.beats.shift();
    return beat;
  }
}

// Heart rate (bpm) at each clean beat, as [t, bpm] pairs.
function hrPoints(beats, from, to) {
  const pts = [];
  for (const b of beats) if (b.ok && b.t >= from && b.t <= to) pts.push([b.t, 60 / b.ibi]);
  return pts;
}

// Heart rate resampled onto a uniform grid ending at tEnd. Null when the window is poorly covered.
export function hrSeries(beats, tEnd, windowSec, fs = HRV_FS) {
  const t0 = tEnd - windowSec;
  const pts = hrPoints(beats, t0 - 3, tEnd);
  if (pts.length < 4 || pts[0][0] > t0 + 3 || pts[pts.length - 1][0] < tEnd - 4) return null;
  // Reject windows with long holes (missed or rejected beats).
  for (let i = 1; i < pts.length; i++) if (pts[i][0] - pts[i - 1][0] > 4) return null;
  const n = Math.floor(windowSec * fs);
  const out = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / fs;
    while (j < pts.length - 2 && pts[j + 1][0] < t) j++;
    const [ta, va] = pts[j], [tb, vb] = pts[Math.min(j + 1, pts.length - 1)];
    out[i] = t <= ta ? va : t >= tb ? vb : va + (vb - va) * (t - ta) / (tb - ta);
  }
  return out;
}

// Linear detrend and Hann window, shared by the spectrum and lock-in.
function prepare(series) {
  const n = series.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += series[i]; sxx += i * i; sxy += i * series[i]; }
  const slope = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
  const icpt = (sy - slope * sx) / n;
  const w = new Float64Array(n), x = new Float64Array(n);
  let wsum = 0, wsq = 0;
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    x[i] = (series[i] - (icpt + slope * i)) * w[i];
    wsum += w[i]; wsq += w[i] * w[i];
  }
  return { x, wsum, wsq };
}

function dft(x, f, fs) {
  let re = 0, im = 0;
  const step = -2 * Math.PI * f / fs;
  for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos(step * i); im += x[i] * Math.sin(step * i); }
  return { re, im };
}

// Power spectral density of a heart-rate series (bpm²/Hz) at 0.005 Hz steps up to 0.4 Hz.
export function hrvSpectrum(series, fs = HRV_FS, step = 0.005) {
  const { x, wsq } = prepare(series);
  const freqs = [], power = [];
  for (let f = step; f <= 0.4 + 1e-9; f += step) {
    const { re, im } = dft(x, f, fs);
    freqs.push(f);
    power.push(2 * (re * re + im * im) / (fs * wsq));
  }
  return { freqs, power, step };
}

// Share of 0.04–0.4 Hz heart-rate power within ±0.03 Hz of the dominant 0.04–0.26 Hz rhythm.
// A slow, smooth, sine-like rhythm scores near 1; an irregular one scores low.
export function coherence(series, fs = HRV_FS) {
  const { freqs, power } = hrvSpectrum(series, fs);
  let peak = -1, total = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] < 0.04 - 1e-9) continue;
    total += power[i];
    if (freqs[i] <= 0.26 + 1e-9 && (peak < 0 || power[i] > power[peak])) peak = i;
  }
  if (peak < 0 || total <= 0) return null;
  let near = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= 0.04 - 1e-9 && Math.abs(freqs[i] - freqs[peak]) <= PEAK_HALF_WIDTH + 1e-9) near += power[i];
  }
  return { value: near / total, peakHz: freqs[peak] };
}

// Amplitude and phase of the component at freq (Hz). Peak-to-trough swing is 2 × amp.
export function lockIn(series, freq, fs = HRV_FS) {
  const { x, wsum } = prepare(series);
  const { re, im } = dft(x, freq, fs);
  return { amp: 2 * Math.hypot(re, im) / wsum, phase: Math.atan2(im, re) };
}

// Root mean square of successive differences between adjacent clean IBIs, in ms.
export function rmssd(beats, from, to) {
  let sum = 0, n = 0;
  for (let i = 1; i < beats.length; i++) {
    const a = beats[i - 1], b = beats[i];
    if (!a.ok || !b.ok || b.t < from || b.t > to) continue;
    sum += ((b.ibi - a.ibi) * 1000) ** 2;
    n++;
  }
  return n >= 5 ? Math.sqrt(sum / n) : null;
}

// Share of the window's expected beats that were detected clean.
export function coverage(beats, from, to) {
  const ok = beats.filter(b => b.t >= from && b.t <= to && b.ok);
  if (ok.length < 2) return 0;
  const mean = ok.reduce((s, b) => s + b.ibi, 0) / ok.length;
  return Math.min(1, ok.length / ((to - from) / mean));
}

// Pulse stream plus rolling HRV summary. Feed samples with push(), read summary().
export class HeartMonitor {
  constructor(fs = PPG_FS) {
    this.detector = new PulseDetector(fs);
    this.lastIndex = null;
    this.summaryCache = null;
    this.summaryAt = -Infinity;
  }

  reset() {
    this.detector.reset();
    this.lastIndex = null;
    this.summaryCache = null;
    this.summaryAt = -Infinity;
  }

  get time() { return this.detector.time; }
  get beats() { return this.detector.beats; }

  push(samples) { return this.detector.push(samples); }

  // Muse packets carry a 16-bit sequence number; missing packets advance the clock.
  pushPacket(index, samples) {
    if (this.lastIndex !== null) {
      const missing = ((index - this.lastIndex + 65536) % 65536) - 1;
      if (missing > 0 && missing < 640) this.detector.skip(missing * samples.length);
    }
    this.lastIndex = index;
    return this.push(samples);
  }

  // Latest heart rate (bpm) linearly interpolated between clean beats, or null.
  hrAt(t) {
    const beats = this.beats;
    for (let i = beats.length - 1; i >= 1; i--) {
      const b = beats[i];
      if (!b.ok) continue;
      if (b.t <= t) {
        const next = beats.slice(i + 1).find(x => x.ok);
        if (!next) return 60 / b.ibi;
        return 60 / b.ibi + (60 / next.ibi - 60 / b.ibi) * (t - b.t) / (next.t - b.t);
      }
    }
    return null;
  }

  // state: 'off' (no stream) | 'searching' (no steady pulse yet) | 'ok'.
  summary(now = this.time, { streaming = true } = {}) {
    const c = this.summaryCache;
    if (c && c.streaming === streaming && now - this.summaryAt < 0.5 && now >= this.summaryAt) return c;
    const beats = this.beats;
    const recent = beats.filter(b => b.t > now - 10);
    const clean = recent.filter(b => b.ok);
    const lastOk = [...beats].reverse().find(b => b.ok);
    let state = !streaming ? 'off' : clean.length >= 5 && clean.length >= recent.length * 0.7 && lastOk && now - lastOk.t < 3 ? 'ok' : 'searching';
    const s = { state, streaming, hr: null, rmssd: null, coherence: null, peakHz: null, window: 0 };
    if (state === 'ok') {
      s.hr = 60 / median(clean.slice(-5).map(b => b.ibi));
      s.rmssd = rmssd(beats, now - 60, now);
      for (const w of [COHERENCE_WINDOW, 45, MIN_COHERENCE_WINDOW]) {
        const series = hrSeries(beats, now, w);
        if (!series) continue;
        const c = coherence(series);
        if (c) { s.coherence = c.value; s.peakHz = c.peakHz; s.window = w; }
        break;
      }
    }
    this.summaryCache = s;
    this.summaryAt = now;
    return s;
  }
}
