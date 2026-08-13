"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useCamera, type CameraStatus } from "../hooks/useCamera";
import { useDeviceOrientation } from "../hooks/useDeviceOrientation";
import {
  usePlayerTracking,
  type TrackedPerson,
} from "../hooks/usePlayerTracking";
import type { VisualProfile, VisualProfileKind } from "../lib/visualProfile";
import { ServiceWorkerRegistration } from "./ServiceWorkerRegistration";

const SETUP_STORAGE_KEY = "cuesight.setup.v1";
const SETUP_STEPS = ["Privacy", "Players", "Profiles", "Camera", "Match"] as const;

interface PlayerDraft {
  name: string;
  faceConsent: boolean;
  faceProfile: VisualProfile | null;
  clothingProfile: VisualProfile | null;
}

interface SetupDraft {
  players: [PlayerDraft, PlayerDraft];
  bestOf: number;
}

const DEFAULT_DRAFT: SetupDraft = {
  players: [
    { name: "", faceConsent: false, faceProfile: null, clothingProfile: null },
    { name: "", faceConsent: false, faceProfile: null, clothingProfile: null },
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
          faceProfile: parsed.players[0]?.faceConsent
            ? readProfile(parsed.players[0]?.faceProfile, "face")
            : null,
          clothingProfile: readProfile(parsed.players[0]?.clothingProfile, "clothing"),
        },
        {
          name: String(parsed.players[1]?.name ?? ""),
          faceConsent: Boolean(parsed.players[1]?.faceConsent),
          faceProfile: parsed.players[1]?.faceConsent
            ? readProfile(parsed.players[1]?.faceProfile, "face")
            : null,
          clothingProfile: readProfile(parsed.players[1]?.clothingProfile, "clothing"),
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

function readProfile(value: unknown, kind: VisualProfileKind): VisualProfile | null {
  if (!value || typeof value !== "object") return null;
  const profile = value as Partial<VisualProfile>;
  if (
    profile.version !== 1 ||
    profile.kind !== kind ||
    typeof profile.capturedAt !== "number" ||
    !Array.isArray(profile.embedding) ||
    !profile.embedding.every((item) => typeof item === "number") ||
    !Array.isArray(profile.swatches) ||
    !profile.swatches.every((item) => typeof item === "string")
  ) {
    return null;
  }
  return profile as VisualProfile;
}

function closestPersonToFrameCentre(
  people: TrackedPerson[],
  videoElement: HTMLVideoElement | null,
) {
  const width = videoElement?.videoWidth || 1;
  const height = videoElement?.videoHeight || 1;
  return [...people].sort((left, right) => {
    const leftDistance =
      Math.abs(left.centerX / width - 0.5) + Math.abs(left.centerY / height - 0.5);
    const rightDistance =
      Math.abs(right.centerX / width - 0.5) + Math.abs(right.centerY / height - 0.5);
    return leftDistance - rightDistance;
  })[0] ?? null;
}

export function SetupApp() {
  const [step, setStep] = useState(0);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [draft, setDraft] = useState<SetupDraft>(DEFAULT_DRAFT);
  const [activeProfilePlayer, setActiveProfilePlayer] = useState<0 | 1>(0);
  const [profileKind, setProfileKind] = useState<VisualProfileKind>("clothing");
  const [profileMessage, setProfileMessage] = useState("");
  const [playerTrackIds, setPlayerTrackIds] = useState<
    [number | null, number | null]
  >([null, null]);
  const [online, setOnline] = useState(true);
  const orientation = useDeviceOrientation();
  const {
    status: cameraStatus,
    stream: cameraStream,
    devices: cameraDevices,
    selectedDeviceId,
    errorMessage: cameraError,
    videoElement,
    videoRef,
    startCamera,
    stopCamera,
    captureVisualProfile,
  } = useCamera();
  const cameraVerified = cameraStatus === "streaming";
  const trackingEnabled = cameraVerified && step >= 2 && step <= 4;
  const {
    status: playerTrackingStatus,
    people: trackedPeople,
    errorMessage: playerTrackingError,
    resetTracker,
  } = usePlayerTracking(videoElement, trackingEnabled);

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

  const profilesAreReady = useMemo(
    () =>
      draft.players.every(
        (player) =>
          Boolean(player.clothingProfile) &&
          (!player.faceConsent || Boolean(player.faceProfile)),
      ),
    [draft.players],
  );
  const playerTracksAreLinked = playerTrackIds.every(
    (trackId) => typeof trackId === "number",
  );
  const centredTrackedPerson = useMemo(
    () => closestPersonToFrameCentre(trackedPeople, videoElement),
    [trackedPeople, videoElement],
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

  const setFaceConsent = (index: 0 | 1, faceConsent: boolean) => {
    updatePlayer(index, {
      faceConsent,
      ...(faceConsent ? {} : { faceProfile: null }),
    });
    if (!faceConsent && index === activeProfilePlayer && profileKind === "face") {
      setProfileKind("clothing");
    }
  };

  const selectProfileCapture = (index: 0 | 1, kind: VisualProfileKind) => {
    setActiveProfilePlayer(index);
    setProfileKind(kind);
    setProfileMessage("");
  };

  const capturePlayerProfile = () => {
    try {
      if (playerTrackingStatus !== "tracking" || !centredTrackedPerson) {
        throw new Error("Wait until the player tracker finds the person in the guide.");
      }

      const otherPlayer = activeProfilePlayer === 0 ? 1 : 0;
      if (playerTrackIds[otherPlayer] === centredTrackedPerson.trackId) {
        throw new Error(
          `That person is already linked to ${draft.players[otherPlayer].name.trim()}. ` +
            `Have ${draft.players[activeProfilePlayer].name.trim()} stand alone in the guide.`,
        );
      }

      if (
        profileKind === "face" &&
        playerTrackIds[activeProfilePlayer] !== centredTrackedPerson.trackId
      ) {
        throw new Error(
          `Capture ${draft.players[activeProfilePlayer].name.trim()}'s clothing profile first ` +
            "to link their tracking ID.",
        );
      }

      const profile = captureVisualProfile(profileKind);
      updatePlayer(activeProfilePlayer, {
        [profileKind === "face" ? "faceProfile" : "clothingProfile"]: profile,
      });
      if (profileKind === "clothing") {
        setPlayerTrackIds((current) => {
          const next: [number | null, number | null] = [...current];
          next[activeProfilePlayer] = centredTrackedPerson.trackId;
          return next;
        });
      }
      setProfileMessage(
        `${draft.players[activeProfilePlayer].name.trim()}'s ${profileKind} profile is ready` +
          (profileKind === "clothing"
            ? ` and linked to track ${centredTrackedPerson.trackId}.`
            : "."),
      );
    } catch (error) {
      setProfileMessage(
        error instanceof Error ? error.message : "The profile could not be captured.",
      );
    }
  };

  const stopCameraAndTracking = () => {
    setPlayerTrackIds([null, null]);
    resetTracker();
    stopCamera();
  };

  const startCameraAndResetTracking = (deviceId?: string) => {
    if (cameraVerified) {
      setPlayerTrackIds([null, null]);
      resetTracker();
    }
    return startCamera(deviceId);
  };

  const completeSetup = () => {
    window.localStorage.setItem(SETUP_STORAGE_KEY, JSON.stringify(draft));
    stopCameraAndTracking();
    setStep(5);
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
        {step < 5 && (
          <div className="setup-progress" aria-label={`Setup step ${step + 1} of 5`}>
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
                        data is uploaded. Player profiles remain on this device.
                      </span>
                    </label>
                  </div>

                  <details className="privacy-details">
                    <summary>How camera data is handled</summary>
                    <p>
                      The live preview is displayed directly from your browser. Closing
                      the preview stops its camera tracks. Optional face enrollment requires
                      a separate choice from each player. Only compact descriptors are
                      saved; raw profile photos and video are discarded.
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
                          setFaceConsent(index as 0 | 1, event.target.checked)
                        }
                      />
                      <label className="toggle-copy" htmlFor={`face-consent-${index}`}>
                        <strong>Allow local face matching</strong>
                        <span>
                          Adds a guided face capture in the next step. Clothing-based
                          matching is set up for every player and does not require this.
                        </span>
                      </label>
                    </div>
                  </div>
                ))}
              </div>

              <div className="privacy-note">
                <span className="note-icon" aria-hidden="true">i</span>
                <span>
                  Consent can be changed later. Face enrollment is skipped unless the
                  player opts in, and nothing is sent off-device.
                </span>
              </div>

              <div className="action-bar">
                <button className="text-button" type="button" onClick={() => setStep(0)}>
                  Back
                </button>
                <button className="primary-button" type="submit" disabled={!namesAreValid}>
                  Create profiles <span className="arrow">→</span>
                </button>
              </div>
            </form>
          </section>
        )}

        {step === 2 && (
          <section className="screen-card camera-screen profile-screen" aria-labelledby="profile-title">
            <div className="profile-layout">
              <div className="camera-stage profile-stage">
                {cameraStream ? (
                  <video
                    ref={videoRef}
                    autoPlay
                    muted
                    playsInline
                    aria-label={`Live camera preview for ${draft.players[activeProfilePlayer].name.trim()}'s profile`}
                  />
                ) : (
                  <div className="camera-placeholder">
                    <span className="camera-glyph" aria-hidden="true" />
                    <h2>Camera is off</h2>
                    <p>
                      Open the rear camera, then have each player stand in the guide.
                      Profile processing stays on this device.
                    </p>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={cameraStatus === "requesting"}
                      onClick={() => void startCameraAndResetTracking()}
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
                  <span className="local-chip">
                    Player {activeProfilePlayer + 1} · {draft.players[activeProfilePlayer].name.trim()}
                  </span>
                  <span className="tracking-pill" data-status={playerTrackingStatus}>
                    <span className="tracking-dot" aria-hidden="true" />
                    {playerTrackingStatus === "loading"
                      ? "Loading player tracker"
                      : playerTrackingStatus === "tracking"
                        ? `${trackedPeople.length} ${trackedPeople.length === 1 ? "person" : "people"} tracked`
                        : playerTrackingStatus === "error"
                          ? "Tracker needs attention"
                          : "Tracker waiting"}
                  </span>
                </div>

                {cameraStatus === "streaming" && (
                  <div
                    className={`profile-guide profile-guide-${profileKind}`}
                    data-profile-guide={profileKind}
                    aria-hidden="true"
                  >
                    <span className="profile-guide-label">
                      {profileKind === "face"
                        ? "Centre your face and look toward the camera"
                        : "Stand naturally with your shirt and upper body visible"}
                    </span>
                  </div>
                )}

                {profileMessage && (
                  <p className="capture-toast" role="status" aria-live="polite">
                    {profileMessage}
                  </p>
                )}
              </div>

              <div className="profile-controls">
                <div className="profile-intro">
                  <p className="eyebrow">Step 3 · Visual identity</p>
                  <h2 id="profile-title">Register each player.</h2>
                  <p>
                    Select a player and profile type, then capture. Keep only that player
                    in the guide.
                  </p>
                </div>

                <div className="profile-roster" role="tablist" aria-label="Player to register">
                  {draft.players.map((player, index) => {
                    const playerIndex = index as 0 | 1;
                    return (
                      <button
                        className="profile-person-card"
                        data-active={activeProfilePlayer === playerIndex}
                        type="button"
                        role="tab"
                        aria-selected={activeProfilePlayer === playerIndex}
                        onClick={() =>
                          selectProfileCapture(
                            playerIndex,
                            profileKind === "face" && !player.faceConsent
                              ? "clothing"
                              : profileKind,
                          )
                        }
                        key={player.name || index}
                      >
                        <div className="profile-person-heading">
                          <span className="player-index">
                            <span className="player-ball" aria-hidden="true" />
                            {player.name.trim()}
                          </span>
                          <span className="profile-count">
                            {Number(Boolean(player.clothingProfile)) +
                              Number(Boolean(player.faceProfile))}
                            /{player.faceConsent ? 2 : 1}
                          </span>
                        </div>
                        <span
                          className="tracker-binding"
                          data-ready={typeof playerTrackIds[playerIndex] === "number"}
                        >
                          {typeof playerTrackIds[playerIndex] === "number"
                            ? `Track ${playerTrackIds[playerIndex]} linked`
                            : "Tracking not linked"}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="registration-panel">
                  <div className="capture-type-row" aria-label="Profile type">
                    <button
                      className="capture-choice"
                      data-selected={profileKind === "clothing"}
                      type="button"
                      onClick={() => selectProfileCapture(activeProfilePlayer, "clothing")}
                    >
                      <span>
                        <strong>Clothing</strong>
                        <small>
                          {draft.players[activeProfilePlayer].clothingProfile
                            ? "Ready · retake"
                            : "Required"}
                        </small>
                      </span>
                      {draft.players[activeProfilePlayer].clothingProfile ? (
                        <span className="profile-swatches" aria-label="Captured clothing colours">
                          {draft.players[activeProfilePlayer].clothingProfile.swatches.map(
                            (colour, swatchIndex) => (
                              <span
                                className="profile-swatch"
                                style={{ backgroundColor: colour }}
                                key={`${colour}-${swatchIndex}`}
                              />
                            ),
                          )}
                        </span>
                      ) : (
                        <span className="capture-state">Add</span>
                      )}
                    </button>

                    <button
                      className="capture-choice"
                      data-selected={profileKind === "face"}
                      type="button"
                      disabled={!draft.players[activeProfilePlayer].faceConsent}
                      onClick={() => selectProfileCapture(activeProfilePlayer, "face")}
                    >
                      <span>
                        <strong>Face</strong>
                        <small>
                          {!draft.players[activeProfilePlayer].faceConsent
                            ? "Not enabled"
                            : draft.players[activeProfilePlayer].faceProfile
                              ? "Ready · retake"
                              : "Required"}
                        </small>
                      </span>
                      <span
                        className="capture-state"
                        data-ready={Boolean(draft.players[activeProfilePlayer].faceProfile)}
                      >
                        {draft.players[activeProfilePlayer].faceProfile ? "✓" : "Add"}
                      </span>
                    </button>
                  </div>

                  {cameraError && (
                    <p className="camera-error" role="alert">{cameraError}</p>
                  )}
                  {playerTrackingError && (
                    <div className="camera-error" role="alert">
                      <span>{playerTrackingError}</span>
                      <button
                        className="inline-retry"
                        type="button"
                        onClick={() => {
                          setPlayerTrackIds([null, null]);
                          resetTracker();
                        }}
                      >
                        Retry player tracker
                      </button>
                    </div>
                  )}

                  <div className="profile-capture-actions">
                    <button
                      className="primary-button"
                      type="button"
                      disabled={
                        cameraStatus !== "streaming" ||
                        playerTrackingStatus !== "tracking" ||
                        !centredTrackedPerson ||
                        (profileKind === "face" &&
                          (!draft.players[activeProfilePlayer].faceConsent ||
                            typeof playerTrackIds[activeProfilePlayer] !== "number"))
                      }
                      onClick={capturePlayerProfile}
                    >
                      Capture {draft.players[activeProfilePlayer].name.trim()}&apos;s {profileKind}
                    </button>
                    {draft.players[activeProfilePlayer].faceProfile && profileKind === "face" && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => {
                          setFaceConsent(activeProfilePlayer, false);
                          setProfileKind("clothing");
                          setProfileMessage("Face data removed from this setup.");
                        }}
                      >
                        Remove face data
                      </button>
                    )}
                  </div>
                </div>

                <div className="profile-nav">
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      stopCameraAndTracking();
                      setStep(1);
                    }}
                  >
                    Back
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!profilesAreReady || !playerTracksAreLinked}
                    onClick={() => setStep(3)}
                  >
                    Frame the table <span className="arrow">→</span>
                  </button>
                </div>

                <p className="descriptor-note">
                  Raw frames are discarded; only compact local descriptors are kept.
                </p>
              </div>
            </div>
          </section>
        )}

        {step === 3 && (
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
                      onClick={() => void startCameraAndResetTracking()}
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

                {cameraStatus === "streaming" && (
                  <div className="tracker-strip" aria-live="polite">
                    <span className="tracker-strip-label">
                      {playerTrackingStatus === "loading" ? "Starting tracker" : "Player tracking"}
                    </span>
                    {trackedPeople.map((person) => {
                      const playerIndex = playerTrackIds.findIndex(
                        (trackId) => trackId === person.trackId,
                      );
                      return (
                        <span className="tracked-person-chip" key={person.trackId}>
                          <span className="tracking-dot" aria-hidden="true" />
                          {playerIndex >= 0
                            ? draft.players[playerIndex].name.trim()
                            : `Unassigned track ${person.trackId}`}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="camera-controls">
                <p className="eyebrow">Step 4 · Camera framing</p>
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
                  <li className="check-item" data-ready={playerTrackingStatus === "tracking"}>
                    <span className="check-mark" aria-hidden="true">
                      {playerTrackingStatus === "tracking" ? "✓" : "4"}
                    </span>
                    MoveNet two-person tracker ready
                  </li>
                  <li className="check-item" data-ready={playerTracksAreLinked}>
                    <span className="check-mark" aria-hidden="true">
                      {playerTracksAreLinked ? "✓" : "5"}
                    </span>
                    {playerTrackIds.filter((trackId) => typeof trackId === "number").length}/2 player IDs linked
                  </li>
                </ul>

                {cameraError && (
                  <p className="camera-error" role="alert">
                    {cameraError}
                  </p>
                )}
                {playerTrackingError && (
                  <p className="camera-error" role="alert">{playerTrackingError}</p>
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
                      onChange={(event) =>
                        void startCameraAndResetTracking(event.target.value)
                      }
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
                  <button className="text-button" type="button" onClick={() => setStep(2)}>
                    Back
                  </button>
                  {cameraStatus === "streaming" && (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={stopCameraAndTracking}
                    >
                      Stop camera
                    </button>
                  )}
                  <button
                    className="primary-button"
                    type="button"
                    disabled={
                      cameraStatus !== "streaming" ||
                      playerTrackingStatus !== "tracking" ||
                      !playerTracksAreLinked
                    }
                    onClick={() => setStep(4)}
                  >
                    Use this view <span className="arrow">→</span>
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {step === 4 && (
          <section className="screen-card" aria-labelledby="match-title">
            <div className="screen-content">
              <p className="eyebrow">Step 5 · Match details</p>
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
                    <div className="summary-row">
                      <dt>Clothing profiles</dt>
                      <dd>{draft.players.filter((player) => player.clothingProfile).length} ready</dd>
                    </div>
                    <div className="summary-row">
                      <dt>Player tracking</dt>
                      <dd>{playerTracksAreLinked ? "Player 1 and Player 2 linked" : "Not linked"}</dd>
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
                <button className="text-button" type="button" onClick={() => setStep(3)}>
                  Back
                </button>
                <button className="primary-button" type="button" onClick={completeSetup}>
                  Complete setup <span className="arrow">→</span>
                </button>
              </div>
            </div>
          </section>
        )}

        {step === 5 && (
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
                <button className="secondary-button" type="button" onClick={() => setStep(4)}>
                  Edit match details
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => {
                    setStep(3);
                    void startCameraAndResetTracking();
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
