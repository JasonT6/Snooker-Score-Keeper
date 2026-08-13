export type DeviceOrientation = "portrait" | "landscape";

export interface OrientationSnapshot {
  mode: DeviceOrientation;
  angle: number;
}

export function inferOrientation(
  width: number,
  height: number,
  orientationType?: string,
): DeviceOrientation {
  if (orientationType?.startsWith("portrait")) return "portrait";
  if (orientationType?.startsWith("landscape")) return "landscape";
  return width > height ? "landscape" : "portrait";
}

export function normalizeOrientationAngle(angle: number | undefined): number {
  if (!Number.isFinite(angle)) return 0;
  return ((Number(angle) % 360) + 360) % 360;
}

export function readOrientation(): OrientationSnapshot {
  if (typeof window === "undefined") {
    return { mode: "portrait", angle: 0 };
  }

  const screenOrientation = window.screen.orientation;
  const legacyAngle = (window as Window & { orientation?: number }).orientation;

  return {
    mode: inferOrientation(
      window.innerWidth,
      window.innerHeight,
      screenOrientation?.type,
    ),
    angle: normalizeOrientationAngle(screenOrientation?.angle ?? legacyAngle),
  };
}
