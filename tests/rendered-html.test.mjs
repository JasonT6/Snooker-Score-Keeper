import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the CueSight setup shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>CueSight — Automatic snooker scoring<\/title>/i);
  assert.match(html, /Your table\. Scored automatically\./);
  assert.match(html, /I agree to on-device camera processing/);
  assert.match(html, /manifest\.webmanifest/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("ships the installable PWA assets", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("public/manifest.webmanifest", projectRoot), "utf8"),
  );
  const serviceWorker = await readFile(new URL("public/sw.js", projectRoot), "utf8");

  assert.equal(manifest.short_name, "CueSight");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, "any");
  assert.equal(manifest.icons.length, 2);
  assert.match(serviceWorker, /cuesight-shell-v1/);
  assert.match(serviceWorker, /request\.mode === "navigate"/);

  await Promise.all([
    access(new URL("public/icon-192.png", projectRoot)),
    access(new URL("public/icon-512.png", projectRoot)),
  ]);
});

test("keeps camera and orientation concerns isolated", async () => {
  const [camera, orientationHook, orientationLogic] = await Promise.all([
    readFile(new URL("app/hooks/useCamera.ts", projectRoot), "utf8"),
    readFile(new URL("app/hooks/useDeviceOrientation.ts", projectRoot), "utf8"),
    readFile(new URL("app/lib/orientation.ts", projectRoot), "utf8"),
  ]);

  assert.match(camera, /facingMode: \{ ideal: "environment" \}/);
  assert.match(camera, /audio: false/);
  assert.match(camera, /getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  assert.match(orientationHook, /orientationchange/);
  assert.match(orientationHook, /screen\.orientation/);
  assert.match(orientationLogic, /width > height \? "landscape" : "portrait"/);
});

test("keeps consented player memory across temporary pose-track loss", async () => {
  const [setup, camera, playerTracking, playerRecognition, brief, readme, packageJson] = await Promise.all([
    readFile(new URL("app/components/SetupApp.tsx", projectRoot), "utf8"),
    readFile(new URL("app/hooks/useCamera.ts", projectRoot), "utf8"),
    readFile(new URL("app/hooks/usePlayerTracking.ts", projectRoot), "utf8"),
    readFile(new URL("app/hooks/usePlayerRecognition.ts", projectRoot), "utf8"),
    readFile(new URL("automatic_snooker_scoring_web_app.md", projectRoot), "utf8"),
    readFile(new URL("README.md", projectRoot), "utf8"),
    readFile(new URL("package.json", projectRoot), "utf8"),
  ]);

  assert.match(setup, /"Privacy", "Players", "Profiles", "Camera", "Match"/);
  assert.match(setup, /recognitionConsentReady/);
  assert.match(setup, /playerMemories\.every\(hasSavedFaceMemory\)/);
  assert.match(setup, /Forget this player/);
  assert.match(setup, /never saved to localStorage/);
  assert.match(setup, /className="profile-nav"/);
  assert.match(setup, /className="capture-type-row"/);
  assert.doesNotMatch(camera, /captureVisualProfile/);
  assert.match(playerTracking, /MULTIPOSE_LIGHTNING/);
  assert.match(playerTracking, /enableTracking: true/);
  assert.match(playerTracking, /maxTracks: 2/);
  assert.match(playerTracking, /maxPoses: 2/);
  assert.match(playerRecognition, /@vladmandic\/human/);
  assert.match(playerRecognition, /MATCH_THRESHOLD/);
  assert.match(playerRecognition, /MATCH_MARGIN/);
  assert.match(playerRecognition, /CONFIRMATION_COUNT = 2/);
  assert.match(playerRecognition, /PLAYER_FACE_DESCRIPTOR_MINIMUM = 5/);
  assert.match(playerRecognition, /ENROLLMENT_SAMPLE_COUNT = PLAYER_FACE_DESCRIPTOR_MINIMUM/);
  assert.match(playerRecognition, /minSize: 32/);
  assert.match(playerRecognition, /rotation: true/);
  assert.match(playerRecognition, /cropTrackedPersonHead/);
  assert.match(playerRecognition, /FACE_CROP_SIZE = 320/);
  assert.match(playerRecognition, /MAX_DESCRIPTOR_GALLERY_SIZE = 10/);
  assert.match(playerRecognition, /LOST_TRACK_RELEASE_MS = 10_000/);
  assert.match(playerRecognition, /releaseTimersRef/);
  assert.match(playerRecognition, /matchDescriptorToPlayer/);
  assert.match(playerRecognition, /human\.detect\(videoElement\)/);
  assert.match(playerRecognition, /trackForFace/);
  assert.match(playerRecognition, /for \(const face of fullFrameResult\.face\)/);
  assert.match(playerRecognition, /playersToIdentify\.has\(match\.playerIndex\)/);
  assert.match(playerRecognition, /bindTrack\(candidate\.playerIndex, candidate\.trackId\)/);
  assert.match(playerRecognition, /faceThumbnail\(videoElement, selectedFace\)/);
  assert.doesNotMatch(playerRecognition, /usableFaces\.length === 1/);
  assert.doesNotMatch(playerRecognition, /unmatchedTracks\.length === 1/);
  assert.doesNotMatch(playerRecognition, /handoffTrackAssignments|pendingFaceMatchesRef/);
  assert.doesNotMatch(playerRecognition, /localStorage|indexedDB/);
  assert.match(setup, /Saved profile · linked to track/);
  assert.match(setup, /hasSavedFaceMemory/);
  assert.match(setup, /Saved profile · not currently linked/);
  assert.match(setup, /Capturing.*face samples/);
  assert.match(setup, /Matching saved faces/);
  assert.match(setup, /Identifying track/);
  assert.match(setup, /Re-identifying/);
  assert.match(setup, /Face seen—look straight at camera/);
  assert.match(setup, /Face matched—waiting for body track/);
  assert.match(playerTracking, /maxAge: 10_000/);
  assert.match(packageJson, /@tensorflow-models\/pose-detection/);
  assert.match(packageJson, /@vladmandic\/human/);
  assert.match(brief, /automatically re-identify and rebind players after track loss/);
  assert.match(brief, /MoveNet MultiPose tracker/);
  assert.match(readme, /face-based re-identification after track loss/);
  assert.match(readme, /Clothing is deliberately not used as identity/);
  assert.doesNotMatch(setup, /Face capture arrives in a later milestone/);

  await Promise.all([
    access(new URL("public/models/human/blazeface.json", projectRoot)),
    access(new URL("public/models/human/facemesh.json", projectRoot)),
    access(new URL("public/models/human/faceres.json", projectRoot)),
  ]);
});
