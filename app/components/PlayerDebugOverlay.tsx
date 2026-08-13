"use client";

import { useEffect, useRef } from "react";
import type { PlayerFaceMemory } from "../hooks/usePlayerRecognition";
import type { TrackedPerson } from "../hooks/usePlayerTracking";

interface PlayerDebugOverlayProps {
  videoElement: HTMLVideoElement | null;
  people: TrackedPerson[];
  playerNames: [string, string];
  playerTrackIds: [number | null, number | null];
  memories: [PlayerFaceMemory | null, PlayerFaceMemory | null];
}

function roundedRectangle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.roundRect(x, y, width, height, safeRadius);
}

export function PlayerDebugOverlay({
  videoElement,
  people,
  playerNames,
  playerTrackIds,
  memories,
}: PlayerDebugOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !videoElement) return;

    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const sourceWidth = videoElement.videoWidth;
      const sourceHeight = videoElement.videoHeight;
      if (!width || !height || !sourceWidth || !sourceHeight) return;

      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const targetWidth = Math.round(width * pixelRatio);
      const targetHeight = Math.round(height * pixelRatio);
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      // The preview uses object-fit: cover, so apply the same scale and crop to
      // MoveNet's source-video coordinates before drawing the debug geometry.
      const scale = Math.max(width / sourceWidth, height / sourceHeight);
      const offsetX = (width - sourceWidth * scale) / 2;
      const offsetY = (height - sourceHeight * scale) / 2;

      for (const person of people) {
        const rawX = (person.centerX - person.width / 2) * scale + offsetX;
        const rawY = (person.centerY - person.height / 2) * scale + offsetY;
        const rawWidth = person.width * scale;
        const rawHeight = person.height * scale;
        const x = Math.max(2, rawX);
        const y = Math.max(2, rawY);
        const boxWidth = Math.max(0, Math.min(width - 4, rawX + rawWidth) - x);
        const boxHeight = Math.max(0, Math.min(height - 4, rawY + rawHeight) - y);
        if (boxWidth < 4 || boxHeight < 4) continue;

        const playerIndex = playerTrackIds.findIndex(
          (trackId) => trackId === person.trackId,
        );
        const hasDescriptor =
          playerIndex >= 0 &&
          Boolean(memories[playerIndex]?.descriptors.length);
        const name =
          playerIndex >= 0
            ? playerNames[playerIndex].trim() || `Player ${playerIndex + 1}`
            : "Unidentified";
        const accent = hasDescriptor ? "#70e2a0" : "#e9c66b";

        context.lineWidth = 2;
        context.strokeStyle = accent;
        context.setLineDash(playerIndex >= 0 ? [] : [7, 5]);
        roundedRectangle(context, x, y, boxWidth, boxHeight, 8);
        context.stroke();
        context.setLineDash([]);

        const primaryLabel = `${name} · track ${person.trackId}`;
        const descriptorLabel = hasDescriptor
          ? `descriptor: saved (${memories[playerIndex]?.descriptors.length ?? 0})`
          : "descriptor: none";
        context.font = '700 12px ui-monospace, "SFMono-Regular", Consolas, monospace';
        const labelWidth = Math.min(
          width - 8,
          Math.max(
            context.measureText(primaryLabel).width,
            context.measureText(descriptorLabel).width,
          ) + 16,
        );
        const labelHeight = 38;
        const labelX = Math.min(Math.max(4, x), width - labelWidth - 4);
        const labelY = y >= labelHeight + 6 ? y - labelHeight - 4 : y + 4;

        context.fillStyle = "rgba(3, 10, 6, 0.9)";
        roundedRectangle(context, labelX, labelY, labelWidth, labelHeight, 7);
        context.fill();
        context.strokeStyle = accent;
        context.lineWidth = 1;
        context.stroke();
        context.fillStyle = "#f4f2e9";
        context.fillText(primaryLabel, labelX + 8, labelY + 15, labelWidth - 16);
        context.fillStyle = accent;
        context.font = '600 10px ui-monospace, "SFMono-Regular", Consolas, monospace';
        context.fillText(descriptorLabel, labelX + 8, labelY + 30, labelWidth - 16);
      }
    };

    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);
    videoElement.addEventListener("loadedmetadata", draw);
    const animationFrame = window.requestAnimationFrame(draw);
    draw();

    return () => {
      resizeObserver.disconnect();
      videoElement.removeEventListener("loadedmetadata", draw);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [memories, people, playerNames, playerTrackIds, videoElement]);

  const description = people.length
    ? people
        .map((person) => {
          const playerIndex = playerTrackIds.findIndex(
            (trackId) => trackId === person.trackId,
          );
          return playerIndex >= 0
            ? `${playerNames[playerIndex]} on track ${person.trackId}, saved descriptor ${
                memories[playerIndex]?.descriptors.length ? "present" : "absent"
              }`
            : `Unidentified person on track ${person.trackId}, no associated saved descriptor`;
        })
        .join(". ")
    : "No people are currently tracked.";

  return (
    <>
      <canvas className="player-debug-overlay" ref={canvasRef} aria-hidden="true" />
      <span className="sr-only" role="status" aria-live="polite">
        Debug view. {description}
      </span>
    </>
  );
}
