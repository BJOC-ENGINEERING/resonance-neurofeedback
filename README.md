# Resonance

Resonance is a browser neurofeedback studio. It reads a Muse 2 or Muse S over Web Bluetooth, or a realistic synthetic EEG, and turns rule-based reward into a flock that gathers, colours and speeds up, with chimes or a drone on the same signal.

Live app: [resonance-neurofeedback.vercel.app](https://resonance-neurofeedback.vercel.app)

User guide: [Quick start](docs/quick-start.md) — connect a Muse, start a session, and troubleshoot signal issues.

## Features

- Guided flow: connect, check signal, record a baseline, train
- Multi-rule protocols: train any measure up or keep it down, as a percentage of your own baseline. All enabled rules must pass
- Measures: delta, theta, alpha, beta, gamma, theta/beta, alpha/theta, alpha peak frequency, frontal alpha R/L, and the 7.63 / 19.99 / 32.57 Hz resonance triad
- Seven starting protocols, plus a local library of up to 24 saved setups
- Hold training (0 to 10 s) with a progress ring; the flock gathers while you hold
- Manual thresholds or auto difficulty that steers toward a target reward rate
- Timed blocks and breaks. The clock counts usable signal only
- Per-sensor quality (blink, motion, muscle, contact). Artifacts never count toward reward or baseline
- Live spectrum (linear or dB), spectrogram, raw traces, and a 60 s reward-index strip
- Synthetic EEG with pink noise, waxing and waning rhythms, and injectable blinks, jaw clench, mains and loose contact. It runs through the same pipeline as the headset
- Session journal with per-block stats, reward timeline, notes, trend chart, CSV and JSON export. Raw EEG is never stored
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
Muse EEG ──────┘        -> measures -> rules vs baseline -> hold -> reward
                                     -> flock + audio + charts + journal
```

- `index.html` is the markup; `src/styles.css` holds tokens, palettes and layout.
- `app.js` wires the modules to the UI and runs the frame loop.
- `src/dsp.js` buffers, FFT, PSD, band amplitude, peak frequency, signal quality.
- `src/protocol.js` measures, presets, baseline, rules, hold, auto difficulty.
- `src/session.js` calibration, blocks and breaks on usable time.
- `src/sim.js` seeded synthetic EEG and artifacts.
- `src/flock.js`, `src/audio.js`, `src/charts.js` feedback and instruments.
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
