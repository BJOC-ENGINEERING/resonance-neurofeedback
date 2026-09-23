import { MuseClient } from 'muse-js';
import { marked } from 'marked';
import readme from './README.md?raw';
import quickStart from './docs/quick-start.md?raw';
import featureList from './docs/features.md?raw';
import howItWorks from './docs/how-it-works.md?raw';
import { FS, CHANNELS, CHANNEL_INFO, WINDOW, BANDS, psd, peakFrequency, Channel, assessQuality, DEFAULT_QUALITY_LIMITS, personalBands, estimateAlphaPeak } from './src/dsp.js';
import { ProtocolEngine, computeFeatures, compositeSpectrum, normalizeProtocol, describeProtocol, needsEeg, needsHeart, MEASURES, MEASURE_BY_KEY, PRESETS, DEFAULT_PROTOCOL } from './src/protocol.js';
import { SessionClock, normalizeTimer, describeTimer, formatClock, TIMER_PRESETS, DEFAULT_TIMER } from './src/session.js';
import { SimulatedEEG, SimulatedHeart, SIM_STATES } from './src/sim.js';
import { HeartMonitor } from './src/heart.js';
import { Pacer, ResonanceAssessment, RESONANCE_RATES, normalizeBreath } from './src/breath.js';
import { normalizeStudy, nextCondition, shamProfile, ShamFeedback, compareConditions } from './src/study.js';
import { runCheckin } from './src/checkin.js';
import { FlockCanvas } from './src/flock.js';
import { StageBackdrop } from './src/backdrop.js';
import { VideoScene } from './src/scene-video.js';
import { AudioEngine } from './src/audio.js';
import { SessionJournal } from './src/journal.js';
import { SpectrumChart, Spectrogram, TraceChart, StripChart, TrendChart, HeartChart, chartTheme, refreshChartTheme } from './src/charts.js';
import { loadSettings, saveSettings, loadLibrary, saveLibrary, LIBRARY_LIMIT } from './src/store.js';
import { registerResonanceMCP } from './src/mcp.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = (msg, err = false) => {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3200);
};

const ANALYSIS_DT = 0.1;       // s, rule evaluation and clock rate
const DEMO_CALIBRATION = 6;    // s
const ARTIFACT_HOLDOFF = 1000; // ms reward stays suppressed after a blink or movement
const HEART_CHART_DELAY = 16;  // analysis steps (1.6 s) so each plotted heart rate sits between two detected beats
const IAF_SITES = ['TP9', 'TP10', 'AF7', 'AF8'];

// ==========================================
// 1. STATE
// ==========================================

const saved = loadSettings();
const settings = {
  palette: saved.palette || 'alabaster',
  protocol: normalizeProtocol(saved.protocol || DEFAULT_PROTOCOL),
  timer: normalizeTimer(saved.timer || DEFAULT_TIMER),
  sensors: Array.isArray(saved.sensors) && saved.sensors.length ? saved.sensors.filter(s => CHANNELS.includes(s)) : ['AF7', 'AF8'],
  sound: { mode: 'chime', volume: 0.6, rate: 1, ambience: true, ...saved.sound },
  flock: { variant: 'classic', count: 72, ...saved.flock },
  milestoneSec: saved.milestoneSec || 5,
  scope: { view: 'spectrum', scale: 'linear', ...saved.scope },
  scene: { mode: 'flock', floor: 0.25, youtube: '', ...saved.scene },
  showPanels: saved.showPanels ?? saved.focus === false,
  fullscreenUsed: !!saved.fullscreenUsed,
  breath: normalizeBreath(saved.breath),
  bands: { personal: false, iaf: null, strength: null, measuredAt: null, source: null, ...saved.bands },
  assessSec: saved.assessSec === 120 ? 120 : 60,
  study: normalizeStudy(saved.study),
  welcomed: !!saved.welcomed
};
const persist = () => saveSettings(settings);

let library = loadLibrary();
let source = 'sim'; // 'sim' | 'muse'
let museClient = null;
let museSubscriptions = [];
let museConnected = false;
let museConnecting = false;

const channels = new Map(CHANNELS.map(name => [name, new Channel(name)]));
const spectra = new Map();
const engine = new ProtocolEngine(settings.protocol);
const clock = new SessionClock(settings.timer);
const sim = new SimulatedEEG({ seed: (Date.now() & 0xffff) + 1 });
const audio = new AudioEngine();
const journal = new SessionJournal();
const heart = new HeartMonitor();
const simHeart = new SimulatedHeart({ seed: (Date.now() & 0xffff) + 7 });
const pacer = new Pacer(settings.breath);

let flock, backdrop, videoScene, spectrumChart, spectrogram, traceChart, stripChart, summaryChart, trendChart, heartChart;
let result = null;        // latest evaluation as shown: the engine's, or the sham's in a sham session
let truth = null;         // the engine's own evaluation, always
let pulse = heart.summary(0, { streaming: false });
let lastPpgAt = -Infinity;
let museHasPpg = false;
let pacerLevel = null;    // lung level 0..1 while a pacer runs
const pacerTrail = [];    // pacer levels waiting to line up with the delayed heart-rate trace
let procedure = null;     // { kind: 'iaf' | 'resonance', ... } a guided measurement outside sessions
let condition = null;     // 'real' | 'sham' for blinded sessions, else null
let sham = null;
let shownReward = false;
let preCheckin = null;
let starting = false;     // a check-in is open before the session
let features = null;
let signal = 'none';      // 'ok' | 'artifact' | 'bad' | 'none'
let artifactUntil = 0;
let muted = saved.sound?.mode === 'mute';
if (settings.sound.mode === 'mute') settings.sound.mode = 'chime';
let openSessionId = null;
let pendingStart = false; // start requested before the first analysis window filled
const stats = { usable: 0, rewardSec: 0, trueRewardSec: 0, streak: 0, bestStreak: 0, score: 0, milestones: 0 };

const activeBands = () => settings.bands.personal && Number.isFinite(settings.bands.iaf) ? personalBands(settings.bands.iaf) : BANDS;
const pacerOn = () => (settings.breath.pacer && procedure?.kind !== 'iaf') || procedure?.kind === 'resonance';
const heartStreaming = () => source === 'sim' || (museConnected && performance.now() - lastPpgAt < 2000);

// ==========================================
// 2. SIGNAL → FEATURES → REWARD
// ==========================================

let lastFrame = performance.now();
let analysisAcc = 0;

let nowMs = 0;

function step(now) {
  // The first rAF timestamp can precede module start, so dt is clamped at zero.
  const dt = Math.max(0, Math.min((now - lastFrame) / 1000, 0.1));
  lastFrame = now;
  nowMs = now;

  if (source === 'sim') {
    for (const [name, samples] of Object.entries(sim.generate(dt))) channels.get(name).push(samples, now);
    simHeart.setBreathing(pacerOn() ? pacer.rate : null);
    simHeart.compliance = sim.stability;
    heart.push(simHeart.generate(dt));
  }
  stepPacer(dt);

  analysisAcc += dt;
  while (analysisAcc >= ANALYSIS_DT) {
    analysisAcc -= ANALYSIS_DT;
    analyse(now);
  }
  drawScope();
}

function frame(now) {
  step(now);
  requestAnimationFrame(frame);
}

function analyse(now) {
  spectra.clear();
  for (const [name, ch] of channels) {
    if (ch.count >= WINDOW && now - ch.lastSampleAt < 1000) {
      ch.spectrum = psd(ch.latest(WINDOW));
      spectra.set(name, ch.spectrum);
    } else ch.spectrum = null;
    assessQuality(ch, now, DEFAULT_QUALITY_LIMITS);
  }

  const states = settings.sensors.map(name => channels.get(name).quality.state);
  signal = states.some(s => s === 'off') ? 'none'
    : states.some(s => s === 'bad') ? 'bad'
    : states.some(s => s === 'artifact') ? 'artifact' : 'ok';
  if (signal === 'artifact') artifactUntil = now + ARTIFACT_HOLDOFF;
  if (pendingStart && signal !== 'none') { pendingStart = false; startSession(); }
  const contact = signal === 'ok' || signal === 'artifact';
  const clean = signal === 'ok' && now >= artifactUntil;

  pulse = heart.summary(heart.time, { streaming: heartStreaming() });
  const eeg = computeFeatures(spectra, settings.sensors, activeBands());
  const coherence = pulse.state === 'ok' ? pulse.coherence : null;
  features = eeg ? { ...eeg, coherence } : { coherence };

  // Each source gates only the protocols that read it.
  const p = settings.protocol;
  const wantEeg = needsEeg(p) || !p.rules.length, wantHeart = needsHeart(p);
  const heartOk = pulse.state === 'ok';
  const sourcesContact = (!wantEeg || contact) && (!wantHeart || heartOk);
  const sourcesClean = (!wantEeg || clean) && (!wantHeart || (heartOk && coherence !== null));

  const feedbackOpen = clock.phase !== 'break' && !clock.paused && clock.phase !== 'finished' && !procedure;
  const valid = sourcesClean && feedbackOpen;
  truth = engine.evaluate(features, ANALYSIS_DT, { valid });
  result = truth;
  if (condition === 'sham' && clock.phase === 'training' && sham) {
    // Sham: same gating, but reward comes from the replayed pattern, not the rules.
    const s = valid ? sham.step(ANALYSIS_DT) : { reward: false, allPass: false, index: 0, holdProgress: 0 };
    result = { ...truth, reward: s.reward, allPass: s.allPass, index: s.index, holdProgress: s.holdProgress };
  }
  result.edge = result.reward === shownReward ? null : result.reward ? 'on' : 'off';
  shownReward = result.reward;

  const wasTraining = clock.training;
  for (const event of clock.tick(ANALYSIS_DT, { valid: sourcesContact })) handleClockEvent(event);

  const rewarded = result.reward && (clock.training || (clock.phase === 'idle' && !procedure));
  if (wasTraining && clock.training && sourcesContact) accumulate(rewarded, truth.reward);
  if (procedure) stepProcedure(now);
  updateHeart();

  const hold = clock.phase === 'calibrating' || procedure ? 0 : result.holdProgress;
  // During the resonance assessment the flock stays lit and breathes with the pacer.
  const dimmed = procedure ? procedure.kind === 'iaf'
    : clock.phase === 'break' || clock.paused || clock.phase === 'calibrating' || !sourcesContact;
  flock.setReward(rewarded, 0.25 + result.index * 0.75, hold);
  flock.setDimmed(dimmed);
  backdrop.set({ energy: rewarded ? 0.55 + result.index * 0.45 : hold * 0.25, hold, dimmed });
  updateVideoScene(rewarded, hold, sourcesContact);
  audio.update(result.index, clock.training, rewarded && clock.training);
  stripChart.push(result.index, rewarded);
  spectrogram.push(features?.spectrum, ANALYSIS_DT);
  renderLive(rewarded, { wantEeg, wantHeart, sourcesContact });
}

function accumulate(rewarded, trueRewarded) {
  const dt = ANALYSIS_DT;
  stats.usable += dt;
  if (trueRewarded) stats.trueRewardSec += dt;
  if (rewarded) {
    stats.rewardSec += dt;
    stats.streak += dt;
    stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
    stats.score += dt * 10 * (0.5 + result.index);
    const marks = Math.floor(stats.rewardSec / settings.milestoneSec);
    if (marks > stats.milestones) {
      stats.milestones = marks;
      flock.flourish();
      backdrop.pulse();
      audio.playMilestone();
      journal.addEvent('milestone', { rewardedSeconds: marks * settings.milestoneSec });
    }
  } else stats.streak = 0;
  if (result.edge) journal.addEvent(result.edge === 'on' ? 'reward-on' : 'reward-off');
  journal.recordTick(dt, rewarded, features?.spectrum ? Object.fromEntries(BANDS.map(b => [b.k, features[b.k]])) : {}, result.index, {
    trueReward: trueRewarded,
    hr: pulse.state === 'ok' ? pulse.hr : null,
    coherence: pulse.state === 'ok' ? pulse.coherence : null
  });
}

// ==========================================
// 2b. PULSE, PACER, GUIDED MEASUREMENTS
// ==========================================

function stepPacer(dt) {
  const on = pacerOn();
  const el = $('pacer');
  if (!on) {
    if (pacerLevel !== null) {
      pacerLevel = null;
      el.hidden = true;
      flock.setBreath(null);
    }
    return;
  }
  const s = pacer.step(dt);
  pacerLevel = s.level;
  el.hidden = false;
  el.style.setProperty('--level', s.level.toFixed(3));
  el.classList.toggle('in', s.inhaling);
  if (s.edge) $('pacerText').textContent = s.inhaling ? 'in' : 'out';
  flock.setBreath(s.level);
}

function updateHeart() {
  const streaming = heartStreaming();
  $('heartCard').hidden = !streaming && pulse.state === 'off';
  pacerTrail.push(pacerLevel);
  const breath = pacerTrail.length > HEART_CHART_DELAY ? pacerTrail.shift() : null;
  heartChart.push(pulse.state === 'ok' ? heart.hrAt(heart.time - HEART_CHART_DELAY * ANALYSIS_DT) : null, breath);
}

function renderHeart() {
  if ($('heartCard').hidden) return;
  const ok = pulse.state === 'ok';
  const blind = document.body.classList.contains('blinded');
  $('heartState').textContent = pulse.state === 'off' ? 'no pulse stream' : ok ? 'pulse' : 'finding pulse';
  $('heartState').className = `state ${ok ? 'on' : 'warn'}`;
  $('hrNow').textContent = ok && pulse.hr ? Math.round(pulse.hr) : '—';
  $('hrvNow').textContent = ok && pulse.rmssd ? Math.round(pulse.rmssd) : '—';
  $('cohNow').textContent = blind ? '··' : ok && pulse.coherence !== null ? `${Math.round(pulse.coherence * 100)}%` : '—';
  $('rhythmNow').textContent = ok && pulse.peakHz ? (pulse.peakHz * 60).toFixed(1) : '—';
  heartChart.redraw();
}

function startIafMeasure() {
  if (clock.active || procedure || starting) return toast('Finish the session first.', true);
  if (signal === 'none') return toast(source === 'muse' ? 'Connect the headset and wait for signal.' : 'Starting signal…', true);
  audio.init(); audio.resume(); applySound();
  procedure = { kind: 'iaf', duration: source === 'sim' ? 20 : 60, elapsed: 0, sum: null, n: 0 };
  audio.playCue('start');
  renderControls();
}

function startAssessment() {
  if (clock.active || procedure || starting) return toast('Finish the session first.', true);
  if (!heartStreaming()) return toast(source === 'muse' ? 'No pulse stream. Muse 2 and Muse S send one; the original Muse does not.' : 'Starting signal…', true);
  audio.init(); audio.resume(); applySound();
  const assess = new ResonanceAssessment({ rates: RESONANCE_RATES, stepSec: settings.assessSec, settleSec: settings.assessSec >= 120 ? 20 : 15 });
  procedure = { kind: 'resonance', assess };
  pacer.set({ rate: assess.rate, inhale: settings.breath.inhale });
  pacer.reset();
  $('pacerText').textContent = 'in';
  renderControls();
}

function stopProcedure(message) {
  if (!procedure) return;
  procedure = null;
  pacer.set(settings.breath);
  renderControls();
  renderBreath();
  if (message) toast(message);
}

function stepProcedure() {
  if (procedure.kind === 'iaf') {
    // Average clean resting spectra from every good site: alpha is clearest behind the ears.
    const good = IAF_SITES.map(n => channels.get(n)).filter(ch => ch.spectrum && (ch.quality.state === 'good' || ch.quality.state === 'fair'));
    if (!good.length || nowMs < artifactUntil) return;
    const spectrum = compositeSpectrum(good.map(ch => ch.spectrum));
    procedure.sum ??= new Float64Array(spectrum.length);
    for (let k = 0; k < spectrum.length; k++) procedure.sum[k] += spectrum[k];
    procedure.n++;
    procedure.elapsed += ANALYSIS_DT;
    if (procedure.elapsed < procedure.duration) return;
    const est = estimateAlphaPeak(procedure.sum.map(v => v / procedure.n));
    audio.playCue('end');
    if (!est || est.iaf === null || est.strength < 1.5) {
      return stopProcedure(`No clear alpha peak${est ? ` (${est.strength} dB above background)` : ''}. Try again with eyes closed, relaxed and still.`);
    }
    settings.bands = { personal: true, iaf: est.iaf, strength: est.strength, measuredAt: new Date().toISOString(), source };
    persist();
    applyBands();
    stopProcedure(`Alpha peak ${est.iaf.toFixed(1)} Hz. Bands now follow it.`);
  } else if (procedure.kind === 'resonance') {
    for (const e of procedure.assess.tick(ANALYSIS_DT, heart.time, heart.beats)) {
      if (e.type === 'rate') { pacer.set({ rate: e.rate }); audio.playChime(440, 0.08); }
      else if (e.type === 'done') {
        const measured = e.results.filter(r => r.valid).length;
        if (e.rate === null) return stopProcedure('Not enough clean pulse to score any rate. Sit still and try again.');
        settings.breath.resonance = { rate: e.rate, results: e.results, measuredAt: new Date().toISOString(), source };
        settings.breath.rate = e.rate;
        persist();
        audio.playCue('end');
        stopProcedure(`Resonance rate ${e.rate} breaths / min${measured < e.results.length ? ` (${measured} of ${e.results.length} rates had clean pulse)` : ''}. The pacer now uses it.`);
      }
    }
  }
}

function applyBands() {
  const bands = activeBands();
  spectrumChart.setBands(bands);
  const personal = bands !== BANDS;
  $('bandLegend').innerHTML = bands.map(b => `<span><i style="background:var(${b.color})"></i>${b.k[0].toUpperCase() + b.k.slice(1)} <em>${+b.lo.toFixed(1)}–${+b.hi.toFixed(1)}</em></span>`).join('');
  $('bandLegend').classList.toggle('personal', personal);
  const iaf = settings.bands;
  $('iafResult').innerHTML = Number.isFinite(iaf.iaf)
    ? `<b>${iaf.iaf.toFixed(1)} Hz</b><span>${iaf.strength} dB above background · ${new Date(iaf.measuredAt).toLocaleDateString([], { dateStyle: 'medium' })}${iaf.source === 'sim' ? ' · simulated' : ''}</span>`
    : '<b>Not measured</b><span>Standard bands: theta 4–8, alpha 8–13, beta 13–30 Hz</span>';
  $('useIaf').checked = personal;
  $('useIaf').disabled = !Number.isFinite(iaf.iaf) || clock.active;
  if (!clock.active) engine.resetBaseline();
}

function renderBreath() {
  const b = settings.breath;
  $('pacerOn').checked = b.pacer;
  $('pacerRate').value = b.rate;
  $('pacerRateLabel').textContent = `${b.rate.toFixed(1)} / min`;
  document.querySelectorAll('#pacerInhale button').forEach(x => x.classList.toggle('active', Number(x.dataset.v) === b.inhale));
  document.querySelectorAll('#assessLength button').forEach(x => x.classList.toggle('active', Number(x.dataset.v) === settings.assessSec));
  if (!procedure) pacer.set(b);
  const r = b.resonance;
  if (!r) {
    $('resonanceResult').innerHTML = '<p class="empty">Not measured yet. Six minutes of paced breathing finds it.</p>';
  } else {
    const top = Math.max(...r.results.map(x => x.swing ?? 0), 1);
    $('resonanceResult').innerHTML = `<div class="res-head"><b>${r.rate} / min</b><span>${new Date(r.measuredAt).toLocaleDateString([], { dateStyle: 'medium' })}${r.source === 'sim' ? ' · simulated' : ''}</span>${b.rate !== r.rate ? `<button class="btn ghost" id="btnUseResonance">Use ${r.rate}</button>` : ''}</div>`
      + r.results.map(x => `<div class="res-row ${x.rate === r.rate ? 'best' : ''}"><span>${x.rate}</span><i style="--w:${x.valid ? (x.swing / top) * 100 : 0}%"></i><em>${x.valid ? `${x.swing.toFixed(1)} bpm` : 'no pulse'}</em></div>`).join('')
      + '<p class="hint">heart-rate swing per breath, peak to trough</p>';
  }
  $('pulseNote').textContent = source === 'sim'
    ? 'A virtual heart follows the pacer.'
    : museConnected ? (museHasPpg ? 'Pulse streaming from the headset.' : 'This headset sends no pulse.')
    : 'Muse 2 and Muse S read your pulse.';
}

function initBreathPanel() {
  const b = settings.breath;
  $('pacerOn').addEventListener('change', e => { b.pacer = e.target.checked; if (b.pacer) { pacer.reset(); $('pacerText').textContent = 'in'; audio.init(); audio.resume(); applySound(); } persist(); renderBreath(); });
  $('pacerRate').addEventListener('input', e => { b.rate = Number(e.target.value); persist(); renderBreath(); });
  seg('pacerInhale', b.inhale, v => { b.inhale = Number(v); persist(); renderBreath(); });
  seg('assessLength', settings.assessSec, v => { settings.assessSec = Number(v); persist(); });
  $('btnAssess').addEventListener('click', startAssessment);
  $('resonanceResult').addEventListener('click', e => {
    if (!e.target.closest('#btnUseResonance')) return;
    b.rate = b.resonance.rate;
    persist();
    renderBreath();
  });
  $('useIaf').addEventListener('change', e => {
    if (clock.active) return;
    settings.bands.personal = e.target.checked;
    persist();
    applyBands();
  });
  $('btnMeasureIaf').addEventListener('click', startIafMeasure);
  $('btnCancelProc').addEventListener('click', () => stopProcedure('Stopped. Nothing was saved.'));
  renderBreath();
}

// ==========================================
// 3. SESSION FLOW
// ==========================================

function handleClockEvent(event) {
  if (event.type === 'calibrated') {
    if (engine.finishCalibration()) {
      toast('Baseline recorded. Training begins.');
    } else {
      clock.recalibrate();
      engine.beginCalibration();
      toast('Not enough clean signal for a baseline. Measuring again.', true);
    }
  } else if (event.type === 'block-start') {
    if (!engine.calibrated) return;
    if (journal.currentBlock?.blockNumber !== event.block) journal.startBlock(event.block);
    engine.resetReward();
    journal.addEvent('block-start', { block: event.block });
  } else if (event.type === 'block-end') {
    journal.endBlock();
  } else if (event.type === 'break-start') {
    toast(`Block ${event.block} done. Rest for ${formatClock(clock.timer.breakSec)}.`);
  } else if (event.type === 'finished') {
    completeSession();
  }
}

// Optional check-in first, then the session proper.
async function requestStart() {
  if (starting || procedure) return;
  if (!settings.protocol.rules.length) return toast('Enable at least one rule first.', true);
  if (needsHeart(settings.protocol) && source === 'muse' && museConnected && !museHasPpg) {
    return toast('This protocol needs a pulse. Muse 2 and Muse S send one; this headset does not.', true);
  }
  preCheckin = null;
  if (settings.study.checkin) {
    starting = true;
    renderControls();
    const answers = await runCheckin({ title: 'Before you start', sub: 'Two quick ratings and a 60 second reaction test.', ratings: true, pvt: true });
    starting = false;
    renderControls();
    if (!answers) return;
    preCheckin = { calm: answers.calm, alert: answers.alert, pvt: answers.pvt };
  }
  startSession();
}

function startSession() {
  if (!settings.protocol.rules.length) return toast('Enable at least one rule first.', true);
  if (signal === 'none') {
    if (source === 'sim') { pendingStart = true; return; }
    return toast('Connect the headset and wait for signal.', true);
  }
  audio.init();
  audio.resume();
  applySound();
  Object.assign(stats, { usable: 0, rewardSec: 0, trueRewardSec: 0, streak: 0, bestStreak: 0, score: 0, milestones: 0 });
  const blinded = settings.study.sham !== 'off';
  const assigned = nextCondition(settings.study);
  settings.study.queue = assigned.queue;
  persist();
  condition = blinded ? assigned.condition : null;
  sham = condition === 'sham'
    ? new ShamFeedback({ ...shamProfile(journal.getHistory(), settings.protocol), holdSec: settings.protocol.holdSec })
    : null;
  clock.configure({ ...settings.timer, calibrationSec: source === 'sim' ? DEMO_CALIBRATION : settings.timer.calibrationSec });
  clock.start();
  engine.beginCalibration();
  stripChart.clear();
  journal.startSession({
    source,
    protocol: settings.protocol.presetId || 'custom',
    target: settings.protocol.rules.map(r => r.measure).join('+'),
    blockDurationSeconds: settings.timer.blockSec,
    totalBlocks: settings.timer.blocks,
    sensors: [...settings.sensors],
    setup: { protocol: settings.protocol, timer: settings.timer },
    condition,
    blinded,
    bands: activeBands() !== BANDS ? { iaf: settings.bands.iaf } : null,
    breath: settings.breath.pacer ? { rate: settings.breath.rate, inhale: settings.breath.inhale } : null,
    checkins: preCheckin ? { pre: preCheckin } : null
  });
  renderControls();
}

function togglePause() {
  if (!clock.active) return requestStart();
  if (clock.paused) { clock.resume(); audio.resume(); }
  else { clock.pause(); journal.addEvent('pause'); }
  renderControls();
}

function finishEarly() {
  for (const event of clock.finish()) handleClockEvent(event);
}

async function completeSession() {
  const session = journal.finishSession(stats.score);
  clock.reset(); // back to live preview against the recorded baseline
  condition = null;
  sham = null;
  renderControls();
  if (!session) return;
  if (session.stats.totalDurationSeconds < 1) {
    journal.deleteSession(session.id);
    return toast('Session ended before training began. Nothing saved.');
  }
  const checkin = !!session.checkins?.pre;
  if (checkin || session.blinded) {
    // Ratings and the guess come before the reveal, so knowing the answer can't colour them.
    const answers = await runCheckin({
      title: 'Before you see the results',
      sub: [checkin && 'The same two ratings and reaction test', session.blinded && 'your guess about the feedback'].filter(Boolean).join(', then ') + '.',
      ratings: checkin, pvt: checkin, guess: session.blinded
    });
    if (answers) {
      journal.setCheckins(session.id, {
        ...(checkin ? { post: { calm: answers.calm, alert: answers.alert, pvt: answers.pvt } } : {}),
        ...(session.blinded ? { guess: answers.guess } : {})
      });
    }
  }
  openSummary(session, true);
}

function recalibrate() {
  if (!clock.active) return;
  clock.recalibrate();
  engine.beginCalibration();
  journal.addEvent('recalibrate');
  toast('Recording a new baseline.');
}

// ==========================================
// 4. LIVE RENDERING
// ==========================================

function renderLive(rewarded, { wantEeg = true, wantHeart = false, sourcesContact = true } = {}) {
  // Clock and cue
  const phase = clock.phase;
  const proc = procedure;
  $('clockTime').textContent = formatClock(proc?.kind === 'iaf' ? proc.duration - proc.elapsed
    : proc?.kind === 'resonance' ? proc.assess.remaining
    : phase === 'idle' || phase === 'finished' ? clock.timer.blockSec : clock.remaining);
  const phaseText = proc?.kind === 'iaf' ? 'Alpha peak · eyes closed'
    : proc?.kind === 'resonance' ? `Rate ${proc.assess.index + 1} of ${proc.assess.rates.length} · ${proc.assess.rate} / min`
    : clock.paused ? 'Paused'
    : phase === 'calibrating' ? 'Recording baseline'
    : phase === 'training' ? (sourcesContact ? `Block ${clock.block} of ${clock.timer.blocks}` : 'Clock stopped · check sensors')
    : phase === 'break' ? 'Break'
    : phase === 'finished' ? 'Finished' : 'Ready · live preview';
  $('clockPhase').textContent = phaseText;

  const cue = $('cue');
  const heartMissing = wantHeart && pulse.state !== 'ok';
  let text;
  if (proc?.kind === 'iaf') text = signal === 'ok' && nowMs >= artifactUntil ? 'Close your eyes and let your face go slack. A chime marks the end.' : 'Hold still. Measuring resumes when the signal is clean.';
  else if (proc?.kind === 'resonance') text = pulse.state !== 'ok' ? 'Finding your pulse. Sit still.' : 'Breathe with the ring: in through the nose, slow and easy out.';
  else if (!settings.protocol.rules.length) text = 'Enable a rule to begin.';
  else if (wantEeg && signal === 'none') text = source === 'muse' ? 'Waiting for the headset.' : 'Starting signal…';
  else if (wantEeg && signal === 'bad') text = 'A training sensor lost contact. Adjust the band.';
  else if (heartMissing) text = pulse.state === 'off' ? 'Waiting for a pulse stream.' : 'Finding your pulse. Sit still.';
  else if (clock.paused) text = 'Paused.';
  else if (phase === 'calibrating') text = wantEeg ? 'Rest your gaze on the flock. Measuring your baseline.' : 'Settle in and follow the pacer.';
  else if (phase === 'break') text = 'Rest. Feedback resumes after the break.';
  else if (wantEeg && nowMs < artifactUntil) text = 'Movement detected. Stay still.';
  else if (rewarded) text = 'In the zone.';
  else if (result.allPass) text = 'Hold it…';
  else if (phase === 'idle') text = 'Live preview. Press start to record a baseline and train.';
  else if (wantHeart && !wantEeg) text = pulse.coherence === null ? 'Keep breathing with the ring. Coherence needs 30 s of pulse.' : 'Breathe with the ring. Let each out-breath be long and easy.';
  else text = 'Ease toward the target. The flock will gather.';
  cue.textContent = text;
  cue.classList.toggle('hot', rewarded);
  $('stage').classList.toggle('rewarded', rewarded);

  const holding = settings.protocol.holdSec > 0 && result.holdProgress > 0 && !rewarded && phase !== 'calibrating' && !proc;
  $('holdRing').classList.toggle('show', holding);
  $('holdArc').style.strokeDashoffset = String(176 * (1 - result.holdProgress));

  document.querySelectorAll('#blockDots i').forEach((dot, i) => {
    const n = i + 1;
    const p = phase === 'finished' || n < clock.block || (n === clock.block && phase === 'break') ? 100
      : n === clock.block && phase === 'training' ? clock.progress * 100 : 0;
    dot.style.setProperty('--p', `${p}%`);
  });

  // Signal → reward table
  const state = $('rewardState');
  const eegWarn = wantEeg && (signal === 'bad' || nowMs < artifactUntil);
  state.textContent = wantEeg && signal === 'none' ? 'no signal' : wantEeg && signal === 'bad' ? 'poor contact'
    : wantEeg && nowMs < artifactUntil ? 'artifact' : heartMissing ? 'no pulse'
    : rewarded ? 'reward on' : result.allPass ? 'holding' : `${result.passing} / ${result.rows.length} passing`;
  state.className = `state ${rewarded ? 'on' : eegWarn || heartMissing ? 'warn' : ''}`;
  const rows = $('measureRows');
  if (rows.children.length !== Math.max(1, result.rows.length) || rows.dataset.key !== ruleKey()) buildMeasureRows();
  result.rows.forEach((r, i) => {
    const tr = rows.children[i];
    const m = MEASURE_BY_KEY[r.measure];
    const digits = m.unit === 'Hz' || !m.unit ? 2 : 1;
    tr.children[1].innerHTML = r.pct === null ? '—' : `${r.pct.toFixed(0)}%<span class="sub">${m.absolute ? 'absolute' : `${r.now.toFixed(digits)} ${m.unit}`}</span>`;
    tr.children[2].textContent = `${r.mode === 'up' ? '≥' : '≤'} ${r.target.toFixed(r.target % 1 ? 1 : 0)}%`;
    tr.children[3].textContent = r.pct === null ? (r.measure === 'asym' ? 'AF7+AF8' : m.heart ? 'pulse' : '—') : r.pass ? '✓ pass' : '· wait';
    tr.children[3].className = r.pass ? 'pass' : 'fail';
    const bar = tr.querySelector('.bar');
    const span = m.absolute ? 100 : Math.max(200, r.target * 1.5);
    bar.style.setProperty('--v', `${Math.min(100, ((r.pct ?? 0) / span) * 100)}%`);
    bar.style.setProperty('--t', `${Math.min(100, (r.target / span) * 100)}%`);
    bar.classList.toggle('pass', r.pass);
  });
  $('baselineNote').textContent = !needsEeg(settings.protocol) && settings.protocol.rules.length
    ? 'Heart coherence is absolute: the share of heart-rate variation in one slow, steady rhythm.'
    : engine.calibrated
    ? `Percent of your recorded baseline${settings.protocol.difficulty.mode === 'auto' ? ' · targets adapt toward ' + Math.round(settings.protocol.difficulty.rate * 100) + '% reward' : ''}.`
    : 'Percent of a drifting reference until you record a baseline.';

  // Tiles and milestones
  $('hudZone').textContent = `${stats.usable > 0 ? Math.round((stats.rewardSec / stats.usable) * 100) : 0}%`;
  $('hudStreak').textContent = `${stats.bestStreak.toFixed(1)}s`;
  $('hudEarned').textContent = formatClock(Math.floor(stats.rewardSec));
  $('hudScore').textContent = Math.round(stats.score);
  const marks = $('milestoneMarks');
  const shown = Math.min(stats.milestones, 12);
  if (marks.dataset.n !== String(stats.milestones)) {
    marks.dataset.n = String(stats.milestones);
    marks.innerHTML = Array.from({ length: Math.max(5, shown) }, (_, i) => `<i class="${i < shown ? 'on' : ''}"></i>`).join('')
      + (stats.milestones > 12 ? `<span>+${stats.milestones - 12}</span>` : '');
  }
  const toNext = settings.milestoneSec - (stats.rewardSec % settings.milestoneSec);
  marks.title = `Milestones · next in ${toNext.toFixed(0)} s rewarded`;

  // Sensors and steps
  document.querySelectorAll('#sensors button').forEach(btn => {
    const q = channels.get(btn.dataset.ch).quality;
    btn.className = `${q.state} ${settings.sensors.includes(btn.dataset.ch) ? 'selected' : ''}`;
    btn.querySelector('em').textContent = q.state === 'artifact' ? (q.blink ? 'blink' : q.motion ? 'motion' : 'muscle') : q.state;
  });
  const connected = source === 'sim' || museConnected;
  const stepState = {
    connect: connected,
    signal: connected && (!wantEeg || signal === 'ok') && (!wantHeart || pulse.state === 'ok'),
    baseline: engine.calibrated,
    train: phase === 'finished'
  };
  let currentSet = false;
  document.querySelectorAll('#steps li').forEach(li => {
    const done = stepState[li.dataset.step];
    li.classList.toggle('done', done);
    li.classList.toggle('current', !done && !currentSet);
    if (!done) currentSet = true;
  });

  if (features?.spectrum) $('peakText').textContent = `peak ${peakFrequency(features.spectrum, 4, 30).toFixed(1)} Hz`;
  renderHeart();
}

const ruleKey = () => settings.protocol.rules.map(r => r.measure + r.mode).join('|');

function buildMeasureRows() {
  const rows = $('measureRows');
  rows.dataset.key = ruleKey();
  rows.innerHTML = settings.protocol.rules.length ? settings.protocol.rules.map(r => {
    const m = MEASURE_BY_KEY[r.measure];
    return `<tr><td><div class="m"><i style="${m.color ? `background:var(${m.color})` : m.heart ? 'background:var(--bad)' : ''}"></i>${m.label} ${r.mode === 'up' ? '↑' : '↓'}</div><div class="bar"></div></td><td></td><td></td><td></td></tr>`;
  }).join('') : '<tr class="empty"><td colspan="4">No rules enabled.</td></tr>';
}

function drawScope() {
  const view = settings.scope.view;
  if (view === 'spectrum') spectrumChart.draw(features?.spectrum || null);
  else if (view === 'spectrogram') spectrogram.redraw();
  else traceChart.draw(CHANNELS.map(name => {
    const ch = channels.get(name);
    return { name, state: ch.quality.state, selected: settings.sensors.includes(name), samples: ch.count ? ch.latest(TraceChart.SAMPLES) : null };
  }));
}

function renderControls() {
  const active = clock.active;
  const busy = !!procedure || starting;
  $('btnGoText').textContent = !active ? 'Start session' : clock.paused ? 'Resume' : 'Pause';
  $('btnGo').querySelector('i').className = `ti ti-player-${active && !clock.paused ? 'pause' : 'play'}`;
  $('btnGo').disabled = busy;
  $('btnFinish').hidden = !active;
  $('btnRecalibrate').hidden = !active;
  $('btnCancelProc').hidden = !procedure;
  document.querySelectorAll('[data-panel="timing"] input, [data-panel="timing"] select, #timerPresets button, #studySham button, #sourceMode button')
    .forEach(el => { el.disabled = active || busy; });
  for (const id of ['btnAssess', 'btnMeasureIaf']) $(id).disabled = active || busy;
  document.querySelectorAll('#assessLength button').forEach(el => { el.disabled = busy; });
  $('useIaf').disabled = !Number.isFinite(settings.bands.iaf) || active || busy;
  // Blinded sessions hide the rule readout: it would show whether reward follows the rules.
  document.body.classList.toggle('blinded', active && condition !== null);
  document.body.classList.toggle('measuring', !!procedure);
  renderFocus();
}

// Focus mode: while a session runs, the rails fold away unless the viewer asks for them.
function renderFocus() {
  const running = (clock.active && !clock.paused) || !!procedure;
  document.body.classList.toggle('focus', running && !settings.showPanels);
  const btn = $('btnPanels');
  btn.hidden = !running;
  btn.setAttribute('aria-pressed', String(settings.showPanels));
  $('panelsText').textContent = settings.showPanels ? 'Hide panels' : 'Show panels';
  btn.querySelector('i').className = `ti ti-layout-sidebar-left-${settings.showPanels ? 'collapse' : 'expand'}`;
}

// The choice sticks: whoever brings the panels back keeps them for the next session.
function togglePanels() {
  if (!((clock.active && !clock.paused) || procedure)) return;
  settings.showPanels = !settings.showPanels;
  renderFocus();
  persist();
}

// ==========================================
// 4b. SCENES
// ==========================================

function updateVideoScene(rewarded, hold, contact) {
  if (settings.scene.mode !== 'video' || !videoScene.loaded) return;
  const phase = clock.phase;
  // Baseline and breaks are neutral: the picture stays mostly clear and carries no reward information.
  const level = !contact ? 0.2
    : phase === 'calibrating' || phase === 'break' ? 0.85
    : rewarded ? 1 : 0.55 * hold;
  videoScene.setLevel(level);
  videoScene.setPlaying(!clock.paused);
}

function applyScene() {
  const mode = settings.scene.mode;
  $('stage').dataset.scene = mode;
  $('videoPanel').hidden = mode !== 'video';
  $('flockOptions').hidden = mode !== 'flock';
  $('stageCanvas').setAttribute('aria-hidden', String(mode !== 'flock'));
  if (mode === 'video' && !videoScene.loaded && settings.scene.youtube) videoScene.loadYouTube(settings.scene.youtube);
  if (mode !== 'video') videoScene.setPlaying(false);
}

function initScenePanel() {
  videoScene = new VideoScene($('sceneVideo'));
  videoScene.setFloor(settings.scene.floor);
  seg('sceneMode', settings.scene.mode, v => { settings.scene.mode = v; applyScene(); persist(); });
  $('videoUrl').value = settings.scene.youtube;
  const loadUrl = () => {
    const url = $('videoUrl').value.trim();
    if (!url) return toast('Paste a YouTube link first.', true);
    if (!videoScene.loadYouTube(url)) return toast('That does not look like a YouTube link.', true);
    settings.scene.youtube = url;
    $('videoFileText').textContent = 'Choose a video file';
    persist();
  };
  $('btnLoadVideo').addEventListener('click', loadUrl);
  $('videoUrl').addEventListener('keydown', e => { if (e.key === 'Enter') loadUrl(); });
  $('videoFile').addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    $('videoFileText').textContent = videoScene.loadFile(file);
    e.target.value = '';
  });
  $('btnClearVideo').addEventListener('click', () => {
    videoScene.clear();
    settings.scene.youtube = '';
    $('videoUrl').value = '';
    $('videoFileText').textContent = 'Choose a video file';
    persist();
  });
  const floorLabel = () => { $('videoFloorLabel').textContent = `${Math.round(settings.scene.floor * 100)}%`; };
  $('videoFloor').value = Math.round(settings.scene.floor * 100);
  floorLabel();
  $('videoFloor').addEventListener('input', e => {
    settings.scene.floor = Number(e.target.value) / 100;
    videoScene.setFloor(settings.scene.floor);
    floorLabel();
    persist();
  });
  applyScene();
}

// ==========================================
// 5. SETUP RAIL
// ==========================================

function seg(id, value, onChange) {
  const root = $(id);
  const set = (v) => root.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.v === String(v)));
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    set(b.dataset.v);
    onChange(b.dataset.v);
  });
  set(value);
  return set;
}

function commitProtocol(changes, { fromPreset = false } = {}) {
  settings.protocol = normalizeProtocol({ ...settings.protocol, ...changes, presetId: fromPreset ? changes.presetId : null, name: fromPreset ? changes.name : 'Custom' });
  engine.updateProtocol(settings.protocol);
  persist();
  renderProtocol();
}

function renderProtocol() {
  const p = settings.protocol;
  const active = PRESETS.find(x => x.id === p.presetId);
  $('presets').innerHTML = PRESETS.map(x =>
    `<button data-id="${x.id}" class="${x.id === p.presetId ? 'active' : ''}"><b>${x.name}</b></button>`).join('')
    + `<p class="preset-blurb">${active ? `${active.blurb} Eyes ${active.eyes}.` : 'Custom rules.'}</p>`;

  // Only the rules in use are listed; the rest wait in the add menu.
  $('rules').innerHTML = MEASURES.filter(m => p.rules.some(x => x.measure === m.k)).map(m => {
    const r = p.rules.find(x => x.measure === m.k);
    const mode = r.mode;
    return `<div class="rule ${mode === 'off' ? 'off' : ''}" data-m="${m.k}">
      <div class="name"><i style="${m.color ? `background:var(${m.color})` : ''}"></i><b>${m.label}</b><span>${m.range}</span></div>
      <div class="seg small">
        <button data-mode="up" class="${mode === 'up' ? 'active' : ''}" title="Reward at or above">↑</button>
        <button data-mode="down" class="${mode === 'down' ? 'active' : ''}" title="Reward at or below">↓</button>
      </div>
      <input type="number" min="10" max="${m.absolute ? 100 : 400}" step="1" value="${r.threshold}" aria-label="${m.label} threshold, ${m.absolute ? 'absolute percent' : 'percent of baseline'}" title="${m.absolute ? 'absolute %' : '% of baseline'}">
      <button class="btn ghost icon del" data-mode="off" aria-label="Remove ${m.label}" title="Remove"><i class="ti ti-x" aria-hidden="true"></i></button>
    </div>`;
  }).join('') || '<p class="empty">No rules yet. Add a measure below.</p>';
  $('addRule').innerHTML = '<option value="">+ Add a measure</option>'
    + MEASURES.filter(m => !p.rules.some(x => x.measure === m.k)).map(m => `<option value="${m.k}">${m.label} · ${m.range}</option>`).join('');

  $('holdSec').value = p.holdSec;
  $('holdLabel').textContent = p.holdSec > 0 ? `${p.holdSec.toFixed(1)} s` : 'instant reward';
  $('rateField').hidden = p.difficulty.mode !== 'auto';
  $('rewardRate').value = Math.round(p.difficulty.rate * 100);
  $('rateLabel').textContent = `${Math.round(p.difficulty.rate * 100)}%`;
  document.querySelectorAll('#difficultyMode button').forEach(b => b.classList.toggle('active', b.dataset.v === p.difficulty.mode));
  $('setupLine').textContent = `${settings.sensors.join(' + ')} · ${describeProtocol(p)} · ${describeTimer(settings.timer)}`;
  buildMeasureRows();
}

function rulesFromDom(changed, mode, threshold) {
  const rules = settings.protocol.rules.filter(r => r.measure !== changed);
  if (mode !== 'off') rules.push({ measure: changed, mode, threshold });
  return MEASURES.map(m => rules.find(r => r.measure === m.k)).filter(Boolean);
}

function applyPreset(preset) {
  commitProtocol({ presetId: preset.id, name: preset.name, rules: preset.rules.map(r => ({ ...r })), holdSec: preset.holdSec }, { fromPreset: true });
  if (preset.id === 'balance' && !(settings.sensors.includes('AF7') && settings.sensors.includes('AF8'))) toast('Balance reads AF7 and AF8 regardless of the training sites.');
  if (preset.pacer && !settings.breath.pacer) {
    settings.breath.pacer = true;
    pacer.reset();
    persist();
    renderBreath();
    toast(`Pacer on at ${settings.breath.rate} breaths / min${settings.breath.resonance ? ', your resonance rate' : ''}. Change it under Breath.`);
  }
}

function initProtocolPanel() {
  $('presets').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) applyPreset(PRESETS.find(x => x.id === b.dataset.id));
  });

  $('rules').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    const row = b.closest('.rule');
    commitProtocol({ rules: rulesFromDom(row.dataset.m, b.dataset.mode, Number(row.querySelector('input').value) || 100) });
  });
  $('addRule').addEventListener('change', e => {
    const m = MEASURES.find(x => x.k === e.target.value);
    if (m) commitProtocol({ rules: rulesFromDom(m.k, 'up', m.defaultThreshold ?? 100) });
  });
  $('rules').addEventListener('change', e => {
    const row = e.target.closest('.rule');
    const current = settings.protocol.rules.find(r => r.measure === row.dataset.m);
    if (current) commitProtocol({ rules: rulesFromDom(row.dataset.m, current.mode, Number(e.target.value) || 100) });
  });

  $('holdSec').addEventListener('input', e => commitProtocol({ holdSec: Number(e.target.value) }));
  seg('difficultyMode', settings.protocol.difficulty.mode, v => commitProtocol({ difficulty: { ...settings.protocol.difficulty, mode: v } }));
  $('rewardRate').addEventListener('input', e => commitProtocol({ difficulty: { ...settings.protocol.difficulty, rate: Number(e.target.value) / 100 } }));

  $('btnSaveProtocol').addEventListener('click', () => {
    const name = $('protocolName').value.trim();
    if (!name) return toast('Give the setup a name first.', true);
    if (!settings.protocol.rules.length) return toast('Enable at least one rule first.', true);
    const entry = { ...settings.protocol, name, presetId: null, timer: settings.timer, sensors: [...settings.sensors] };
    const existing = library.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
    if (existing === -1 && library.length >= LIBRARY_LIMIT) return toast(`The library holds ${LIBRARY_LIMIT} protocols. Delete one first.`, true);
    if (existing === -1) library.unshift(entry); else library[existing] = entry;
    saveLibrary(library);
    $('protocolName').value = '';
    renderLibrary();
    toast(`Saved “${name}”.`);
  });

  $('library').addEventListener('click', e => {
    const item = e.target.closest('.item');
    if (!item) return;
    const entry = library[Number(item.dataset.i)];
    if (e.target.closest('.del')) {
      library.splice(Number(item.dataset.i), 1);
      saveLibrary(library);
      return renderLibrary();
    }
    settings.protocol = normalizeProtocol(entry);
    engine.updateProtocol(settings.protocol);
    if (!clock.active && entry.timer) { settings.timer = normalizeTimer(entry.timer); clock.configure(settings.timer); renderTimer(); }
    persist();
    renderProtocol();
    toast(`Loaded “${entry.name}”.`);
  });
}

function renderLibrary() {
  $('libraryCount').textContent = `${library.length} / ${LIBRARY_LIMIT}`;
  $('library').innerHTML = library.length ? library.map((x, i) =>
    `<div class="item" data-i="${i}"><button class="load"><b>${esc(x.name)}</b><span>${esc(describeProtocol(normalizeProtocol(x)))}</span></button><button class="btn ghost icon del" aria-label="Delete ${esc(x.name)}"><i class="ti ti-x"></i></button></div>`).join('')
    : '<p class="empty">Nothing saved yet. Tune the rules, then name the setup.</p>';
}

function renderTimer() {
  const t = settings.timer;
  $('blocks').value = t.blocks;
  $('blockMin').value = Math.floor(t.blockSec / 60); $('blockSecs').value = t.blockSec % 60;
  $('breakMin').value = Math.floor(t.breakSec / 60); $('breakSecs').value = t.breakSec % 60;
  $('calibrationSec').value = String([10, 20, 30, 60].includes(t.calibrationSec) ? t.calibrationSec : 20);
  const total = t.blocks * t.blockSec + (t.blocks - 1) * t.breakSec;
  $('timerSummary').textContent = `${describeTimer(t)} · ${formatClock(total)} planned`;
  $('timerPresets').innerHTML = TIMER_PRESETS.map(p =>
    `<button data-id="${p.id}" class="${p.blocks === t.blocks && p.blockSec === t.blockSec && p.breakSec === t.breakSec ? 'active' : ''}">${p.name} · ${describeTimer(p)}</button>`).join('');
  $('blockDots').innerHTML = t.blocks > 1 ? '<i></i>'.repeat(t.blocks) : '';
  $('setupLine').textContent = `${settings.sensors.join(' + ')} · ${describeProtocol(settings.protocol)} · ${describeTimer(t)}`;
  renderControls();
}

function initTimingPanel() {
  const commit = (timer) => {
    if (clock.active) return;
    settings.timer = normalizeTimer(timer);
    clock.configure(settings.timer);
    persist();
    renderTimer();
  };
  $('timerPresets').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b && !b.disabled) commit({ ...settings.timer, ...TIMER_PRESETS.find(p => p.id === b.dataset.id) });
  });
  $('studyCheckin').checked = settings.study.checkin;
  $('studyCheckin').addEventListener('change', e => { settings.study.checkin = e.target.checked; persist(); });
  seg('studySham', settings.study.sham, v => { settings.study = { ...settings.study, sham: v, queue: [] }; persist(); });
  for (const id of ['blocks', 'blockMin', 'blockSecs', 'breakMin', 'breakSecs', 'calibrationSec']) {
    $(id).addEventListener('change', () => commit({
      blocks: $('blocks').value,
      blockSec: Number($('blockMin').value) * 60 + Number($('blockSecs').value),
      breakSec: Number($('breakMin').value) * 60 + Number($('breakSecs').value),
      calibrationSec: $('calibrationSec').value
    }));
  }
}

function applySound() {
  const s = settings.sound;
  audio.setMuted(muted);
  audio.setSoundMode(s.mode);
  audio.setVolume(s.volume);
  audio.setChimeRate(s.rate);
  audio.setAmbience(s.ambience);
  $('muteText').textContent = muted ? 'Sound off' : 'Sound on';
  $('btnMute').querySelector('i').className = `ti ti-volume${muted ? '-off' : ''}`;
  $('btnMute').setAttribute('aria-pressed', String(muted));
}

function applyPalette() {
  document.body.dataset.palette = settings.palette;
  refreshChartTheme();
  const th = chartTheme();
  flock?.setPalette({ hue: th.hue, light: false }); // the stage is dark on every palette
  backdrop?.setHue(th.hue);
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  document.querySelectorAll('#palettes button').forEach(b => b.classList.toggle('active', b.dataset.color === settings.palette));
  spectrogram?.clear();
  for (const c of [spectrumChart, stripChart]) c?.redraw();
}

function initFeedbackPanel() {
  const s = settings.sound;
  seg('soundMode', s.mode, v => { s.mode = v; muted = false; applySound(); persist(); });
  seg('chimeRate', s.rate, v => { s.rate = Number(v); applySound(); persist(); });
  $('volume').value = Math.round(s.volume * 100);
  $('volumeLabel').textContent = `${Math.round(s.volume * 100)}%`;
  $('volume').addEventListener('input', e => { s.volume = Number(e.target.value) / 100; $('volumeLabel').textContent = `${e.target.value}%`; applySound(); persist(); });
  $('ambience').checked = s.ambience;
  $('ambience').addEventListener('change', e => { s.ambience = e.target.checked; applySound(); persist(); });
  $('btnTestSound').addEventListener('click', () => { audio.init(); audio.resume(); applySound(); audio.playChime(); });

  seg('flockVariant', settings.flock.variant, v => { settings.flock.variant = v; flock.setVariant(v); persist(); });
  $('birdCount').value = settings.flock.count;
  $('birdLabel').textContent = settings.flock.count;
  $('birdCount').addEventListener('input', e => { settings.flock.count = Number(e.target.value); $('birdLabel').textContent = e.target.value; flock.setCount(settings.flock.count); persist(); });
  $('milestoneSec').value = String(settings.milestoneSec);
  $('milestoneSec').addEventListener('change', e => { settings.milestoneSec = Number(e.target.value); stats.milestones = Math.floor(stats.rewardSec / settings.milestoneSec); persist(); });
  $('palettes').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.palette = b.dataset.color;
    applyPalette();
    persist();
  });
}

// ==========================================
// 6. SIGNAL SOURCES
// ==========================================

function resetSignal() {
  for (const ch of channels.values()) ch.reset();
  heart.reset();
  heartChart.clear();
  pacerTrail.length = 0;
  engine.resetBaseline();
  spectrogram.clear();
  stripChart.clear();
  features = null;
}

function setSource(next) {
  if (clock.active) return toast('Finish the session before switching source.', true);
  if (procedure) stopProcedure();
  if (next === 'sim' && museConnected) disconnectMuse();
  source = next;
  resetSignal();
  $('musePanel').hidden = next !== 'muse';
  $('simPanel').hidden = next !== 'sim';
  document.querySelectorAll('#sourceMode button').forEach(b => b.classList.toggle('active', b.dataset.v === next));
  renderSource();
}

function renderSource() {
  const live = source === 'muse' && museConnected;
  $('sourceText').textContent = museConnecting ? 'Connecting…' : source === 'sim' ? 'Simulated EEG' : live ? 'Live Muse EEG' : 'Muse not connected';
  const badge = $('sourceBadge');
  badge.classList.toggle('live', live);
  badge.disabled = museConnecting;
  badge.title = museConnected ? 'Muse settings' : 'Connect a Muse';
  $('sourceAction').hidden = museConnected || museConnecting;
  $('btnDisconnectMuse').hidden = !museConnected;
  const btn = $('btnConnectMuse');
  btn.hidden = museConnected;
  btn.disabled = museConnecting;
  btn.querySelector('span').textContent = museConnecting ? 'Connecting…' : 'Connect Muse';
  document.querySelectorAll('#sourceMode button').forEach(btn => { btn.disabled = museConnecting; });
  renderBreath();
}

function initSignalPanel() {
  seg('sourceMode', source, setSource);
  $('btnConnectMuse').addEventListener('click', connectMuse);
  $('sourceBadge').addEventListener('click', () => museConnected ? document.querySelector('.tabs [data-tab="signal"]').click() : connectMuse());
  $('btnDisconnectMuse').addEventListener('click', () => { disconnectMuse(); toast('Muse disconnected.'); });

  $('simStates').innerHTML = Object.entries(SIM_STATES).map(([k, v]) => `<button data-s="${k}" class="${k === sim.state ? 'active' : ''}">${v.label}</button>`).join('');
  $('simStates').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    sim.configure({ state: b.dataset.s });
    document.querySelectorAll('#simStates button').forEach(x => x.classList.toggle('active', x === b));
  });
  for (const [id, key] of [['simIntensity', 'intensity'], ['simStability', 'stability'], ['simTriad', 'triad']]) {
    $(id).addEventListener('input', e => { sim.configure({ [key]: Number(e.target.value) / 100 }); $(`${id}Label`).textContent = `${e.target.value}%`; });
  }
  $('simArtifacts').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    b.classList.toggle('active');
    sim.configure({ artifacts: { [b.dataset.a]: b.classList.contains('active') } });
  });

  $('sensors').innerHTML = CHANNELS.map(name => `<button data-ch="${name}"><b>${name}</b><span>${CHANNEL_INFO[name]}</span><em>off</em></button>`).join('');
  $('sensors').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const name = b.dataset.ch;
    const chosen = new Set(settings.sensors);
    if (chosen.has(name)) {
      if (chosen.size === 1) return toast('Keep at least one training sensor.');
      chosen.delete(name);
    } else {
      if (channels.get(name).quality.state === 'off') return toast(`${name} is not streaming.`);
      chosen.add(name);
    }
    settings.sensors = CHANNELS.filter(c => chosen.has(c));
    persist();
    renderProtocol();
    if (clock.active) { recalibrate(); toast('Training sensors changed. Recording a new baseline.'); }
    else engine.resetBaseline();
  });
}

async function connectMuse() {
  if (museConnecting || museConnected) return;
  if (!navigator.bluetooth) return toast('Web Bluetooth needs Chrome or Edge on desktop or Android.', true);
  if (source !== 'muse') {
    setSource('muse');
    if (source !== 'muse') return;
  }
  document.querySelector('.tabs [data-tab="signal"]').click();
  museConnecting = true;
  renderSource();
  try {
    if (museClient) disconnectMuse();
    museClient = new MuseClient();
    museClient.enableAux = true;
    museClient.enablePpg = true;
    try {
      await museClient.connect();
      museHasPpg = true;
    } catch (err) {
      // The original Muse has no pulse sensor: reconnect over the same link without it.
      const gatt = museClient.gatt;
      if (!gatt) throw err;
      museClient = new MuseClient();
      museClient.enableAux = true;
      await museClient.connect(gatt);
      museHasPpg = false;
    }
    museSubscriptions = [
      museClient.eegReadings.subscribe({
        next: handleMuseReading,
        error: err => toast(`EEG stream error: ${err.message || err}`, true)
      }),
      ...(museHasPpg ? [museClient.ppgReadings.subscribe(r => {
        // Infrared carries the clearest pulse of the three PPG channels.
        if (source !== 'muse' || r.ppgChannel !== 1) return;
        heart.pushPacket(r.index, r.samples);
        lastPpgAt = performance.now();
      })] : []),
      museClient.telemetryData.subscribe(t => {
        $('museInfo').textContent = `${museClient?.deviceName || 'Muse'} · ${FS} Hz · battery ${Math.round(t.batteryLevel)}%`;
      }),
      museClient.connectionStatus.subscribe(connected => {
        if (!connected && museConnected) {
          disconnectMuse();
          if (clock.active && !clock.paused) { clock.pause(); renderControls(); }
          toast('Muse disconnected. Session paused.', true);
        }
      })
    ];
    await museClient.start();
    museConnected = true;
    resetSignal();
    $('museInfo').textContent = `${museClient.deviceName || 'Muse'} · streaming at ${FS} Hz`;
    settings.scope.view = 'traces';
    applyScopeView();
    toast(museHasPpg ? 'Muse connected with pulse. Wait for every sensor to read good.' : 'Muse connected. Wait for every sensor to read good.');
  } catch (err) {
    disconnectMuse();
    if (err?.name !== 'NotFoundError') toast(`Connection failed: ${err.message || err}`, true);
  } finally {
    museConnecting = false;
    renderSource();
  }
}

function handleMuseReading(reading) {
  if (source !== 'muse') return;
  const name = CHANNELS[reading.electrode];
  if (name) channels.get(name).push(reading.samples, performance.now());
}

function disconnectMuse() {
  museSubscriptions.forEach(s => s.unsubscribe());
  museSubscriptions = [];
  try { museClient?.disconnect(); } catch {}
  museClient = null;
  museConnected = false;
  museHasPpg = false;
  $('museInfo').textContent = 'Muse 2 or Muse S over Web Bluetooth.';
  renderSource();
}

// ==========================================
// 7. SCOPE, MODALS, JOURNAL
// ==========================================

function applyScopeView() {
  const { view, scale } = settings.scope;
  $('spectrumCanvas').hidden = view !== 'spectrum';
  $('spectrogramCanvas').hidden = view !== 'spectrogram';
  $('traceCanvas').hidden = view !== 'traces';
  $('spectrumScale').hidden = view !== 'spectrum';
  $('bandLegend').hidden = view === 'traces';
  $('scopeUnits').textContent = view === 'spectrum' ? `${scale === 'log' ? 'dB re 1 µV²/Hz' : 'µV²/Hz'} · Hz`
    : view === 'spectrogram' ? 'Hz · darker is stronger' : `last ${TraceChart.SECONDS} s · ±100 µV per lane`;
  document.querySelectorAll('#scopeView button').forEach(b => b.classList.toggle('active', b.dataset.v === view));
  for (const c of [spectrumChart, spectrogram, traceChart]) c.fit();
}

function initScope() {
  spectrumChart = new SpectrumChart($('spectrumCanvas'));
  spectrogram = new Spectrogram($('spectrogramCanvas'));
  traceChart = new TraceChart($('traceCanvas'));
  stripChart = new StripChart($('stripCanvas'));
  summaryChart = new StripChart($('summaryCanvas'));
  trendChart = new TrendChart($('trendCanvas'));
  heartChart = new HeartChart($('heartCanvas'));
  spectrumChart.scale = settings.scope.scale;
  seg('scopeView', settings.scope.view, v => { settings.scope.view = v; applyScopeView(); persist(); });
  seg('spectrumScale', settings.scope.scale, v => { settings.scope.scale = v; spectrumChart.setScale(v); applyScopeView(); persist(); });
  applyBands();
  applyScopeView();
}

const showModal = (id) => $(id).classList.add('show');
const hideModal = (id) => $(id).classList.remove('show');

function openSummary(session, fresh = false) {
  openSessionId = session.id;
  $('summaryTitle').textContent = fresh ? 'Session complete' : new Date(session.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const setup = session.setup?.protocol ? describeProtocol(normalizeProtocol(session.setup.protocol)) : `${session.protocol} (${session.target})`;
  const extras = [
    session.bands?.iaf && `bands at ${session.bands.iaf} Hz alpha`,
    session.breath?.rate && `pacer ${session.breath.rate} / min`,
    session.stats.heartRate && `${Math.round(session.stats.heartRate)} bpm`,
    session.stats.coherencePct !== null && session.stats.coherencePct !== undefined && `coherence ${session.stats.coherencePct}%`
  ].filter(Boolean);
  $('summarySub').textContent = `${session.source === 'muse' ? 'Muse' : 'Simulated'} · ${(session.sensors || []).join(' + ') || '—'} · ${setup}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
  const reveal = $('summaryReveal');
  reveal.hidden = !session.condition;
  if (session.condition) {
    const guess = session.checkins?.guess;
    const guessText = !guess ? '' : guess === 'unsure' ? ' You weren’t sure.' : guess === session.condition ? ' You guessed right.' : ' You guessed the other way.';
    reveal.className = `reveal ${session.condition}`;
    reveal.innerHTML = session.condition === 'sham'
      ? `<b>Sham session.</b> The feedback replayed your usual reward pattern. Your rules were actually met ${session.stats.trueInZonePct}% of the time.${guessText}`
      : `<b>Real session.</b> The feedback followed your rules.${guessText}`;
  }
  const c = session.checkins;
  $('summaryCheckins').hidden = !(c?.pre || c?.post);
  if (c?.pre || c?.post) {
    const row = (label, get, unit = '', lowerBetter = false) => {
      const a = c.pre ? get(c.pre) : null, b = c.post ? get(c.post) : null;
      const d = a !== null && a !== undefined && b !== null && b !== undefined ? b - a : null;
      const better = d === null || d === 0 ? '' : (d < 0) === lowerBetter ? 'up' : 'down';
      return `<tr><td>${label}</td><td>${a ?? '—'}${a !== null && a !== undefined ? unit : ''}</td><td>${b ?? '—'}${b !== null && b !== undefined ? unit : ''}</td><td class="delta ${better}">${d === null ? '—' : `${d > 0 ? '+' : ''}${d}${unit}`}</td></tr>`;
    };
    const tested = c.pre?.pvt || c.post?.pvt;
    $('summaryCheckinRows').innerHTML = [
      tested && row('Reaction time, median', x => x.pvt?.medianMs ?? null, ' ms', true),
      tested && row('Lapses (≥ 500 ms)', x => x.pvt?.lapses ?? null, '', true),
      row('Calm', x => x.calm ?? null),
      row('Alert', x => x.alert ?? null)
    ].filter(Boolean).join('');
  }
  $('sumZone').textContent = `${session.stats.timeInZonePct}%`;
  $('sumStreak').textContent = `${session.stats.bestStreakSeconds}s`;
  $('sumTime').textContent = formatClock(session.stats.totalDurationSeconds);
  $('sumScore').textContent = session.stats.score;
  $('summaryBlocks').innerHTML = session.blocks.map(b => `<tr>
    <td>${b.blockNumber}</td><td>${formatClock(b.durationSeconds)}</td>
    <td>${b.durationSeconds > 0 ? Math.round((b.rewardSeconds / b.durationSeconds) * 100) : 0}%</td>
    <td>${b.longestStreak.toFixed(1)}s</td><td>${b.recoveries}</td>
    <td>${b.bandAverages.alpha.toFixed(1)}</td><td>${b.bandAverages.beta.toFixed(1)}</td><td>${b.bandAverages.theta.toFixed(1)}</td></tr>`).join('');
  $('summaryNotes').value = session.notes || '';
  showModal('summaryModal');
  const line = session.timeline;
  summaryChart.fit();
  summaryChart.load(line ? line.index.map(v => v / 100) : [], line ? line.reward : [], line?.stepSeconds || 2);
}

function openJournal() {
  const history = journal.getHistory();
  $('journalRows').innerHTML = history.length ? history.map(s => `<tr data-id="${s.id}">
    <td>${new Date(s.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
    <td>${esc(s.setup?.protocol?.name || s.protocol)}</td><td>${s.source === 'muse' ? 'Muse' : 'Sim'}</td>
    <td>${s.condition === 'sham' ? '<span class="tag sham">sham</span>' : s.condition === 'real' ? '<span class="tag">real</span>' : '—'}</td>
    <td>${formatClock(s.stats.totalDurationSeconds)}</td><td>${s.stats.timeInZonePct}%</td>
    <td>${s.stats.bestStreakSeconds}s</td><td>${s.stats.score}</td></tr>`).join('')
    : '<tr class="empty"><td colspan="8">No sessions yet. Finish one and it appears here.</td></tr>';
  renderComparison(history);
  const recent = history.slice(0, 30).reverse();
  $('trendHint').textContent = recent.length ? `last ${recent.length} · oldest to newest` : '';
  showModal('journalModal');
  trendChart.fit();
  trendChart.draw(recent);
}

function renderComparison(history) {
  const c = compareConditions(history);
  $('studyCompare').hidden = !(c.real.n || c.sham.n);
  if (!(c.real.n || c.sham.n)) return;
  const fmt = (m, unit, digits = 0) => m.mean === null ? '—'
    : `${m.mean > 0 && unit !== '%' ? '+' : ''}${m.mean.toFixed(digits)}${unit}${m.se !== null ? `<span class="sub">± ${m.se.toFixed(digits)} · n ${m.n}</span>` : `<span class="sub">n ${m.n}</span>`}`;
  const diff = (a, b, unit, digits = 0) => a.mean === null || b.mean === null ? '—'
    : `${a.mean - b.mean > 0 ? '+' : ''}${(a.mean - b.mean).toFixed(digits)}${unit}`;
  const rows = [
    ['Rules met', 'trueZone', '%', 0, 'How often your rules were actually met, whatever the feedback showed.'],
    ['Reaction time change', 'rt', ' ms', 0, 'After minus before. Negative is faster.'],
    ['Calm change', 'calm', '', 1, 'After minus before, 1–7 scale.'],
    ['Alert change', 'alert', '', 1, 'After minus before, 1–7 scale.']
  ];
  $('studyRows').innerHTML = rows.map(([label, key, unit, digits, tip]) =>
    `<tr title="${tip}"><td>${label}</td><td>${fmt(c.real[key], unit, digits)}</td><td>${fmt(c.sham[key], unit, digits)}</td><td>${diff(c.real[key], c.sham[key], unit, digits)}</td></tr>`).join('');
  $('studyHint').textContent = `${c.real.n} real · ${c.sham.n} sham`;
  const g = c.guesses;
  $('studyNote').textContent = [
    g.total ? `You named the condition correctly in ${g.correct} of ${g.total} session${g.total === 1 ? '' : 's'}${g.total >= 6 ? (g.correct / g.total > 0.75 ? ', so the blind may be leaking.' : ', close to chance: the blind is holding.') : '.'}` : '',
    '± is one standard error.'
  ].filter(Boolean).join(' ');
}

function download(content, fileName, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function initModals() {
  document.querySelectorAll('.modal:not(#checkinModal)').forEach(modal => {
    modal.addEventListener('click', e => {
      if (e.target === modal || e.target.closest('[data-close]')) modal.classList.remove('show');
    });
  });
  $('btnJournal').addEventListener('click', openJournal);
  const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const renderDocs = (page, section) => {
    $('docsContent').innerHTML = marked.parse({ how: howItWorks, guide: quickStart, features: featureList }[page] ?? readme);
    $('docsContent').querySelectorAll('h2, h3').forEach(h => { h.id = `doc-${slug(h.textContent)}`; });
    $('docsContent').scrollTop = 0;
    if (section) $(`doc-${section}`)?.scrollIntoView({ block: 'start' });
    document.querySelectorAll('#docsPages button').forEach(btn => {
      const active = btn.dataset.page === page;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    $('docsContent').querySelectorAll('a').forEach(link => {
      const internal = { 'docs/quick-start.md': 'guide', 'docs/features.md': 'features' }[link.getAttribute('href')];
      if (internal) {
        link.addEventListener('click', e => { e.preventDefault(); renderDocs(internal); });
      } else {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    });
  };
  const openDocs = () => {
    $('docsDialog').showModal();
    renderDocs('how');
  };
  $('btnDocs').addEventListener('click', openDocs);
  document.addEventListener('click', e => {
    const link = e.target.closest('a[data-doc]');
    if (!link) return;
    e.preventDefault();
    const [page, section] = link.dataset.doc.split('#');
    $('docsDialog').showModal();
    renderDocs(page, section);
  });
  $('btnCloseDocs').addEventListener('click', () => $('docsDialog').close());
  $('docsPages').addEventListener('click', e => {
    const btn = e.target.closest('button[data-page]');
    if (btn) renderDocs(btn.dataset.page);
  });
  $('journalRows').addEventListener('click', e => {
    const session = journal.getHistory().find(s => s.id === e.target.closest('tr')?.dataset.id);
    if (session) { hideModal('journalModal'); openSummary(session); }
  });
  $('btnSaveNotes').addEventListener('click', () => {
    toast(journal.setNotes(openSessionId, $('summaryNotes').value) ? 'Notes saved.' : 'Could not save notes.', false);
    hideModal('summaryModal');
  });
  $('btnDeleteSession').addEventListener('click', () => {
    if (!confirm('Delete this journal entry?')) return;
    journal.deleteSession(openSessionId);
    hideModal('summaryModal');
    toast('Entry deleted.');
  });
  $('btnExportCSV').addEventListener('click', () => download(journal.exportCSV(), 'resonance_sessions.csv', 'text/csv'));
  $('btnExportJSON').addEventListener('click', () => download(journal.exportJSON(), 'resonance_sessions.json', 'application/json'));
  $('btnClearJournal').addEventListener('click', () => {
    if (!confirm('Clear every saved session from this browser?')) return;
    journal.clearHistory();
    openJournal();
  });

  const welcomed = () => { settings.welcomed = true; persist(); hideModal('welcomeModal'); };
  $('btnWelcomeDemo').addEventListener('click', () => { welcomed(); requestStart(); });
  $('btnWelcomeMuse').addEventListener('click', () => {
    welcomed();
    document.querySelector('.tabs [data-tab="signal"]').click();
    setSource('muse');
  });
  if (!settings.welcomed) showModal('welcomeModal');
}

// ==========================================
// 8. WEB MCP
// ==========================================

function initMCP() {
  registerResonanceMCP({
    getState: () => ({
      mode: source,
      phase: clock.paused ? 'paused' : clock.phase,
      protocol: settings.protocol.presetId || 'custom',
      target: describeProtocol(settings.protocol),
      score: Math.round(stats.score),
      timeInZonePct: stats.usable > 0 ? Math.round((stats.rewardSec / stats.usable) * 100) : 0,
      currentStreak: stats.streak,
      bestStreak: stats.bestStreak,
      electrodeQuality: Object.fromEntries([...channels].map(([k, v]) => [k, v.quality.state])),
      heart: { state: pulse.state, bpm: pulse.hr, rmssdMs: pulse.rmssd, coherence: condition ? null : pulse.coherence },
      pacer: pacerOn() ? { rate: pacer.rate, inhale: pacer.inhale } : null,
      alphaPeakHz: settings.bands.iaf,
      personalBands: activeBands() !== BANDS
    }),
    setProtocol: (id) => {
      const preset = PRESETS.find(p => p.id === id);
      if (!preset) return false;
      applyPreset(preset);
      return true;
    },
    setSimulation: (args) => sim.configure({ state: args.mentalState, intensity: args.intensity, stability: args.stability })
  });
}

// ==========================================
// 9. BOOT
// ==========================================

function init() {
  document.body.dataset.palette = settings.palette;
  const th = chartTheme();
  flock = new FlockCanvas($('stageCanvas'), { count: settings.flock.count, variant: settings.flock.variant, hue: th.hue, light: false });
  flock.start();
  backdrop = new StageBackdrop($('backdropCanvas'), { getFocus: () => flock.centroid() });
  backdrop.setHue(th.hue);
  backdrop.start();

  initScope();
  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tabpanel').forEach(p => p.classList.toggle('active', p.dataset.panel === b.dataset.tab));
    b.closest('.rail').scrollTop = 0;
  });
  initProtocolPanel();
  initTimingPanel();
  initFeedbackPanel();
  initScenePanel();
  initSignalPanel();
  initBreathPanel();
  initModals();
  initMCP();

  renderProtocol();
  renderLibrary();
  renderTimer();
  renderSource();
  applyPalette();
  applySound();

  $('btnGo').addEventListener('click', togglePause);
  $('btnFinish').addEventListener('click', finishEarly);
  $('btnRecalibrate').addEventListener('click', recalibrate);
  $('btnMute').addEventListener('click', () => { muted = !muted; applySound(); });
  $('btnPanels').addEventListener('click', togglePanels);
  const renderFullscreen = () => {
    const active = document.fullscreenElement === $('stage');
    const btn = $('btnFullscreen');
    if (active && !settings.fullscreenUsed) { settings.fullscreenUsed = true; persist(); }
    $('fullscreenHint').hidden = !active && settings.fullscreenUsed;
    $('fullscreenHint').textContent = active ? 'Exit fullscreen' : 'Try fullscreen';
    btn.classList.toggle('fullscreen-invite', !active && !settings.fullscreenUsed);
    btn.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
    btn.title = active ? 'Exit fullscreen (Esc or F)' : 'Fullscreen (F)';
    btn.querySelector('i').className = active ? 'ti ti-minimize' : 'ti ti-maximize';
    btn.hidden = !document.fullscreenEnabled;
  };
  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('stage').requestFullscreen();
    } catch {
      toast('Could not open fullscreen. Try the fullscreen button again.', true);
    }
  };
  document.addEventListener('fullscreenchange', renderFullscreen);
  renderFullscreen();
  $('btnFullscreen').addEventListener('click', fullscreen);
  document.addEventListener('keydown', e => {
    if ($('docsDialog').open) return;
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.modal.show')) { if (e.key === 'Escape') document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show')); return; }
    if (e.code === 'Space') { if (e.target.closest('button')) return; e.preventDefault(); togglePause(); }
    else if (e.key === 'f') fullscreen();
    else if (e.key === 'm') { muted = !muted; applySound(); }
    else if (e.key === 'p') togglePanels();
    else if (e.key === '?') $('btnDocs').click();
  });

  requestAnimationFrame(frame);

  // Dev-only hook: advance the pipeline without animation frames (headless checks, hidden tabs).
  if (import.meta.env?.DEV) {
    window.__resonance = {
      flock,
      backdrop,
      advance(seconds) { for (let i = 0; i < seconds * 60; i++) step(lastFrame + 1000 / 60); },
      snapshot: () => ({ phase: clock.phase, block: clock.block, paused: clock.paused, signal, calibrated: engine.calibrated, reward: result?.reward, trueReward: truth?.reward, condition, procedure: procedure?.kind ?? null, pulse: { ...pulse }, pacer: pacerLevel, stats: { ...stats }, rows: result?.rows.map(r => ({ m: r.measure, pct: r.pct, target: r.target, pass: r.pass })) }),
      heart,
      simHeart
    };
  }
}

window.addEventListener('DOMContentLoaded', init);
