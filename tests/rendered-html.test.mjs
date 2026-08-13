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

test("includes consent-gated face and required clothing enrollment in milestone 1", async () => {
  const [setup, camera, playerTracking, visualProfile, brief, readme, packageJson] = await Promise.all([
    readFile(new URL("app/components/SetupApp.tsx", projectRoot), "utf8"),
    readFile(new URL("app/hooks/useCamera.ts", projectRoot), "utf8"),
    readFile(new URL("app/hooks/usePlayerTracking.ts", projectRoot), "utf8"),
    readFile(new URL("app/lib/visualProfile.ts", projectRoot), "utf8"),
    readFile(new URL("automatic_snooker_scoring_web_app.md", projectRoot), "utf8"),
    readFile(new URL("README.md", projectRoot), "utf8"),
    readFile(new URL("package.json", projectRoot), "utf8"),
  ]);

  assert.match(setup, /"Privacy", "Players", "Profiles", "Camera", "Match"/);
  assert.match(setup, /Boolean\(player\.clothingProfile\)/);
  assert.match(setup, /!player\.faceConsent \|\| Boolean\(player\.faceProfile\)/);
  assert.match(setup, /Remove face data/);
  assert.match(setup, /Raw capture frames are discarded immediately/);
  assert.match(camera, /captureVisualProfile/);
  assert.match(visualProfile, /context\.drawImage\(/);
  assert.match(visualProfile, /kind === "clothing" \? sampleSwatches/);
  assert.match(playerTracking, /MULTIPOSE_LIGHTNING/);
  assert.match(playerTracking, /enableTracking: true/);
  assert.match(playerTracking, /maxTracks: 2/);
  assert.match(playerTracking, /maxPoses: 2/);
  assert.match(setup, /playerTracksAreLinked/);
  assert.match(setup, /Live track.*linked/);
  assert.match(packageJson, /@tensorflow-models\/pose-detection/);
  assert.match(brief, /guided face enrollment for players who opt in/);
  assert.match(brief, /MoveNet MultiPose tracker/);
  assert.match(readme, /guided face\/clothing enrollment/);
  assert.doesNotMatch(setup, /Face capture arrives in a later milestone/);
});
