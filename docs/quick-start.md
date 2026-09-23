# Resonance quick start

Resonance turns EEG from a Muse headset into a moving flock and sound feedback. You can also try it with simulated EEG, without a headset.

## Open the app

For the local app, run these commands in the project folder:

```bash
npm install
npm run dev
```

Use Node.js 20.19 or newer. Open the URL printed in the terminal, usually [localhost:5173](http://localhost:5173/), in Chrome or Edge for headset support. No account or API key is needed.

## Connect your Muse

1. Turn on your Muse 2 or Muse S and your computer's Bluetooth.
2. Click **Connect Muse** in the top bar, beside the source status. This selects the headset source and opens the connection flow.
3. Choose your Muse in the browser's Bluetooth picker.
4. Fit the headset just above your brow and check **Traces** and the **Sensors** card. Wait for your selected training sensors to read **GOOD**.

You can also connect through **Signal → Muse headset → Connect Muse** in the setup panel. The numbered steps at the top are progress indicators; the **Signal** tab is beside **Feedback** in the setup panel.

The badge reads **Live Muse EEG** once connected. To disconnect, use **Disconnect** in the Signal panel.

## Start a session

1. In **Protocol**, choose a preset such as **Calm focus**.
2. Use **Timing** to set blocks, breaks, and baseline duration. Use **Feedback** to adjust sound and the flock.
3. Click **Start session**. Remain still while the app records your baseline; the default headset baseline is 20 seconds.
4. Training starts automatically. The flock and sound respond when all enabled rules meet their targets. If **Hold** is set, they must stay in target for that duration first.

Targets are relative to your baseline: an upward target of 105% means at least 5% above baseline. Poor signal pauses the baseline or training timer and does not count toward reward.

The Protocol panel keeps **Presets**, **Hold & difficulty**, **Saved**, and **Rules** shortcuts at the top as you scroll. Hold and difficulty sit together under **Make it your own**, above the rules. Use **Saved** to name and save a setup.

Use **Space** to start or pause, **F** for fullscreen, and **M** to mute. Open **Journal** to review sessions, add notes, or export CSV/JSON.

For a more immersive view, click **Try fullscreen** in the upper-right corner of the flock. This button stays visible with a soft green glow whenever you are outside fullscreen. In fullscreen, click **Exit fullscreen** or press **Esc** to return.

## Personal alpha bands

Alpha peaks somewhere between about 8 and 12 Hz, and the standard 8–13 Hz band fits some people badly. To anchor the bands to your own peak:

1. Open **Signal → Alpha peak** and click **Measure · 60 s, eyes closed**.
2. Close your eyes, relax your face and stay still. A soft chime marks the end. Movement pauses the clock.
3. The result shows your peak in Hz. **Anchor bands to my alpha peak** turns on automatically; untick it to go back to standard bands.

Theta, alpha, upper alpha and beta all move with the peak. The spectrum legend shows the edges in use. With personal bands a 9 Hz alpha is no longer counted as theta. Changing bands clears the baseline, so start a session to record a new one.

## Resonance breathing

Muse 2 and Muse S read your pulse through a light sensor on the forehead. The **Heart** card shows heart rate, RMSSD (beat-to-beat variability), coherence, and the dominant rhythm in breaths a minute. Its chart shades each in-breath from the pacer. When your breathing is at resonance, heart rate rises with every shaded span and falls between them.

1. Open **Breath**. Choose **Quick · 6 min** or **Full · 12 min** and click **Find my resonance rate**.
2. Breathe with the ring on the stage: in as it widens, out as it narrows. It steps from 7 down to 4.5 breaths a minute. Sit upright, breathe gently through your nose and don't force it.
3. Each rate is scored by how far your heart rate swings with each breath. The widest swing is your resonance rate, and the pacer switches to it.

To train, pick the **Breath coherence** preset (heart coherence only) or **Heart & mind** (coherence plus alpha). Both turn the pacer on. Coherence is absolute, not a share of baseline, and it needs about 30 seconds of clean pulse before it reads. You can also switch the pacer on under **Breath** for any protocol.

The original Muse (2016) has no pulse sensor. Protocols with heart coherence need a Muse 2, a Muse S, or the simulator.

## Test whether it works for you

Under **Timing → Self-experiment**:

- **Check in before and after** asks you to rate how calm and alert you feel (1–7) and runs a 60 second reaction test. When the counter appears, press **Space** or tap it as fast as you can.
- **Blinded sham sessions** makes 1 in 3, or 1 in 2, of your sessions sham. A sham session looks and sounds normal, but its feedback replays your usual reward pattern instead of following your signal. The rule readout and coherence are hidden during every blinded session, so neither kind gives itself away. Keep the side panels folded while you train.

After a blinded session you are asked whether you think it was real or sham, and only then is it revealed. **Journal → Real vs sham** compares the two kinds on how often your rules were actually met, and on the before-and-after changes.

## Return to the main screen

- **Documentation:** click **Docs** in the top bar to read the README or this quick-start guide in a popup. Close it with **×** or **Esc**.
- **From fullscreen:** press **Esc** or **F** to return to the studio controls.
- **During a session:** click **Finish** below the flock to end the session, then close the summary with **×** or **Esc**. You can choose another protocol or source from the setup panel.
- **From Journal or Help:** click **×**, press **Esc**, or click outside the popup.

The studio is the main screen. The initial welcome screen with **Try the demo** and **Connect a Muse** currently has no reopen button; use **Signal → Simulated** or the top-bar **Connect Muse** button for those options.

## Try without a headset

Choose **Signal → Simulated**. Pick a simulated state and start a session to explore the feedback.

## Connection troubleshooting

- **No Bluetooth picker:** use Chrome or Edge directly. Web Bluetooth requires HTTPS or localhost; an ordinary HTTP address on your network will not work.
- **Muse missing from the picker:** disconnect it from other apps or devices, then turn the headset off and on.
- **Paired in system settings but no signal:** connect using the app's **Connect Muse** button too.
- **Poor signal:** adjust the fit and sensor contact, relax your jaw, and stay still. Check the Sensors card before starting.
- **Connection lost:** reconnect, wait for good signal, and resume the paused session.
