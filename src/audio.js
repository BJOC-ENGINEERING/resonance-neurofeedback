// Web Audio Feedback Engine
// Supports Continuous Harmonic Drone, Pentatonic Chimes, and Ambient Pink Noise / Rain

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.droneVoices = [];
    this.noiseNode = null;
    this.noiseGain = null;
    this.masterGain = null;
    this.soundMode = 'chime'; // 'chime' | 'drone' | 'both'
    this.volume = 0.8;
    this.muted = false;
    this.lastChimeAt = 0;
    this.chimeNotes = [523.25, 659.25, 783.99, 880.00, 1046.50]; // C5, E5, G5, A5, C6
    this.chimeIdx = 0;
    this.chimeIntervalMs = 1000; // repeat while reward is active
    this.ambience = true;        // pink-noise bed under the feedback
  }

  init() {
    if (this.ctx) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContext();

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : this.volume;
    this.masterGain.connect(this.ctx.destination);

    // Initialize Drone (3 sine oscillators: 220, 330, 440)
    [220, 330, 440].forEach((baseFreq) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = baseFreq;
      gain.gain.value = 0;
      osc.connect(gain).connect(this.masterGain);
      osc.start();
      this.droneVoices.push({ osc, gain, baseFreq });
    });

    // Initialize Procedural Pink Noise
    this.initPinkNoise();
  }

  initPinkNoise() {
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * 2;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;

    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.04;
      b6 = white * 0.115926;
    }

    const whiteNoise = this.ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;
    whiteNoise.loop = true;

    // Filter for gentle rain-like quality
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;

    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.value = 0;

    whiteNoise.connect(filter).connect(this.noiseGain).connect(this.masterGain);
    whiteNoise.start();
    this.noiseNode = whiteNoise;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    }
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (!this.muted && this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  setSoundMode(mode) {
    this.soundMode = mode;
    if (mode === 'chime' && this.droneVoices.length) {
      // Silence drone
      this.droneVoices.forEach(v => v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1));
    }
  }

  // Called on each frame with reward level (0 to 1) and whether state is active
  update(level, isRunning, isReward) {
    if (!this.ctx || this.muted || !isRunning) {
      if (this.droneVoices.length && this.ctx) {
        this.droneVoices.forEach(v => v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1));
      }
      if (this.noiseGain && this.ctx) {
        this.noiseGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
      }
      return;
    }

    const now = performance.now();

    // 1. Drone update
    if (this.soundMode === 'drone' || this.soundMode === 'both') {
      this.droneVoices.forEach((voice, index) => {
        const spread = 0.95 + index * 0.05;
        const targetFreq = voice.baseFreq * spread * (0.85 + level * 0.45);
        const targetVol = 0.015 + level * 0.08;
        voice.gain.gain.setTargetAtTime(targetVol, this.ctx.currentTime, 0.12);
        voice.osc.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.12);
      });
    }

    // 2. Chime trigger on reward edge
    if ((this.soundMode === 'chime' || this.soundMode === 'both') && isReward) {
      if (now - this.lastChimeAt > this.chimeIntervalMs) {
        this.playChime();
        this.lastChimeAt = now;
      }
    }

    // 3. Ambient Pink Noise / Rain
    if (this.noiseGain) {
      const rainVol = !this.ambience ? 0 : isReward ? 0.08 : 0.02;
      this.noiseGain.gain.setTargetAtTime(rainVol, this.ctx.currentTime, 0.3);
    }
  }

  setAmbience(on) { this.ambience = !!on; }

  setChimeRate(perSecond) {
    this.chimeIntervalMs = 1000 / Math.max(0.25, Math.min(4, perSecond));
  }

  // Milestone accent: a soft open fifth.
  playMilestone() {
    this.playChime(392.00, 0.12);
    this.playChime(587.33, 0.1);
  }

  playChime(frequency, peak = 0.18) {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    const freq = frequency ?? this.chimeNotes[this.chimeIdx++ % this.chimeNotes.length];

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.005, now + 0.1);

    // Bell/chime envelope: instant attack, exponential decay
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);

    osc.connect(gain).connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.7);
  }
}
