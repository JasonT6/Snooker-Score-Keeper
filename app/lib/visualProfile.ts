export type VisualProfileKind = "face" | "clothing";

export interface VisualProfile {
  version: 1;
  kind: VisualProfileKind;
  capturedAt: number;
  embedding: number[];
  swatches: string[];
}

interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PROFILE_REGIONS: Record<VisualProfileKind, CropRegion> = {
  face: { x: 0.33, y: 0.12, width: 0.34, height: 0.43 },
  clothing: { x: 0.22, y: 0.37, width: 0.56, height: 0.55 },
};

function resolveCrop(video: HTMLVideoElement, kind: VisualProfileKind) {
  const fallback = PROFILE_REGIONS[kind];
  const guide = video.parentElement?.querySelector<HTMLElement>(
    `[data-profile-guide="${kind}"]`,
  );
  if (!guide || !video.clientWidth || !video.clientHeight) {
    return {
      x: video.videoWidth * fallback.x,
      y: video.videoHeight * fallback.y,
      width: video.videoWidth * fallback.width,
      height: video.videoHeight * fallback.height,
    };
  }

  const videoBounds = video.getBoundingClientRect();
  const guideBounds = guide.getBoundingClientRect();
  const scale = Math.max(
    videoBounds.width / video.videoWidth,
    videoBounds.height / video.videoHeight,
  );
  const croppedX = (video.videoWidth * scale - videoBounds.width) / 2;
  const croppedY = (video.videoHeight * scale - videoBounds.height) / 2;
  const x = (guideBounds.left - videoBounds.left + croppedX) / scale;
  const y = (guideBounds.top - videoBounds.top + croppedY) / scale;
  const width = guideBounds.width / scale;
  const height = guideBounds.height / scale;

  return {
    x: Math.max(0, Math.min(video.videoWidth - 1, x)),
    y: Math.max(0, Math.min(video.videoHeight - 1, y)),
    width: Math.max(1, Math.min(video.videoWidth - x, width)),
    height: Math.max(1, Math.min(video.videoHeight - y, height)),
  };
}

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

function toHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((channel) => clampByte(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function sampleSwatches(pixels: Uint8ClampedArray, size: number) {
  const swatches: string[] = [];
  const bands = [
    [0.05, 0.34],
    [0.34, 0.66],
    [0.66, 0.95],
  ] as const;

  for (const [start, end] of bands) {
    const firstRow = Math.floor(size * start);
    const lastRow = Math.max(firstRow + 1, Math.floor(size * end));
    let red = 0;
    let green = 0;
    let blue = 0;
    let count = 0;

    for (let row = firstRow; row < lastRow; row += 1) {
      for (let column = 0; column < size; column += 1) {
        const offset = (row * size + column) * 4;
        red += pixels[offset];
        green += pixels[offset + 1];
        blue += pixels[offset + 2];
        count += 1;
      }
    }

    swatches.push(toHex(red / count, green / count, blue / count));
  }

  return swatches;
}

function buildEmbedding(pixels: Uint8ClampedArray, size: number) {
  const cells = 4;
  const cellSize = size / cells;
  const embedding: number[] = [];

  for (let cellY = 0; cellY < cells; cellY += 1) {
    for (let cellX = 0; cellX < cells; cellX += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;

      for (let y = cellY * cellSize; y < (cellY + 1) * cellSize; y += 1) {
        for (let x = cellX * cellSize; x < (cellX + 1) * cellSize; x += 1) {
          const offset = (y * size + x) * 4;
          red += pixels[offset];
          green += pixels[offset + 1];
          blue += pixels[offset + 2];
          count += 1;
        }
      }

      embedding.push(
        Number((red / count / 255).toFixed(4)),
        Number((green / count / 255).toFixed(4)),
        Number((blue / count / 255).toFixed(4)),
      );
    }
  }

  return embedding;
}

export function createVisualProfile(
  video: HTMLVideoElement,
  kind: VisualProfileKind,
): VisualProfile {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
    throw new Error("The camera image is not ready yet. Hold still and try again.");
  }

  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser could not prepare the local profile.");

  const region = resolveCrop(video, kind);
  context.drawImage(
    video,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    size,
    size,
  );

  const pixels = context.getImageData(0, 0, size, size).data;
  return {
    version: 1,
    kind,
    capturedAt: Date.now(),
    embedding: buildEmbedding(pixels, size),
    swatches: kind === "clothing" ? sampleSwatches(pixels, size) : [],
  };
}
