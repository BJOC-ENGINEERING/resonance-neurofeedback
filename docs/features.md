# Resonance features

Everything runs in the browser. There is no account, no server and no upload.

## Signal

- **Muse 2 and Muse S over Web Bluetooth** in desktop Chrome or Edge. Connect from the top bar or **Signal → Muse headset**
- **Five EEG sites:** TP9, AF7, AF8, TP10 and the AUX input, at 256 Hz. You choose which sites feed training (AF7 + AF8 by default)
- **Pulse from the forehead PPG** on Muse 2 and Muse S (64 Hz). Beats are detected in the browser and checked for plausibility. The original Muse connects EEG-only
- **Per-sensor quality:** each sensor reads good, fair, artifact (blink, motion or muscle) or bad. Artifacts never count toward reward or baseline, and reward stays off for 1 s after one
- **Simulator:** synthetic EEG with pink noise, rhythms that wax and wane, and five mental states (calm, focused, deep, restless, drowsy). Intensity, stability and resonance-triad sliders
- **Artifact injection:** blinks, jaw clench, 50 Hz mains and a loose AF7 contact, all passed through the same quality checks as a headset
- **Simulated heart:** its rate swings with breathing and peaks at its own resonance rate. It produces a PPG waveform for the real beat detector. **Stability** sets how closely it follows the pacer

## Measures

| Measure | What it is |
| --- | --- |
| Delta, theta, alpha, beta, gamma | RMS band amplitude in µV |
| Upper alpha | Alpha peak to 2 Hz above it |
| Theta / beta, alpha / theta | Band ratios |
| Alpha peak | Dominant frequency between 7 and 13 Hz |
| Alpha R / L | Frontal alpha asymmetry, AF8 ÷ AF7 |
| Resonance triad | Three narrow lines at 7.63, 19.99 and 32.57 Hz |
| Heart coherence | Share of heart-rate variation in one slow, steady rhythm (absolute %) |

- **Personal alpha bands:** a 60 second eyes-closed recording finds your alpha peak, taken as the centre of gravity of the power above the 1/f background. Theta, alpha, upper alpha and beta then move with the peak. Weak peaks are rejected
- **Heart readouts:** heart rate, RMSSD, coherence, and your dominant heart rhythm in breaths a minute

## Protocols

- **Multi-rule:** train any measure up or keep it down. All enabled rules must pass together
- **Relative targets:** EEG targets are a percentage of your own baseline, so a protocol carries between people and days. Heart coherence uses a fixed target
- **Nine presets:**

| Preset | Rules |
| --- | --- |
| Calm focus | Alpha up |
| Sharpen | Beta up, theta down, gamma guard |
| Settle | Theta/beta down |
| Deep | Theta over alpha, delta guard, eyes closed |
| Alpha peak | Alpha frequency up |
| Balance | Frontal alpha toward the right |
| Resonance | The 7.63 / 19.99 / 32.57 Hz triad |
| Breath coherence | Heart coherence, with the pacer on |
| Heart & mind | Alpha up and heart coherence, with the pacer on |

- **Hold training:** set 0 to 10 s. Every rule must stay in target that long before reward begins, and a progress ring fills while you hold
- **Difficulty:** set thresholds by hand, or let auto difficulty steer toward a target reward rate (30–90%) from your last 30 s
- **Library:** save up to 24 named setups, each with its rules, timing and sensors

## Sessions

- **Guided flow:** connect, check signal, record a baseline, train. The steps light up in the top bar
- **Baseline:** 10, 20, 30 or 60 s (6 s in the demo). You can record a new one mid-session
- **Timed blocks and breaks:** Quick (1 × 2:00), Standard (3 × 3:00, 20 s breaks) and Long (7 × 4:00, 30 s breaks), or custom lengths up to 20 blocks
- **Usable time only:** the clock counts usable signal only. Pauses, lost contact and hidden tabs stop it
- **Live stats:** time in zone, best streak, rewarded time, score, and milestone marks every 5, 10 or 20 s rewarded

## Breathing

- **Pacer:** a ring on the stage widens as you breathe in and narrows as you breathe out. Rate 3.5–10 breaths a minute, in 4 · out 6 or even
- **The flock breathes too,** holding a ring that follows the pacer. An optional breath sound swells with it
- **Resonance-rate assessment:** a Quick (6 min) or Full (12 min) run paces 7, 6.5, 6, 5.5, 5 and 4.5 breaths a minute. It scores each rate by the heart-rate swing locked to the breath, peak to trough, and sets the pacer to the widest one
- **Heart chart:** the last 60 s of heart rate with in-breaths shaded. At resonance the line rises with each breath and falls between

## Feedback

- **Flock:** boids that gather while you hold, then colour, glow, trail and speed up when rewarded. Classic or pixel style, 24–140 birds. You can steer them with the cursor
- **Night-sky stage:** a WebGL aurora brightens and widens with reward and follows the flock. It pulses on milestones
- **Video scene:** a YouTube link or a local video file dims, blurs and quietens off target and clears as you hold it. Local files never leave the device
- **Sound:** chimes (1 or 2 a second), a drone that follows the reward index, or both. Optional rain bed and milestone accents
- **Focus mode:** the side panels fold away during a session, with a compact score readout on the stage
- **Fullscreen and palettes:** fullscreen stage, six palettes, reduced-motion support

## Instruments

- **Signal to reward table:** each rule's live value, target and pass state
- **Reward index strip:** the last 60 s, shaded while rewarded
- **Scope:** spectrum (linear or dB) coloured by the bands in use, a 60 s spectrogram, and raw traces for every sensor

## Self-experiment

- **Blinded sham sessions:** 1 in 3 or 1 in 2 sessions, assigned in shuffled blocks. A sham session looks and sounds normal, but its feedback replays your usual reward pattern (rate and run length from your recent real sessions) instead of following your signal
- **Blinding:** during every blinded session, real or sham, the rule readout and coherence are hidden. After the session you guess real or sham, then it is revealed
- **Check-ins:** calm and alert ratings (1–7) and a 60 s reaction-time test before and after a session. The test reports median reaction time, lapses (500 ms or slower) and false starts
- **Real vs sham comparison:** Journal compares the two on how often your rules were actually met and on before-and-after change, with standard errors. It also shows how often your guesses were right

## Journal

- **What each session records:** per-block length, time in zone, best streak, recoveries and band averages, plus a reward timeline. Also events, notes, heart rate and coherence, pacer rate, alpha peak, sham status and check-ins
- **Trend chart:** rules met per session, with sham sessions marked
- **Export:** CSV and JSON. Up to 60 sessions are kept in the browser

## Integrations

- **WebMCP tools** for browser agents: `read_session_state`, `configure_protocol` and `configure_simulation`. Coherence is withheld during blinded sessions
- **Keyboard:** Space starts or pauses, F toggles fullscreen, M mutes, P toggles the panels
- **Dev hook:** in dev builds, `window.__resonance.advance(seconds)` steps the pipeline without animation frames
