import { MuseClient } from 'muse-js';
import { marked } from 'marked';
import readme from './README.md?raw';
import quickStart from './docs/quick-start.md?raw';
import { FS, CHANNELS, CHANNEL_INFO, WINDOW, BANDS, psd, peakFrequency, Channel, assessQuality, DEFAULT_QUALITY_LIMITS } from './src/dsp.js';
import { ProtocolEngine, computeFeatures, normalizeProtocol, describeProtocol, MEASURES, MEASURE_BY_KEY, PRESETS, DEFAULT_PROTOCOL } from './src/protocol.js';
import { SessionClock, normalizeTimer, describeTimer, formatClock, TIMER_PRESETS, DEFAULT_TIMER } from './src/session.js';
import { SimulatedEEG, SIM_STATES } from './src/sim.js';
import { FlockCanvas } from './src/flock.js';
import { StageBackdrop } from './src/backdrop.js';
import { VideoScene } from './src/scene-video.js';
import { AudioEngine } from './src/audio.js';
import { SessionJournal } from './src/journal.js';
import { SpectrumChart, Spectrogram, TraceChart, StripChart, TrendChart, chartTheme, refreshChartTheme } from './src/charts.js';
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
  focus: saved.focus ?? true,
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

let flock, backdrop, videoScene, spectrumChart, spectrogram, traceChart, stripChart, summaryChart, trendChart;
let result = null;        // latest engine evaluation
let features = null;
let signal = 'none';      // 'ok' | 'artifact' | 'bad' | 'none'
let artifactUntil = 0;
let muted = false;
let openSessionId = null;
let pendingStart = false; // start requested before the first analysis window filled
let showPanels = false;   // user reopened the rails during a focused session
const stats = { usable: 0, rewardSec: 0, streak: 0, bestStreak: 0, score: 0, milestones: 0 };

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
  }

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

  features = computeFeatures(spectra, settings.sensors);
  const feedbackOpen = clock.phase !== 'break' && !clock.paused && clock.phase !== 'finished';
  result = engine.evaluate(features, ANALYSIS_DT, { valid: clean && feedbackOpen });

  const wasTraining = clock.training;
  for (const event of clock.tick(ANALYSIS_DT, { valid: contact })) handleClockEvent(event);

  const rewarded = result.reward && (clock.training || clock.phase === 'idle');
  if (wasTraining && clock.training && contact) accumulate(rewarded);

  const hold = clock.phase === 'calibrating' ? 0 : result.holdProgress;
  const dimmed = clock.phase === 'break' || clock.paused || clock.phase === 'calibrating' || !contact;
  flock.setReward(rewarded, 0.25 + result.index * 0.75, hold);
  flock.setDimmed(dimmed);
  backdrop.set({ energy: rewarded ? 0.55 + result.index * 0.45 : hold * 0.25, hold, dimmed });
  updateVideoScene(rewarded, hold, contact);
  audio.update(result.index, clock.training, rewarded && clock.training);
  stripChart.push(result.index, rewarded);
  spectrogram.push(features?.spectrum, ANALYSIS_DT);
  renderLive(rewarded);
}

function accumulate(rewarded) {
  const dt = ANALYSIS_DT;
  stats.usable += dt;
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
  journal.recordTick(dt, rewarded, features ? Object.fromEntries(BANDS.map(b => [b.k, features[b.k]])) : {}, result.index);
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

function startSession() {
  if (!settings.protocol.rules.length) return toast('Enable at least one rule first.', true);
  if (signal === 'none') {
    if (source === 'sim') { pendingStart = true; return; }
    return toast('Connect the headset and wait for signal.', true);
  }
  audio.init();
  audio.resume();
  applySound();
  Object.assign(stats, { usable: 0, rewardSec: 0, streak: 0, bestStreak: 0, score: 0, milestones: 0 });
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
    setup: { protocol: settings.protocol, timer: settings.timer }
  });
  renderControls();
}

function togglePause() {
  if (!clock.active) return startSession();
  if (clock.paused) { clock.resume(); audio.resume(); }
  else { clock.pause(); journal.addEvent('pause'); }
  renderControls();
}

function finishEarly() {
  for (const event of clock.finish()) handleClockEvent(event);
}

function completeSession() {
  const session = journal.finishSession(stats.score);
  clock.reset(); // back to live preview against the recorded baseline
  renderControls();
  if (!session) return;
  if (session.stats.totalDurationSeconds < 1) {
    journal.deleteSession(session.id);
    return toast('Session ended before training began. Nothing saved.');
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

function renderLive(rewarded) {
  // Clock and cue
  const phase = clock.phase;
  $('clockTime').textContent = formatClock(phase === 'idle' || phase === 'finished' ? clock.timer.blockSec : clock.remaining);
  const contact = signal === 'ok' || signal === 'artifact';
  const phaseText = clock.paused ? 'Paused'
    : phase === 'calibrating' ? 'Recording baseline'
    : phase === 'training' ? (contact ? `Block ${clock.block} of ${clock.timer.blocks}` : 'Clock stopped · check sensors')
    : phase === 'break' ? 'Break'
    : phase === 'finished' ? 'Finished' : 'Ready · live preview';
  $('clockPhase').textContent = phaseText;

  const cue = $('cue');
  let text;
  if (!settings.protocol.rules.length) text = 'Enable a rule to begin.';
  else if (signal === 'none') text = source === 'muse' ? 'Waiting for the headset.' : 'Starting signal…';
  else if (signal === 'bad') text = 'A training sensor lost contact. Adjust the band.';
  else if (clock.paused) text = 'Paused.';
  else if (phase === 'calibrating') text = 'Rest your gaze on the flock. Measuring your baseline.';
  else if (phase === 'break') text = 'Rest. Feedback resumes after the break.';
  else if (nowMs < artifactUntil) text = 'Movement detected. Stay still.';
  else if (rewarded) text = 'In the zone.';
  else if (result.allPass) text = 'Hold it…';
  else if (phase === 'idle') text = 'Live preview. Press start to record a baseline and train.';
  else text = 'Ease toward the target. The flock will gather.';
  cue.textContent = text;
  cue.classList.toggle('hot', rewarded);
  $('stage').classList.toggle('rewarded', rewarded);

  const holding = settings.protocol.holdSec > 0 && result.holdProgress > 0 && !rewarded && phase !== 'calibrating';
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
  state.textContent = signal === 'none' ? 'no signal' : signal === 'bad' ? 'poor contact'
    : nowMs < artifactUntil ? 'artifact' : rewarded ? 'reward on' : result.allPass ? 'holding' : `${result.passing} / ${result.rows.length} passing`;
  state.className = `state ${rewarded ? 'on' : signal === 'bad' || nowMs < artifactUntil ? 'warn' : ''}`;
  const rows = $('measureRows');
  if (rows.children.length !== Math.max(1, result.rows.length) || rows.dataset.key !== ruleKey()) buildMeasureRows();
  result.rows.forEach((r, i) => {
    const tr = rows.children[i];
    const m = MEASURE_BY_KEY[r.measure];
    const digits = m.unit === 'Hz' || !m.unit ? 2 : 1;
    tr.children[1].innerHTML = r.pct === null ? '—' : `${r.pct.toFixed(0)}%<span class="sub">${r.now.toFixed(digits)} ${m.unit}</span>`;
    tr.children[2].textContent = `${r.mode === 'up' ? '≥' : '≤'} ${r.target.toFixed(r.target % 1 ? 1 : 0)}%`;
    tr.children[3].textContent = r.pct === null ? (r.measure === 'asym' ? 'AF7+AF8' : '—') : r.pass ? '✓ pass' : '· wait';
    tr.children[3].className = r.pass ? 'pass' : 'fail';
    const bar = tr.querySelector('.bar');
    const span = Math.max(200, r.target * 1.5);
    bar.style.setProperty('--v', `${Math.min(100, ((r.pct ?? 0) / span) * 100)}%`);
    bar.style.setProperty('--t', `${Math.min(100, (r.target / span) * 100)}%`);
    bar.classList.toggle('pass', r.pass);
  });
  $('baselineNote').textContent = engine.calibrated
    ? `Percent of your recorded baseline${settings.protocol.difficulty.mode === 'auto' ? ' · targets adapt toward ' + Math.round(settings.protocol.difficulty.rate * 100) + '% reward' : ''}.`
    : 'Percent of a drifting reference until you record a baseline.';

  // Tiles and milestones
  $('statZone').textContent = `${stats.usable > 0 ? Math.round((stats.rewardSec / stats.usable) * 100) : 0}%`;
  $('statStreak').textContent = `${stats.bestStreak.toFixed(1)}s`;
  $('statEarned').textContent = formatClock(Math.floor(stats.rewardSec));
  $('statScore').textContent = Math.round(stats.score);
  $('hudZone').textContent = $('statZone').textContent;
  $('hudStreak').textContent = $('statStreak').textContent;
  $('hudScore').textContent = $('statScore').textContent;
  const marks = $('milestoneMarks');
  const shown = Math.min(stats.milestones, 12);
  if (marks.dataset.n !== String(stats.milestones)) {
    marks.dataset.n = String(stats.milestones);
    marks.innerHTML = Array.from({ length: Math.max(5, shown) }, (_, i) => `<i class="${i < shown ? 'on' : ''}"></i>`).join('')
      + (stats.milestones > 12 ? `<span>+${stats.milestones - 12}</span>` : '');
  }
  const toNext = settings.milestoneSec - (stats.rewardSec % settings.milestoneSec);
  $('milestoneText').textContent = `next mark in ${toNext.toFixed(0)} s rewarded`;

  // Sensors and steps
  document.querySelectorAll('#sensors button').forEach(btn => {
    const q = channels.get(btn.dataset.ch).quality;
    btn.className = `${q.state} ${settings.sensors.includes(btn.dataset.ch) ? 'selected' : ''}`;
    btn.querySelector('em').textContent = q.state === 'artifact' ? (q.blink ? 'blink' : q.motion ? 'motion' : 'muscle') : q.state;
  });
  const connected = source === 'sim' || museConnected;
  const stepState = {
    connect: connected,
    signal: connected && signal === 'ok',
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

  if (features) $('peakText').textContent = `peak ${peakFrequency(features.spectrum, 4, 30).toFixed(1)} Hz`;
}

const ruleKey = () => settings.protocol.rules.map(r => r.measure + r.mode).join('|');

function buildMeasureRows() {
  const rows = $('measureRows');
  rows.dataset.key = ruleKey();
  rows.innerHTML = settings.protocol.rules.length ? settings.protocol.rules.map(r => {
    const m = MEASURE_BY_KEY[r.measure];
    return `<tr><td><div class="m"><i style="${m.color ? `background:var(${m.color})` : ''}"></i>${m.label} ${r.mode === 'up' ? '↑' : '↓'}</div><div class="bar"></div></td><td></td><td></td><td></td></tr>`;
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
  $('btnGoText').textContent = !active ? 'Start session' : clock.paused ? 'Resume' : 'Pause';
  $('btnGo').querySelector('i').className = `ti ti-player-${active && !clock.paused ? 'pause' : 'play'}`;
  $('btnFinish').hidden = !active;
  $('btnRecalibrate').hidden = !active;
  document.querySelectorAll('[data-panel="timing"] input, [data-panel="timing"] select, #timerPresets button, #sourceMode button')
    .forEach(el => { el.disabled = active; });
  renderFocus();
}

// Focus mode: while a session runs, the rails fold away unless the viewer asks for them.
function renderFocus() {
  const running = clock.active && !clock.paused;
  if (!clock.active) showPanels = false;
  document.body.classList.toggle('focus', settings.focus && running && !showPanels);
  const btn = $('btnPanels');
  btn.hidden = !(settings.focus && running);
  btn.setAttribute('aria-pressed', String(showPanels));
  $('panelsText').textContent = showPanels ? 'Hide panels' : 'Show panels';
  btn.querySelector('i').className = `ti ti-layout-sidebar-left-${showPanels ? 'collapse' : 'expand'}`;
}

function togglePanels() {
  if (!(settings.focus && clock.active && !clock.paused)) return;
  showPanels = !showPanels;
  renderFocus();
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
  $('focusMode').checked = settings.focus;
  $('focusMode').addEventListener('change', e => { settings.focus = e.target.checked; renderFocus(); persist(); });
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
    `<button data-id="${x.id}" class="${x.id === p.presetId ? 'active' : ''}"><b>${x.name}</b><span>eyes ${x.eyes}</span></button>`).join('')
    + `<p class="preset-blurb">${active ? active.blurb : 'Custom rules.'}</p>`;

  $('rules').innerHTML = MEASURES.map(m => {
    const r = p.rules.find(x => x.measure === m.k);
    const mode = r?.mode || 'off';
    return `<div class="rule ${mode === 'off' ? 'off' : ''}" data-m="${m.k}">
      <div class="name"><i style="${m.color ? `background:var(${m.color})` : ''}"></i><b>${m.label}</b><span>${m.range}</span></div>
      <div class="seg small">
        <button data-mode="off" class="${mode === 'off' ? 'active' : ''}" title="Off">–</button>
        <button data-mode="up" class="${mode === 'up' ? 'active' : ''}" title="Reward at or above">↑</button>
        <button data-mode="down" class="${mode === 'down' ? 'active' : ''}" title="Reward at or below">↓</button>
      </div>
      <input type="number" min="10" max="400" step="1" value="${r?.threshold ?? 100}" aria-label="${m.label} threshold, percent of baseline" title="% of baseline">
    </div>`;
  }).join('');

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

function initProtocolPanel() {
  $('protocolShortcuts').addEventListener('click', e => {
    const btn = e.target.closest('button[data-section]');
    if (!btn) return;
    const target = $(btn.dataset.section);
    const rail = btn.closest('.rail');
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    const top = rail.scrollTop + target.getBoundingClientRect().top - rail.getBoundingClientRect().top
      - rail.querySelector('.rail-nav').offsetHeight - 16;
    target.focus({ preventScroll: true });
    if (rail.scrollHeight > rail.clientHeight) rail.scrollTo({ top, behavior });
    else {
      target.style.scrollMarginTop = `${rail.querySelector('.rail-nav').offsetHeight + 16}px`;
      target.scrollIntoView({ block: 'start', behavior });
    }
  });
  $('presets').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const preset = PRESETS.find(x => x.id === b.dataset.id);
    commitProtocol({ presetId: preset.id, name: preset.name, rules: preset.rules.map(r => ({ ...r })), holdSec: preset.holdSec }, { fromPreset: true });
    if (preset.id === 'balance' && !(settings.sensors.includes('AF7') && settings.sensors.includes('AF8'))) toast('Balance reads AF7 and AF8 regardless of the training sites.');
  });

  $('rules').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    const row = b.closest('.rule');
    commitProtocol({ rules: rulesFromDom(row.dataset.m, b.dataset.mode, Number(row.querySelector('input').value) || 100) });
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
  audio.setMuted(muted || s.mode === 'mute');
  if (s.mode !== 'mute') audio.setSoundMode(s.mode);
  audio.setVolume(s.volume);
  audio.setChimeRate(s.rate);
  audio.setAmbience(s.ambience);
  $('muteText').textContent = muted || s.mode === 'mute' ? 'Sound off' : 'Sound on';
  $('btnMute').querySelector('i').className = `ti ti-volume${muted || s.mode === 'mute' ? '-off' : ''}`;
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
  seg('soundMode', s.mode, v => { s.mode = v; if (v !== 'mute') muted = false; applySound(); persist(); });
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
  engine.resetBaseline();
  spectrogram.clear();
  stripChart.clear();
  features = null;
}

function setSource(next) {
  if (clock.active) return toast('Finish the session before switching source.', true);
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
  $('sourceText').textContent = source === 'sim' ? 'Simulated EEG' : live ? 'Live Muse EEG' : 'Muse not connected';
  $('sourceBadge').classList.toggle('live', live);
  $('btnDisconnectMuse').hidden = !museConnected;
  for (const id of ['btnConnectMuse', 'btnHeaderConnectMuse']) {
    const btn = $(id);
    btn.hidden = museConnected;
    btn.disabled = museConnecting;
    btn.querySelector('span').textContent = museConnecting ? 'Connecting…' : 'Connect Muse';
  }
  document.querySelectorAll('#sourceMode button').forEach(btn => { btn.disabled = museConnecting; });
}

function initSignalPanel() {
  seg('sourceMode', source, setSource);
  $('btnConnectMuse').addEventListener('click', connectMuse);
  $('btnHeaderConnectMuse').addEventListener('click', connectMuse);
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
    await museClient.connect();
    museSubscriptions = [
      museClient.eegReadings.subscribe({
        next: handleMuseReading,
        error: err => toast(`EEG stream error: ${err.message || err}`, true)
      }),
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
    toast('Muse connected. Wait for every sensor to read good.');
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
  spectrumChart.scale = settings.scope.scale;
  seg('scopeView', settings.scope.view, v => { settings.scope.view = v; applyScopeView(); persist(); });
  seg('spectrumScale', settings.scope.scale, v => { settings.scope.scale = v; spectrumChart.setScale(v); applyScopeView(); persist(); });
  $('bandLegend').innerHTML = BANDS.map(b => `<span><i style="background:var(${b.color})"></i>${b.k[0].toUpperCase() + b.k.slice(1)} <em>${b.lo}–${b.hi}</em></span>`).join('');
  applyScopeView();
}

const showModal = (id) => $(id).classList.add('show');
const hideModal = (id) => $(id).classList.remove('show');

function openSummary(session, fresh = false) {
  openSessionId = session.id;
  $('summaryTitle').textContent = fresh ? 'Session complete' : new Date(session.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const setup = session.setup?.protocol ? describeProtocol(normalizeProtocol(session.setup.protocol)) : `${session.protocol} (${session.target})`;
  $('summarySub').textContent = `${session.source === 'muse' ? 'Muse' : 'Simulated'} · ${(session.sensors || []).join(' + ') || '—'} · ${setup}`;
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
    <td>${formatClock(s.stats.totalDurationSeconds)}</td><td>${s.stats.timeInZonePct}%</td>
    <td>${s.stats.bestStreakSeconds}s</td><td>${s.stats.score}</td></tr>`).join('')
    : '<tr class="empty"><td colspan="7">No sessions yet. Finish one and it appears here.</td></tr>';
  const recent = history.slice(0, 30).reverse();
  $('trendHint').textContent = recent.length ? `last ${recent.length} · oldest to newest` : '';
  showModal('journalModal');
  trendChart.fit();
  trendChart.draw(recent);
}

function download(content, fileName, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function initModals() {
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', e => {
      if (e.target === modal || e.target.closest('[data-close]')) modal.classList.remove('show');
    });
  });
  $('btnJournal').addEventListener('click', openJournal);
  $('btnHelp').addEventListener('click', () => showModal('helpModal'));
  const renderDocs = (page) => {
    $('docsContent').innerHTML = marked.parse(page === 'guide' ? quickStart : readme);
    $('docsContent').scrollTop = 0;
    document.querySelectorAll('#docsPages button').forEach(btn => {
      const active = btn.dataset.page === page;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    $('docsContent').querySelectorAll('a').forEach(link => {
      if (link.getAttribute('href') === 'docs/quick-start.md') {
        link.addEventListener('click', e => { e.preventDefault(); renderDocs('guide'); });
      } else {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    });
  };
  $('btnDocs').addEventListener('click', () => {
    renderDocs('readme');
    $('docsDialog').showModal();
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
  $('btnWelcomeDemo').addEventListener('click', () => { welcomed(); startSession(); });
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
      electrodeQuality: Object.fromEntries([...channels].map(([k, v]) => [k, v.quality.state]))
    }),
    setProtocol: (id) => {
      const preset = PRESETS.find(p => p.id === id);
      if (!preset) return false;
      commitProtocol({ presetId: preset.id, name: preset.name, rules: preset.rules.map(r => ({ ...r })), holdSec: preset.holdSec }, { fromPreset: true });
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
    $('protocolShortcuts').hidden = b.dataset.tab !== 'protocol';
    b.closest('.rail').scrollTop = 0;
  });
  initProtocolPanel();
  initTimingPanel();
  initFeedbackPanel();
  initScenePanel();
  initSignalPanel();
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
    $('fullscreenHint').hidden = false;
    $('fullscreenHint').textContent = active ? 'Exit fullscreen' : 'Try fullscreen';
    btn.classList.toggle('fullscreen-invite', !active);
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
  });

  requestAnimationFrame(frame);

  // Dev-only hook: advance the pipeline without animation frames (headless checks, hidden tabs).
  if (import.meta.env?.DEV) {
    window.__resonance = {
      flock,
      backdrop,
      advance(seconds) { for (let i = 0; i < seconds * 60; i++) step(lastFrame + 1000 / 60); },
      snapshot: () => ({ phase: clock.phase, block: clock.block, paused: clock.paused, signal, calibrated: engine.calibrated, reward: result?.reward, stats: { ...stats }, rows: result?.rows.map(r => ({ m: r.measure, pct: r.pct, target: r.target, pass: r.pass })) })
    };
  }
}

window.addEventListener('DOMContentLoaded', init);
