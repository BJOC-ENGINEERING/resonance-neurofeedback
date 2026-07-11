import { MuseClient } from 'muse-js';

const BANDS = [
  { k: 'delta', hz: '0.5-4 hz', c: '--delta', lo: 0.5, hi: 4, center: 2, desc: 'deep sleep, recovery' },
  { k: 'theta', hz: '4-8 hz', c: '--theta', lo: 4, hi: 8, center: 6, desc: 'meditative, creative' },
  { k: 'alpha', hz: '8-13 hz', c: '--alpha', lo: 8, hi: 13, center: 10, desc: 'relaxed calm-focus' },
  { k: 'beta', hz: '13-30 hz', c: '--beta', lo: 13, hi: 30, center: 20, desc: 'active thinking, alert' },
  { k: 'gamma', hz: '30-50 hz', c: '--gamma', lo: 30, hi: 50, center: 40, desc: 'hyperfocus, binding' }
];

const RESONANCE = [7.63, 19.99, 32.57];
const STATE_PROFILES = {
  sleep:      [1.00, 0.40, 0.13, 0.07, 0.04],
  meditative: [0.22, 0.95, 0.62, 0.15, 0.08],
  calm:       [0.12, 0.34, 1.00, 0.34, 0.10],
  thinking:   [0.08, 0.18, 0.34, 1.00, 0.26],
  hyper:      [0.06, 0.14, 0.24, 0.84, 0.76]
};
const STATE_LABELS = {
  sleep: 'deep sleep', meditative: 'meditative', calm: 'calm focus', thinking: 'active thinking', hyper: 'hyperfocus'
};

const $ = id => document.getElementById(id);
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const percentile = (values, q) => {
  if (!values.length) return 0.5;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)];
};

let mode = 'single';
let targets = [2];
let inputSource = 'sim';
let mentalState = 'calm';
let effort = 0.58;
let stability = 0.72;
let sound = true;
let visual = true;
let phase = 'idle';
let score = 0;
let peak = 0;
let elapsed = 0;
let threshold = 0.5;
let hot = false;
let sessionStart = 0;
let calibrationStart = 0;
let calibrationValues = [];
let featureHistory = [];
let progressHistory = [];
let zoneHits = 0;
let zoneTotal = 0;
let currentStreak = 0;
let bestStreak = 0;
let feature = 0;
let artifacts = { blink: false, muscle: false, mains: false };
let museClient = null;
let museSubscriptions = [];
let museConnected = false;
let museSamplesReceived = 0;
let musePacketCount = 0;
let museDc = 0;
let musePeakMicrovolts = 0;
let lastMusePacketAt = 0;
const museElectrodeSeenAt = [0, 0, 0, 0];
const pendingMusePackets = new Map();

const bandsEl = $('bands');
const bandEls = [];
const meterEls = [];
const meterBars = [];
const metersEl = $('meters');

BANDS.forEach((band, index) => {
  const button = document.createElement('button');
  button.className = 'band';
  button.dataset.i = index;
  button.style.setProperty('--bc', `var(${band.c})`);
  button.innerHTML = `<div class="top"><span class="nm"><i></i>${band.k}</span><span class="hz">${band.hz}</span></div>
    <div class="desc">${band.desc}</div><div class="bar"><i></i></div>`;
  button.onclick = () => {
    if (mode === 'resonate') return;
    targets = [index];
    resetSession(false);
    refreshTargets();
  };
  bandsEl.appendChild(button);
  bandEls.push(button);

  const meter = document.createElement('div');
  meter.className = 'meter';
  meter.dataset.i = index;
  meter.style.setProperty('--mc', `var(${band.c})`);
  meter.innerHTML = `<div class="mtop"><span class="mn">${band.k}</span><span class="mv" data-v>0</span></div>
    <div class="track">${Array.from({ length: 9 }, () => '<i></i>').join('')}</div>`;
  meter.onclick = button.onclick;
  metersEl.appendChild(meter);
  meterEls.push(meter);
  meterBars.push({ bars: [...meter.querySelectorAll('.track>i')], value: meter.querySelector('[data-v]'), history: new Array(9).fill(0.1) });
});

document.querySelectorAll('.mode').forEach(button => {
  button.onclick = () => setMode(button.dataset.mode);
});

document.querySelectorAll('.statebtn').forEach(button => {
  button.onclick = () => {
    mentalState = button.dataset.state;
    document.querySelectorAll('.statebtn').forEach(item => item.classList.toggle('on', item === button));
    toast(`Synthetic state: ${STATE_LABELS[mentalState]}`);
  };
});

$('effort').oninput = event => {
  effort = Number(event.target.value) / 100;
  $('effortVal').textContent = `${event.target.value}%`;
};
$('stability').oninput = event => {
  stability = Number(event.target.value) / 100;
  $('stabilityVal').textContent = `${event.target.value}%`;
};

document.querySelectorAll('.chip').forEach(button => {
  button.onclick = () => {
    const key = button.dataset.artifact;
    artifacts[key] = !artifacts[key];
    button.classList.toggle('on', artifacts[key]);
  };
});

$('connectMuse').onclick = connectMuse2;
$('disconnectMuse').onclick = disconnectMuseClient;

async function connectMuse2() {
  if (!navigator.bluetooth) {
    setMuseStatus('Web Bluetooth is unavailable — use desktop Chrome or Edge', false);
    toast('Muse 2 needs desktop Chrome or Edge.');
    return;
  }
  const connectButton = $('connectMuse');
  connectButton.disabled = true;
  connectButton.innerHTML = '<i class="ti ti-loader-2"></i>Connecting...';
  setMuseStatus('select Muse 2 in the browser prompt', false);
  try {
    if (museClient) disconnectMuseClient();
    museClient = new MuseClient();
    await museClient.connect();
    museSubscriptions = [
      museClient.eegReadings.subscribe({
        next: handleMuseReading,
        error: error => handleMuseStreamError(error)
      }),
      museClient.telemetryData.subscribe({
        next: telemetry => { $('museBattery').textContent = `battery ${Math.round(telemetry.batteryLevel)}%`; }
      }),
      museClient.connectionStatus.subscribe(connected => {
        if (!connected && museConnected) handleMuseDisconnected();
      })
    ];
    await museClient.start();
    museConnected = true;
    inputSource = 'muse';
    museSamplesReceived = 0;
    musePacketCount = 0;
    pendingMusePackets.clear();
    setMuseStatus(`${museClient.deviceName || 'Muse 2'} connected — waiting for EEG`, true);
    connectButton.style.display = 'none';
    $('disconnectMuse').style.display = 'inline-flex';
    $('go').disabled = true;
    $('cue').textContent = 'receiving Muse EEG — hold still for a moment';
    updateSourceBadge();
    toast('Muse 2 connected. Waiting for one second of EEG.');
  } catch (error) {
    const cancelled = error && error.name === 'NotFoundError';
    setMuseStatus(cancelled ? 'connection cancelled' : `connection failed: ${error.message || error}`, false);
    toast(cancelled ? 'No Muse selected.' : 'Could not connect to Muse 2.');
    disconnectMuseClient(false);
  } finally {
    connectButton.disabled = false;
    connectButton.innerHTML = '<i class="ti ti-bluetooth"></i>Connect Muse 2';
  }
}

function handleMuseReading(reading) {
  if (!museConnected || reading.electrode < 0 || reading.electrode > 3) return;
  lastMusePacketAt = performance.now();
  museElectrodeSeenAt[reading.electrode] = lastMusePacketAt;
  let packet = pendingMusePackets.get(reading.index);
  if (!packet) {
    packet = new Array(4);
    pendingMusePackets.set(reading.index, packet);
  }
  packet[reading.electrode] = reading.samples;
  if (packet.every(Boolean)) {
    const sampleCount = Math.min(...packet.map(samples => samples.length));
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
      const microvolts = packet.reduce((sum, samples) => sum + samples[sampleIndex], 0) / 4;
      museDc = museDc * 0.995 + microvolts * 0.005;
      musePeakMicrovolts = Math.max(musePeakMicrovolts * 0.995, Math.abs(microvolts - museDc));
      writeRingSample(clamp((microvolts - museDc) / 80, -4, 4));
      museSamplesReceived++;
    }
    musePacketCount++;
    pendingMusePackets.delete(reading.index);
    $('musePackets').textContent = `${musePacketCount.toLocaleString()} packets`;
    if (museSamplesReceived >= FFT_SIZE && $('go').disabled && phase === 'idle') {
      $('go').disabled = false;
      $('cue').textContent = 'Muse signal ready — calibrate to begin';
      setMuseStatus(`${museClient.deviceName || 'Muse 2'} streaming at 256 hz`, true);
    }
  }
  if (pendingMusePackets.size > 24) {
    const oldest = pendingMusePackets.keys().next().value;
    pendingMusePackets.delete(oldest);
  }
}

function handleMuseStreamError(error) {
  setMuseStatus(`EEG stream error: ${error.message || error}`, false);
  toast('Muse EEG stream stopped.');
}

function handleMuseDisconnected() {
  museConnected = false;
  inputSource = 'none';
  setMuseStatus('Muse 2 disconnected', false);
  $('connectMuse').style.display = 'inline-flex';
  $('disconnectMuse').style.display = 'none';
  $('go').disabled = true;
  resetSession(false);
  $('go').disabled = true;
  $('cue').textContent = 'Muse disconnected — reconnect to continue';
  updateSourceBadge();
}

function disconnectMuseClient(showToast = true) {
  museSubscriptions.forEach(subscription => subscription.unsubscribe());
  museSubscriptions = [];
  if (museClient) {
    try { museClient.disconnect(); } catch (error) { /* already disconnected */ }
  }
  museClient = null;
  museConnected = false;
  pendingMusePackets.clear();
  if (mode === 'muse') inputSource = 'none';
  setMuseStatus('headset not connected', false);
  $('connectMuse').style.display = 'inline-flex';
  $('disconnectMuse').style.display = 'none';
  if (mode === 'muse') {
    resetSession(false);
    $('go').disabled = true;
    $('cue').textContent = 'connect a Muse 2 to begin';
  }
  updateSourceBadge();
  if (showToast) toast('Muse 2 disconnected.');
}

function setMuseStatus(message, connected) {
  const element = $('museStatus');
  element.classList.toggle('connected', connected);
  element.querySelector('span').textContent = message;
}

function updateSourceBadge() {
  const badge = $('srcBadge');
  const live = mode === 'muse' && museConnected;
  badge.classList.toggle('hw', live);
  $('srcTxt').textContent = live ? 'live Muse 2 EEG' : mode === 'muse' ? 'Muse 2 ready' : 'simulated EEG';
}

addEventListener('beforeunload', () => {
  if (museClient) museClient.disconnect();
});

function setMode(nextMode) {
  const previousMode = mode;
  mode = nextMode;
  document.querySelectorAll('.mode').forEach(button => button.classList.toggle('on', button.dataset.mode === mode));
  targets = mode === 'resonate' ? [1, 3, 4] : [mode === 'muse' ? 2 : (targets[0] ?? 2)];
  bandEls.forEach(button => { button.style.opacity = mode === 'resonate' ? '0.55' : '1'; });
  $('scoreLbl').textContent = mode === 'resonate' ? 'resonance score' : mode === 'muse' ? 'live training score' : 'training score';
  document.body.classList.toggle('muse-mode', mode === 'muse');
  if (previousMode === 'muse' && mode !== 'muse' && museConnected) disconnectMuseClient();
  inputSource = mode === 'muse' ? (museConnected ? 'muse' : 'none') : 'sim';
  $('spectrumLbl').textContent = mode === 'muse' ? 'live EEG spectrum' : 'live synthetic spectrum';
  if (mode === 'muse' && !museConnected) clearSignalBuffer();
  resetSession(false);
  if (mode === 'muse' && !museConnected) {
    $('go').disabled = true;
    $('cue').textContent = 'connect a Muse 2 to begin';
  }
  updateSourceBadge();
  refreshTargets();
}

function refreshTargets() {
  bandEls.forEach((element, index) => element.classList.toggle('on', targets.includes(index)));
  meterEls.forEach((element, index) => element.classList.toggle('active', targets.includes(index)));
  if (mode === 'resonate') {
    $('scopeLbl').textContent = 'resonance \u00B7 7.63 + 19.99 + 32.57 hz';
    $('targetCnt').textContent = '3 waves';
  } else {
    const target = BANDS[targets[0]];
    $('scopeLbl').textContent = `${mode === 'muse' ? 'live ' : ''}${target.k} \u00B7 ${target.hz}`;
    $('targetCnt').textContent = mode === 'muse' ? 'Muse 2' : '';
  }
}

let audioContext;
let voices = [];
function initAudio() {
  if (audioContext) return;
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  [220, 330, 440].forEach(base => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = base;
    gain.gain.value = 0;
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    voices.push({ oscillator, gain, base });
  });
}

function setTone(level) {
  if (!audioContext) return;
  const audible = phase === 'running' && sound;
  voices.forEach((voice, index) => {
    const spread = mode === 'resonate' ? 0.88 + index * 0.08 : 1;
    voice.gain.gain.setTargetAtTime(audible ? 0.018 + level * 0.07 : 0, audioContext.currentTime, 0.12);
    voice.oscillator.frequency.setTargetAtTime(voice.base * spread * (0.82 + level * 0.58), audioContext.currentTime, 0.12);
  });
}

$('tSound').onclick = () => {
  sound = !sound;
  $('tSound').classList.toggle('on', sound);
  if (!sound) setTone(0);
};
$('tVisual').onclick = () => {
  visual = !visual;
  $('tVisual').classList.toggle('on', visual);
};

$('go').onclick = () => {
  if (phase === 'idle' || phase === 'finished') startCalibration();
  else if (phase === 'running') pauseSession();
  else if (phase === 'paused') resumeSession();
};
$('finish').onclick = finishSession;
$('reset').onclick = () => resetSession(true);
$('closeSummary').onclick = () => {
  $('summaryModal').classList.remove('show');
  resetSession(false);
};

function startCalibration() {
  if (mode === 'muse' && (!museConnected || museSamplesReceived < FFT_SIZE)) {
    toast('Connect Muse 2 and wait for the EEG signal first.');
    return;
  }
  resetMetrics();
  initAudio();
  if (audioContext.state === 'suspended') audioContext.resume();
  phase = 'calibrating';
  calibrationStart = performance.now();
  calibrationValues = [];
  document.body.classList.add('live', 'session');
  $('go').disabled = true;
  $('goTxt').textContent = 'Calibrating 3.0s';
  $('go').querySelector('i').className = 'ti ti-adjustments-horizontal';
  $('cue').textContent = 'reading a synthetic baseline\u2026';
}

function beginTraining() {
  threshold = clamp(percentile(calibrationValues, 0.62) + 0.025, 0.18, 0.86);
  phase = 'running';
  sessionStart = performance.now();
  $('go').disabled = false;
  $('goTxt').textContent = 'Pause';
  $('go').querySelector('i').className = 'ti ti-player-pause';
  toast(`Baseline set \u00B7 threshold ${Math.round(threshold * 100)}`);
}

function pauseSession() {
  elapsed = (performance.now() - sessionStart) / 1000;
  phase = 'paused';
  hot = false;
  setTone(0);
  $('goTxt').textContent = 'Resume';
  $('go').querySelector('i').className = 'ti ti-player-play';
  $('cue').textContent = 'paused \u2014 adjust the simulation or resume';
  $('cue').classList.remove('hot');
}

function resumeSession() {
  phase = 'running';
  sessionStart = performance.now() - elapsed * 1000;
  $('goTxt').textContent = 'Pause';
  $('go').querySelector('i').className = 'ti ti-player-pause';
}

function finishSession() {
  if (!['running', 'paused'].includes(phase)) return;
  if (phase === 'running') elapsed = (performance.now() - sessionStart) / 1000;
  phase = 'finished';
  hot = false;
  setTone(0);
  document.body.classList.remove('live');
  $('sumScore').textContent = score;
  $('sumZone').textContent = `${zoneTotal ? Math.round(zoneHits / zoneTotal * 100) : 0}%`;
  $('sumStreak').textContent = `${bestStreak.toFixed(1)}s`;
  const strongest = bandPowers.indexOf(Math.max(...bandPowers));
  $('sumBand').textContent = BANDS[strongest].k;
  const sourceLabel = mode === 'muse' ? 'live Muse 2' : STATE_LABELS[mentalState];
  $('summarySub').textContent = `${mode === 'resonate' ? 'Three-wave resonance' : BANDS[targets[0]].k + ' training'} \u00B7 ${sourceLabel} \u00B7 ${formatTime(elapsed)}`;
  $('summaryModal').classList.add('show');
}

function resetMetrics() {
  score = 0;
  peak = 0;
  elapsed = 0;
  zoneHits = 0;
  zoneTotal = 0;
  currentStreak = 0;
  bestStreak = 0;
  featureHistory = [];
  progressHistory = [];
}

function resetSession(withToast) {
  phase = 'idle';
  hot = false;
  resetMetrics();
  setTone(0);
  document.body.classList.remove('live', 'session');
  $('go').disabled = false;
  $('goTxt').textContent = 'Calibrate & start';
  $('go').querySelector('i').className = 'ti ti-player-play';
  $('cue').textContent = 'choose a state, then calibrate the simulation';
  $('cue').classList.remove('hot');
  $('summaryModal').classList.remove('show');
  if (mode === 'muse' && (!museConnected || museSamplesReceived < FFT_SIZE)) $('go').disabled = true;
  if (withToast) toast('Session reset.');
}

const FS = 256;
const RING_SIZE = 512;
const FFT_SIZE = 256;
const ring = new Float32Array(RING_SIZE);
let ringPosition = 0;
let generatedSamples = 0;
let sampleCarry = 0;
let lastFrameTime = performance.now();
let bandAmplitudes = STATE_PROFILES.calm.map(value => value * 0.52);
const bandPhases = BANDS.map(() => Math.random() * Math.PI * 2);
const resonancePhases = RESONANCE.map(() => Math.random() * Math.PI * 2);
let pinkA = 0;
let pinkB = 0;
let pinkC = 0;
let blinkRemaining = 0;

function writeRingSample(sample) {
  ring[ringPosition] = sample;
  ringPosition = (ringPosition + 1) % RING_SIZE;
  generatedSamples++;
}

function clearSignalBuffer() {
  ring.fill(0);
  ringPosition = 0;
  generatedSamples = 0;
  spectrumValues.fill(0);
  bandPowers = new Array(5).fill(0);
}

function generateSignal(deltaSeconds) {
  sampleCarry += Math.min(deltaSeconds, 0.1) * FS;
  const count = Math.floor(sampleCarry);
  sampleCarry -= count;
  const profile = STATE_PROFILES[mentalState];
  const calibrationEffort = phase === 'calibrating' ? 0.28 : effort;
  const noisiness = 1 - stability;
  const desired = profile.map((value, index) => {
    const selected = mode === 'single' && targets.includes(index);
    return 0.10 + value * 0.42 + (selected ? calibrationEffort * 0.52 : 0);
  });
  for (let index = 0; index < 5; index++) bandAmplitudes[index] += (desired[index] - bandAmplitudes[index]) * 0.015;

  for (let sampleIndex = 0; sampleIndex < count; sampleIndex++) {
    let sample = 0;
    for (let bandIndex = 0; bandIndex < BANDS.length; bandIndex++) {
      bandPhases[bandIndex] += Math.PI * 2 * BANDS[bandIndex].center / FS;
      sample += Math.sin(bandPhases[bandIndex]) * bandAmplitudes[bandIndex];
    }
    if (mode === 'resonate') {
      RESONANCE.forEach((frequency, index) => {
        resonancePhases[index] += Math.PI * 2 * frequency / FS;
        const wobble = 0.86 + Math.sin(generatedSamples / FS * (0.21 + index * 0.04) + index) * noisiness * 0.28;
        sample += Math.sin(resonancePhases[index]) * (0.12 + calibrationEffort * 0.58) * wobble;
      });
    }
    const white = Math.random() * 2 - 1;
    pinkA = 0.99765 * pinkA + white * 0.099046;
    pinkB = 0.963 * pinkB + white * 0.2965164;
    pinkC = 0.57 * pinkC + white * 1.0526913;
    sample += (pinkA + pinkB + pinkC + white * 0.1848) * (0.018 + noisiness * 0.055);

    if (artifacts.blink && blinkRemaining <= 0 && Math.random() < 0.0008) blinkRemaining = 84;
    if (blinkRemaining > 0) {
      sample += Math.sin(Math.PI * (1 - blinkRemaining / 84)) * 1.8;
      blinkRemaining--;
    }
    if (artifacts.muscle) sample += (Math.random() * 2 - 1) * 0.38 * Math.sin(generatedSamples * 1.37);
    if (artifacts.mains) sample += Math.sin(Math.PI * 2 * 50 * generatedSamples / FS) * 0.32;

    writeRingSample(sample);
  }
}

const hann = Array.from({ length: FFT_SIZE }, (_, index) => 0.5 * (1 - Math.cos(Math.PI * 2 * index / (FFT_SIZE - 1))));
const hannSum = hann.reduce((sum, value) => sum + value, 0);
const spectrumValues = new Array(51).fill(0);
let bandPowers = new Array(5).fill(0.1);
let spectrumTick = 0;

function ringSample(index) {
  const start = (ringPosition - FFT_SIZE + RING_SIZE) % RING_SIZE;
  return ring[(start + index) % RING_SIZE];
}

function magnitudeAt(frequency) {
  let real = 0;
  let imaginary = 0;
  const omega = Math.PI * 2 * frequency / FS;
  for (let index = 0; index < FFT_SIZE; index++) {
    const sample = ringSample(index) * hann[index];
    real += sample * Math.cos(omega * index);
    imaginary -= sample * Math.sin(omega * index);
  }
  return Math.sqrt(real * real + imaginary * imaginary) * 2 / hannSum;
}

function analyzeSignal() {
  for (let frequency = 1; frequency <= 50; frequency++) spectrumValues[frequency] = magnitudeAt(frequency);
  bandPowers = BANDS.map(band => {
    let energy = 0;
    let count = 0;
    for (let frequency = Math.max(1, Math.ceil(band.lo)); frequency <= Math.floor(band.hi); frequency++) {
      energy += spectrumValues[frequency] * spectrumValues[frequency];
      count++;
    }
    return clamp(Math.sqrt(energy / Math.max(1, count)) / 0.56);
  });

  if (mode === 'resonate') {
    const harmonics = RESONANCE.map(frequency => clamp(magnitudeAt(frequency) / 0.76));
    const balance = Math.min(...harmonics) / Math.max(0.01, Math.max(...harmonics));
    const energy = harmonics.reduce((sum, value) => sum + value, 0) / harmonics.length;
    feature = clamp(energy * 0.72 + balance * 0.28);
  } else {
    feature = bandPowers[targets[0]];
  }
  handleFeedbackTick();
}

function handleFeedbackTick() {
  if (phase === 'calibrating') {
    calibrationValues.push(feature);
    const remaining = Math.max(0, 3 - (performance.now() - calibrationStart) / 1000);
    $('goTxt').textContent = `Calibrating ${remaining.toFixed(1)}s`;
    $('cue').textContent = `sampling baseline \u00B7 ${remaining.toFixed(1)} seconds`;
    if (remaining <= 0 && calibrationValues.length > 8) beginTraining();
    return;
  }
  if (phase !== 'running') return;

  elapsed = (performance.now() - sessionStart) / 1000;
  hot = feature > threshold;
  zoneTotal++;
  if (hot) {
    zoneHits++;
    currentStreak += 0.1;
    bestStreak = Math.max(bestStreak, currentStreak);
    score = Math.min(99999, score + Math.max(1, Math.round((feature - threshold) * 95)));
  } else {
    currentStreak = 0;
  }
  peak = Math.max(peak, score);
  featureHistory.push(feature);
  if (featureHistory.length > 300) featureHistory.shift();
  progressHistory.push(feature);
  if (progressHistory.length > 240) progressHistory.shift();
  if (zoneTotal % 50 === 0 && featureHistory.length > 40) {
    const adaptiveTarget = percentile(featureHistory, 0.58);
    threshold += (adaptiveTarget - threshold) * 0.16;
  }
}

const scope = $('scope');
const scopeContext = scope.getContext('2d');
const bloom = $('bloom');
const bloomContext = bloom.getContext('2d');
const progress = $('prog');
const progressContext = progress.getContext('2d');
const spectrum = $('spectrum');
const spectrumContext = spectrum.getContext('2d');
let scopeRect;
let bloomRect;
let progressRect;
let spectrumRect;
let bloomLevel = 0;
let sparks = [];

function fit(canvas) {
  const rect = canvas.getBoundingClientRect();
  const density = Math.min(devicePixelRatio || 1, 2);
  canvas.width = rect.width * density;
  canvas.height = rect.height * density;
  canvas.getContext('2d').setTransform(density, 0, 0, density, 0, 0);
  return rect;
}
function fitCanvases() {
  scopeRect = fit(scope);
  bloomRect = fit(bloom);
  progressRect = fit(progress);
  spectrumRect = fit(spectrum);
}
addEventListener('resize', fitCanvases);

function drawScope() {
  const width = scopeRect.width;
  const height = scopeRect.height;
  scopeContext.clearRect(0, 0, width, height);
  scopeContext.strokeStyle = 'rgba(255,255,255,0.035)';
  scopeContext.lineWidth = 1;
  for (let y = 0; y < height; y += 25) {
    scopeContext.beginPath();
    scopeContext.moveTo(0, y);
    scopeContext.lineTo(width, y);
    scopeContext.stroke();
  }
  scopeContext.beginPath();
  let maxSample = 0;
  const samplesShown = Math.min(384, generatedSamples);
  for (let x = 0; x < width; x++) {
    const offset = Math.floor(x / width * Math.max(1, samplesShown - 1));
    const ringIndex = (ringPosition - samplesShown + offset + RING_SIZE) % RING_SIZE;
    const value = ring[ringIndex];
    maxSample = Math.max(maxSample, Math.abs(value));
    const y = height / 2 - value * height * 0.19;
    if (x === 0) scopeContext.moveTo(x, y); else scopeContext.lineTo(x, y);
  }
  const color = cssVar(BANDS[targets[0]].c);
  scopeContext.strokeStyle = color;
  scopeContext.shadowColor = color;
  scopeContext.shadowBlur = phase === 'running' ? 8 : 3;
  scopeContext.lineWidth = 1.7;
  scopeContext.stroke();
  scopeContext.shadowBlur = 0;
  $('scopeNow').textContent = inputSource === 'none' ? '-- \u00B5V' : `${(inputSource === 'muse' ? musePeakMicrovolts : maxSample * 26).toFixed(1)} \u00B5V`;
}

function drawSpectrum() {
  const width = spectrumRect.width;
  const height = spectrumRect.height;
  spectrumContext.clearRect(0, 0, width, height);
  spectrumContext.fillStyle = 'rgba(255,255,255,.025)';
  for (let frequency = 10; frequency <= 50; frequency += 10) spectrumContext.fillRect(frequency / 50 * width, 0, 1, height);
  const gradient = spectrumContext.createLinearGradient(0, 0, width, 0);
  BANDS.forEach((band, index) => gradient.addColorStop(index / 4, cssVar(band.c)));
  spectrumContext.beginPath();
  spectrumContext.moveTo(0, height);
  for (let frequency = 1; frequency <= 50; frequency++) {
    const x = frequency / 50 * width;
    const y = height - 8 - clamp(spectrumValues[frequency] / 1.25) * (height - 28);
    spectrumContext.lineTo(x, y);
  }
  spectrumContext.lineTo(width, height);
  spectrumContext.closePath();
  spectrumContext.globalAlpha = 0.18;
  spectrumContext.fillStyle = gradient;
  spectrumContext.fill();
  spectrumContext.globalAlpha = 1;
  spectrumContext.beginPath();
  for (let frequency = 1; frequency <= 50; frequency++) {
    const x = frequency / 50 * width;
    const y = height - 8 - clamp(spectrumValues[frequency] / 1.25) * (height - 28);
    if (frequency === 1) spectrumContext.moveTo(x, y); else spectrumContext.lineTo(x, y);
  }
  spectrumContext.strokeStyle = cssVar('--mint');
  spectrumContext.lineWidth = 1.5;
  spectrumContext.stroke();
  if (mode === 'resonate') {
    spectrumContext.setLineDash([3, 3]);
    RESONANCE.forEach(frequency => {
      const x = frequency / 50 * width;
      spectrumContext.beginPath();
      spectrumContext.moveTo(x, 20);
      spectrumContext.lineTo(x, height);
      spectrumContext.strokeStyle = 'rgba(242,178,92,.65)';
      spectrumContext.stroke();
    });
    spectrumContext.setLineDash([]);
  }
}

function drawBloom() {
  const targetLevel = phase === 'running' ? (hot ? 0.55 + feature * 0.45 : feature * 0.46) : 0;
  bloomLevel += (targetLevel - bloomLevel) * 0.08;
  const width = bloomRect.width;
  const height = bloomRect.height;
  bloomContext.clearRect(0, 0, width, height);
  if (!visual) return;
  const centerX = width / 2;
  const centerY = height * 0.45;
  const color = cssVar(BANDS[targets[0]].c);
  for (let ringIndex = 3; ringIndex >= 0; ringIndex--) {
    const radius = (24 + ringIndex * 30) * (0.6 + bloomLevel * 1.5);
    bloomContext.beginPath();
    bloomContext.arc(centerX, centerY, radius, 0, Math.PI * 2);
    bloomContext.fillStyle = hexAlpha(color, (0.05 + bloomLevel * 0.13) * (1 - ringIndex * 0.22));
    bloomContext.fill();
  }
  bloomContext.beginPath();
  bloomContext.arc(centerX, centerY, 18 + bloomLevel * 34, 0, Math.PI * 2);
  bloomContext.fillStyle = hexAlpha(color, 0.22 + bloomLevel * 0.55);
  bloomContext.shadowColor = color;
  bloomContext.shadowBlur = bloomLevel * 40;
  bloomContext.fill();
  bloomContext.shadowBlur = 0;
  if (hot && phase === 'running' && Math.random() < 0.35) {
    const angle = Math.random() * Math.PI * 2;
    sparks.push({ x: centerX, y: centerY, vx: Math.cos(angle) * (1 + Math.random() * 2.5), vy: Math.sin(angle) * (1 + Math.random() * 2.5), life: 1 });
  }
  sparks.forEach(spark => {
    spark.x += spark.vx;
    spark.y += spark.vy;
    spark.life = Math.max(0, spark.life - 0.02);
    bloomContext.beginPath();
    bloomContext.arc(spark.x, spark.y, 2 * spark.life, 0, Math.PI * 2);
    bloomContext.fillStyle = hexAlpha(color, spark.life * 0.8);
    bloomContext.fill();
  });
  sparks = sparks.filter(spark => spark.life > 0);
}

function drawProgress() {
  const width = progressRect.width;
  const height = progressRect.height;
  progressContext.clearRect(0, 0, width, height);
  const thresholdY = height - threshold * (height - 8) - 4;
  progressContext.strokeStyle = 'rgba(255,255,255,.14)';
  progressContext.setLineDash([4, 4]);
  progressContext.beginPath();
  progressContext.moveTo(0, thresholdY);
  progressContext.lineTo(width, thresholdY);
  progressContext.stroke();
  progressContext.setLineDash([]);
  if (progressHistory.length < 2) return;
  const xAt = index => index / (progressHistory.length - 1) * width;
  const yAt = value => height - value * (height - 8) - 4;
  const color = cssVar(BANDS[targets[0]].c);
  progressContext.beginPath();
  progressContext.moveTo(0, height);
  progressHistory.forEach((value, index) => progressContext.lineTo(xAt(index), yAt(value)));
  progressContext.lineTo(width, height);
  progressContext.closePath();
  progressContext.fillStyle = hexAlpha(color, 0.12);
  progressContext.fill();
  progressContext.beginPath();
  progressHistory.forEach((value, index) => index ? progressContext.lineTo(xAt(index), yAt(value)) : progressContext.moveTo(xAt(index), yAt(value)));
  progressContext.strokeStyle = color;
  progressContext.lineWidth = 2;
  progressContext.stroke();
}

function updateReadouts() {
  bandEls.forEach((element, index) => { element.querySelector('.bar>i').style.width = `${bandPowers[index] * 100}%`; });
  meterBars.forEach((meter, index) => {
    meter.history.push(bandPowers[index]);
    meter.history.shift();
    meter.bars.forEach((bar, barIndex) => { bar.style.height = `${6 + meter.history[barIndex] * 40}px`; });
    meter.value.textContent = Math.round(bandPowers[index] * 100);
  });
  const scoreElement = $('score');
  scoreElement.textContent = score;
  scoreElement.classList.toggle('hot', hot);
  $('statPeak').textContent = peak;
  $('statTime').textContent = formatTime(elapsed);
  const average = progressHistory.length ? progressHistory.reduce((sum, value) => sum + value, 0) / progressHistory.length : 0;
  $('progAvg').textContent = `avg ${Math.round(average * 100)}`;
  $('progTip').textContent = `time in zone ${zoneTotal ? Math.round(zoneHits / zoneTotal * 100) : 0}%`;
  if (phase === 'running') {
    const name = mode === 'resonate' ? 'resonance' : BANDS[targets[0]].k;
    $('cue').classList.toggle('hot', hot);
    $('cue').textContent = hot ? `in the zone \u2014 hold the ${name}` : feature > threshold * 0.82 ? 'getting warmer\u2026' : `quiet \u2014 raise the ${name}`;
  }
  setTone(feature);
  if (mode === 'muse') {
    const now = performance.now();
    document.querySelectorAll('.channel').forEach(element => {
      const electrode = Number(element.dataset.electrode);
      element.classList.toggle('live', now - museElectrodeSeenAt[electrode] < 750);
    });
  }
}

function frame(now) {
  const deltaSeconds = (now - lastFrameTime) / 1000;
  lastFrameTime = now;
  if (inputSource === 'sim') generateSignal(deltaSeconds);
  spectrumTick += deltaSeconds;
  if (spectrumTick >= 0.1 && generatedSamples >= FFT_SIZE) {
    spectrumTick = 0;
    analyzeSignal();
  }
  if (phase === 'running') elapsed = (performance.now() - sessionStart) / 1000;
  drawScope();
  drawSpectrum();
  drawBloom();
  drawProgress();
  updateReadouts();
  requestAnimationFrame(frame);
}

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(element._timer);
  element._timer = setTimeout(() => element.classList.remove('show'), 3000);
}

function formatTime(seconds) {
  seconds = Math.floor(seconds);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function hexAlpha(hex, alpha) {
  const clean = hex.replace('#', '');
  const number = parseInt(clean, 16);
  return `rgba(${(number >> 16) & 255},${(number >> 8) & 255},${number & 255},${alpha})`;
}

fitCanvases();
setMode('single');
requestAnimationFrame(frame);
