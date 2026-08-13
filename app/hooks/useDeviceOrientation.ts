"use client";

import { useEffect, useState } from "react";
import { readOrientation, type OrientationSnapshot } from "../lib/orientation";

const INITIAL_ORIENTATION: OrientationSnapshot = {
  mode: "portrait",
  angle: 0,
};

export function useDeviceOrientation() {
  const [orientation, setOrientation] = useState(INITIAL_ORIENTATION);

  useEffect(() => {
    const update = () => {
      const next = readOrientation();
      setOrientation(next);
      document.documentElement.dataset.orientation = next.mode;
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    window.screen.orientation?.addEventListener?.("change", update);

    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      window.screen.orientation?.removeEventListener?.("change", update);
      delete document.documentElement.dataset.orientation;
    };
  }, []);

  return orientation;
}
