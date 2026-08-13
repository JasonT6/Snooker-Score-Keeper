"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createVisualProfile,
  type VisualProfileKind,
} from "../lib/visualProfile";

export type CameraStatus =
  | "idle"
  | "requesting"
  | "streaming"
  | "denied"
  | "unavailable"
  | "error";

interface CameraDevice {
  deviceId: string;
  label: string;
}

function cameraErrorMessage(error: unknown) {
  if (!(error instanceof DOMException)) {
    return "The camera could not be started. Check this browser's camera settings and try again.";
  }

  if (error.name === "NotAllowedError" || error.name === "SecurityError") {
    return "Camera access is blocked. Allow camera access in your browser settings, then try again.";
  }

  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
    return "No camera was found on this device.";
  }

  if (error.name === "NotReadableError" || error.name === "TrackStartError") {
    return "The camera is being used by another app. Close it there, then try again.";
  }

  if (error.name === "OverconstrainedError") {
    return "The selected camera does not support the requested video mode. Choose another camera.";
  }

  return "The camera could not be started. Check this browser's camera settings and try again.";
}

export function useCamera() {
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    setStatus("idle");
  }, []);

  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    videoElementRef.current = element;
    setVideoElement(element);
    if (!element || !streamRef.current) return;

    element.srcObject = streamRef.current;
    void element.play().catch(() => {
      setErrorMessage("Tap the preview to resume the camera.");
    });
  }, []);

  const startCamera = useCallback(async (deviceId?: string) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("unavailable");
      setErrorMessage(
        "Camera preview is not supported here. Use current Safari or Chrome over a secure connection.",
      );
      return;
    }

    setStatus("requesting");
    setErrorMessage("");
    streamRef.current?.getTracks().forEach((track) => track.stop());

    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId
          ? {
              deviceId: { exact: deviceId },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            }
          : {
              facingMode: { ideal: "environment" },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              aspectRatio: { ideal: 16 / 9 },
            },
      });

      streamRef.current = nextStream;
      setStream(nextStream);
      setStatus("streaming");

      const activeDeviceId = nextStream.getVideoTracks()[0]?.getSettings().deviceId;
      if (activeDeviceId) setSelectedDeviceId(activeDeviceId);

      const availableDevices = await navigator.mediaDevices.enumerateDevices();
      const cameras = availableDevices
        .filter((item) => item.kind === "videoinput")
        .map((item, index) => ({
          deviceId: item.deviceId,
          label: item.label || `Camera ${index + 1}`,
        }));
      setDevices(cameras);
    } catch (error) {
      streamRef.current = null;
      setStream(null);
      setStatus(
        error instanceof DOMException &&
          (error.name === "NotAllowedError" || error.name === "SecurityError")
          ? "denied"
          : "error",
      );
      setErrorMessage(cameraErrorMessage(error));
    }
  }, []);

  const captureVisualProfile = useCallback((kind: VisualProfileKind) => {
    if (!videoElementRef.current || status !== "streaming") {
      throw new Error("Open the camera before capturing a player profile.");
    }
    return createVisualProfile(videoElementRef.current, kind);
  }, [status]);

  useEffect(() => stopCamera, [stopCamera]);

  return {
    status,
    stream,
    devices,
    selectedDeviceId,
    errorMessage,
    videoElement,
    videoRef: attachVideo,
    startCamera,
    stopCamera,
    captureVisualProfile,
  };
}
