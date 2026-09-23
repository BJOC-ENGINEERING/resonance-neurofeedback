// Self-experiment tools: blinded sham sessions, check-in scoring and real-versus-sham comparison.
// Pure logic, no DOM.

export const SHAM_SHARES = { off: 0, third: 1 / 3, half: 1 / 2 };
export const DEFAULT_STUDY = { checkin: false, sham: 'off', queue: [] };

export function normalizeStudy(s = {}) {
  return {
    checkin: !!s.checkin,
    sham: s.sham in SHAM_SHARES ? s.sham : 'off',
    queue: Array.isArray(s.queue) ? s.queue.filter(c => c === 'real' || c === 'sham').slice(0, 8) : []
  };
}

// Permuted blocks keep the sham share exact over every few sessions without making it guessable:
// 1 in 3 draws from shuffled blocks of [sham, real, real]; 1 in 2 from [sham, sham, real, real].
export function nextCondition(study, rand = Math.random) {
  const share = SHAM_SHARES[study.sham] ?? 0;
  if (!share) return { condition: 'real', queue: [] };
  let queue = [...study.queue];
  if (!queue.length) {
    queue = share === 0.5 ? ['sham', 'sham', 'real', 'real'] : ['sham', 'real', 'real'];
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
  }
  const condition = queue.shift();
  return { condition, queue };
}

// Reward rate and typical reward-run length from recent real sessions, so sham feedback
// looks and feels like the viewer's own.
export function shamProfile(sessions, protocol) {
  const usable = sessions.filter(s => (s.condition || 'real') === 'real' && s.stats?.totalDurationSeconds > 20);
  // Prefer sessions that trained the same measures; reward patterns differ a lot between protocols.
  const target = protocol.rules.map(r => r.measure).join('+');
  const same = usable.filter(s => s.target === target);
  const real = (same.length >= 2 ? same : usable).slice(0, 10);
  const rates = real.map(s => (s.stats.trueInZonePct ?? s.stats.timeInZonePct) / 100).sort((a, b) => a - b);
  let rate = protocol.difficulty.mode === 'auto' ? protocol.difficulty.rate
    : rates.length ? rates[rates.length >> 1] : 0.5;
  rate = Math.max(0.2, Math.min(0.85, rate));
  const runs = [];
  for (const s of real) {
    const line = s.timeline;
    if (!line?.reward?.length) continue;
    let run = 0;
    for (const r of [...line.reward, 0]) {
      if (r) run++;
      else if (run) { runs.push(run * line.stepSeconds); run = 0; }
    }
  }
  const meanOn = runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : 3;
  return { rate, meanOn: Math.max(1.5, Math.min(8, meanOn)) };
}

// Sham feedback: a two-state process with the given reward share and mean reward run, plus a
// wandering index that tracks it. Holds are rehearsed too: a ring fills, and sometimes breaks.
export class ShamFeedback {
  constructor({ rate = 0.5, meanOn = 3, holdSec = 0, seed = Date.now() } = {}) {
    let a = seed >>> 0;
    this.rand = () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.meanOn = meanOn;
    this.holdSec = holdSec;
    // Stationary share on = meanOn / (meanOn + meanOff + hold time spent before each run).
    this.meanOff = Math.max(0.5, meanOn * (1 - rate) / rate - holdSec);
    this.state = 'off';         // 'off' | 'hold' | 'on'
    this.left = this.draw(this.meanOff);
    this.holdLeft = 0;
    this.holdBreak = null;
    this.index = 0.35;
    this.target = 0.35;
    this.reward = false;
  }

  draw(mean) { return -Math.log(1 - this.rand()) * mean; }

  step(dt) {
    const was = this.reward;
    this.left -= dt;
    if (this.state === 'off' && this.left <= 0) {
      if (this.holdSec > 0) {
        this.state = 'hold';
        this.holdLeft = this.holdSec;
        this.holdBreak = this.rand() < 0.3 ? this.holdSec * (0.2 + this.rand() * 0.6) : null;
      } else {
        this.state = 'on';
        this.left = this.draw(this.meanOn);
      }
    } else if (this.state === 'hold') {
      this.holdLeft -= dt;
      if (this.holdBreak !== null && this.holdSec - this.holdLeft >= this.holdBreak) {
        this.state = 'off';
        this.left = this.draw(this.meanOff * 0.4);
      } else if (this.holdLeft <= 0) {
        this.state = 'on';
        this.left = this.draw(this.meanOn);
      }
    } else if (this.state === 'on' && this.left <= 0) {
      this.state = 'off';
      this.left = this.draw(this.meanOff);
    }
    this.reward = this.state === 'on';
    if (this.rand() < dt * 0.8) this.target = this.reward ? 0.62 + this.rand() * 0.3 : 0.15 + this.rand() * 0.3;
    if (this.reward && this.target < 0.55) this.target = 0.7;
    if (!this.reward && this.state !== 'hold' && this.target > 0.48) this.target = 0.35;
    if (this.state === 'hold') this.target = 0.52 + 0.1 * (1 - this.holdLeft / this.holdSec);
    this.index += (this.target - this.index) * Math.min(1, dt * 2.5);
    const holdProgress = this.state === 'hold' ? 1 - this.holdLeft / this.holdSec : this.reward ? 1 : 0;
    return {
      reward: this.reward,
      allPass: this.state !== 'off',
      index: this.index,
      holdProgress,
      edge: this.reward === was ? null : this.reward ? 'on' : 'off'
    };
  }
}

// Psychomotor vigilance: reaction times in ms, null for a false start.
// Lapses are responses of 500 ms or slower. Speed is the mean of 1/RT, per second.
export function scorePvt(trials) {
  const rts = trials.filter(t => t !== null && Number.isFinite(t));
  const falseStarts = trials.length - rts.length;
  if (!rts.length) return { n: 0, medianMs: null, speed: null, lapses: 0, falseStarts };
  const s = [...rts].sort((a, b) => a - b), m = s.length >> 1;
  return {
    n: rts.length,
    medianMs: Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2),
    speed: Math.round(rts.reduce((sum, rt) => sum + 1000 / rt, 0) / rts.length * 100) / 100,
    lapses: rts.filter(rt => rt >= 500).length,
    falseStarts
  };
}

const mean = (v) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
const se = (v) => {
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1) / v.length);
};

// Group saved sessions by condition. Each metric: { mean, se, n }.
// trueZone: how often the rules were actually met, whatever was shown.
// Deltas are after minus before: rt (ms, lower is faster), calm and alert (1–7 ratings).
export function compareConditions(sessions) {
  const blinded = sessions.filter(s => s.condition === 'real' || s.condition === 'sham');
  const group = (cond) => {
    const list = blinded.filter(s => s.condition === cond);
    const pick = (fn) => {
      const v = list.map(fn).filter(x => x !== null && x !== undefined && Number.isFinite(x));
      return { mean: mean(v), se: se(v), n: v.length };
    };
    const delta = (key) => (s) => {
      const pre = s.checkins?.pre, post = s.checkins?.post;
      if (!pre || !post) return null;
      if (key === 'rt') return pre.pvt?.medianMs != null && post.pvt?.medianMs != null ? post.pvt.medianMs - pre.pvt.medianMs : null;
      return Number.isFinite(pre[key]) && Number.isFinite(post[key]) ? post[key] - pre[key] : null;
    };
    return {
      n: list.length,
      trueZone: pick(s => s.stats?.trueInZonePct ?? null),
      rt: pick(delta('rt')),
      calm: pick(delta('calm')),
      alert: pick(delta('alert'))
    };
  };
  const guessed = blinded.filter(s => s.checkins?.guess && s.checkins.guess !== 'unsure');
  return {
    real: group('real'),
    sham: group('sham'),
    guesses: { total: guessed.length, correct: guessed.filter(s => s.checkins.guess === s.condition).length }
  };
}
