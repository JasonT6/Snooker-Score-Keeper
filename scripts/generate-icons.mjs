import sharp from "sharp";

const size = 512;
const channels = 4;
const pixels = Buffer.alloc(size * size * channels);

function roundedRectDistance(x, y, left, top, width, height, radius) {
  const centreX = left + width / 2;
  const centreY = top + height / 2;
  const qx = Math.abs(x - centreX) - (width / 2 - radius);
  const qy = Math.abs(y - centreY) - (height / 2 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function circleDistance(x, y, cx, cy, radius) {
  return Math.hypot(x - cx, y - cy) - radius;
}

function blend(base, overlay, alpha) {
  return Math.round(base * (1 - alpha) + overlay * alpha);
}

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const offset = (y * size + x) * channels;
    const glow = Math.max(0, 1 - Math.hypot(x - 150, y - 80) / 480);
    let red = blend(7, 22, glow * 0.42);
    let green = blend(17, 68, glow * 0.42);
    let blue = blend(13, 40, glow * 0.42);

    const outer = roundedRectDistance(x, y, 65, 122, 382, 268, 54);
    const inner = roundedRectDistance(x, y, 85, 142, 342, 228, 37);

    if (outer <= 0) {
      const edgeLight = Math.max(0, 1 - Math.abs(outer) / 24);
      red = blend(72, 112, edgeLight * 0.35);
      green = blend(48, 76, edgeLight * 0.28);
      blue = blend(32, 45, edgeLight * 0.2);
    }

    if (inner <= 0) {
      const feltGlow = Math.max(0, 1 - Math.hypot(x - 215, y - 210) / 360);
      red = blend(5, 18, feltGlow * 0.42);
      green = blend(82, 151, feltGlow * 0.5);
      blue = blend(47, 82, feltGlow * 0.42);
    }

    const pockets = [
      [89, 147], [256, 143], [423, 147],
      [89, 365], [256, 369], [423, 365],
    ];
    if (pockets.some(([cx, cy]) => circleDistance(x, y, cx, cy, 15) <= 0)) {
      red = 5; green = 11; blue = 8;
    }

    if (circleDistance(x, y, 338, 242, 24) <= 0) {
      const light = Math.max(0, 1 - Math.hypot(x - 330, y - 234) / 33);
      red = blend(211, 255, light);
      green = blend(215, 255, light);
      blue = blend(207, 250, light);
    }

    if (circleDistance(x, y, 210, 292, 20) <= 0) {
      const light = Math.max(0, 1 - Math.hypot(x - 203, y - 285) / 28);
      red = blend(173, 244, light * 0.7);
      green = blend(35, 92, light * 0.5);
      blue = blend(43, 93, light * 0.45);
    }

    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = 255;
  }
}

const base = sharp(pixels, { raw: { width: size, height: size, channels } });
await base.clone().png().toFile("public/icon-512.png");
await base.clone().resize(192, 192).png().toFile("public/icon-192.png");
