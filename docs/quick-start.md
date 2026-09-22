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

## Return to the main screen

- **Documentation:** click **Docs** in the top bar to read the README or this quick-start guide in a popup. Close it with **×** or **Esc**.
- **From fullscreen:** press **Esc** or **F** to return to the studio controls.
- **During a session:** click **Finish** below the flock to end the session, then close the summary with **×** or **Esc**. You can choose another protocol or source from the setup panel.
- **From Journal or Help:** click **×**, press **Esc**, or click outside the popup.

The studio is the main screen. The initial welcome screen with **Try the demo** and **Connect a Muse** currently has no reopen button; use **Signal → Simulated** or the top-bar **Connect Muse** button for those options.

## Try without a headset

Choose **Signal → Simulated**. Pick a simulated state and start a session to explore the feedback. This uses generated data, not readings from you.

## Connection troubleshooting

- **No Bluetooth picker:** use Chrome or Edge directly. Web Bluetooth requires HTTPS or localhost; an ordinary HTTP address on your network will not work.
- **Muse missing from the picker:** disconnect it from other apps or devices, then turn the headset off and on.
- **Paired in system settings but no signal:** connect using the app's **Connect Muse** button too.
- **Poor signal:** adjust the fit and sensor contact, relax your jaw, and stay still. Check the Sensors card before starting.
- **Connection lost:** reconnect, wait for good signal, and resume the paused session.

EEG processing stays in your browser. Settings and session summaries are stored locally; raw EEG is not saved. Export sessions you want to keep before clearing browser data.
