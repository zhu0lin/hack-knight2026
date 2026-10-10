# Vital Verdict

An Among Us-inspired social deduction game where your heart and facial expressions gives you away. Each player's webcam measures their pulse live using the [Presage SmartSpectra SDK](https://smartspectra.presagetech.com/docs/), and everyone sees everyone's heart rate during emergency meetings.

On a normal Wi-Fi network, one laptop hosts and the others join it. On a campus network that blocks laptop-to-laptop traffic, everyone joins the shared Cloud Run server instead. 

## How it works

- **One camera per player.** SmartSpectra measures one face per camera, so every player uses their own laptop.
- **Camera selection.** If 2+ webcams are detected, a **Camera** dropdown in the left sidebar (under the video preview) lets you pick which one to use.
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
| `VV_SIM` | no | `0` | `1` forces simulated vitals (hold `H` to fake a spike). |
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

## Shared server (campus Wi-Fi)

The server for this event is already running at <https://vital-verdict-120242246392.us-east1.run.app>.

Each player still runs the app on their own laptop. Nobody clicks **Host game**.

```bash
npm install
cp .env.example .env   # paste your own PRESAGE_API_KEY
npm start
```

Enter a name, paste the URL above into **Join a friend**, and click **Join game**. The first person in the lobby is the host and can add a bot, then start once vitals are locked.

No Docker, gcloud, or `VV_PORT` change is required to join. `.env` stays on your machine and is not in git. Shut the Cloud Run service down after the event so the always-on instance does not keep billing.

To test two windows on one laptop (only one can use the camera):

```bash
npm start                                 # window 1: real camera, host
```

macOS/Linux:

```bash
VV_SIM=1 VV_PROFILE=2 npm start           # window 2: simulated, join "localhost"
```

Windows (PowerShell):

```powershell
$env:VV_SIM=1; $env:VV_PROFILE=2; npm start   # window 2: simulated, join "localhost"
```

## Game flow

1. **Lobby:** calibrate resting pulse.
2. **Role reveal:** one player is secretly the impostor.
3. **Shift (150s):** everyone spawns around the emergency button in the Mess Hall and explores the ship. Crew walk to their task stations (yellow, with arrows at the screen edge pointing to them). The impostor fakes tasks and eliminates crew up close (25s cooldown), leaving a body. Finding and reporting a body, pressing the emergency button, or the shift timer running out starts a meeting.
4. **Meeting (60s discussion, 30s voting):** live heart-rate cards for everyone, Accuse and Vote buttons. The host can skip timers.
5. **Reveal:** the ejected player's role is shown.
6. **Win:** crew wins by ejecting the impostor or finishing all tasks; the impostor wins when they equal the remaining crew.

## Controls (during the shift)

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` / arrow keys | Move |
| `E` | Use a task station, or the emergency button in the Mess Hall |
| `R` | Report a body you're standing near |
| `Q` | Eliminate a nearby crewmate (impostor only) |
| `Esc` | Cancel the task you're doing |

You can only see players within your vision radius (the impostor sees further). Eliminated players become ghosts who can drift through walls and watch, but can't vote.

The ship has nine rooms: Mess Hall, Medbay, Lab, Hub, Reactor, Navigation, Electrical, Storage and Comms.

## Getting a good reading

- Light in front of you, not behind (no window at your back).
- Face the camera, upper chest visible, about an arm's length away.
- Sit still. Talking and big movements reduce accuracy. Pulse is a ~12 second average, so reactions show up after a few seconds.
- No flickering light sources (TVs, some LEDs) on your face.
- The yellow hint over the camera preview tells you what to fix (too dark, face not centered, multiple faces, and so on).

## Project layout

```
src/main/        Electron main process + preload (SDK bridge, host game server)
src/server/      WebSocket game server (state machine, positions, bots, vitals relay)
src/shared/      map.js: rooms, corridors, collision, task stations, bot waypoints (used by server and client)
src/renderer/    UI: vitals.js (SmartSpectra + simulator), app.js (screens), map-view.js (canvas map + WASD), net.js, sound.js
src/socket-url.js  turns a typed IP or Cloud Run URL into a websocket address
Dockerfile       game server only, for Cloud Run
test/            node:test suite
```

SDK metrics are for general wellness and entertainment only, not medical use. Among Us is a trademark of Innersloth; this project uses no Among Us assets.
