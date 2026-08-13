"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type Human from "@vladmandic/human";
import type { FaceResult } from "@vladmandic/human";
import type { TrackedPerson } from "./usePlayerTracking";

export type PlayerRecognitionStatus = "idle" | "loading" | "ready" | "error";

export interface PlayerFaceMemory {
  capturedAt: number;
  descriptors: number[][];
  thumbnail: string;
}

type PlayerMemories = [PlayerFaceMemory | null, PlayerFaceMemory | null];
type PlayerTrackIds = [number | null, number | null];
type PlayerAnchors = [TrackedPerson | null, TrackedPerson | null];

const RECOGNITION_INTERVAL_MS = 750;
const MATCH_THRESHOLD = 0.55;
const MATCH_MARGIN = 0.08;
const CONFIRMATION_COUNT = 2;
const HANDOFF_WINDOW_MS = 5_000;
const HANDOFF_MAX_DISTANCE = 1.5;
const ENROLLMENT_SAMPLE_COUNT = 2;
const MAX_DESCRIPTOR_GALLERY_SIZE = 5;
const FACE_CROP_SIZE = 320;

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

function faceThumbnail(video: HTMLVideoElement, face: FaceResult) {
  const [faceX, faceY, faceWidth, faceHeight] = face.box;
  const side = Math.max(faceWidth, faceHeight) * 1.55;
  const sourceX = Math.max(0, Math.min(video.videoWidth - side, faceX + faceWidth / 2 - side / 2));
  const sourceY = Math.max(0, Math.min(video.videoHeight - side, faceY + faceHeight / 2 - side / 2));
  const sourceSide = Math.min(side, video.videoWidth - sourceX, video.videoHeight - sourceY);
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
  const loadGenerationRef = useRef(0);
  const [status, setStatus] = useState<PlayerRecognitionStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [memories, setMemories] = useState<PlayerMemories>([null, null]);
  const [playerTrackIds, setPlayerTrackIds] = useState<PlayerTrackIds>([null, null]);

  useEffect(() => {
    peopleRef.current = people;
    const currentAssignments = assignmentsRef.current;
    for (const playerIndex of [0, 1] as const) {
      const assignedPerson = people.find(
        (person) => person.trackId === currentAssignments[playerIndex],
      );
      if (assignedPerson) identityAnchorsRef.current[playerIndex] = assignedPerson;
    }

    if (Date.now() <= handoffUntilRef.current) {
      const handedOff = handoffTrackAssignments(
        identityAnchorsRef.current,
        people,
        currentAssignments,
      );
      if (
        handedOff[0] !== currentAssignments[0] ||
        handedOff[1] !== currentAssignments[1]
      ) {
        assignmentsRef.current = handedOff;
        setPlayerTrackIds(handedOff);
      }
    }
  }, [people]);

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
              minConfidence: 0.5,
              minSize: 32,
              skipFrames: 0,
              skipTime: 0,
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
    async (playerIndex: 0 | 1, trackId: number) => {
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
            (face) => face.embedding && face.embedding.length >= 64 && face.size[0] >= 64,
          );
          if (usableFaces.length !== 1) {
            throw new Error(
              usableFaces.length === 0
                ? "No clear face was found. Move closer, face the camera, and try again."
                : "More than one face is visible. Keep only the selected player in the guide.",
            );
          }
          const face = usableFaces[0];
          descriptors.push([...(face.embedding ?? [])]);
          if (!thumbnail) thumbnail = faceThumbnail(videoElement, face);
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
        bindTrack(playerIndex, trackId);
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
    votesRef.current.clear();
  }, []);

  const resetAssignments = useCallback(() => {
    assignmentsRef.current = [null, null];
    identityAnchorsRef.current = [null, null];
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
        peopleRef.current.length === 0
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

        for (const track of tracksToIdentify) {
          const headCrop = cropTrackedPersonHead(videoElement, track);
          if (!headCrop) continue;
          const result = await human.detect(headCrop);
          if (cancelled) return;
          const face = [...result.face]
            .filter((candidate) => candidate.embedding && candidate.embedding.length >= 64)
            .sort((left, right) => right.size[0] * right.size[1] - left.size[0] * left.size[1])[0];
          if (!face?.embedding || face.embedding.length < 64) continue;
          const descriptor = [...face.embedding];
          const similarities = memoriesRef.current.map((memory) =>
            bestMemorySimilarity(human, descriptor, memory),
          );
          const playerIndex = similarities[0] >= similarities[1] ? 0 : 1;
          const otherPlayer = playerIndex === 0 ? 1 : 0;
          if (
            similarities[playerIndex] < MATCH_THRESHOLD ||
            similarities[playerIndex] - similarities[otherPlayer] < MATCH_MARGIN
          ) {
            continue;
          }
          candidates.push({
            descriptor,
            playerIndex: playerIndex as 0 | 1,
            similarity: similarities[playerIndex],
            trackId: track.trackId,
          });
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
          if (votes >= CONFIRMATION_COUNT) {
            bindTrack(candidate.playerIndex, candidate.trackId);
            const memory = memoriesRef.current[candidate.playerIndex];
            if (memory && memory.descriptors.length < MAX_DESCRIPTOR_GALLERY_SIZE) {
              memory.descriptors.push(candidate.descriptor);
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
    enrollPlayer,
    forgetPlayer,
    resetAssignments,
  };
}
