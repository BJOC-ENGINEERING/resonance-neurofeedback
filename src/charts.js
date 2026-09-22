// Canvas instruments: spectrum, spectrogram, raw traces, reward strip, session trend.
// Colours come from CSS custom properties so every palette restyles the charts.

import { BANDS, DF, FS } from './dsp.js';

let cached = null;
export function chartTheme() {
  if (cached) return cached;
  const css = getComputedStyle(document.body);
  const v = (name) => css.getPropertyValue(name).trim();
  cached = {
    txt: v('--txt'), muted: v('--txt-muted'), faint: v('--txt-faint'), line: v('--line'),
    accent: v('--accent'), bg: v('--bg-solid'), warn: v('--warn'), bad: v('--bad'),
    hue: Number(v('--wave-hue')) || 165,
    light: v('--scheme') === 'light',
    bands: Object.fromEntries(BANDS.map(b => [b.k, v(b.color)]))
  };
  return cached;
}
export function refreshChartTheme() { cached = null; }

const FONT = '10px ui-monospace, "SF Mono", Menlo, monospace';
const bandAt = (hz) => BANDS.find(b => hz >= b.lo && hz < b.hi) || (hz >= 45 ? null : hz < 1 ? null : BANDS[BANDS.length - 1]);

class Chart {
  constructor(canvas, { hover = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 300; this.h = 120;
    this.hoverX = null;
    this.fit();
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { this.fit(); this.redraw?.(); }).observe(canvas);
    if (hover) {
      this.tip = document.createElement('div');
      this.tip.className = 'chart-tip';
      canvas.parentElement.appendChild(this.tip);
      canvas.addEventListener('pointermove', e => {
        const r = canvas.getBoundingClientRect();
        this.hoverX = e.clientX - r.left;
        this.redraw?.();
      });
      canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.tip.classList.remove('show'); this.redraw?.(); });
    }
  }

  fit() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  showTip(x, html) {
    if (!this.tip) return;
    this.tip.innerHTML = html;
    this.tip.classList.add('show');
    const half = this.tip.offsetWidth / 2;
    this.tip.style.left = `${Math.max(half, Math.min(this.w - half, x))}px`;
  }

  crosshair(x, top, bottom) {
    const { ctx } = this;
    ctx.strokeStyle = chartTheme().faint;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 0.5, top); ctx.lineTo(x + 0.5, bottom); ctx.stroke();
  }
}

const MAX_HZ = 45;

export class SpectrumChart extends Chart {
  constructor(canvas) {
    super(canvas);
    this.scale = 'linear'; // 'linear' | 'log'
    this.peak = 1;
    this.shown = null;
    this.spectrum = null;
  }

  setScale(scale) { this.scale = scale; this.peak = 1; this.redraw(); }

  draw(spectrum) {
    this.spectrum = spectrum;
    if (spectrum) {
      // Ease bar motion only; readings elsewhere use the unsmoothed values.
      if (!this.shown || this.shown.length !== spectrum.length) this.shown = Float64Array.from(spectrum);
      else for (let k = 0; k < spectrum.length; k++) this.shown[k] += (spectrum[k] - this.shown[k]) * 0.35;
    }
    this.redraw();
  }

  redraw() {
    const { ctx, w, h } = this;
    const th = chartTheme();
    const pad = { l: 30, r: 6, t: 8, b: 16 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;

    const s = this.shown;
    const log = this.scale === 'log';
    const kMax = Math.floor(MAX_HZ / DF);
    let top = 1;
    if (s) {
      let max = 0;
      for (let k = 2; k <= kMax; k++) max = Math.max(max, s[k]);
      this.peak += (max - this.peak) * (max > this.peak ? 0.3 : 0.02);
      top = Math.max(this.peak * 1.15, 0.5);
    }
    const LOG_LO = -10, LOG_HI = 25; // dB re 1 µV²/Hz
    const yOf = (p) => {
      const n = log ? (10 * Math.log10(Math.max(p, 1e-3)) - LOG_LO) / (LOG_HI - LOG_LO) : p / top;
      return pad.t + ph * (1 - Math.max(0, Math.min(1, n)));
    };
    const xOf = (hz) => pad.l + (hz / MAX_HZ) * pw;

    // Recessive grid and axis labels.
    ctx.strokeStyle = th.line; ctx.fillStyle = th.faint; ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const ticks = log ? [0, 10, 20] : [top / 2, top];
    for (const tv of ticks) {
      const y = Math.round(log ? yOf(Math.pow(10, tv / 10)) : yOf(tv)) + 0.5;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillText(log ? `${tv}` : tv >= 10 ? tv.toFixed(0) : tv.toFixed(1), pad.l - 5, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const hz of [0, 10, 20, 30, 40]) ctx.fillText(String(hz), xOf(hz), h - pad.b + 4);

    if (!s) {
      ctx.fillStyle = th.muted; ctx.textBaseline = 'middle';
      ctx.fillText('waiting for signal', pad.l + pw / 2, pad.t + ph / 2);
      return;
    }

    // One filled segment per band, with a surface gap at each boundary.
    const base = pad.t + ph;
    for (const b of BANDS) {
      const k0 = Math.ceil(b.lo / DF), k1 = Math.floor(b.hi / DF);
      const x0 = xOf(b.lo) + 1, x1 = xOf(b.hi) - 1;
      ctx.beginPath();
      ctx.moveTo(x0, base);
      for (let k = k0; k <= k1; k++) ctx.lineTo(Math.max(x0, Math.min(x1, xOf(k * DF))), yOf(s[k]));
      ctx.lineTo(x1, base);
      ctx.closePath();
      ctx.globalAlpha = 0.28; ctx.fillStyle = th.bands[b.k]; ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      for (let k = k0; k <= k1; k++) {
        const x = Math.max(x0, Math.min(x1, xOf(k * DF))), y = yOf(s[k]);
        k === k0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = th.bands[b.k]; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    }

    if (this.hoverX !== null && this.hoverX >= pad.l && this.hoverX <= w - pad.r) {
      const hz = Math.round(((this.hoverX - pad.l) / pw) * MAX_HZ / DF) * DF;
      const k = Math.round(hz / DF);
      const band = bandAt(hz);
      this.crosshair(xOf(hz), pad.t, base);
      ctx.fillStyle = th.txt;
      ctx.beginPath(); ctx.arc(xOf(hz), yOf(s[k]), 3, 0, Math.PI * 2); ctx.fill();
      this.showTip(xOf(hz), `<b>${hz.toFixed(1)} Hz</b> ${this.spectrum[k].toFixed(2)} µV²/Hz${band ? ` · ${band.k}` : ''}`);
    }
  }
}

export class Spectrogram extends Chart {
  constructor(canvas, seconds = 60) {
    super(canvas, { hover: false });
    this.cols = 300;
    this.rows = Math.floor(MAX_HZ / DF);
    this.seconds = seconds;
    this.buffer = document.createElement('canvas');
    this.buffer.width = this.cols; this.buffer.height = this.rows;
    this.bctx = this.buffer.getContext('2d');
    this.acc = 0;
  }

  clear() { this.bctx.clearRect(0, 0, this.cols, this.rows); }

  push(spectrum, dt) {
    this.acc += dt;
    const step = this.seconds / this.cols;
    if (!spectrum || this.acc < step) return;
    this.acc = 0;
    const th = chartTheme();
    const b = this.bctx;
    b.globalCompositeOperation = 'copy';
    b.drawImage(this.buffer, -1, 0);
    b.globalCompositeOperation = 'source-over';
    b.clearRect(this.cols - 1, 0, 1, this.rows);
    // Sequential single-hue ramp: surface toward the accent hue.
    for (let r = 0; r < this.rows; r++) {
      const db = 10 * Math.log10(Math.max(spectrum[r + 1], 1e-3));
      const n = Math.max(0, Math.min(1, (db + 8) / 30));
      if (n < 0.04) continue;
      const l = th.light ? 92 - n * 66 : 10 + n * 62;
      b.fillStyle = `hsla(${th.hue}, 72%, ${l}%, ${0.25 + n * 0.75})`;
      b.fillRect(this.cols - 1, this.rows - 1 - r, 1, 1);
    }
  }

  redraw() {
    const { ctx, w, h } = this;
    const th = chartTheme();
    const pad = { l: 30, b: 16 };
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.buffer, pad.l, 0, w - pad.l, h - pad.b);
    ctx.font = FONT; ctx.fillStyle = th.faint;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const hz of [10, 20, 30, 40]) ctx.fillText(String(hz), pad.l - 5, (h - pad.b) * (1 - hz / MAX_HZ));
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left'; ctx.fillText(`−${this.seconds} s`, pad.l, h - pad.b + 4);
    ctx.textAlign = 'right'; ctx.fillText('now', w, h - pad.b + 4);
  }
}

export class TraceChart extends Chart {
  constructor(canvas) { super(canvas, { hover: false }); }

  // lanes: [{ name, samples (µV, newest last), state, selected }]
  draw(lanes) {
    const { ctx, w, h } = this;
    const th = chartTheme();
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT; ctx.textBaseline = 'middle';
    const padL = 64;
    const laneH = h / Math.max(1, lanes.length);
    lanes.forEach((lane, i) => {
      const mid = laneH * (i + 0.5);
      const stroke = lane.state === 'bad' || lane.state === 'off' ? th.bad : lane.state === 'artifact' ? th.warn : lane.selected ? th.accent : th.muted;
      ctx.textAlign = 'left';
      ctx.fillStyle = th.txt; ctx.fillText(lane.name, 0, mid - 6);
      ctx.fillStyle = th.muted; ctx.fillText(lane.state, 0, mid + 6);
      ctx.strokeStyle = th.line; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, Math.round(mid) + 0.5); ctx.lineTo(w, Math.round(mid) + 0.5); ctx.stroke();
      if (!lane.samples || lane.state === 'off') return;
      const n = lane.samples.length, span = 100; // ±100 µV per lane
      ctx.beginPath();
      for (let j = 0; j < n; j += 2) {
        const x = padL + (j / (n - 1)) * (w - padL);
        const y = mid - Math.max(-1, Math.min(1, lane.samples[j] / span)) * (laneH / 2 - 2);
        j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = stroke; ctx.lineWidth = 1.25; ctx.stroke();
    });
  }
}
TraceChart.SECONDS = 4;
TraceChart.SAMPLES = FS * 4;

// Reward index over time with the threshold at 0.5 and rewarded spans shaded.
export class StripChart extends Chart {
  constructor(canvas, { seconds = 60, stepSeconds = 0.1 } = {}) {
    super(canvas);
    this.step = stepSeconds;
    this.capacity = Math.round(seconds / stepSeconds);
    this.index = []; this.reward = [];
    this.live = true;
  }

  push(index, reward) {
    this.index.push(index); this.reward.push(reward ? 1 : 0);
    if (this.index.length > this.capacity) { this.index.shift(); this.reward.shift(); }
    this.redraw();
  }

  // Replace the data wholesale, e.g. a stored session timeline.
  load(index, reward, stepSeconds) {
    this.index = index; this.reward = reward; this.step = stepSeconds;
    this.capacity = Math.max(index.length, 2);
    this.live = false;
    this.redraw();
  }

  clear() { this.index = []; this.reward = []; this.redraw(); }

  redraw() {
    const { ctx, w, h } = this;
    const th = chartTheme();
    const pad = { l: 4, r: 4, t: 6, b: 6 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    ctx.clearRect(0, 0, w, h);
    const n = this.index.length;
    const xOf = (i) => pad.l + pw * ((this.capacity - n + i) / (this.capacity - 1));
    const yOf = (v) => pad.t + ph * (1 - v);

    ctx.fillStyle = th.accent; ctx.globalAlpha = 0.14;
    for (let i = 0; i < n; i++) {
      if (!this.reward[i]) continue;
      let j = i;
      while (j + 1 < n && this.reward[j + 1]) j++;
      ctx.fillRect(xOf(i), pad.t, Math.max(1, xOf(j) - xOf(i)), ph);
      i = j;
    }
    ctx.globalAlpha = 1;

    ctx.setLineDash([3, 4]); ctx.strokeStyle = th.faint; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, yOf(0.5) + 0.5); ctx.lineTo(w - pad.r, yOf(0.5) + 0.5); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = FONT; ctx.fillStyle = th.faint; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('threshold', pad.l + 2, yOf(0.5) - 2);

    if (n > 1) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) i === 0 ? ctx.moveTo(xOf(i), yOf(this.index[i])) : ctx.lineTo(xOf(i), yOf(this.index[i]));
      ctx.strokeStyle = th.accent; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    }

    if (this.hoverX !== null && n > 1) {
      const i = Math.round(((this.hoverX - pad.l) / pw) * (this.capacity - 1)) - (this.capacity - n);
      if (i >= 0 && i < n) {
        this.crosshair(xOf(i), pad.t, pad.t + ph);
        ctx.fillStyle = th.txt;
        ctx.beginPath(); ctx.arc(xOf(i), yOf(this.index[i]), 3, 0, Math.PI * 2); ctx.fill();
        const seconds = this.live ? (n - 1 - i) * this.step : i * this.step;
        const when = this.live ? `−${seconds.toFixed(0)} s` : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
        this.showTip(xOf(i), `<b>${when}</b> index ${this.index[i].toFixed(2)} · ${this.reward[i] ? 'rewarded' : 'below target'}`);
      }
    }
  }
}

// In-zone % per saved session, oldest to newest.
export class TrendChart extends Chart {
  draw(sessions) {
    this.sessions = sessions;
    this.redraw();
  }

  redraw() {
    const { ctx, w, h } = this;
    const th = chartTheme();
    const list = this.sessions || [];
    const pad = { l: 30, r: 4, t: 8, b: 6 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT; ctx.fillStyle = th.faint; ctx.strokeStyle = th.line; ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const pct of [0, 50, 100]) {
      const y = Math.round(pad.t + ph * (1 - pct / 100)) + 0.5;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillText(`${pct}%`, pad.l - 5, y);
    }
    if (!list.length) return;
    const slot = Math.min(28, pw / list.length);
    const bar = Math.max(3, slot - 2);
    const hovered = this.hoverX === null ? -1 : Math.floor((this.hoverX - pad.l) / slot);
    list.forEach((s, i) => {
      const x = pad.l + i * slot + 1;
      const bh = Math.max(2, ph * (s.stats.timeInZonePct / 100));
      ctx.fillStyle = th.accent;
      ctx.globalAlpha = hovered === -1 || hovered === i ? 1 : 0.45;
      ctx.beginPath();
      ctx.roundRect(x, pad.t + ph - bh, bar, bh, [Math.min(4, bar / 2), Math.min(4, bar / 2), 0, 0]);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    if (hovered >= 0 && hovered < list.length) {
      const s = list[hovered];
      this.showTip(pad.l + hovered * slot + bar / 2, `<b>${s.stats.timeInZonePct}% in zone</b> ${new Date(s.startedAt).toLocaleDateString()} · ${s.setup?.protocol?.name || s.protocol}`);
    } else this.tip?.classList.remove('show');
  }
}
