# Resonance

Resonance is a browser neurofeedback studio. It reads a Muse 2 or Muse S over Web Bluetooth, or a realistic synthetic EEG, and turns rule-based reward into a flock that gathers, colours and speeds up, with chimes or a drone on the same signal. It also reads your pulse from the headset for heart-rate-variability breathing, and can run blinded sham sessions so you can test whether training works for you.

Live app: [resonance-neurofeedback.vercel.app](https://resonance-neurofeedback.vercel.app)

User guide: [Quick start](docs/quick-start.md) — connect a Muse, start a session, and troubleshoot signal issues.

Full feature list: [Features](docs/features.md).

## Features

- Guided flow: connect, check signal, record a baseline, train
- Multi-rule protocols: train any measure up or keep it down, as a percentage of your own baseline. All enabled rules must pass
- Measures: delta, theta, alpha, upper alpha, beta, gamma, theta/beta, alpha/theta, alpha peak frequency, frontal alpha R/L, the 7.63 / 19.99 / 32.57 Hz resonance triad, and heart coherence
- Nine starting protocols, plus a local library of up to 24 saved setups
- Personal alpha bands: a 60 second eyes-closed recording finds your alpha peak (centre of gravity above the 1/f background), and the theta, alpha and beta edges move with it
- HRV resonance breathing: the Muse's forehead PPG gives beat-to-beat heart rate, RMSSD and coherence. A breathing pacer (ring, flock and optional breath sound) guides you, and a 6 or 12 minute assessment paces 7 down to 4.5 breaths a minute and picks the rate with the widest breath-locked heart-rate swing
- Breath coherence and Heart & mind protocols: reward a smooth, slow heart rhythm, alone or together with alpha
- Blinded self-experiment: optional sham sessions (1 in 3 or 1 in 2, in permuted blocks) replay your usual reward pattern instead of following your signal. The rule readout is hidden while blinded; you guess before the reveal
- Check-ins: calm and alert ratings plus a 60 second reaction-time test (PVT) before and after a session. Journal compares real and sham sessions on rules met, reaction time and ratings
- Hold training (0 to 10 s) with a progress ring; the flock gathers while you hold
- Night-sky stage: a WebGL aurora brightens and widens with reward, light follows the flock while you hold, and the birds glow and trail when rewarded
- Video scene: play a YouTube link or a local video file that dims, blurs and quietens off target and clears as you hold it. Files never leave the device
- Focus mode: the side panels fold away while a session runs, with a compact score readout on the stage. Press P to bring them back
- Manual thresholds or auto difficulty that steers toward a target reward rate
- Timed blocks and breaks. The clock counts usable signal only
- Per-sensor quality (blink, motion, muscle, contact). Artifacts never count toward reward or baseline
- Live spectrum (linear or dB), spectrogram, raw traces, and a 60 s reward-index strip
- Synthetic EEG with pink noise, waxing and waning rhythms, and injectable blinks, jaw clench, mains and loose contact. It runs through the same pipeline as the headset
- Synthetic pulse: a virtual heart whose rate swings with breathing and peaks at its own resonance rate, rendered as a 64 Hz PPG waveform for the real beat detector. Lower **Stability** makes it follow the pacer less closely
- Session journal with per-block stats, reward timeline, notes, trend chart, CSV and JSON export
- Six palettes, fullscreen stage, keyboard shortcuts, reduced-motion support, WebMCP tools
- All processing happens in the browser

## Requirements

- Node.js 20.19 or newer; Node 22 is recommended and recorded in `.nvmrc`
- npm
- Desktop Chrome or Edge for Muse 2/Web Bluetooth
- A Muse is optional; the simulator works without hardware

No environment variables, API keys, accounts, databases, or backend services are required.

## Reproduce locally

```bash
git clone https://github.com/BJOC-ENGINEERING/resonance-neurofeedback.git
cd resonance-neurofeedback
nvm use
npm ci
npm run dev
```

Open the local URL printed by Vite. The simulation is ready immediately. Run the unit tests with `npm test`.

To reproduce the production build:

```bash
npm ci
npm run build
npm run preview
```

The static production output is written to `dist/`.

## Use a Muse 2 or Muse S

1. Turn on Bluetooth and your Muse.
2. Open the app in desktop Chrome or Edge over HTTPS or localhost.
3. Click **Connect Muse** beside the source badge in the top bar, or open **Signal → Muse headset** in the setup panel and click **Connect Muse** there.
4. Choose the headset in the browser prompt.
5. Watch **Traces** until every training sensor reads good.
6. Pick a protocol and click **Start session**. A 20 second baseline runs first.

Training sensors default to AF7 + AF8 and can be changed in the Sensors card. Changing them mid-session records a new baseline.

## Architecture

```text
Synthetic EEG ─┐
               ├─> per-channel ring buffers -> Hann PSD + quality (10 Hz)
Muse EEG ──────┘        -> measures (standard or alpha-peak bands) ─┐
                                                                    ├─> rules -> hold -> reward
Synthetic PPG ─┐                                                    │    (or sham in blinded sessions)
               ├─> band-pass -> beats -> IBIs -> HR, RMSSD, coherence ┘      -> flock + audio + charts + journal
Muse PPG ──────┘
```

- `index.html` is the markup; `src/styles.css` holds tokens, palettes and layout.
- `app.js` wires the modules to the UI and runs the frame loop.
- `src/dsp.js` buffers, FFT, PSD, band amplitude, peak frequency, signal quality.
- `src/protocol.js` measures, presets, baseline, rules, hold, auto difficulty.
- `src/session.js` calibration, blocks and breaks on usable time.
- `src/heart.js` PPG beat detection, heart-rate series, RMSSD, coherence and lock-in swing.
- `src/breath.js` breathing pacer and the resonance-rate assessment.
- `src/study.js` sham assignment and feedback, reaction-test scoring, real-versus-sham comparison. `src/checkin.js` the check-in sheet.
- `src/sim.js` seeded synthetic EEG and artifacts, and the synthetic heart.
- `src/flock.js`, `src/backdrop.js`, `src/scene-video.js`, `src/audio.js`, `src/charts.js` feedback scenes and instruments.
- `src/journal.js`, `src/store.js` local persistence. `src/mcp.js` WebMCP tools.
- `mockups/landing-v2.html` is the earlier marketing-page mock, kept for reference.

In dev builds `window.__resonance.advance(seconds)` steps the pipeline without animation frames, which is useful in hidden tabs and automated checks.

## Deployment

The project is a static Vite site and can be deployed directly to Vercel:

```bash
npm ci
npm run build
npx vercel
```

No Vercel project metadata is committed. Each developer links their own deployment locally.

## Validation

Before publishing a change:

```bash
npm ci
npm audit
npm test
npm run build
```

Then run a demo session in the browser: baseline, a hold protocol, an injected blink, the break, the summary and the journal.
