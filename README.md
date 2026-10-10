# Vital Verdict

An Among Us-inspired social deduction game where your heart gives you away. Each player's webcam measures their pulse live using the [Presage SmartSpectra SDK](https://smartspectra.presagetech.com/docs/), and everyone sees everyone's heart rate during emergency meetings.

Everything runs locally: one laptop hosts, the others join over the same Wi-Fi. Nothing is deployed.

## How it works

- **One camera per player.** SmartSpectra measures one face per camera, so every player uses their own laptop.
- **Calibration.** In the lobby each player sits still for about 20 seconds. The app records their resting pulse (the "baseline").
- **Spikes.** During meetings, a player whose pulse rises 10+ BPM above their resting rate gets a red glow and a sound cue.
- **Accuse.** Accusing someone puts them in the spotlight, so everyone watches their pulse react.
- **Fake vitals.** Once per meeting the impostor can broadcast a calm, resting pulse for 25 seconds. Is that steady number real?
- **Calm the reactor.** One possible task only completes if you keep your pulse near resting for 6 seconds.

Heart rate is computed on each laptop by the SDK. The SDK needs internet access only to validate the API key; game traffic stays on your local network.

## Setup (every laptop)

Requirements: macOS on Apple Silicon (also supports Linux x64/arm64 and Windows x64), Node.js 20+, a webcam.

```bash
npm install
cp .env.example .env   # then paste your key into PRESAGE_API_KEY
```

Get a free API key from the [Presage Developer Portal](https://physiology.presagetech.com).

`.env` settings:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PRESAGE_API_KEY` | yes | none | SmartSpectra key. Without it the app uses simulated vitals. |
| `VV_SIM` | no | `0` | `1` forces simulated vitals (hold `S` to fake a spike). |
| `VV_PORT` | no | `7777` | Port the host listens on. Must match on every laptop. |

## Running

```bash
npm start      # real camera vitals
npm run sim    # simulated vitals, no camera SDK
npm run host   # optional: run the game server alone in a terminal
npm test       # game logic + LAN relay tests
```

1. **Host laptop:** enter a name, click **Host game**. The lobby shows the IP address others should use.
2. **Other laptops:** enter a name, type the host's IP, click **Join game**.
3. Wait for **Vitals locked** on each laptop, then the host clicks **Start game**. At least 3 players are needed; the host can add bots to fill seats.

To test two windows on one laptop (only one can use the camera):

```bash
npm start                                 # window 1: real camera, host
VV_SIM=1 VV_PROFILE=2 npm start           # window 2: simulated, join "localhost"
```

## Game flow

1. **Lobby:** calibrate resting pulse.
2. **Role reveal:** one player is secretly the impostor.
3. **Shift (90s):** crew completes tasks; the impostor fakes tasks and can eliminate crew (25s cooldown). Anyone alive can call an emergency meeting.
4. **Meeting (60s discussion, 30s voting):** live heart-rate cards for everyone, Accuse and Vote buttons. The host can skip timers.
5. **Reveal:** the ejected player's role is shown.
6. **Win:** crew wins by ejecting the impostor or finishing all tasks; the impostor wins when they equal the remaining crew.

## Getting a good reading

- Light in front of you, not behind (no window at your back).
- Face the camera, upper chest visible, about an arm's length away.
- Sit still. Talking and big movements reduce accuracy. Pulse is a ~12 second average, so reactions show up after a few seconds.
- No flickering light sources (TVs, some LEDs) on your face.
- The yellow hint over the camera preview tells you what to fix (too dark, face not centered, multiple faces, and so on).

## Demo script (3 players, ~5 minutes)

**Setup before judges arrive:** 3 laptops on the same Wi-Fi, each with `.env` configured, a lamp in front of each player. Practice once.

1. **Pitch (30s).** "This is Among Us, except you can't hide your heartbeat. Each webcam reads the player's pulse with no wearables."
2. **Lobby (30s).** Host clicks **Host game**; the other two join with the IP shown. Point out the live BPM on the left and the **Vitals locked** resting rate. Host clicks **Start game**.
3. **Roles (5s).** Each player privately sees CREW or THE IMPOSTOR.
4. **Tasks (30-45s).** Show the task bar filling. Do **Calm the reactor** to show a task driven by heart rate. The impostor eliminates one player, or a crewmate calls an **Emergency meeting**.
5. **Meeting (the main moment, 90s).** Show all heart-rate cards beating at each player's real rate. One player clicks **Accuse** on another; the accused card gets the ACCUSED tag. Ask the accused to defend themselves out loud; as their pulse climbs, the card turns red and a beep plays.
6. **Twist (30s).** The impostor clicks **Fake calm vitals**: their card now shows a steady resting rate. Explain that players must decide whether a too-steady number is real.
7. **Vote and reveal (30s).** Host clicks **Start voting**, everyone votes, and the reveal shows whether the impostor was caught.
8. **Close (15s).** "All heart-rate processing runs on each laptop; only the numbers are shared over the local network."

**Backup plans:**

- **Only one laptop:** host, click **+ Add bot** twice, start the game. Bots have simulated heart rates that spike when accused (impostor bots spike harder).
- **Readings are unstable:** switch that laptop to `npm run sim` and hold `S` to show a spike on cue.
- **No internet for key validation:** run every laptop with `npm run sim`; the game still works over the local network.

## Project layout

```
src/main/        Electron main process + preload (SDK bridge, host game server)
src/server/      LAN WebSocket game server (state machine, bots, vitals relay)
src/renderer/    UI: vitals.js (SmartSpectra + simulator), app.js (screens), net.js, sound.js
test/            node:test suite
```

SDK metrics are for general wellness and entertainment only, not medical use. Among Us is a trademark of Innersloth; this project uses no Among Us assets.
