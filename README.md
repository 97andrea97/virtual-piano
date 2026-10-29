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

A single camera can't measure true depth, so "is the finger touching the
key?" has to be inferred. The app offers two ways to play:

| Mode | How you play | Best for |
|---|---|---|
| **Touch** (default) | The top edge of the keyboard (orange line) is the key surface. Lower a fingertip past it to press the key under it, and lift it back above the line to release. Slide sideways to move to the next key (glissando). Hysteresis keeps a finger resting on the line from flickering. | Hands hovering over the drawn keyboard, or a camera looking at a table from the front |
| **Tap** | Hover over the keyboard and press by quickly bending a finger down, like playing a real piano in the air. The detector measures each fingertip relative to its own knuckle, so moving the whole hand never plays a note. Only a quick finger flex does. | Playing "in the air" in front of a tablet or laptop |

Other details:

- **Velocity / dynamics:** how fast the finger moves when it presses sets the loudness and brightness of the note.
- **Stuck-note protection:** if a hand leaves the frame, its notes are released after 150 ms. A hand that reappears already inside the keyboard won't play until the finger lifts.
- **Sustain pedal:** the *Pedal* button in the toolbar.
- **Adjustable keyboard:** use *Adjust* to drag the keyboard anywhere and resize it from the corner handle. Portrait and landscape positions are saved separately.
- **1–4 octaves**, starting from C2 to C5. Fewer octaves give wider keys, which are easier to hit.
- **Front or back camera**, with an optional mirrored selfie view.
- **Touch the screen** to play the keys directly. This is useful for testing, or if no camera is available.
- **Two sounds:** a synthesized piano that works offline, and a sampled grand piano ([Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm, CC-BY 3.0, streamed from the Tone.js sample host).
- Settings are remembered. The screen stays awake while you play, and the app can be installed to the home screen as a PWA.

## Tips for good tracking

- Use good, even lighting and a background that contrasts with your hands.
- Keep your whole hand in view, not just the fingertips. The tracker needs to see the palm.
- Start with **1–2 octaves** and resize the keyboard so each key is about as wide as a finger in the picture.
- If notes trigger by accident, lower **Sensitivity**. If presses are missed, raise it.
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
| `js/detector.js` | Touch / tap press detection (pure logic) |
| `js/keyboard.js` | Key layout, hit testing, note names (pure logic) |
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
