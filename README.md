# CueSight

CueSight is a phone-first progressive web app for automatic snooker scoring. This repository currently implements **Milestone 1**: the PWA shell, privacy-first setup flow, rear-camera preview, landscape-primary camera workspaces, table-framing guide, player names, per-player face consent, session-only face-memory enrollment, on-device two-person pose tracking, face-based re-identification after track loss, a live identity debug overlay, and match-format review.

The full product brief is in [`automatic_snooker_scoring_web_app.md`](./automatic_snooker_scoring_web_app.md).

## Run locally

Requirements: Node.js 22.13 or newer and npm.

```bash
npm install
npm run dev
```

Open the URL printed by the development server. Camera access works on `localhost`. Testing from a separate phone requires an HTTPS URL because mobile browsers do not expose `getUserMedia` to ordinary insecure network origins.

## Test on a phone

1. Serve the production build from an HTTPS origin.
2. Open it in current iOS Safari or Android Chrome.
3. Accept the on-device processing notice, add both player names, and obtain local face-matching consent from each player.
4. Open the rear camera and wait for the MoveNet tracker and face-memory model to become ready. Model files are served by the app; camera frames remain on the device.
5. Have only the selected player stand in the guide and capture their face, then repeat for the other player.
6. Confirm both players show as remembered. Move either player out of view and back in; after their face is visible, the tracker should reconnect their name even if MoveNet issued a new track ID.
7. Use the **Debug view** button on the framing screen to confirm each body box shows the expected player name, temporary track ID, and saved-descriptor status.
8. Rotate the phone between portrait and landscape. Installed/full-screen browsers should prefer landscape; the portrait fallback should remain fully usable without vertical scrolling on a camera screen.
9. Confirm that stopping or completing setup turns off the camera indicator.
10. Add the app to the home screen and verify it opens in standalone mode.

## Checks

```bash
npm run lint
npm test
```

## Milestone 1 architecture

- `app/components/SetupApp.tsx` owns the first-run flow and device-local setup draft.
- `app/hooks/useCamera.ts` isolates camera permission, rear-camera preference, stream cleanup, and camera switching.
- `app/hooks/usePlayerTracking.ts` loads MoveNet MultiPose Lightning through TensorFlow.js at a higher-detail mobile input size, limits it to two tracks, and exposes stable pose IDs during a continuous camera session.
- `app/hooks/usePlayerRecognition.ts` loads the Human face-description model without the unused face-mesh pass, uses enlarged pose-guided head crops for fast long-range matching, holds each player’s descriptor gallery and thumbnail in React memory, and explicitly binds a returning player’s new MoveNet ID back to their stable identity. Clear high-confidence matches bind immediately; borderline matches still require a second observation.
- `app/components/PlayerDebugOverlay.tsx` maps MoveNet source coordinates through the covered video preview and draws each current body box, track ID, identity, and face-descriptor association.
- `app/hooks/useDeviceOrientation.ts` isolates modern and legacy orientation events.
- `app/lib/orientation.ts` contains deterministic orientation helpers.
- `public/manifest.webmanifest` and `public/sw.js` provide installable, offline-aware PWA behavior.

Camera streams, face descriptors, and face thumbnails are never persisted or uploaded. MoveNet and Human inference run in the browser through WebGL. Only player names, face-consent choices, and match length are stored in localStorage after setup; the two face memories disappear when the page closes. MoveNet pose IDs are temporary and cannot be forced to reuse an expired number. The app instead maintains a stable Player 1/Player 2 identity layer. After a player is absent for ten seconds the stale mapping is released. A returning face can be recognized near or far in the full frame and linked to its overlapping new body track; if the face is too close for MoveNet to produce a body track, the match is held for eight seconds and attached once exactly one new unassigned track appears. Two matching observations are still required before assignment. Clothing is deliberately not used as identity because it is not a reliable person descriptor.

## Scope boundary

Milestone 1 does not pretend to calibrate the table or score a match. Table/pocket geometry and the normalized top-down overlay begin in Milestone 2. MoveNet detects two live body tracks and Milestone 1 now preserves player identity across track loss with face-based re-identification. Deciding who is actively shooting still requires the later proximity, cue-alignment, pose, and shot-timing inference stage.
