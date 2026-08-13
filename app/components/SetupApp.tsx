"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useCamera, type CameraStatus } from "../hooks/useCamera";
import { useDeviceOrientation } from "../hooks/useDeviceOrientation";
import { ServiceWorkerRegistration } from "./ServiceWorkerRegistration";

const SETUP_STORAGE_KEY = "cuesight.setup.v1";
const SETUP_STEPS = ["Privacy", "Players", "Camera", "Match"] as const;

interface PlayerDraft {
  name: string;
  faceConsent: boolean;
}

interface SetupDraft {
  players: [PlayerDraft, PlayerDraft];
  bestOf: number;
}

const DEFAULT_DRAFT: SetupDraft = {
  players: [
    { name: "", faceConsent: false },
    { name: "", faceConsent: false },
  ],
  bestOf: 3,
};

const CAMERA_STATUS_LABELS: Record<CameraStatus, string> = {
  idle: "Camera off",
  requesting: "Starting camera",
  streaming: "Camera live",
  denied: "Permission blocked",
  unavailable: "Camera unavailable",
  error: "Camera needs attention",
};

function safeLoadDraft(): SetupDraft {
  try {
    const saved = window.localStorage.getItem(SETUP_STORAGE_KEY);
    if (!saved) return DEFAULT_DRAFT;
    const parsed = JSON.parse(saved) as Partial<SetupDraft>;
    if (!Array.isArray(parsed.players) || parsed.players.length !== 2) {
      return DEFAULT_DRAFT;
    }
    return {
      players: [
        {
          name: String(parsed.players[0]?.name ?? ""),
          faceConsent: Boolean(parsed.players[0]?.faceConsent),
        },
        {
          name: String(parsed.players[1]?.name ?? ""),
          faceConsent: Boolean(parsed.players[1]?.faceConsent),
        },
      ],
      bestOf: [1, 3, 5, 7, 9].includes(Number(parsed.bestOf))
        ? Number(parsed.bestOf)
        : 3,
    };
  } catch {
    return DEFAULT_DRAFT;
  }
}

export function SetupApp() {
  const [step, setStep] = useState(0);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [draft, setDraft] = useState<SetupDraft>(DEFAULT_DRAFT);
  const [online, setOnline] = useState(true);
  const orientation = useDeviceOrientation();
  const {
    status: cameraStatus,
    stream: cameraStream,
    devices: cameraDevices,
    selectedDeviceId,
    errorMessage: cameraError,
    videoRef,
    startCamera,
    stopCamera,
  } = useCamera();
  const cameraVerified = cameraStatus === "streaming";

  useEffect(() => {
    const syncConnection = () => setOnline(navigator.onLine);
    const initialSync = window.setTimeout(() => {
      setDraft(safeLoadDraft());
      syncConnection();
    }, 0);
    window.addEventListener("online", syncConnection);
    window.addEventListener("offline", syncConnection);
    return () => {
      window.clearTimeout(initialSync);
      window.removeEventListener("online", syncConnection);
      window.removeEventListener("offline", syncConnection);
    };
  }, []);

  const namesAreValid = useMemo(
    () => draft.players.every((player) => player.name.trim().length > 0),
    [draft.players],
  );

  const updatePlayer = (index: 0 | 1, patch: Partial<PlayerDraft>) => {
    setDraft((current) => {
      const players: [PlayerDraft, PlayerDraft] = [
        { ...current.players[0] },
        { ...current.players[1] },
      ];
      players[index] = { ...players[index], ...patch };
      return { ...current, players };
    });
  };

  const completeSetup = () => {
    window.localStorage.setItem(SETUP_STORAGE_KEY, JSON.stringify(draft));
    stopCamera();
    setStep(4);
  };

  return (
    <div className="app" data-orientation={orientation.mode}>
      <ServiceWorkerRegistration />
      <header className="topbar">
        <div className="wordmark" aria-label="CueSight">
          <span className="brand-mark" aria-hidden="true" />
          <span>CueSight</span>
        </div>
        <div className="network-chip" data-online={online} role="status">
          <span className="network-dot" aria-hidden="true" />
          <span className="network-copy">{online ? "Online" : "Offline ready"}</span>
        </div>
      </header>

      <main className="shell">
        {step < 4 && (
          <div className="setup-progress" aria-label={`Setup step ${step + 1} of 4`}>
            {SETUP_STEPS.map((label, index) => (
              <span
                className="progress-segment"
                data-complete={index < step}
                data-current={index === step}
                key={label}
                title={label}
              />
            ))}
          </div>
        )}

        {step === 0 && (
          <section className="screen-card" aria-labelledby="welcome-title">
            <div className="screen-content">
              <div className="welcome-grid">
                <div>
                  <p className="eyebrow">Phone-first match setup</p>
                  <h1 id="welcome-title">Your table. Scored automatically.</h1>
                  <p className="lede">
                    Mount one phone, frame the whole table, then play. CueSight is
                    designed to watch the action without routine score-confirmation taps.
                  </p>

                  <div className="feature-row">
                    <div className="feature-item">
                      <span className="feature-number">01</span>
                      <span className="feature-copy">
                        <strong>Private by default</strong>
                        <span>Camera and identity processing stay on this device.</span>
                      </span>
                    </div>
                    <div className="feature-item">
                      <span className="feature-number">02</span>
                      <span className="feature-copy">
                        <strong>Built for the tripod</strong>
                        <span>Portrait and landscape mounting are both supported.</span>
                      </span>
                    </div>
                    <div className="feature-item">
                      <span className="feature-number">03</span>
                      <span className="feature-copy">
                        <strong>Honest about uncertainty</strong>
                        <span>Later scoring stages will pause instead of guessing.</span>
                      </span>
                    </div>
                  </div>

                  <div className="consent-box">
                    <input
                      id="camera-processing-consent"
                      type="checkbox"
                      checked={privacyAccepted}
                      onChange={(event) => setPrivacyAccepted(event.target.checked)}
                    />
                    <label className="consent-copy" htmlFor="camera-processing-consent">
                      <strong>I agree to on-device camera processing</strong>
                      <span>
                        Camera access starts only when requested. No video or biometric
                        data is uploaded in this milestone.
                      </span>
                    </label>
                  </div>

                  <details className="privacy-details">
                    <summary>How camera data is handled</summary>
                    <p>
                      The live preview is displayed directly from your browser. Closing
                      the preview stops its camera tracks. Optional face matching requires
                      a separate choice for each player and is not performed yet.
                    </p>
                  </details>

                  <div className="action-bar">
                    <button
                      className="primary-button"
                      type="button"
                      disabled={!privacyAccepted}
                      onClick={() => setStep(1)}
                    >
                      Begin setup <span className="arrow">→</span>
                    </button>
                  </div>
                </div>

                <div className="table-visual" aria-hidden="true">
                  <span className="visual-label">
                    One wide view captures the table and the players around it.
                  </span>
                  <span className="camera-orbit">●</span>
                </div>
              </div>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="screen-card" aria-labelledby="players-title">
            <form
              className="screen-content"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                if (namesAreValid) setStep(2);
              }}
            >
              <p className="eyebrow">Step 2 · Player profiles</p>
              <h2 id="players-title">Who&apos;s at the table?</h2>
              <p className="lede">
                Add the names that should appear on the live scoreboard. Face matching is
                optional and must be approved separately by each player.
              </p>

              <div className="players-grid">
                {draft.players.map((player, index) => (
                  <div className="player-card" key={index}>
                    <div className="player-card-header">
                      <div className="player-index">
                        <span className="player-ball" aria-hidden="true" />
                        Player {index + 1}
                      </div>
                      <span className="optional-label">Local profile</span>
                    </div>
                    <label className="field-label" htmlFor={`player-${index}`}>
                      Display name
                    </label>
                    <input
                      className="text-field"
                      id={`player-${index}`}
                      name={`player-${index}`}
                      value={player.name}
                      maxLength={32}
                      autoComplete="off"
                      placeholder={index === 0 ? "e.g. Alex" : "e.g. Sam"}
                      onChange={(event) =>
                        updatePlayer(index as 0 | 1, { name: event.target.value })
                      }
                    />
                    <div className="toggle-row">
                      <input
                        id={`face-consent-${index}`}
                        type="checkbox"
                        checked={player.faceConsent}
                        onChange={(event) =>
                          updatePlayer(index as 0 | 1, {
                            faceConsent: event.target.checked,
                          })
                        }
                      />
                      <label className="toggle-copy" htmlFor={`face-consent-${index}`}>
                        <strong>Allow local face matching</strong>
                        <span>
                          Records consent only. Face capture arrives in a later milestone;
                          clothing-based matching does not require this.
                        </span>
                      </label>
                    </div>
                  </div>
                ))}
              </div>

              <div className="privacy-note">
                <span className="note-icon" aria-hidden="true">i</span>
                <span>
                  Consent can be changed later. No face image or embedding is collected on
                  this screen, and nothing is sent off-device.
                </span>
              </div>

              <div className="action-bar">
                <button className="text-button" type="button" onClick={() => setStep(0)}>
                  Back
                </button>
                <button className="primary-button" type="submit" disabled={!namesAreValid}>
                  Set up camera <span className="arrow">→</span>
                </button>
              </div>
            </form>
          </section>
        )}

        {step === 2 && (
          <section className="screen-card camera-screen" aria-labelledby="camera-title">
            <div className="camera-layout">
              <div className="camera-stage">
                {cameraStream ? (
                  <video
                    ref={videoRef}
                    autoPlay
                    muted
                    playsInline
                    aria-label="Live rear camera preview"
                  />
                ) : (
                  <div className="camera-placeholder">
                    <span className="camera-glyph" aria-hidden="true" />
                    <h2>Camera is off</h2>
                    <p>
                      CueSight will ask the browser for your rear camera. You stay in
                      control and can stop it at any time.
                    </p>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={cameraStatus === "requesting"}
                      onClick={() => void startCamera()}
                    >
                      {cameraStatus === "requesting" ? "Starting…" : "Open rear camera"}
                    </button>
                  </div>
                )}

                <div className="camera-top-overlay">
                  <span className="status-pill" data-status={cameraStatus}>
                    <span className="status-dot" aria-hidden="true" />
                    {CAMERA_STATUS_LABELS[cameraStatus]}
                  </span>
                  <span className="orientation-pill">
                    <span className="orientation-icon" aria-hidden="true" />
                    {orientation.mode === "portrait" ? "Portrait" : "Landscape"}
                    {orientation.angle ? ` · ${orientation.angle}°` : ""}
                  </span>
                </div>

                {cameraStatus === "streaming" && (
                  <div className="table-guide" aria-hidden="true">
                    {[1, 2, 3, 4, 5, 6].map((pocket) => (
                      <span className={`pocket pocket-${pocket}`} key={pocket} />
                    ))}
                    <span className="guide-label">
                      Keep the table, six pockets, and player space inside the view
                    </span>
                  </div>
                )}
              </div>

              <div className="camera-controls">
                <p className="eyebrow">Step 3 · Camera framing</p>
                <h2 id="camera-title">Mount wide. Keep still.</h2>
                <p className="lede">
                  Place the phone on a tripod where every rail and pocket is visible, with
                  room around the table for both players.
                </p>

                <ul className="check-list">
                  <li className="check-item" data-ready={cameraVerified}>
                    <span className="check-mark" aria-hidden="true">
                      {cameraVerified ? "✓" : "1"}
                    </span>
                    Camera access confirmed
                  </li>
                  <li className="check-item" data-ready={true}>
                    <span className="check-mark" aria-hidden="true">✓</span>
                    {orientation.mode === "portrait" ? "Portrait" : "Landscape"} orientation detected
                  </li>
                  <li className="check-item" data-ready={cameraStatus === "streaming"}>
                    <span className="check-mark" aria-hidden="true">
                      {cameraStatus === "streaming" ? "✓" : "3"}
                    </span>
                    Live framing preview
                  </li>
                </ul>

                {cameraError && (
                  <p className="camera-error" role="alert">
                    {cameraError}
                  </p>
                )}

                {cameraDevices.length > 1 && (
                  <div className="device-field">
                    <label className="field-label" htmlFor="camera-device">
                      Camera
                    </label>
                    <select
                      className="select-field"
                      id="camera-device"
                      value={selectedDeviceId}
                      onChange={(event) => void startCamera(event.target.value)}
                    >
                      {cameraDevices.map((device) => (
                        <option value={device.deviceId} key={device.deviceId}>
                          {device.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="action-bar">
                  <button className="text-button" type="button" onClick={() => setStep(1)}>
                    Back
                  </button>
                  {cameraStatus === "streaming" && (
                    <button className="secondary-button" type="button" onClick={stopCamera}>
                      Stop camera
                    </button>
                  )}
                  <button
                    className="primary-button"
                    type="button"
                    disabled={cameraStatus !== "streaming"}
                    onClick={() => setStep(3)}
                  >
                    Use this view <span className="arrow">→</span>
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="screen-card" aria-labelledby="match-title">
            <div className="screen-content">
              <p className="eyebrow">Step 4 · Match details</p>
              <h2 id="match-title">One last look.</h2>
              <p className="lede">
                Confirm the players and match length. Your choices are stored only on this
                device and can be changed before play.
              </p>

              <div className="review-grid">
                <div className="review-panel">
                  <h3>Camera view</h3>
                  <div className="summary-video">
                    {cameraStream ? (
                      <video
                        ref={videoRef}
                        autoPlay
                        muted
                        playsInline
                        aria-label="Selected live camera preview"
                      />
                    ) : (
                      <div className="camera-placeholder">
                        <span className="camera-glyph" aria-hidden="true" />
                        <p>Camera preview stopped</p>
                      </div>
                    )}
                    <span className="orientation-pill">
                      <span className="orientation-icon" aria-hidden="true" />
                      {orientation.mode === "portrait" ? "Portrait" : "Landscape"}
                    </span>
                  </div>
                </div>

                <div className="review-panel">
                  <h3>Match setup</h3>
                  <dl className="summary-list">
                    <div className="summary-row">
                      <dt>Players</dt>
                      <dd>{draft.players[0].name.trim()} · {draft.players[1].name.trim()}</dd>
                    </div>
                    <div className="summary-row">
                      <dt>Camera</dt>
                      <dd>{cameraVerified ? "Permission confirmed" : "Not confirmed"}</dd>
                    </div>
                    <div className="summary-row">
                      <dt>Face matching</dt>
                      <dd>{draft.players.filter((player) => player.faceConsent).length} opted in</dd>
                    </div>
                  </dl>

                  <label className="field-label" htmlFor="best-of" style={{ marginTop: 18 }}>
                    Match length
                  </label>
                  <select
                    className="select-field"
                    id="best-of"
                    value={draft.bestOf}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        bestOf: Number(event.target.value),
                      }))
                    }
                  >
                    {[1, 3, 5, 7, 9].map((frames) => (
                      <option value={frames} key={frames}>
                        Best of {frames} {frames === 1 ? "frame" : "frames"}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="info-note" style={{ marginTop: 18 }}>
                <span className="note-icon" aria-hidden="true">i</span>
                <span>
                  Table detection and pocket calibration are deliberately not simulated.
                  They begin in Milestone 2 after this camera setup.
                </span>
              </div>

              <div className="action-bar">
                <button className="text-button" type="button" onClick={() => setStep(2)}>
                  Back
                </button>
                <button className="primary-button" type="button" onClick={completeSetup}>
                  Complete setup <span className="arrow">→</span>
                </button>
              </div>
            </div>
          </section>
        )}

        {step === 4 && (
          <section className="screen-card" aria-labelledby="complete-title">
            <div className="screen-content completion">
              <span className="completion-mark" aria-hidden="true">✓</span>
              <p className="eyebrow">Milestone 1 ready</p>
              <h1 id="complete-title">Camera setup complete.</h1>
              <p className="lede">
                {draft.players[0].name.trim()} and {draft.players[1].name.trim()} are ready
                for a best-of-{draft.bestOf} match. The camera is off and the setup is saved
                locally on this device.
              </p>
              <div className="next-milestone">
                <strong>Next · Table calibration</strong>
                <span>
                  The next build stage will identify the table boundary, six pockets, and
                  perspective before any scoring begins.
                </span>
              </div>
              <div className="action-bar">
                <button className="secondary-button" type="button" onClick={() => setStep(3)}>
                  Edit match details
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => {
                    setStep(2);
                    void startCamera();
                  }}
                >
                  Reopen camera
                </button>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
