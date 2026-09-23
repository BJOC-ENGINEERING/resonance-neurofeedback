// Signal processing: per-channel buffers, spectra, band amplitudes, signal quality.
// All amplitudes are in microvolts. Band amplitude = RMS µV within the band.

export const FS = 256;
export const CHANNELS = ['TP9', 'AF7', 'AF8', 'TP10', 'AUX'];
export const CHANNEL_INFO = {
  TP9: 'left ear', AF7: 'left forehead', AF8: 'right forehead', TP10: 'right ear', AUX: 'external cup'
};
export const FRONTAL = new Set(['AF7', 'AF8']);

export const WINDOW = 512;            // 2 s analysis window -> 0.5 Hz bins
export const DF = FS / WINDOW;
export const RING = FS * 20;          // 20 s of history per channel
export const RAIL_UV = 980;           // Muse 12-bit range is about ±1000 µV

export const BANDS = [
  { k: 'delta', lo: 1, hi: 4, color: '--delta' },
  { k: 'theta', lo: 4, hi: 8, color: '--theta' },
  { k: 'alpha', lo: 8, hi: 13, color: '--alpha' },
  { k: 'beta', lo: 13, hi: 30, color: '--beta' },
  { k: 'gamma', lo: 30, hi: 45, color: '--gamma' }
];

// In-place iterative radix-2 FFT.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    const wr = Math.cos(angle), wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const hann = Float64Array.from({ length: WINDOW }, (_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / (WINDOW - 1))));
const hannPower = hann.reduce((sum, w) => sum + w * w, 0);

// One-sided power spectral density in µV²/Hz, bins 0..WINDOW/2.
export function psd(samples) {
  const re = new Float64Array(WINDOW);
  const im = new Float64Array(WINDOW);
  let mean = 0;
  for (let i = 0; i < WINDOW; i++) mean += samples[i];
  mean /= WINDOW;
  for (let i = 0; i < WINDOW; i++) re[i] = (samples[i] - mean) * hann[i];
  fft(re, im);
  const out = new Float64Array(WINDOW / 2 + 1);
  for (let k = 0; k <= WINDOW / 2; k++) {
    const p = (re[k] * re[k] + im[k] * im[k]) / (FS * hannPower);
    out[k] = k === 0 || k === WINDOW / 2 ? p : 2 * p;
  }
  return out;
}

// RMS amplitude (µV) of the band [lo, hi] Hz, inclusive of bins whose centre lies inside.
export function bandAmplitude(spectrum, lo, hi) {
  let power = 0;
  const k0 = Math.max(1, Math.ceil(lo / DF - 1e-9));
  const k1 = Math.min(spectrum.length - 1, Math.floor(hi / DF + 1e-9));
  for (let k = k0; k <= k1; k++) power += spectrum[k] * DF;
  return Math.sqrt(power);
}

// Dominant frequency in [lo, hi] with parabolic interpolation between bins.
export function peakFrequency(spectrum, lo, hi) {
  const k0 = Math.max(1, Math.ceil(lo / DF));
  const k1 = Math.min(spectrum.length - 2, Math.floor(hi / DF));
  let best = k0;
  for (let k = k0; k <= k1; k++) if (spectrum[k] > spectrum[best]) best = k;
  const a = spectrum[best - 1], b = spectrum[best], c = spectrum[best + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denom)) : 0;
  return (best + shift) * DF;
}

export class Channel {
  constructor(name) {
    this.name = name;
    this.raw = new Float32Array(RING);
    this.hp = new Float32Array(RING);   // DC-removed, for display and artifact checks
    this.pos = 0;
    this.count = 0;
    this.lastSampleAt = 0;
    this.hpPrevX = 0;
    this.hpPrevY = 0;
    this.spectrum = null;
    this.quality = { state: 'off', std: 0, p2p: 0, emg: 0, railed: false, blink: false };
  }

  push(samples, now) {
    // One-pole high-pass at about 0.5 Hz.
    const a = 0.988;
    for (const x of samples) {
      if (!Number.isFinite(x)) continue;
      const y = a * (this.hpPrevY + x - this.hpPrevX);
      this.hpPrevX = x;
      this.hpPrevY = y;
      this.raw[this.pos] = x;
      this.hp[this.pos] = y;
      this.pos = (this.pos + 1) % RING;
      this.count++;
    }
    this.lastSampleAt = now;
  }

  latest(n, source = this.hp, out = new Float64Array(n)) {
    const available = Math.min(n, this.count, RING);
    const pad = n - available;
    for (let i = 0; i < pad; i++) out[i] = 0;
    for (let i = 0; i < available; i++) out[pad + i] = source[(this.pos - available + i + RING) % RING];
    return out;
  }

  reset() {
    this.raw.fill(0);
    this.hp.fill(0);
    this.pos = 0;
    this.count = 0;
    this.spectrum = null;
    this.hpPrevX = this.hpPrevY = 0;
    this.quality = { state: 'off', std: 0, p2p: 0, emg: 0, railed: false, blink: false };
  }
}

export const DEFAULT_QUALITY_LIMITS = {
  blinkUv: 150,
  motionUv: 250,
  noisyUv: 60,
  emgUv: 40
};

// Heuristic signal quality. Thresholds are tunable from settings.
export function assessQuality(channel, now, limits = DEFAULT_QUALITY_LIMITS) {
  const q = channel.quality;
  if (channel.count < WINDOW || now - channel.lastSampleAt > 1000) {
    Object.assign(q, { state: 'off', std: 0, p2p: 0, emg: 0, railed: false, blink: false });
    return q;
  }
  const second = channel.latest(FS);
  const recentRaw = channel.latest(FS, channel.raw);
  let mean = 0;
  for (const v of second) mean += v;
  mean /= second.length;
  let variance = 0;
  for (const v of second) variance += (v - mean) ** 2;
  const std = Math.sqrt(variance / second.length);

  // Blink / movement: peak-to-peak over the last half second.
  let lo = Infinity, hi = -Infinity;
  for (let i = FS / 2; i < FS; i++) { lo = Math.min(lo, second[i]); hi = Math.max(hi, second[i]); }
  const p2p = hi - lo;
  let railed = false;
  for (const v of recentRaw) if (Math.abs(v) >= RAIL_UV) { railed = true; break; }
  const emg = channel.spectrum ? bandAmplitude(channel.spectrum, 30, 45) : 0;

  const blink = FRONTAL.has(channel.name) && p2p > limits.blinkUv;
  const motion = p2p > limits.motionUv;
  let state = 'good';
  if (railed || std < 0.3 || std > limits.noisyUv) state = 'bad';
  else if (blink || motion || emg > limits.emgUv) state = 'artifact';
  else if (std > limits.noisyUv * 0.5) state = 'fair';
  Object.assign(q, { state, std, p2p, emg, railed, blink, motion });
  return q;
}

// Ratios for protocol training
export function thetaBetaRatio(spectrum) {
  const theta = bandAmplitude(spectrum, 4, 8);
  const beta = bandAmplitude(spectrum, 13, 30);
  return theta / Math.max(0.01, beta);
}

export function alphaThetaRatio(spectrum) {
  const alpha = bandAmplitude(spectrum, 8, 13);
  const theta = bandAmplitude(spectrum, 4, 8);
  return alpha / Math.max(0.01, theta);
}

export function alphaBetaRatioDb(spectrum) {
  const alpha = Math.max(1e-6, bandAmplitude(spectrum, 8, 13));
  const beta = Math.max(1e-6, bandAmplitude(spectrum, 13, 30));
  return 10 * Math.log10(alpha / beta);
}

// Normalized relative band powers (sum = 1.0)
export function relativeBandPowers(spectrum) {
  const raw = {
    delta: bandAmplitude(spectrum, 1, 4),
    theta: bandAmplitude(spectrum, 4, 8),
    alpha: bandAmplitude(spectrum, 8, 13),
    beta: bandAmplitude(spectrum, 13, 30),
    gamma: bandAmplitude(spectrum, 30, 45)
  };
  const total = Object.values(raw).reduce((sum, v) => sum + v, 0) || 1;
  return {
    delta: raw.delta / total,
    theta: raw.theta / total,
    alpha: raw.alpha / total,
    beta: raw.beta / total,
    gamma: raw.gamma / total,
    raw
  };
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Adaptive baseline with median and MAD spread, and tanh sigmoid response
export class AdaptiveBaseline {
  constructor(durationMs = 20000) {
    this.durationMs = durationMs;
    this.values = [];
    this.elapsed = 0;
    this.lastAt = null;
    this.baseline = null;
    this.spread = 1;
  }

  get ready() {
    return this.baseline !== null;
  }

  reset() {
    this.values = [];
    this.elapsed = 0;
    this.lastAt = null;
    this.baseline = null;
    this.spread = 1;
  }

  update(value, now) {
    if (value === null || !Number.isFinite(value)) return;
    if (this.lastAt !== null) {
      this.elapsed += Math.min(Math.max(now - this.lastAt, 0), 300);
    }
    this.lastAt = now;
    this.values.push(value);

    if (!this.ready && this.elapsed >= this.durationMs && this.values.length >= 10) {
      this.baseline = median(this.values);
      const absDevs = this.values.map(v => Math.abs(v - this.baseline));
      const mad = median(absDevs);
      this.spread = Math.max(0.1, mad * 1.4826);
    }
  }

  response(value, sensitivity = 1.0) {
    if (!this.ready) return 0.5;
    const norm = (value - this.baseline) / Math.max(0.01, this.spread);
    const tanh = Math.tanh(norm * 0.5 * sensitivity);
    return Math.max(0, Math.min(1, 0.5 + 0.45 * tanh));
  }
}

// Individual alpha frequency (IAF) bands: every edge up to 30 Hz moves with the alpha peak,
// so a 10 Hz peak gives the standard bands. Upper beta and gamma stay fixed.
export const IAF_RANGE = [7.5, 12.5];
export function personalBands(iaf) {
  if (!Number.isFinite(iaf)) return BANDS;
  const s = Math.max(IAF_RANGE[0], Math.min(IAF_RANGE[1], iaf)) - 10;
  const deltaTop = Math.max(2.5, 4 + s);
  return BANDS.map(b => {
    if (b.k === 'delta') return { ...b, hi: deltaTop };
    if (b.k === 'theta') return { ...b, lo: deltaTop, hi: 8 + s };
    if (b.k === 'alpha') return { ...b, lo: 8 + s, hi: 13 + s };
    if (b.k === 'beta') return { ...b, lo: 13 + s };
    return b;
  });
}

// Alpha peak from an averaged resting spectrum. The 1/f background is fitted in log-log space
// outside 7–14 Hz and removed; the peak is the centre of gravity of the power left above it
// between 7 and 13 Hz, which is steadier than the single highest bin when alpha is split or broad.
// strength: the largest rise above the background, in dB. Below about 1.5 dB there is no reliable peak.
export function estimateAlphaPeak(spectrum) {
  const pts = [];
  for (let k = 1; k < spectrum.length; k++) {
    const hz = k * DF;
    if (hz < 2 || hz > 40 || (hz >= 7 && hz <= 14) || (hz >= 48 && hz <= 52) || spectrum[k] <= 0) continue;
    pts.push([Math.log10(hz), Math.log10(spectrum[k])]);
  }
  if (pts.length < 8) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  const slope = sxy / sxx, icpt = my - slope * mx;
  const background = (k) => Math.pow(10, icpt + slope * Math.log10(k * DF));
  let num = 0, den = 0, rise = -Infinity;
  for (let k = Math.ceil(7 / DF); k <= Math.floor(13 / DF); k++) {
    const excess = Math.max(0, spectrum[k] - background(k));
    num += excess * k * DF;
    den += excess;
    rise = Math.max(rise, 10 * Math.log10(Math.max(spectrum[k], 1e-12) / background(k)));
  }
  if (den <= 0) return { iaf: null, strength: Math.round(rise * 10) / 10 };
  return { iaf: Math.round((num / den) * 10) / 10, strength: Math.round(rise * 10) / 10 };
}
