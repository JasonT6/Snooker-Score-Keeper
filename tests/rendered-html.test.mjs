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
