// Session Journal & Structured Block Training Manager
// Stores private sessions in localStorage with CSV/JSON export

const JOURNAL_KEY = 'resonance.journal.v1';
const TIMELINE_STEP = 2;   // seconds per stored timeline point
const MAX_SESSIONS = 60;

export class SessionJournal {
  constructor() {
    this.sessions = this.load();
    this.currentSession = null;
    this.currentBlock = null;
  }

  load() {
    try {
      const data = localStorage.getItem(JOURNAL_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  save() {
    try {
      localStorage.setItem(JOURNAL_KEY, JSON.stringify(this.sessions));
      return true;
    } catch {
      return false;
    }
  }

  startSession(options = {}) {
    const session = {
      id: 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      startedAt: new Date().toISOString(),
      source: options.source || 'sim', // 'sim' | 'muse'
      protocol: options.protocol || 'single', // 'single' | 'resonate' | 'ratio' | 'iaf' | 'multirule'
      target: options.target || 'alpha',
      blockDurationSeconds: options.blockDurationSeconds || 240, // 4 mins
      totalBlocks: options.totalBlocks || 1,
      setup: options.setup || null,       // protocol + timer snapshot; never raw EEG
      sensors: options.sensors || [],
      notes: '',
      events: [],
      timeline: { stepSeconds: TIMELINE_STEP, index: [], reward: [] },
      blocks: [],
      stats: {
        totalDurationSeconds: 0,
        rewardSeconds: 0,
        timeInZonePct: 0,
        bestStreakSeconds: 0,
        score: 0
      }
    };
    this.currentSession = session;
    this.startBlock(1);
    return session;
  }

  startBlock(blockNumber) {
    if (!this.currentSession) return;
    this.currentBlock = {
      blockNumber,
      startedAt: performance.now(),
      durationSeconds: 0,
      rewardSeconds: 0,
      currentStreak: 0,
      longestStreak: 0,
      recoveries: 0,
      samplesCount: 0,
      bandAverages: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }
    };
    this.currentSession.blocks.push(this.currentBlock);
  }

  // index: continuous 0..1 reward index, stored downsampled for the session chart.
  recordTick(dt, isReward, bandPowers = {}, index = null) {
    if (!this.currentBlock) return;
    this.currentBlock.durationSeconds += dt;
    if (index !== null) this.sampleTimeline(dt, isReward, index);
    this.currentBlock.samplesCount++;

    if (isReward) {
      this.currentBlock.rewardSeconds += dt;
      this.currentBlock.currentStreak += dt;
      if (this.currentBlock.currentStreak > this.currentBlock.longestStreak) {
        this.currentBlock.longestStreak = this.currentBlock.currentStreak;
      }
    } else {
      if (this.currentBlock.currentStreak > 1.0) {
        this.currentBlock.recoveries++;
      }
      this.currentBlock.currentStreak = 0;
    }

    // Accumulate band powers
    for (const [k, v] of Object.entries(bandPowers)) {
      if (this.currentBlock.bandAverages[k] !== undefined) {
        this.currentBlock.bandAverages[k] += (v - this.currentBlock.bandAverages[k]) / this.currentBlock.samplesCount;
      }
    }
  }

  sampleTimeline(dt, isReward, index) {
    const acc = this.timelineAcc ??= { t: 0, n: 0, index: 0, reward: 0 };
    acc.t += dt; acc.n++; acc.index += index; acc.reward += isReward ? 1 : 0;
    if (acc.t < TIMELINE_STEP) return;
    const line = this.currentSession.timeline;
    line.index.push(Math.round((acc.index / acc.n) * 100));
    line.reward.push(acc.reward / acc.n >= 0.5 ? 1 : 0);
    this.timelineAcc = null;
  }

  addEvent(type, detail = {}) {
    if (!this.currentSession) return;
    const at = this.currentSession.blocks.reduce((sum, b) => sum + b.durationSeconds, 0);
    this.currentSession.events.push({ type, at: Math.round(at * 10) / 10, ...detail });
  }

  endBlock() { this.currentBlock = null; }

  setNotes(id, notes) {
    const s = this.sessions.find(x => x.id === id);
    if (!s) return false;
    s.notes = String(notes).slice(0, 2000);
    return this.save();
  }

  deleteSession(id) {
    this.sessions = this.sessions.filter(x => x.id !== id);
    return this.save();
  }

  finishSession(finalScore = 0) {
    if (!this.currentSession) return null;
    const session = this.currentSession;
    let totalDur = 0;
    let totalReward = 0;
    let maxStreak = 0;

    for (const b of session.blocks) {
      totalDur += b.durationSeconds;
      totalReward += b.rewardSeconds;
      if (b.longestStreak > maxStreak) maxStreak = b.longestStreak;
    }

    session.endedAt = new Date().toISOString();
    session.stats = {
      totalDurationSeconds: Math.round(totalDur),
      rewardSeconds: Math.round(totalReward),
      timeInZonePct: totalDur > 0 ? Math.round((totalReward / totalDur) * 100) : 0,
      bestStreakSeconds: Math.round(maxStreak * 10) / 10,
      score: Math.round(finalScore)
    };

    this.sessions.unshift(session);
    if (this.sessions.length > MAX_SESSIONS) this.sessions.length = MAX_SESSIONS;
    this.save();

    this.currentSession = null;
    this.currentBlock = null;
    this.timelineAcc = null;
    return session;
  }

  getHistory() {
    return this.sessions;
  }

  clearHistory() {
    this.sessions = [];
    this.save();
  }

  exportJSON() {
    return JSON.stringify(this.sessions, null, 2);
  }

  exportCSV() {
    if (!this.sessions.length) return '';
    const headers = ['ID', 'Date', 'Source', 'Protocol', 'Target', 'Duration (s)', 'Reward (s)', 'In-Zone %', 'Best Streak (s)', 'Score', 'Notes'];
    const rows = this.sessions.map(s => [
      s.id,
      s.startedAt,
      s.source,
      s.protocol,
      s.target,
      s.stats.totalDurationSeconds,
      s.stats.rewardSeconds,
      s.stats.timeInZonePct,
      s.stats.bestStreakSeconds,
      s.stats.score,
      s.notes || ''
    ]);
    const cell = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
    return [headers.join(','), ...rows.map(r => r.map(cell).join(','))].join('\n');
  }
}
