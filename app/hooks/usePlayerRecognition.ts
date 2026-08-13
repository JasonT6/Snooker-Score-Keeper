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
type PlayerTimers = [number | null, number | null];

const RECOGNITION_INTERVAL_MS = 750;
const MATCH_THRESHOLD = 0.5;
const MATCH_MARGIN = 0.03;
const CONFIRMATION_COUNT = 2;
export const PLAYER_FACE_DESCRIPTOR_MINIMUM = 5;
const ENROLLMENT_SAMPLE_COUNT = PLAYER_FACE_DESCRIPTOR_MINIMUM;
const ENROLLMENT_SAMPLE_DELAY_MS = 180;
const MAX_DESCRIPTOR_GALLERY_SIZE = 10;
const FACE_CROP_SIZE = 320;
const LOST_TRACK_RELEASE_MS = 10_000;

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

function cropTrackedPersonHead(video: HTMLVideoElement, person: TrackedPerson) {
  const personX = person.centerX - person.width / 2;
  const personY = person.centerY - person.height / 2;
  const sourceWidth = Math.min(video.videoWidth, person.width * 1.15);
  const sourceHeight = Math.min(
    video.videoHeight,
    Math.max(person.height * 0.42, sourceWidth * 1.15),
  );
  const sourceX = Math.max(
    0,
    Math.min(video.videoWidth - sourceWidth, personX - person.width * 0.075),
  );
  const sourceY = Math.max(
    0,
    Math.min(video.videoHeight - sourceHeight, personY - person.height * 0.035),
  );
  if (sourceWidth < 20 || sourceHeight < 20) return null;

  const canvas = document.createElement("canvas");
  canvas.width = FACE_CROP_SIZE;
  canvas.height = FACE_CROP_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return null;
  // This magnifies only the upper-body search region for distant players.
  // Human still runs BlazeFace inside the crop and sends its aligned face
  // tensor—not this entire region—to the face-description model.
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
  const processingRef = useRef(false);
  const votesRef = useRef(new Map<string, number>());
  const missingSinceRef = useRef<[number | null, number | null]>([null, null]);
  const releaseTimersRef = useRef<PlayerTimers>([null, null]);
  const loadGenerationRef = useRef(0);
  const [status, setStatus] = useState<PlayerRecognitionStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [memories, setMemories] = useState<PlayerMemories>([null, null]);
  const [playerTrackIds, setPlayerTrackIds] = useState<PlayerTrackIds>([null, null]);
  const [reidentificationStatus, setReidentificationStatus] =
    useState<ReidentificationStatus>("idle");

  const clearLostTrackTimer = useCallback((playerIndex: 0 | 1) => {
    const timer = releaseTimersRef.current[playerIndex];
    if (timer !== null) window.clearTimeout(timer);
    releaseTimersRef.current[playerIndex] = null;
  }, []);

  useEffect(() => {
    peopleRef.current = people;
    for (const playerIndex of [0, 1] as const) {
      const trackId = assignmentsRef.current[playerIndex];
      if (typeof trackId !== "number") {
        clearLostTrackTimer(playerIndex);
        missingSinceRef.current[playerIndex] = null;
        continue;
      }

      const assignedPerson = people.find(
        (person) => person.trackId === trackId,
      );
      if (assignedPerson) {
        clearLostTrackTimer(playerIndex);
        missingSinceRef.current[playerIndex] = null;
        continue;
      }

      missingSinceRef.current[playerIndex] ??= Date.now();
      if (releaseTimersRef.current[playerIndex] !== null) continue;
      const missingSince = missingSinceRef.current[playerIndex] ?? Date.now();
      const remaining = Math.max(
        0,
        LOST_TRACK_RELEASE_MS - (Date.now() - missingSince),
      );
      releaseTimersRef.current[playerIndex] = window.setTimeout(() => {
        releaseTimersRef.current[playerIndex] = null;
        const trackIsStillMissing = !peopleRef.current.some(
          (person) => person.trackId === trackId,
        );
        const stillAssigned = assignmentsRef.current[playerIndex] === trackId;
        const absentLongEnough =
          missingSinceRef.current[playerIndex] !== null &&
          Date.now() - (missingSinceRef.current[playerIndex] ?? Date.now()) >=
            LOST_TRACK_RELEASE_MS;
        if (!trackIsStillMissing || !stillAssigned || !absentLongEnough) return;

        const nextAssignments: PlayerTrackIds = [...assignmentsRef.current];
        nextAssignments[playerIndex] = null;
        assignmentsRef.current = nextAssignments;
        missingSinceRef.current[playerIndex] = null;
        votesRef.current.clear();
        setPlayerTrackIds(nextAssignments);
      }, remaining + 20);
    }
  }, [clearLostTrackTimer, people]);

  useEffect(() => {
    return () => {
      for (const playerIndex of [0, 1] as const) {
        clearLostTrackTimer(playerIndex);
      }
    };
  }, [clearLostTrackTimer]);

  const bindTrack = useCallback((playerIndex: 0 | 1, trackId: number) => {
    if (assignmentsRef.current[playerIndex] === trackId) return;
    const next: PlayerTrackIds = [...assignmentsRef.current];
    const otherPlayer = playerIndex === 0 ? 1 : 0;
    if (next[otherPlayer] === trackId) {
      next[otherPlayer] = null;
      clearLostTrackTimer(otherPlayer);
      missingSinceRef.current[otherPlayer] = null;
    }
    next[playerIndex] = trackId;
    clearLostTrackTimer(playerIndex);
    missingSinceRef.current[playerIndex] = null;
    assignmentsRef.current = next;
    setPlayerTrackIds(next);
  }, [clearLostTrackTimer]);

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
              rotation: true,
              minConfidence: 0.5,
              minSize: 32,
              skipFrames: 0,
              skipTime: 0,
              return: false,
            },
            mesh: { enabled: true },
            iris: { enabled: false },
            description: {
              enabled: true,
              minConfidence: 0.5,
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
          // Human detects all faces first, creates an aligned tensor for each
          // BlazeFace result, and runs the descriptor model on that face tensor.
          const result = await human.detect(videoElement);
          const usableFaces = result.face.filter(
            (face) => face.embedding && face.embedding.length >= 64 && face.size[0] >= 32,
          );
          const selectedFace = usableFaces.find(
            (face) => trackForFace(face, peopleRef.current)?.trackId === person.trackId,
          );
          if (!selectedFace) {
            throw new Error(
              usableFaces.length === 0
                ? "No face was found. Look directly at the camera and keep your face inside the guide."
                : "The selected player's face could not be linked to their body track. Centre that player in the guide and try again.",
            );
          }
          descriptors.push([...(selectedFace.embedding ?? [])]);
          if (!thumbnail) thumbnail = faceThumbnail(videoElement, selectedFace);
          if (sampleIndex + 1 < ENROLLMENT_SAMPLE_COUNT) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, ENROLLMENT_SAMPLE_DELAY_MS),
            );
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
    const nextAssignments: PlayerTrackIds = [...assignmentsRef.current];
    nextAssignments[playerIndex] = null;
    assignmentsRef.current = nextAssignments;
    clearLostTrackTimer(playerIndex);
    missingSinceRef.current[playerIndex] = null;
    setPlayerTrackIds(nextAssignments);
    votesRef.current.clear();
  }, [clearLostTrackTimer]);

  const resetAssignments = useCallback(() => {
    for (const playerIndex of [0, 1] as const) {
      clearLostTrackTimer(playerIndex);
    }
    assignmentsRef.current = [null, null];
    missingSinceRef.current = [null, null];
    setPlayerTrackIds([null, null]);
    votesRef.current.clear();
  }, [clearLostTrackTimer]);

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
        const visiblePeople = peopleRef.current;
        const visibleTrackIds = new Set(
          visiblePeople.map((person) => person.trackId),
        );
        const assignedTrackIds = new Set(
          assignmentsRef.current.filter(
            (trackId): trackId is number => typeof trackId === "number",
          ),
        );
        const playersToIdentify = new Set<0 | 1>(
          ([0, 1] as const).filter(
            (playerIndex) => assignmentsRef.current[playerIndex] === null,
          ),
        );
        const tracksToIdentify = visiblePeople.filter(
          (person) => !assignedTrackIds.has(person.trackId),
        );
        if (playersToIdentify.size === 0 || tracksToIdentify.length === 0) {
          votesRef.current.clear();
          setReidentificationStatus("idle");
          return;
        }

        const candidates: Array<{
          descriptor: number[];
          playerIndex: 0 | 1;
          similarity: number;
          trackId: number;
        }> = [];
        const seenVoteKeys = new Set<string>();
        let faceFound = false;
        let matchedFaceFound = false;
        setReidentificationStatus("waiting-for-face");

        // Human enumerates every BlazeFace result in the full frame. Its face
        // pipeline aligns/crops each result before creating face.embedding.
        const fullFrameResult = await human.detect(videoElement);
        if (cancelled) return;
        for (const face of fullFrameResult.face) {
          if (!face.embedding || face.embedding.length < 64) continue;
          faceFound = true;
          setReidentificationStatus("comparing");
          const descriptor = [...face.embedding];
          const match = matchDescriptorToPlayer(human, descriptor, memoriesRef.current);
          if (!match.matched || !playersToIdentify.has(match.playerIndex)) continue;
          matchedFaceFound = true;
          const track = trackForFace(face, visiblePeople);
          if (!track || assignedTrackIds.has(track.trackId)) {
            setReidentificationStatus("face-matched");
            continue;
          }
          candidates.push({
            descriptor,
            playerIndex: match.playerIndex,
            similarity: match.similarity,
            trackId: track.trackId,
          });
        }

        // A pose-guided crop is only a zoomed search area for a distant face.
        // The embedding still comes from a face Human detects inside that crop,
        // and the source pose gives the corresponding track ID explicitly.
        for (const track of tracksToIdentify) {
          if (candidates.some((candidate) => candidate.trackId === track.trackId)) continue;
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
          if (!match.matched || !playersToIdentify.has(match.playerIndex)) continue;
          matchedFaceFound = true;
          candidates.push({
            descriptor,
            playerIndex: match.playerIndex,
            similarity: match.similarity,
            trackId: track.trackId,
          });
        }

        if (!faceFound) {
          setReidentificationStatus("waiting-for-face");
        } else if (faceFound && !matchedFaceFound) {
          setReidentificationStatus("no-match");
        } else if (matchedFaceFound && candidates.length === 0) {
          setReidentificationStatus("face-matched");
        }

        const claimedPlayers = new Set<number>();
        const claimedTracks = new Set<number>();
        for (const candidate of candidates.sort(
          (left, right) => right.similarity - left.similarity,
        )) {
          if (
            claimedPlayers.has(candidate.playerIndex) ||
            claimedTracks.has(candidate.trackId) ||
            visibleTrackIds.has(assignmentsRef.current[candidate.playerIndex] ?? -1)
          ) {
            continue;
          }
          claimedPlayers.add(candidate.playerIndex);
          claimedTracks.add(candidate.trackId);
          const voteKey = `${candidate.trackId}:${candidate.playerIndex}`;
          seenVoteKeys.add(voteKey);
          const votes = (votesRef.current.get(voteKey) ?? 0) + 1;
          votesRef.current.set(voteKey, votes);
          setReidentificationStatus("confirming");
          if (votes >= CONFIRMATION_COUNT) {
            bindTrack(candidate.playerIndex, candidate.trackId);
            missingSinceRef.current[candidate.playerIndex] = null;
            setReidentificationStatus("matched");
            const memory = memoriesRef.current[candidate.playerIndex];
            if (
              memory &&
              memory.descriptors.length < MAX_DESCRIPTOR_GALLERY_SIZE
            ) {
              const updatedMemory: PlayerFaceMemory = {
                ...memory,
                descriptors: [...memory.descriptors, candidate.descriptor],
              };
              const nextMemories: PlayerMemories = [...memoriesRef.current];
              nextMemories[candidate.playerIndex] = updatedMemory;
              memoriesRef.current = nextMemories;
              setMemories(nextMemories);
            }
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
