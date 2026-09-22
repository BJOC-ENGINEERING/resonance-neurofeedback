// Session clock: calibration, timed training blocks, breaks.
// Only usable signal advances calibration and block time. Pure logic, no DOM.

export const TIMER_PRESETS = [
  { id: 'quick', name: 'Quick', blocks: 1, blockSec: 120, breakSec: 0 },
  { id: 'standard', name: 'Standard', blocks: 3, blockSec: 180, breakSec: 20 },
  { id: 'long', name: 'Long', blocks: 7, blockSec: 240, breakSec: 30 }
];

export const DEFAULT_TIMER = { blocks: 3, blockSec: 180, breakSec: 20, calibrationSec: 20 };

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

export function normalizeTimer(t = {}) {
  return {
    blocks: clampInt(t.blocks, 1, 20, DEFAULT_TIMER.blocks),
    blockSec: clampInt(t.blockSec, 10, 3600, DEFAULT_TIMER.blockSec),
    breakSec: clampInt(t.breakSec, 0, 3600, DEFAULT_TIMER.breakSec),
    calibrationSec: clampInt(t.calibrationSec, 5, 120, DEFAULT_TIMER.calibrationSec)
  };
}

export const formatClock = (seconds) => {
  const s = Math.max(0, Math.ceil(seconds - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const describeTimer = (t) =>
  `${t.blocks} × ${formatClock(t.blockSec)}${t.blocks > 1 && t.breakSec ? ` · ${formatClock(t.breakSec)} breaks` : ''}`;

export class SessionClock {
  constructor(timer = DEFAULT_TIMER) {
    this.configure(timer);
  }

  configure(timer) {
    this.timer = normalizeTimer(timer);
    this.reset();
  }

  reset() {
    this.phase = 'idle'; // idle | calibrating | training | break | finished
    this.paused = false;
    this.block = 0;
    this.phaseElapsed = 0;
    this.usableElapsed = 0;
    this.wallElapsed = 0;
    this.resumeBlock = 0;
  }

  get active() { return this.phase === 'calibrating' || this.phase === 'training' || this.phase === 'break'; }
  get training() { return this.phase === 'training' && !this.paused; }
  get plannedSec() { return this.timer.blocks * this.timer.blockSec; }

  get phaseDuration() {
    if (this.phase === 'calibrating') return this.timer.calibrationSec;
    if (this.phase === 'training') return this.timer.blockSec;
    if (this.phase === 'break') return this.timer.breakSec;
    return 0;
  }

  get remaining() { return Math.max(0, this.phaseDuration - this.phaseElapsed); }
  get progress() { return this.phaseDuration ? Math.min(1, this.phaseElapsed / this.phaseDuration) : 0; }

  start() {
    this.reset();
    this.phase = 'calibrating';
    return [{ type: 'calibration-start' }];
  }

  pause() { if (this.active) this.paused = true; }
  resume() { this.paused = false; }

  finish() {
    if (!this.active) return [];
    const events = this.phase === 'training' ? [{ type: 'block-end', block: this.block, partial: true }] : [];
    this.phase = 'finished';
    this.paused = false;
    return [...events, { type: 'finished' }];
  }

  // valid: the signal is usable right now. Breaks run on wall time.
  tick(dt, { valid = true } = {}) {
    if (!this.active || this.paused) return [];
    this.wallElapsed += dt;
    if (this.phase !== 'break' && !valid) return [];
    this.phaseElapsed += dt;
    if (this.phase === 'training') this.usableElapsed += dt;
    if (this.phaseElapsed < this.phaseDuration) return [];

    this.phaseElapsed = 0;
    if (this.phase === 'calibrating') {
      this.phase = 'training';
      this.block = this.resumeBlock || 1;
      return [{ type: 'calibrated' }, { type: 'block-start', block: this.block }];
    }
    if (this.phase === 'training') {
      const ended = { type: 'block-end', block: this.block };
      if (this.block >= this.timer.blocks) {
        this.phase = 'finished';
        return [ended, { type: 'finished' }];
      }
      if (this.timer.breakSec > 0) {
        this.phase = 'break';
        return [ended, { type: 'break-start', block: this.block }];
      }
      this.block++;
      return [ended, { type: 'block-start', block: this.block }];
    }
    this.phase = 'training';
    this.block++;
    return [{ type: 'block-start', block: this.block }];
  }

  // Record a fresh baseline, then restart the current block.
  recalibrate() {
    this.resumeBlock = Math.max(1, this.block);
    this.phase = 'calibrating';
    this.phaseElapsed = 0;
  }
}
