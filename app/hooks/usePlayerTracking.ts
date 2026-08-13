"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MoveNetModelConfig,
  Pose,
  PoseDetector,
} from "@tensorflow-models/pose-detection";

export type PlayerTrackingStatus =
  | "idle"
  | "loading"
  | "tracking"
  | "error";

export interface TrackedPerson {
  trackId: number;
  confidence: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

const TRACKING_INTERVAL_MS = 100;

function toTrackedPerson(pose: Pose): TrackedPerson | null {
  if (typeof pose.id !== "number" || !pose.box) return null;
  return {
    trackId: pose.id,
    confidence: pose.score ?? 0,
    centerX: pose.box.xMin + pose.box.width / 2,
    centerY: pose.box.yMin + pose.box.height / 2,
    width: pose.box.width,
    height: pose.box.height,
  };
}

export function usePlayerTracking(
  videoElement: HTMLVideoElement | null,
  enabled: boolean,
) {
  const detectorRef = useRef<PoseDetector | null>(null);
  const loadGenerationRef = useRef(0);
  const [detectorGeneration, setDetectorGeneration] = useState(0);
  const [status, setStatus] = useState<PlayerTrackingStatus>("idle");
  const [people, setPeople] = useState<TrackedPerson[]>([]);
  const [errorMessage, setErrorMessage] = useState("");

  const resetTracker = useCallback(() => {
    loadGenerationRef.current += 1;
    detectorRef.current?.dispose();
    detectorRef.current = null;
    setDetectorGeneration((generation) => generation + 1);
    setPeople([]);
    setErrorMessage("");
    setStatus("idle");
  }, []);

  useEffect(() => {
    if (!enabled || detectorRef.current) return;

    const loadGeneration = ++loadGenerationRef.current;
    let disposed = false;
    setStatus("loading");
    setErrorMessage("");

    const loadDetector = async () => {
      try {
        const [moveNet, moveNetConstants, trackerTypes, tf] = await Promise.all([
          import("@tensorflow-models/pose-detection/dist/movenet/detector"),
          import("@tensorflow-models/pose-detection/dist/movenet/constants"),
          import("@tensorflow-models/pose-detection/dist/calculators/types"),
          import("@tensorflow/tfjs-core"),
          import("@tensorflow/tfjs-backend-webgl"),
        ]).then(([moveNetModule, constantsModule, trackerTypesModule, tfModule]) => [
          moveNetModule,
          constantsModule,
          trackerTypesModule,
          tfModule,
        ] as const);

        await tf.setBackend("webgl");
        await tf.ready();

        const config: MoveNetModelConfig = {
          modelType: moveNetConstants.MULTIPOSE_LIGHTNING,
          enableSmoothing: true,
          enableTracking: true,
          trackerType: trackerTypes.TrackerType.BoundingBox,
          minPoseScore: 0.25,
          multiPoseMaxDimension: 256,
          trackerConfig: {
            maxTracks: 2,
            maxAge: 1000,
            minSimilarity: 0.15,
          },
        };

        const detector = await moveNet.load(config);

        if (disposed || loadGeneration !== loadGenerationRef.current) {
          detector.dispose();
          return;
        }

        detectorRef.current = detector;
        setDetectorGeneration((generation) => generation + 1);
        setStatus("tracking");
      } catch (error) {
        if (disposed || loadGeneration !== loadGenerationRef.current) return;
        setStatus("error");
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "The on-device player tracker could not be loaded.",
        );
      }
    };

    void loadDetector();
    return () => {
      disposed = true;
    };
  }, [detectorGeneration, enabled]);

  useEffect(() => {
    if (enabled) return;
    loadGenerationRef.current += 1;
    detectorRef.current?.dispose();
    detectorRef.current = null;
  }, [enabled]);

  useEffect(() => {
    const detector = detectorRef.current;
    if (!enabled || !videoElement || !detector) return;

    let animationFrame = 0;
    let cancelled = false;
    let processing = false;
    let lastRun = 0;

    const trackFrame = async (timestamp: number) => {
      if (cancelled) return;
      animationFrame = window.requestAnimationFrame(trackFrame);
      if (
        processing ||
        timestamp - lastRun < TRACKING_INTERVAL_MS ||
        videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        return;
      }

      processing = true;
      lastRun = timestamp;
      try {
        const poses = await detector.estimatePoses(videoElement, {
          maxPoses: 2,
          flipHorizontal: false,
        });
        if (cancelled) return;
        setPeople(
          poses
            .map(toTrackedPerson)
            .filter((person): person is TrackedPerson => Boolean(person))
            .sort((left, right) => right.confidence - left.confidence)
            .slice(0, 2),
        );
        setStatus("tracking");
      } catch (error) {
        if (!cancelled) {
          setStatus("error");
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Player tracking stopped unexpectedly.",
          );
        }
      } finally {
        processing = false;
      }
    };

    animationFrame = window.requestAnimationFrame(trackFrame);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrame);
    };
  }, [detectorGeneration, enabled, videoElement]);

  useEffect(
    () => () => {
      loadGenerationRef.current += 1;
      detectorRef.current?.dispose();
      detectorRef.current = null;
    },
    [],
  );

  return {
    status: enabled ? status : "idle",
    people: enabled ? people : [],
    errorMessage: enabled ? errorMessage : "",
    resetTracker,
  };
}
