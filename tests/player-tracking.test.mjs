import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedPoseBoxToPixels,
  toTrackedPerson,
} from "../app/hooks/usePlayerTracking.ts";

test("converts MoveNet MultiPose boxes from padded normalized space to frame pixels", () => {
  const converted = normalizedPoseBoxToPixels(
    {
      xMin: 0.2,
      yMin: 0.1,
      xMax: 0.7,
      yMax: 0.9,
      width: 0.5,
      height: 0.8,
    },
    1920,
    1080,
  );

  assert.ok(converted.centerX > 500);
  assert.ok(converted.centerY > 400);
  assert.ok(converted.width > 900);
  assert.ok(converted.height > 800);
  assert.ok(converted.centerX <= 1920);
  assert.ok(converted.centerY <= 1080);
});

test("exposes tracked people in the same pixel coordinate space as face boxes", () => {
  const tracked = toTrackedPerson(
    {
      id: 7,
      score: 0.92,
      keypoints: [],
      box: {
        xMin: 0.25,
        yMin: 0.1,
        xMax: 0.75,
        yMax: 0.95,
        width: 0.5,
        height: 0.85,
      },
    },
    1280,
    720,
  );

  assert.ok(tracked);
  assert.equal(tracked.trackId, 7);
  assert.ok(tracked.width > 600);
  assert.ok(tracked.height > 600);
  assert.ok(tracked.centerX > 500);
  assert.ok(tracked.centerY > 300);
});
