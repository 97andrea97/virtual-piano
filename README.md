# Air Piano 🎹✋

A virtual piano drawn on your camera image. The camera tracks your hands and
fingertips, and when a fingertip "presses" one of the drawn keys, that note
plays. You don't need a physical or computer keyboard, so it works on an
iPad or phone as well as a laptop.

It runs entirely in the browser. Hand tracking uses
[MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker),
which runs on your device, and the video is never uploaded.

## How it works

```
camera ─► MediaPipe (21 landmarks per hand, up to 2 hands)
       ─► hand tracker   (stable ids per hand + One-Euro smoothing to remove jitter)
       ─► press detector (fingertip vs. keyboard → note on / note off + velocity)
       ─► Web Audio      (synthesized piano, or sampled grand piano)
```

### When does a key play?

A single camera can't measure true depth, so the app can't tell when a finger
"touches" a key. Instead it looks for the **intention** of a key press: a finger
that aims at a key, moves down quickly and then **lands** (stops abruptly), like
on a real piano. Where the fingertips happen to be, or what they pass over, never
plays anything.

How it works, per finger:

1. **Signal:** how far the fingertip is below its own knuckle, measured in hand
   sizes so it doesn't matter how close you are to the camera.
2. **Aim:** the key under the fingertip while it hovers. It is "sticky", so it
   only changes when the tip is clearly inside another key. The aimed key is
   lightly highlighted, and it's the key that will play.
3. **Stroke:** a quick downward movement starts. It must reach about 1/11 of a
   hand size and a minimum speed within 0.35 s.
4. **Landing:** when the movement suddenly slows down (or goes very deep), the
   note plays on the key that was aimed at *before* the stroke started. Loudness
   comes from the stroke speed.
5. **Release:** lifting the finger again releases the note.

The app ignores movements that aren't key presses:

| Movement | Result |
|---|---|
| Fingers resting or hovering over the keys | nothing |
| Moving, lowering or sliding the whole hand | nothing (tip and knuckle move together) |
| Swinging the hand fast | nothing |
| Tilting the hand at the wrist (all fingers drop together) | nothing (shared movement is subtracted) |
| A finger sliding sideways across keys while moving down | nothing ("slid") |
| A finger dragged along by a neighbour's press (weaker stroke) | nothing ("neighbour") |
| Two or three fingers pressing with similar strength | a chord |
| Slowly curling a finger | nothing (the stroke must be quick) |
| A small bounce right after releasing | nothing (the finger must lift and press again) |
| Shaky tracking (poor light) | needs a clearer stroke (automatic noise floor) |

A ring around each fingertip fills up as the finger gets close to a press. With
**Settings → Show why a movement didn't play**, a short label ("neighbour",
"slid") appears whenever a stroke is ignored. This makes it easier to tune
**Sensitivity** and to report problems.

### The 3D keyboard

The keyboard is drawn in perspective, as if it were lying on a table in front of
you. It has raised black keys, visible key fronts and a back panel, and pressed
keys move down. The key under each fingertip is lightly highlighted so you can
aim. In **Adjust** mode you can:

- drag the keyboard to move it,
- drag the ↔ handle to change its width,
- drag the ↕ handle to change how long the keys are,
- use the **Tilt** slider to make it lie flatter or stand up more.

Other details:

- **Velocity / dynamics:** how fast the finger moves when it presses sets the loudness and brightness of the note.
- **Stuck-note protection:** if a hand leaves the frame, its notes are released after 150 ms.
- **Sustain pedal:** the *Pedal* button in the toolbar.
- **Adjustable keyboard:** portrait and landscape positions are saved separately. Keyboard opacity is a setting.
- **1–4 octaves**, starting from C2 to C5. Fewer octaves give wider keys, which are easier to hit.
- **Front or back camera**, with an optional mirrored selfie view.
- **Touch the screen** to play the keys directly. This is useful for testing, or if no camera is available.
- **Two sounds:** a synthesized piano that works offline, and a sampled grand piano ([Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm, CC-BY 3.0, streamed from the Tone.js sample host).
- Settings are remembered. The screen stays awake while you play, and the app can be installed to the home screen as a PWA.

## Tips for good tracking

- Use good, even lighting and a background that contrasts with your hands.
- Keep your whole hand in view, not just the fingertips. The tracker needs to see the palm.
- Start with **1–2 octaves** and resize the keyboard so each key is about as wide as a finger in the picture.
- If notes trigger by accident, lower **Sensitivity**. If presses are missed, raise it, or make the tap a little bigger and quicker.
- Fingers pointing towards the camera (palm down, like on a real piano) work best.
- On iPhone/iPad, if you hear nothing, check the volume. The app asks Safari to play even in silent mode, but older iOS versions ignore that.

## Put it online (no commands needed)

Browsers only allow the camera on `https://` pages, so the app is published with
GitHub Pages. Everything is done on the GitHub website:

1. **Make the repository public** (GitHub Pages is free only for public repos):
   repository → **Settings** → **General** → scroll to the bottom (**Danger Zone**) →
   **Change visibility** → **Make public** → confirm.
2. **Turn on GitHub Pages:** repository → **Settings** → **Pages** (left menu) →
   under **Build and deployment** set **Source** to **Deploy from a branch** →
   pick the branch with the app (for example `main`) and the folder **/ (root)** → **Save**.
3. Wait 1–2 minutes and refresh the Pages settings page. It shows
   **"Your site is live at https://97andrea97.github.io/virtual-piano/"**.
4. Open that link on your iPad, phone or laptop. In Safari, *Share → Add to Home Screen*
   makes it look like an app.

Every later change pushed to that branch goes live by itself within a couple of minutes.

Optional, for developers: run it locally with `npm start` (or `python3 -m http.server 8080`)
and open http://localhost:8080.

## Development

There's no build step. The code is plain ES modules:

| File | Purpose |
|---|---|
| `js/main.js` | App wiring, render loop, UI, settings |
| `js/vision.js` | Camera + MediaPipe hand landmarker |
| `js/hands.js` | Frame-to-frame hand identity + landmark smoothing |
| `js/filters.js` | One-Euro filter |
| `js/detector.js` | Key-press (finger stroke) detection (pure logic) |
| `js/keyboard.js` | Key layout, 3D perspective projection, hit testing (pure logic) |
| `js/audio.js` | Web Audio piano synth and sampler |

Run the unit tests (Node 18+):

```bash
npm test
```

The detection logic is tested with synthetic hand landmarks, so it can be tuned without a camera.

## Ideas for later

- Record and play back what you played, or export it as MIDI.
- Web MIDI output, so it can drive a DAW or a real synth.
- "Learn a song" mode with falling notes over the keyboard.
- A calibration step that learns your own resting and pressing finger positions.
- A paper keyboard: print a keyboard, lay it on the table, and detect it with the back camera, so you get real tactile feedback.
