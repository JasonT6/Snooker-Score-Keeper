export type DeviceOrientation = "portrait" | "landscape";

export interface OrientationSnapshot {
  mode: DeviceOrientation;
  angle: number;
}

interface LockableScreenOrientation {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
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

export async function preferLandscapeOrientation() {
  if (typeof window === "undefined") return false;
  const orientation = window.screen.orientation as unknown as LockableScreenOrientation;
  if (typeof orientation?.lock !== "function") return false;

  try {
    await orientation.lock("landscape-primary");
    return true;
  } catch {
    // Mobile browsers commonly allow locking only for installed/full-screen PWAs.
    // The responsive camera layout remains usable when the request is declined.
    return false;
  }
}

export function releaseOrientationLock() {
  if (typeof window === "undefined") return;
  const orientation = window.screen.orientation as unknown as LockableScreenOrientation;
  try {
    orientation?.unlock?.();
  } catch {
    // Unlock support varies by browser and does not affect the responsive fallback.
  }
}
