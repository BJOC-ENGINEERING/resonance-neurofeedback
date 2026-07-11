# Resonance

Resonance is a desktop-browser neurofeedback trainer with two synthetic EEG modes and an optional live Muse 2 input. It turns band activity into a continuous audio and visual reward loop, with calibration, adaptive thresholds, session scoring, and summaries.

Live app: [resonance-neurofeedback.vercel.app](https://resonance-neurofeedback.vercel.app)

## Features

- Single-band training for delta, theta, alpha, beta, or gamma
- Three-frequency resonance simulation at 7.63, 19.99, and 32.57 Hz
- Synthetic EEG with pink noise and optional blink, muscle, and 50 Hz artifacts
- Live Muse 2 EEG over Web Bluetooth using TP9, AF7, AF8, and TP10
- Hann-windowed spectrum analysis and adaptive baseline thresholding
- Audio tone, bloom, score, progress graph, time-in-zone, and session summary
- All EEG processing occurs in the browser

## Requirements

- Node.js 20.19 or newer; Node 22 is recommended and recorded in `.nvmrc`
- npm
- Desktop Chrome or Edge for Muse 2/Web Bluetooth
- A Muse 2 is optional; both simulation modes work without hardware

No environment variables, API keys, accounts, databases, or backend services are required.

## Reproduce locally

```bash
git clone https://github.com/BJOC-ENGINEERING/resonance-neurofeedback.git
cd resonance-neurofeedback
nvm use
npm ci
npm run dev
```

Open the local URL printed by Vite. The simulation is ready immediately.

To reproduce the production build:

```bash
npm ci
npm run build
npm run preview
```

The static production output is written to `dist/`.

## Use a Muse 2

1. Turn on Bluetooth and the Muse 2.
2. Open the app in desktop Chrome or Edge over HTTPS.
3. Select **Live Muse 2**.
4. Click **Connect Muse 2** and choose the headset in the browser prompt.
5. Wait for TP9, AF7, AF8, and TP10 to show incoming packets.
6. Choose a target band and click **Calibrate & start**.

The app waits for at least one second of complete four-channel EEG before enabling calibration. The headset data is averaged, DC-corrected, windowed, and sent through the same spectral and reward pipeline as the simulator.

## Architecture

```text
Synthetic EEG ─┐
               ├─> ring buffer -> Hann-windowed DFT -> band power
Muse 2 EEG ────┘                                  -> adaptive reward
                                                   -> audio + visuals + summary
```

- `index.html` contains the interface and styling.
- `app.js` contains signal generation, Muse input, spectral analysis, reward logic, audio, and canvas rendering.
- `vite.config.js` contains the local Vite configuration.
- `package-lock.json` pins the complete dependency tree for repeatable installs.

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
npm run build
```

Then verify the simulation calibration, single-band scoring, resonance mode, Muse connection gate, audio toggle, and session summary in the browser.

## Scope

This is an educational and experimental trainer, not a medical device. The synthetic modes do not read the user. Live Muse results depend on fit, electrode contact, movement, and other EEG artifacts.
