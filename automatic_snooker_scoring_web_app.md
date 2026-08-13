# Build: automatic snooker scoring web app

Build a production-minded, phone-first progressive web app that automatically keeps score for a live snooker match from a single smartphone camera on a tripod. The physical camera view is an angled, room-level view from beside the table—not a camera mounted directly above it—and the phone is pointed toward the table and players. Any top-down view mentioned below is a perspective-rectified internal representation derived from that tripod footage, not the expected camera position. The app must run in a mobile browser, request camera access, work when the phone is mounted in portrait or landscape, and need no score-confirmation taps while a frame is in progress.

## Product goal

After a short setup, two people can play snooker normally while the app watches the table and its surroundings. The app determines who is at the table, detects shots and potting events, applies official snooker rules, and continuously displays the score, break, player at the table, current target ball, and match state.

This is a vision-assisted referee and scorer. Design it so that the system is honest about confidence and has an audit trail of detections, but do not interrupt normal play for routine confirmation.

## Required player flow

1. The user opens the app on a phone and starts a new match.
2. The app opens the camera and guides the user through setup.
3. During setup, the app sees both players and creates a profile for each:
   - Obtain explicit consent before processing face data.
   - Capture a face embedding locally only if consent is given.
   - Also learn a visual appearance profile from clothing, body shape, and colours, so face matching is not required during play.
   - Let the user enter or confirm each player's name.
4. The user places the phone on a tripod beside or beyond the table and points its camera toward the table from an oblique angle. The setup screen guides them to frame the entire table, all six pockets, and a useful amount of space around the table where players stand; it must not assume an overhead or top-down physical camera position.
5. Automatically detect the table boundary, pockets, rails, balls, camera orientation, and table perspective. Rectify the camera view into a normalized top-down table coordinate system.
6. Start the frame. From then on, detect the player at the table, cue/shot events, ball paths, contacts, pots, fouls, and end-of-frame conditions. Update the score automatically.

## Rules engine: full snooker support

Implement a deterministic rules engine separate from computer vision. It must represent enough event detail to explain and replay each ruling.

Support the full normal game, including:

- Opening and subsequent red/colour sequence.
- Correct colour values: yellow 2, green 3, brown 4, blue 5, pink 6, black 7.
- Reds worth 1, with a colour nominated/selected after every legally potted red.
- Colours re-spotted while reds remain, and the correct colours clearance order after the final red.
- Legal multi-pot outcomes where applicable, including multiple reds.
- First-contact and ball-on rules.
- Misses, fouls, in-off, cue ball off table, wrong-ball-first, failing to hit a ball, and potting an off ball.
- Foul-point calculation: award at least four points, or the value of the highest-value relevant ball when greater.
- Opponent score awards for fouls.
- Free ball decisions, including nominated free-ball scoring and the resulting state transitions. Because a referee's determination that a player is snookered may not always be reliably inferable from one camera, surface this as an internally recorded "referee judgement" state and build the architecture for automatic inference where confidence is high.
- Foul-and-a-miss logic, including a configurable referee policy and replay/audit support.
- Re-spotted black when scores are tied after the final black, including coin toss / player-to-play state handled by the match UI.
- Frame end, concession, and match-format tracking.

When vision is uncertain, preserve the raw observation and confidence. The scoring engine should only commit a rule event when all required evidence meets its threshold. Maintain an internal review queue and make corrections possible after the fact; corrections must recompute score and break history from the event log.

## Computer-vision requirements

Use a hybrid on-device / server-capable architecture. Start with browser APIs and make the vision pipeline modular so models can run locally with WebAssembly/WebGPU or through an optional backend.

### Camera and calibration

- Use `getUserMedia` with the rear camera preferred.
- Correct EXIF/device orientation and react to orientation changes.
- Detect a snooker table from arbitrary camera angles and rectify it with a homography into canonical table coordinates.
- Find rail lines, playing surface, pocket centres, and the six pocket regions.
- Run a calibration check before each frame and alert the user if the tripod moves, table is obstructed, lighting changes too much, or a pocket/table boundary cannot be tracked.
- Support at least common 12-foot and 10-foot tables through calibration rather than assuming pixels map to fixed distances.

### Balls and shots

- Detect, classify, and track the white, reds, and six colours over time in the rectified view.
- Track identity conservatively: reds are interchangeable for score purposes, but colour identities must be maintained for re-spotting and rules.
- Detect cue-ball strike, ball motion start and stop, first contact, collisions, rail contacts, balls crossing pocket regions, and balls that are potted or leave the table.
- Account for occlusion by the cue, hands, and players. Use temporal state tracking rather than deciding from one frame.
- Infer the shot outcome only after all balls are stationary.
- Keep a short event video/frame buffer and structured observations for every scored shot.

### Player attribution

- Detect people around the table and establish the active player from proximity, pose, cue alignment, and shot timing.
- Match each person to the two setup profiles using clothing/body appearance, with face matching only where the user consented.
- Do not send biometric data off-device by default. Provide clear retention and deletion controls.
- If the active player cannot be determined confidently, mark the shot as attribution-uncertain in the audit data rather than confidently assigning the wrong player.

## UI and experience

Create a polished, high-contrast mobile interface usable in a billiards room.

### Main screens

- Welcome / privacy and camera-permission screen.
- New-match setup: player names, face-consent choice, clothing-profile capture, table framing, calibration, match format.
- Live scorer: both names and scores, current break, active player, ball-on, phase of frame, camera-health indicator, concise detection status, and pause/end controls.
- Event history: chronological shots, points/fouls, reason, confidence, and replay thumbnail/video when available.
- Match summary: frames, highest breaks, corrections, and exportable match record.
- Settings: offline mode, model/backend mode, privacy/data deletion, referee policy, and accessibility.

The app must feel automatic during play. Do not require routine player interaction. Use discreet on-screen status for uncertainty and only raise a prominent alert when tracking has become unreliable enough that automatic scoring should pause.

## Architecture

Use TypeScript and a modern web framework suitable for a PWA. Keep these layers separate:

1. Camera capture and device-orientation handling.
2. Calibration / table geometry.
3. Vision observations and multi-object tracking.
4. Player identity and active-player inference.
5. Shot event extraction.
6. Pure snooker rules engine and event-sourced match state.
7. UI, storage, and optional backend synchronization.

Create explicit typed contracts between layers. Vision returns observations plus confidences; the rules engine consumes normalized shot events and must be independently unit-testable without a camera.

Persist a match as an append-only event log plus derived state. Include a correction event type rather than mutating history. Support local-first storage and later export.

## Technical milestones

Build in phases, keeping the app runnable after each phase:

1. Mobile PWA shell, camera preview, orientation handling, and setup UI.
2. Table/pocket calibration from the angled tripod footage and a perspective-rectified, normalized top-down overlay.
3. Ball detection/tracking with a simulated or recorded-video adapter for deterministic development.
4. Complete rules engine with exhaustive unit tests for regular scoring, fouls, free balls, clearance, and re-spotted black.
5. Shot event extraction and automatic score updates from detected events.
6. Player setup, active-player inference, privacy controls, and event history.
7. Reliability work: confidence thresholds, movement/lost-calibration detection, recovery paths, replay/audit data, accessibility, and field testing.

## Testing and acceptance criteria

- Test on current iOS Safari and Android Chrome where supported camera APIs permit.
- Test portrait and landscape mounting, varied camera positions, normal room lighting, shadows, colourful clothing, and momentary occlusions.
- Unit-test the rules engine with table-driven cases for every rule above.
- Use recorded clips and synthetic event sequences to regression-test detection and scoring.
- The app must never silently invent a score when evidence is below the confidence threshold. It may enter a clearly visible tracking-paused state while retaining the uncommitted observations for review.
- Show calibration confidence and camera health in the live UI.
- Keep biometric processing opt-in, local by default, and deletable.

## Deliverables

Produce a runnable mobile-friendly web app, a clear README explaining local setup and device testing, a documented architecture, typed event schemas, the rules-engine tests, and a small set of recorded/simulated fixtures so scoring can be demonstrated without a live table.

Start by implementing the app shell and deterministic rules engine, then use a simulated vision adapter to exercise the complete end-to-end scoring flow before integrating real camera models.
