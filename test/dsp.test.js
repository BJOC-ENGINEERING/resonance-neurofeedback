import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FS, WINDOW, DF, CHANNELS, BANDS, fft, psd, bandAmplitude, peakFrequency,
  Channel, assessQuality, DEFAULT_QUALITY_LIMITS,
  thetaBetaRatio, alphaThetaRatio, alphaBetaRatioDb, relativeBandPowers,
  AdaptiveBaseline
} from '../src/dsp.js';

test('FFT accurately identifies 10 Hz sine wave peak', () => {
  const n = WINDOW;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = Math.sin(2 * Math.PI * 10 * i / FS);
  }
  fft(re, im);
  const magnitudes = new Float64Array(n / 2);
  let peakIdx = 0;
  let maxMag = 0;
  for (let i = 0; i < n / 2; i++) {
    magnitudes[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    if (magnitudes[i] > maxMag) {
      maxMag = magnitudes[i];
      peakIdx = i;
    }
  }
  const peakFreq = peakIdx * DF;
  assert.equal(peakFreq, 10, '10 Hz sine should peak at 10 Hz');
});

test('psd calculates energy in alpha band for 10 Hz wave', () => {
  const samples = new Float64Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) {
    samples[i] = 20 * Math.sin(2 * Math.PI * 10 * i / FS); // 20 uV peak
  }
  const spectrum = psd(samples);
  const alphaAmp = bandAmplitude(spectrum, 8, 13);
  const thetaAmp = bandAmplitude(spectrum, 4, 8);
  const betaAmp = bandAmplitude(spectrum, 13, 30);

  assert.ok(alphaAmp > 10, 'Alpha amplitude should capture the 10 Hz wave');
  assert.ok(alphaAmp > thetaAmp * 5, 'Alpha amplitude should dominate Theta');
  assert.ok(alphaAmp > betaAmp * 5, 'Alpha amplitude should dominate Beta');
});

test('peakFrequency detects 10.2 Hz with parabolic interpolation', () => {
  const samples = new Float64Array(WINDOW);
  const trueFreq = 10.25;
  for (let i = 0; i < WINDOW; i++) {
    samples[i] = 15 * Math.sin(2 * Math.PI * trueFreq * i / FS);
  }
  const spectrum = psd(samples);
  const detected = peakFrequency(spectrum, 8, 13);
  assert.ok(Math.abs(detected - trueFreq) < 0.25, `Detected ${detected} should be close to ${trueFreq}`);
});

test('ratios and relative band powers', () => {
  const samples = new Float64Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) {
    samples[i] = 10 * Math.sin(2 * Math.PI * 10 * i / FS) + 2 * Math.sin(2 * Math.PI * 20 * i / FS);
  }
  const spectrum = psd(samples);
  const tbr = thetaBetaRatio(spectrum);
  const atr = alphaThetaRatio(spectrum);
  const abDb = alphaBetaRatioDb(spectrum);
  const rel = relativeBandPowers(spectrum);

  assert.ok(typeof tbr === 'number' && Number.isFinite(tbr));
  assert.ok(atr > 1, 'Alpha should be higher than Theta');
  assert.ok(abDb > 0, 'Alpha/Beta dB should be positive since Alpha > Beta');
  const sumRel = rel.delta + rel.theta + rel.alpha + rel.beta + rel.gamma;
  assert.ok(Math.abs(sumRel - 1.0) < 1e-4, 'Relative band powers should sum to 1.0');
});

test('Channel push and quality assessment', () => {
  const ch = new Channel('AF7');
  const now = 1000;
  // Push 512 clean samples
  const clean = Array.from({ length: 512 }, (_, i) => 15 * Math.sin(2 * Math.PI * 10 * i / FS));
  ch.push(clean, now);

  const qGood = assessQuality(ch, now, DEFAULT_QUALITY_LIMITS);
  assert.equal(qGood.state, 'good', 'Clean sine wave should be assessed as good');

  // Push noisy samples with huge amplitude
  const noisy = Array.from({ length: 512 }, () => (Math.random() - 0.5) * 800);
  ch.push(noisy, now + 100);
  const qBad = assessQuality(ch, now + 100, DEFAULT_QUALITY_LIMITS);
  assert.ok(['bad', 'artifact', 'fair'].includes(qBad.state), 'High noise should not be good');
});

test('AdaptiveBaseline computes baseline, spread, and tanh response', () => {
  const baselineTracker = new AdaptiveBaseline(2000); // 2 seconds for test
  // Feed 10 values
  for (let t = 0; t <= 2000; t += 200) {
    baselineTracker.update(50 + Math.sin(t), t);
  }
  assert.ok(baselineTracker.ready, 'Tracker should be ready after duration');
  assert.ok(Math.abs(baselineTracker.baseline - 50) < 2, 'Baseline should be near 50');

  const highResponse = baselineTracker.response(60);
  const lowResponse = baselineTracker.response(40);
  assert.ok(highResponse > 0.5, 'Value above baseline should yield response > 0.5');
  assert.ok(lowResponse < 0.5, 'Value below baseline should yield response < 0.5');
});
