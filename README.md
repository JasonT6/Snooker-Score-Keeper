# CueSight

CueSight is a phone-first progressive web app for automatic snooker scoring. This repository currently implements **Milestone 1**: the PWA shell, privacy-first setup flow, rear-camera preview, responsive orientation handling, table-framing guide, player names, per-player face consent, guided face/clothing enrollment, and match-format review.

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
3. Accept the on-device processing notice, add both player names, and choose face matching separately for each player.
4. Open the rear camera. Capture a clothing profile for each player and a face reference for each player who opted in.
5. Confirm captured clothing colour swatches appear and that table framing stays locked until all required profiles are ready.
6. Rotate the phone between portrait and landscape. The orientation status and layout should update without restarting the stream.
7. Confirm that stopping or completing setup turns off the camera indicator.
8. Add the app to the home screen and verify it opens in standalone mode.

## Checks

```bash
npm run lint
npm test
```

## Milestone 1 architecture

- `app/components/SetupApp.tsx` owns the first-run flow and device-local setup draft.
- `app/hooks/useCamera.ts` isolates camera permission, rear-camera preference, stream cleanup, and camera switching.
- `app/lib/visualProfile.ts` crops the guided face/clothing regions and derives compact local visual descriptors and clothing colour samples.
- `app/hooks/useDeviceOrientation.ts` isolates modern and legacy orientation events.
- `app/lib/orientation.ts` contains deterministic orientation helpers.
- `public/manifest.webmanifest` and `public/sw.js` provide installable, offline-aware PWA behavior.

Camera streams and raw profile frames are never persisted. Player names, face-consent choices, compact face/clothing descriptors, clothing colour samples, and match length are stored locally only after setup is completed. Face enrollment is strictly opt-in per player; clothing enrollment is required so player attribution does not depend on biometric data.

## Scope boundary

Milestone 1 does not pretend to calibrate the table or score a match. Table/pocket geometry and the normalized top-down overlay begin in Milestone 2. The rules engine, vision adapters, shot extraction, and active-player inference using the enrolled profiles remain later milestones from the product brief.
