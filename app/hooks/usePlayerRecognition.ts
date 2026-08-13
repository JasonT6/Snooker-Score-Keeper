"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type Human from "@vladmandic/human";
import type { FaceResult } from "@vladmandic/human";
import type { TrackedPerson } from "./usePlayerTracking";

export type PlayerRecognitionStatus = "idle" | "loading" | "ready" | "error";
export type ReidentificationStatus =
  | "idle"
  | "waiting-for-face"
  | "comparing"
  | "face-matched"
  | "no-match"
  | "confirming"
  | "matched";

export interface PlayerFaceMemory {
  capturedAt: number;
  descriptors: number[][];
  thumbnail: string;
}

type PlayerMemories = [PlayerFaceMemory | null, PlayerFaceMemory | null];
type PlayerTrackIds = [number | null, number | null];
type PlayerAnchors = [TrackedPerson | null, TrackedPerson | null];

const RECOGNITION_INTERVAL_MS = 350;
const MATCH_THRESHOLD = 0.46;
const STRONG_MATCH_THRESHOLD = 0.58;
const MATCH_MARGIN = 0.025;
const CONFIRMATION_COUNT = 2;
const HANDOFF_WINDOW_MS = 5_000;
const HANDOFF_MAX_DISTANCE = 1.5;
const ENROLLMENT_SAMPLE_COUNT = 2;
const MAX_DESCRIPTOR_GALLERY_SIZE = 5;
const FACE_CROP_SIZE = 320;
const LOST_TRACK_RELEASE_MS = 10_000;
const PENDING_FACE_MATCH_MS = 8_000;

function faceThumbnail(video: HTMLVideoElement, face: FaceResult) {
  const [faceX, faceY, faceWidth, faceHeight] = face.box;
  const side = Math.max(faceWidth, faceHeight) * 1.55;
  const sourceX = Math.max(
    0,
    Math.min(video.videoWidth - side, faceX + faceWidth / 2 - side / 2),
  );
  const sourceY = Math.max(
    0,
    Math.min(video.videoHeight - side, faceY + faceHeight / 2 - side / 2),
  );
  const sourceSide = Math.min(
    side,
    video.videoWidth - sourceX,
    video.videoHeight - sourceY,
  );
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 160;
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceSide,
    sourceSide,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas.toDataURL("image/jpeg", 0.82);
}

function trackForFace(face: FaceResult, people: TrackedPerson[]) {
  const [faceX, faceY, faceWidth, faceHeight] = face.box;
  const faceCenterX = faceX + faceWidth / 2;
  const faceCenterY = faceY + faceHeight / 2;

  return [...people]
    .filter((person) => {
      const xMin = person.centerX - person.width / 2;
      const yMin = person.centerY - person.height / 2;
      return (
        faceCenterX >= xMin - person.width * 0.18 &&
        faceCenterX <= xMin + person.width * 1.18 &&
        faceCenterY >= yMin - person.height * 0.18 &&
        faceCenterY <= yMin + person.height * 0.62
      );
    })
    .sort((left, right) => {
      const leftDistance =
        Math.abs(left.centerX - faceCenterX) / Math.max(left.width, 1) +
        Math.abs(left.centerY - faceCenterY) / Math.max(left.height, 1);
      const rightDistance =
        Math.abs(right.centerX - faceCenterX) / Math.max(right.width, 1) +
        Math.abs(right.centerY - faceCenterY) / Math.max(right.height, 1);
      return leftDistance - rightDistance;
    })[0] ?? null;
}

function trackDistance(previous: TrackedPerson, current: TrackedPerson) {
  const width = Math.max(previous.width, current.width, 1);
  const height = Math.max(previous.height, current.height, 1);
  const positionDistance =
    Math.abs(previous.centerX - current.centerX) / width +
    Math.abs(previous.centerY - current.centerY) / height;
  const sizeDistance =
    Math.abs(Math.log(Math.max(current.width, 1) / Math.max(previous.width, 1))) +
    Math.abs(Math.log(Math.max(current.height, 1) / Math.max(previous.height, 1)));
  return positionDistance + sizeDistance * 0.25;
}

export function handoffTrackAssignments(
  anchors: PlayerAnchors,
  people: TrackedPerson[],
  assignments: PlayerTrackIds,
) {
  const next: PlayerTrackIds = [...assignments];
  const visibleTrackIds = new Set(people.map((person) => person.trackId));
  const usedTrackIds = new Set(
    next.filter((trackId): trackId is number =>
      typeof trackId === "number" && visibleTrackIds.has(trackId),
    ),
  );

  for (const playerIndex of [0, 1] as const) {
    if (typeof next[playerIndex] === "number" && visibleTrackIds.has(next[playerIndex] as number)) {
      continue;
    }
    const anchor = anchors[playerIndex];
    if (!anchor) continue;
    const candidate = people
      .filter((person) => !usedTrackIds.has(person.trackId))
      .map((person) => ({ person, distance: trackDistance(anchor, person) }))
      .sort((left, right) => left.distance - right.distance)[0];
    if (!candidate || candidate.distance > HANDOFF_MAX_DISTANCE) continue;
    next[playerIndex] = candidate.person.trackId;
    usedTrackIds.add(candidate.person.trackId);
  }

  return next;
}

function cropTrackedPersonHead(video: HTMLVideoElement, person: TrackedPerson) {
  const personX = person.centerX - person.width / 2;
  const personY = person.centerY - person.height / 2;
  // MoveNet's full-body box gives us a reliable way to enlarge a distant face
  // before BlazeFace sees it. Keep this crop tight enough that a face across a
  // snooker table still occupies a useful portion of the detector input.
  const sourceWidth = Math.min(video.videoWidth, person.width * 0.9);
  const sourceHeight = Math.min(
    video.videoHeight,
    Math.max(person.height * 0.34, sourceWidth * 1.12),
  );
  const sourceX = Math.max(
    0,
    Math.min(video.videoWidth - sourceWidth, personX + person.width * 0.05),
  );
  const sourceY = Math.max(
    0,
    Math.min(video.videoHeight - sourceHeight, personY - person.height * 0.08),
  );
  if (sourceWidth < 20 || sourceHeight < 20) return null;

  const canvas = document.createElement("canvas");
  canvas.width = FACE_CROP_SIZE;
  canvas.height = FACE_CROP_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
  const targetWidth = sourceWidth * scale;
  const targetHeight = sourceHeight * scale;
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    (canvas.width - targetWidth) / 2,
    (canvas.height - targetHeight) / 2,
    targetWidth,
    targetHeight,
  );
  return canvas;
}

function bestMemorySimilarity(
  human: Human,
  descriptor: number[],
  memory: PlayerFaceMemory | null,
) {
  if (!memory) return 0;
  return Math.max(
    0,
    ...memory.descriptors.map((reference) =>
      human.match.similarity(descriptor, reference),
    ),
  );
}

export function matchDescriptorToPlayer(
  human: Human,
  descriptor: number[],
  memories: PlayerMemories,
) {
  const similarities = memories.map((memory) =>
    bestMemorySimilarity(human, descriptor, memory),
  ) as [number, number];
  const playerIndex: 0 | 1 = similarities[0] >= similarities[1] ? 0 : 1;
  const otherPlayer = playerIndex === 0 ? 1 : 0;
  return {
    playerIndex,
    similarity: similarities[playerIndex],
    margin: similarities[playerIndex] - similarities[otherPlayer],
    matched:
      similarities[playerIndex] >= MATCH_THRESHOLD &&
      similarities[playerIndex] - similarities[otherPlayer] >= MATCH_MARGIN,
  };
}

export function usePlayerRecognition(
  videoElement: HTMLVideoElement | null,
  people: TrackedPerson[],
  enabled: boolean,
) {
  const humanRef = useRef<Human | null>(null);
  const peopleRef = useRef(people);
  const memoriesRef = useRef<PlayerMemories>([null, null]);
  const assignmentsRef = useRef<PlayerTrackIds>([null, null]);
  const identityAnchorsRef = useRef<PlayerAnchors>([null, null]);
  const lastVideoElementRef = useRef<HTMLVideoElement | null>(null);
  const handoffUntilRef = useRef(0);
  const processingRef = useRef(false);
  const votesRef = useRef(new Map<string, number>());
  const missingSinceRef = useRef<[number | null, number | null]>([null, null]);
  const missingReleaseTimerRef = useRef<number | null>(null);
  const pendingFaceMatchesRef = useRef<[number, number]>([0, 0]);
  const loadGenerationRef = useRef(0);
  const [status, setStatus] = useState<PlayerRecognitionStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [memories, setMemories] = useState<PlayerMemories>([null, null]);
  const [playerTrackIds, setPlayerTrackIds] = useState<PlayerTrackIds>([null, null]);
  const [reidentificationStatus, setReidentificationStatus] =
    useState<ReidentificationStatus>("idle");

  useEffect(() => {
    peopleRef.current = people;
    let nextAssignments: PlayerTrackIds = [...assignmentsRef.current];
    let nextReleaseDelay = Number.POSITIVE_INFINITY;
    const now = Date.now();

    for (const playerIndex of [0, 1] as const) {
      const assignedPerson = people.find(
        (person) => person.trackId === nextAssignments[playerIndex],
      );
      if (assignedPerson) {
        identityAnchorsRef.current[playerIndex] = assignedPerson;
        missingSinceRef.current[playerIndex] = null;
      } else if (typeof nextAssignments[playerIndex] === "number") {
        missingSinceRef.current[playerIndex] ??= now;
        const remaining =
          LOST_TRACK_RELEASE_MS -
          (now - (missingSinceRef.current[playerIndex] ?? now));
        if (remaining <= 0) {
          nextAssignments[playerIndex] = null;
          missingSinceRef.current[playerIndex] = null;
        } else {
          nextReleaseDelay = Math.min(nextReleaseDelay, remaining);
        }
      }
    }

    if (Date.now() <= handoffUntilRef.current) {
      const handedOff = handoffTrackAssignments(
        identityAnchorsRef.current,
        people,
        nextAssignments,
      );
      nextAssignments = handedOff;
    }

    if (
      nextAssignments[0] !== assignmentsRef.current[0] ||
      nextAssignments[1] !== assignmentsRef.current[1]
    ) {
      assignmentsRef.current = nextAssignments;
      setPlayerTrackIds(nextAssignments);
    }

    if (missingReleaseTimerRef.current !== null) {
      window.clearTimeout(missingReleaseTimerRef.current);
      missingReleaseTimerRef.current = null;
    }
    if (Number.isFinite(nextReleaseDelay)) {
      missingReleaseTimerRef.current = window.setTimeout(() => {
        missingReleaseTimerRef.current = null;
        const visibleTrackIds = new Set(
          peopleRef.current.map((person) => person.trackId),
        );
        const released: PlayerTrackIds = [...assignmentsRef.current];
        let changed = false;
        for (const playerIndex of [0, 1] as const) {
          const trackId = released[playerIndex];
          const missingSince = missingSinceRef.current[playerIndex];
          if (
            typeof trackId === "number" &&
            !visibleTrackIds.has(trackId) &&
            missingSince !== null &&
            Date.now() - missingSince >= LOST_TRACK_RELEASE_MS
          ) {
            released[playerIndex] = null;
            missingSinceRef.current[playerIndex] = null;
            changed = true;
          }
        }
        if (changed) {
          assignmentsRef.current = released;
          setPlayerTrackIds(released);
        }
      }, Math.max(0, nextReleaseDelay + 20));
    }

    return () => {
      if (missingReleaseTimerRef.current !== null) {
        window.clearTimeout(missingReleaseTimerRef.current);
        missingReleaseTimerRef.current = null;
      }
    };
  }, [people, playerTrackIds]);

  useEffect(() => {
    if (!videoElement) {
      if (lastVideoElementRef.current) handoffUntilRef.current = Date.now() + HANDOFF_WINDOW_MS;
      return;
    }
    if (lastVideoElementRef.current && lastVideoElementRef.current !== videoElement) {
      handoffUntilRef.current = Date.now() + HANDOFF_WINDOW_MS;
    }
    lastVideoElementRef.current = videoElement;
  }, [videoElement]);

  const bindTrack = useCallback((playerIndex: 0 | 1, trackId: number) => {
    const currentPerson = peopleRef.current.find((person) => person.trackId === trackId);
    if (currentPerson) identityAnchorsRef.current[playerIndex] = currentPerson;
    setPlayerTrackIds((current) => {
      if (current[playerIndex] === trackId) return current;
      const next: PlayerTrackIds = [...current];
      const otherPlayer = playerIndex === 0 ? 1 : 0;
      if (next[otherPlayer] === trackId) next[otherPlayer] = null;
      next[playerIndex] = trackId;
      assignmentsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!enabled || humanRef.current) return;

    const loadGeneration = ++loadGenerationRef.current;
    let cancelled = false;
    setStatus("loading");
    setErrorMessage("");

    const loadRecognition = async () => {
      try {
        const { Human: HumanModel } = await import("@vladmandic/human");
        const human = new HumanModel({
          backend: "webgl",
          modelBasePath: "/models/human/",
          cacheModels: true,
          cacheSensitivity: 0,
          debug: false,
          warmup: "none",
          filter: { enabled: true, equalization: true, return: true },
          face: {
            enabled: true,
            detector: {
              enabled: true,
              maxDetected: 2,
              minConfidence: 0.35,
              minSize: 18,
              skipFrames: 0,
              skipTime: 0,
            },
            // FaceRes can consume the detector crop directly; skipping the much
            // heavier 468-point mesh makes returning-player matching noticeably faster.
            mesh: { enabled: false },
            iris: { enabled: false },
            description: {
              enabled: true,
              minConfidence: 0.35,
              skipFrames: 0,
              skipTime: 0,
            },
            emotion: { enabled: false },
            antispoof: { enabled: false },
            liveness: { enabled: false },
            attention: { enabled: false },
            gear: { enabled: false },
          },
          body: { enabled: false },
          hand: { enabled: false },
          object: { enabled: false },
          segmentation: { enabled: false },
          gesture: { enabled: false },
        });
        await human.load();
        if (cancelled || loadGeneration !== loadGenerationRef.current) return;
        humanRef.current = human;
        setStatus("ready");
      } catch (error) {
        if (cancelled || loadGeneration !== loadGenerationRef.current) return;
        setStatus("error");
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "The on-device face recognition model could not be loaded.",
        );
      }
    };

    void loadRecognition();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const enrollPlayer = useCallback(
    async (playerIndex: 0 | 1, person: TrackedPerson) => {
      const human = humanRef.current;
      if (!human || status !== "ready") {
        throw new Error("Wait until the face-memory model is ready.");
      }
      if (!videoElement || videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        throw new Error("Wait until the live camera picture is visible.");
      }
      if (processingRef.current) {
        throw new Error("Face matching is busy. Hold still and try again.");
      }

      processingRef.current = true;
      try {
        const descriptors: number[][] = [];
        let thumbnail = "";
        for (let sampleIndex = 0; sampleIndex < ENROLLMENT_SAMPLE_COUNT; sampleIndex += 1) {
          const result = await human.detect(videoElement);
          const usableFaces = result.face.filter(
            (face) => face.embedding && face.embedding.length >= 64 && face.size[0] >= 32,
          );
          const selectedFace =
            usableFaces.find(
              (face) => trackForFace(face, peopleRef.current)?.trackId === person.trackId,
            ) ?? (usableFaces.length === 1 ? usableFaces[0] : null);
          if (!selectedFace) {
            throw new Error(
              usableFaces.length === 0
                ? "No face was found. Look directly at the camera and keep your face inside the guide."
                : "The selected player's face could not be linked to their body. Keep the other player out of view and try again.",
            );
          }
          descriptors.push([...(selectedFace.embedding ?? [])]);
          if (!thumbnail) thumbnail = faceThumbnail(videoElement, selectedFace);
          if (sampleIndex + 1 < ENROLLMENT_SAMPLE_COUNT) {
            await new Promise((resolve) => window.setTimeout(resolve, 180));
          }
        }

        const otherPlayer = playerIndex === 0 ? 1 : 0;
        const otherMemory = memoriesRef.current[otherPlayer];
        if (
          otherMemory &&
          descriptors.some(
            (descriptor) => bestMemorySimilarity(human, descriptor, otherMemory) >= 0.62,
          )
        ) {
          throw new Error(
            "This face is too similar to the other saved player. Make sure the selected player is alone in view.",
          );
        }

        const memory: PlayerFaceMemory = {
          capturedAt: Date.now(),
          descriptors,
          thumbnail,
        };
        const nextMemories: PlayerMemories = [...memoriesRef.current];
        nextMemories[playerIndex] = memory;
        memoriesRef.current = nextMemories;
        setMemories(nextMemories);
        bindTrack(playerIndex, person.trackId);
        votesRef.current.clear();
        return memory;
      } finally {
        processingRef.current = false;
      }
    },
    [bindTrack, status, videoElement],
  );

  const forgetPlayer = useCallback((playerIndex: 0 | 1) => {
    const nextMemories: PlayerMemories = [...memoriesRef.current];
    nextMemories[playerIndex] = null;
    memoriesRef.current = nextMemories;
    setMemories(nextMemories);
    setPlayerTrackIds((current) => {
      const next: PlayerTrackIds = [...current];
      next[playerIndex] = null;
      assignmentsRef.current = next;
      return next;
    });
    pendingFaceMatchesRef.current[playerIndex] = 0;
    votesRef.current.clear();
  }, []);

  const resetAssignments = useCallback(() => {
    if (missingReleaseTimerRef.current !== null) {
      window.clearTimeout(missingReleaseTimerRef.current);
      missingReleaseTimerRef.current = null;
    }
    assignmentsRef.current = [null, null];
    identityAnchorsRef.current = [null, null];
    missingSinceRef.current = [null, null];
    pendingFaceMatchesRef.current = [0, 0];
    setPlayerTrackIds([null, null]);
    votesRef.current.clear();
  }, []);

  useEffect(() => {
    const human = humanRef.current;
    if (
      !enabled ||
      status !== "ready" ||
      !human ||
      !videoElement ||
      !memories[0] ||
      !memories[1]
    ) {
      return;
    }

    let cancelled = false;
    let recognitionTimer = 0;
    const scheduleRecognition = () => {
      if (cancelled) return;
      recognitionTimer = window.setTimeout(
        () => void recognize(),
        RECOGNITION_INTERVAL_MS,
      );
    };
    const recognize = async () => {
      if (
        cancelled ||
        processingRef.current ||
        videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        !memoriesRef.current[0] ||
        !memoriesRef.current[1]
      ) {
        scheduleRecognition();
        return;
      }

      processingRef.current = true;
      try {
        const assignedTrackIds = new Set(
          assignmentsRef.current.filter(
          (trackId): trackId is number => typeof trackId === "number",
          ),
        );
        const visibleTrackIds = new Set(
          peopleRef.current.map((person) => person.trackId),
        );
        const playersNeedingIdentity = new Set(
          ([0, 1] as const).filter((playerIndex) => {
            const trackId = assignmentsRef.current[playerIndex];
            return typeof trackId !== "number" || !visibleTrackIds.has(trackId);
          }),
        );
        const tracksToIdentify = peopleRef.current.filter(
          (person) => !assignedTrackIds.has(person.trackId),
        );
        const candidates: Array<{
          descriptor: number[];
          playerIndex: 0 | 1;
          similarity: number;
          trackId: number;
        }> = [];
        const seenVoteKeys = new Set<string>();
        let faceFound = false;
        let matchedFaceFound = false;
        setReidentificationStatus(tracksToIdentify.length > 0 ? "waiting-for-face" : "idle");

        // Start with pose-guided head crops. This is both faster than an extra
        // full-frame pass and substantially enlarges faces in a wide table view.
        for (const track of tracksToIdentify) {
          const headCrop = cropTrackedPersonHead(videoElement, track);
          if (!headCrop) continue;
          const result = await human.detect(headCrop);
          if (cancelled) return;
          const face = [...result.face]
            .filter((candidate) => candidate.embedding && candidate.embedding.length >= 64)
            .sort((left, right) => right.size[0] * right.size[1] - left.size[0] * left.size[1])[0];
          if (!face?.embedding || face.embedding.length < 64) continue;
          faceFound = true;
          setReidentificationStatus("comparing");
          const descriptor = [...face.embedding];
          const match = matchDescriptorToPlayer(human, descriptor, memoriesRef.current);
          if (!match.matched || !playersNeedingIdentity.has(match.playerIndex)) continue;
          matchedFaceFound = true;
          candidates.push({
            descriptor,
            playerIndex: match.playerIndex,
            similarity: match.similarity,
            trackId: track.trackId,
          });
        }

        // If a face is close enough to see but MoveNet cannot form a body track,
        // retain the face result briefly and attach it when its body appears.
        if (tracksToIdentify.length === 0 && playersNeedingIdentity.size > 0) {
          const fullFrameResult = await human.detect(videoElement);
          if (cancelled) return;
          for (const face of fullFrameResult.face) {
            if (!face.embedding || face.embedding.length < 64) continue;
            faceFound = true;
            setReidentificationStatus("comparing");
            const descriptor = [...face.embedding];
            const match = matchDescriptorToPlayer(
              human,
              descriptor,
              memoriesRef.current,
            );
            if (!match.matched || !playersNeedingIdentity.has(match.playerIndex)) continue;
            matchedFaceFound = true;
            pendingFaceMatchesRef.current[match.playerIndex] =
              Date.now() + PENDING_FACE_MATCH_MS;
            setReidentificationStatus("face-matched");
          }
        }

        const candidateTrackIds = new Set(candidates.map((candidate) => candidate.trackId));
        const unmatchedTracks = tracksToIdentify.filter(
          (track) => !candidateTrackIds.has(track.trackId),
        );
        const pendingPlayers = ([0, 1] as const).filter(
          (playerIndex) => pendingFaceMatchesRef.current[playerIndex] >= Date.now(),
        );
        if (unmatchedTracks.length === 1 && pendingPlayers.length === 1) {
          candidates.push({
            descriptor: [],
            playerIndex: pendingPlayers[0],
            similarity: 1,
            trackId: unmatchedTracks[0].trackId,
          });
        }

        if (tracksToIdentify.length > 0 && !faceFound) {
          setReidentificationStatus("waiting-for-face");
        } else if (faceFound && !matchedFaceFound) {
          setReidentificationStatus("no-match");
        }

        const claimedPlayers = new Set<number>();
        for (const candidate of candidates.sort(
          (left, right) => right.similarity - left.similarity,
        )) {
          if (claimedPlayers.has(candidate.playerIndex)) continue;
          claimedPlayers.add(candidate.playerIndex);
          const voteKey = `${candidate.trackId}:${candidate.playerIndex}`;
          seenVoteKeys.add(voteKey);
          const votes = (votesRef.current.get(voteKey) ?? 0) + 1;
          votesRef.current.set(voteKey, votes);
          setReidentificationStatus("confirming");
          const requiredVotes =
            candidate.similarity >= STRONG_MATCH_THRESHOLD
              ? 1
              : CONFIRMATION_COUNT;
          if (votes >= requiredVotes) {
            bindTrack(candidate.playerIndex, candidate.trackId);
            missingSinceRef.current[candidate.playerIndex] = null;
            setReidentificationStatus("matched");
            const memory = memoriesRef.current[candidate.playerIndex];
            if (
              memory &&
              candidate.descriptor.length > 0 &&
              memory.descriptors.length < MAX_DESCRIPTOR_GALLERY_SIZE
            ) {
              memory.descriptors.push(candidate.descriptor);
            }
            pendingFaceMatchesRef.current[candidate.playerIndex] = 0;
          }
        }

        for (const voteKey of votesRef.current.keys()) {
          if (!seenVoteKeys.has(voteKey)) votesRef.current.delete(voteKey);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Player re-identification stopped unexpectedly.",
          );
        }
      } finally {
        processingRef.current = false;
        scheduleRecognition();
      }
    };

    void recognize();
    return () => {
      cancelled = true;
      window.clearTimeout(recognitionTimer);
    };
  }, [bindTrack, enabled, memories, status, videoElement]);

  return {
    status: enabled ? status : "idle",
    errorMessage: enabled ? errorMessage : "",
    memories,
    playerTrackIds,
    reidentificationStatus,
    enrollPlayer,
    forgetPlayer,
    resetAssignments,
  };
}
