#!/usr/bin/env node
/**
 * Headless capture for the demo video.
 *
 * Nothing on the desktop can reach a frame: Chrome renders offscreen, so other
 * windows, wallet extensions, notification banners and the clock are not in the
 * picture at all. The pointer is drawn *into the page* by this script and the
 * clicks are dispatched through the DevTools protocol, which makes the take
 * scripted instead of mimed: the same beats produce the same video every time,
 * and a click lands on the button the caption says it lands on.
 *
 *   node scripts/shoot.mjs check                  dry run, spends nothing
 *   node scripts/shoot.mjs take --yes-spend       the real take (forty completions)
 *   node scripts/shoot.mjs frames film/x.mp4 dir  one frame every two seconds
 *
 * Output: film/NN-name.mkv — 30 fps, 1280x720, near-lossless intermediate — and
 * film/list.txt for ./scripts/edit.sh. Captions and the step chip are part of the
 * page while recording, so no text is burned in afterwards and none is lost:
 * a sampled frame still says what it is and what the numbers mean.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FILM = join(ROOT, "film");
const SCRATCH = join(FILM, ".scratch");
const APP = process.env.APP_URL ?? "http://localhost:5173";
const API = process.env.API_URL ?? "http://127.0.0.1:8787";
const CHROME = process.env.CHROME ?? "google-chrome-stable";
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
/**
 * Which policies this take bought. Written as soon as they exist, because the
 * expensive part of a take (the two arms) is already spent by then: if the run
 * dies during the closing shots, the tail can be re-recorded against the same
 * policy instead of buying two more and waiting out another poisoned arm.
 */
const TAKE_STATE = join(FILM, "take-state.json");

/** The video is exactly 720p; 1.25 renders 1024x576 CSS pixels into it. */
const W = 1280;
const H = 720;
const FPS = 30;
const TIMELAPSE_SECONDS = Number(process.env.SHOOT_TIMELAPSE ?? 6);
const SCALE = Number(process.env.SHOOT_SCALE ?? 1.25);
const CSS_W = Math.round(W / SCALE);
const CSS_H = Math.round(H / SCALE);

const log = (message) => process.stdout.write(`shoot: ${message}\n`);

// ── a very small DevTools client ────────────────────────────────────────────

class Cdp {
  #socket;
  #next = 1;
  #pending = new Map();
  #handlers = new Map();

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot reach ${url}`)), { once: true });
    });
    const cdp = new Cdp();
    cdp.#socket = socket;
    socket.addEventListener("message", (event) => cdp.#receive(JSON.parse(event.data)));
    return cdp;
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    this.#socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 180_000);
    });
  }

  on(method, handler) {
    this.#handlers.set(method, handler);
  }

  close() {
    this.#socket.close();
  }

  #receive(message) {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message}${message.error.data ? ` (${message.error.data})` : ""}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.#handlers.get(message.method)?.(message.params, message.sessionId);
  }
}

// ── the page overlay: pointer, step chip, caption ───────────────────────────
//
// Installed on every new document, before the app's own scripts run. It lives on
// <html>, outside #root, so a React re-render cannot remove it. The pointer is
// real SVG in the page, which is why it survives H.264 at 720p: it is drawn at
// 1.25x device pixels like the text, not recorded as a bitmap overlay.

const OVERLAY = String.raw`
(() => {
  const CSS = [
    "#__shoot_ui{position:fixed;inset:0;pointer-events:none;z-index:2147483647}",
    "#__shoot_ui .arrow{position:absolute;left:0;top:0;width:20px;height:28px;transform:translate(24px,24px);transform-origin:2px 1px;transition:transform .3s cubic-bezier(.22,.75,.24,1);filter:drop-shadow(0 1px 3px rgba(0,0,0,.7))}",
    "#__shoot_ui .ring{position:absolute;left:0;top:0;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:999px;border:3px solid rgba(110,231,183,.95);opacity:0}",
    // The caption is a band, never a plate. It is pinned to the bottom edge,
    // full width, on the app's own background and hairline, with the text
    // starting on the app's left margin — so it reads as the bottom chrome of
    // the window rather than a box dropped onto the screenshot. Nothing in the
    // recorded UI is ever overdrawn, and the same band position is used for
    // every shot, which is what makes a cut feel deliberate.
    "#__shoot_bar{position:fixed;left:0;right:0;bottom:0;display:none;padding:0 25px;background:#0b0d10;border-top:1px solid #22272e;font-family:ui-sans-serif,-apple-system,'Segoe UI',sans-serif}",
    // A hard edge through a panel border reads as a mistake, so the last rows
    // dissolve into the band instead of being sliced by it.
    "#__shoot_bar::before{content:'';position:absolute;left:0;right:0;top:-30px;height:30px;background:linear-gradient(to bottom,rgba(11,13,16,0),#0b0d10);pointer-events:none}",
    "#__shoot_bar .plate{height:94px;display:flex;flex-direction:column;justify-content:center}",
    "#__shoot_bar .chip{font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#6ee7b7;margin-bottom:9px}",
    "#__shoot_bar .text{color:#eef1f5;font-size:21px;line-height:1.32;max-width:570px}",
    // The band owns the bottom of the frame, so the page is given the same
    // amount of extra scroll room at its end: anything the band would cover can
    // still be scrolled up into the open area instead of being lost.
    "main{padding-bottom:118px !important}"
  ].join("");

  const install = () => {
    if (document.getElementById("__shoot_ui")) return;

    const style = document.createElement("style");
    style.textContent = CSS;
    document.documentElement.appendChild(style);

    const ui = document.createElement("div");
    ui.id = "__shoot_ui";
    ui.innerHTML =
      '<svg class="arrow" viewBox="0 0 20 28" aria-hidden="true">' +
      '<path d="M1 1 L1 21.6 L6.4 16.5 L9.9 24.7 L13.5 23.2 L10 15 L17.1 15 Z" ' +
      'fill="#ffffff" stroke="#111318" stroke-width="1.4" stroke-linejoin="round"/></svg>' +
      '<div class="ring"></div>';
    document.documentElement.appendChild(ui);

    // Card pages get the overlay too, because it is installed on every new
    // document. A pointer belongs on the app, not parked in the corner of a
    // title card, so hide it wherever the page is a local file.
    if (location.protocol === "file:") ui.style.display = "none";

    const bar = document.createElement("div");
    bar.id = "__shoot_bar";
    bar.innerHTML = '<div class="plate"><div class="chip"></div><div class="text"></div></div>';
    document.documentElement.appendChild(bar);

    const arrow = ui.querySelector(".arrow");
    const ring = ui.querySelector(".ring");
    let x = 24;
    let y = 24;
    const place = (scale) => {
      arrow.style.transform = "translate(" + x + "px," + y + "px) scale(" + scale + ")";
    };

    window.__shootPointer = {
      // Two things that point at once read as a glitch. The caption is up for
      // most of the video, so the cursor is only drawn while it is clicking.
      hide() { ui.style.opacity = "0"; },
      show() { ui.style.opacity = "1"; },
      move(nx, ny) { x = nx; y = ny; place(1); },
      press() { place(0.86); },
      release() { place(1); },
      click() {
        ring.style.left = x + "px";
        ring.style.top = y + "px";
        ring.style.transition = "none";
        ring.style.transform = "scale(.45)";
        ring.style.opacity = "1";
        void ring.offsetWidth;
        ring.style.transition = "transform .44s ease-out, opacity .44s ease-out";
        ring.style.transform = "scale(1.7)";
        ring.style.opacity = "0";
      },
    };

    // One placement for every shot. The band is opaque chrome that the app is
    // scrolled behind, so the caption never sits on a row of data and the reader
    // never has to re-find it between cuts.
    window.__shootCaption = (chip, text) => {
      const textEl = bar.querySelector(".text");
      bar.querySelector(".chip").textContent = chip || "";
      textEl.textContent = text || "";
      bar.style.display = chip || text ? "flex" : "none";
      // The band is a fixed height even when the copy is one line, so a cut
      // between a one-line and a two-line caption does not move the frame edge.
      ui.style.opacity = "0";
      // Line boxes, not height: a third line would spill out of the band, and
      // that is worth knowing before the segment is recorded rather than after.
      const range = document.createRange();
      range.selectNodeContents(textEl);
      return range.getClientRects().length;
    };
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
`;

// ── process plumbing ────────────────────────────────────────────────────────

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`))));
  });
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

const hold = (ms) => sleep(ms);

// ── the session ─────────────────────────────────────────────────────────────

const session = {
  cdp: null,
  chrome: null,
  page: null,
  frames: [],
  segments: [],
  recorder: null,
};

async function launch() {
  mkdirSync(FILM, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });
  const profile = join(SCRATCH, "chrome");
  rmSync(profile, { recursive: true, force: true });

  session.chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${W},${H}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-features=Translate,MediaRouter",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--disable-lcd-text",
      "--font-render-hinting=none",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let stderr = "";
  session.chrome.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(portFile); i += 1) await sleep(100);
  if (!existsSync(portFile)) {
    throw new Error(`chrome never opened its debugging port\n${stderr.slice(-800)}`);
  }
  const [port] = readFileSync(portFile, "utf8").split("\n");
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();

  session.cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const { targetId } = await session.cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await session.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  session.page = sessionId;

  await session.cdp.send("Page.enable", {}, session.page);
  await session.cdp.send("Runtime.enable", {}, session.page);
  await session.cdp.send("Emulation.setDeviceMetricsOverride", {
    width: CSS_W,
    height: CSS_H,
    deviceScaleFactor: SCALE,
    mobile: false,
  }, session.page);
  await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: OVERLAY }, session.page);

  session.cdp.on("Page.screencastFrame", (frame, pageSession) => {
    // Acknowledge first: Chrome sends no further frames until this one is acked.
    void session.cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }, pageSession).catch(() => {});
    const recorder = session.recorder;
    if (!recorder || !recorder.open) return;
    const file = join(recorder.dir, `f-${String(recorder.frames.length).padStart(5, "0")}.png`);
    writeFileSync(file, Buffer.from(frame.data, "base64"));
    recorder.frames.push({ file, t: frame.metadata.timestamp });
  });

  await session.cdp.send("Page.startScreencast", {
    format: "png",
    maxWidth: W,
    maxHeight: H,
    everyNthFrame: 1,
  }, session.page);

  const probe = await session.cdp.send("Page.captureScreenshot", { format: "png" }, session.page);
  const png = Buffer.from(probe.data, "base64");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  writeFileSync(join(FILM, "probe.png"), png);
  log(`viewport ${CSS_W}x${CSS_H} css at ${SCALE}x -> ${width}x${height} device px`);
  if (width !== W || height !== H) {
    log(`WARNING: the capture surface is ${width}x${height}, not ${W}x${H}; the encoder will scale it`);
  }
}

async function shutdown({ keepScratch = false } = {}) {
  try {
    session.cdp?.close();
  } catch {
    /* already gone */
  }
  session.chrome?.kill("SIGTERM");
  if (!keepScratch) rmSync(SCRATCH, { recursive: true, force: true });
}

// ── page helpers ────────────────────────────────────────────────────────────

async function evaluate(expression) {
  const { result, exceptionDetails } = await session.cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    session.page,
  );
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  return result.value;
}

async function waitFor(expression, { timeout = 60_000, label = expression, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await evaluate(expression)) return;
    } catch {
      /* a navigation is in flight; the next poll will see the new document */
    }
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${label}`);
    await sleep(interval);
  }
}

/**
 * Wait for a job whose duration we do not control.
 *
 * A fixed deadline has to guess the job's length, and the two arms are not the
 * same length: control settles in about four minutes, the poisoned context in
 * about thirty-six, because the rounding instruction makes the model think for
 * roughly ten times as long (measured: 248 vs 1779 reasoning tokens). A cap
 * that fits one cuts the other off mid-take.
 *
 * So the deadline is on progress, not on the clock: every newly settled cell
 * buys another `stallMs`, and `capMs` stays as a backstop for a run that is
 * alive but never going to finish. `capMs` is set below the policy window
 * because receipts posted after it are rejected by the contract anyway.
 */
async function waitForProgress(
  expression,
  progressExpression,
  { stallMs = 10 * 60_000, capMs = 55 * 60_000, interval = 1000, label = expression } = {},
) {
  const started = Date.now();
  let lastProgress = -1;
  let lastChange = started;
  for (;;) {
    try {
      if (await evaluate(expression)) return;
      const progress = Number(await evaluate(progressExpression)) || 0;
      if (progress !== lastProgress) {
        lastProgress = progress;
        lastChange = Date.now();
      }
    } catch {
      /* a navigation is in flight; the next poll will see the new document */
    }
    const now = Date.now();
    if (now - lastChange > stallMs) {
      throw new Error(
        `gave up waiting for ${label}: no progress for ${Math.round((now - lastChange) / 1000)}s`,
      );
    }
    if (now - started > capMs) {
      throw new Error(`gave up waiting for ${label} after ${Math.round((now - started) / 1000)}s`);
    }
    await sleep(interval);
  }
}

/** Navigate and wait for the app's own markup plus the overlay. */
async function openApp(path) {
  await session.cdp.send("Page.navigate", { url: `${APP}${path}` }, session.page);
  await waitFor('document.readyState === "complete" && !!document.querySelector("main")', {
    label: `the app at ${path}`,
    timeout: 30_000,
  });
  await waitFor("!!window.__shootPointer", { label: "the pointer overlay", timeout: 10_000 });
  // Park it off-screen: drawn at its home position it covers the wordmark until
  // the first click, which reads as a glitch rather than a cursor.
  await evaluate("window.__shootPointer.move(-80, -80)");
  await hold(500); // one poll of the contract view, so the panels are populated
}

async function showCard(file) {
  await session.cdp.send("Page.navigate", { url: pathToFileURL(file).href }, session.page);
  await waitFor("document.readyState === 'complete' && !!window.__shootCaption", { timeout: 15_000 });
  await hold(250);
}

async function caption(chip, text) {
  const lines = await evaluate(
    `window.__shootCaption(${JSON.stringify(chip)}, ${JSON.stringify(text)})`,
  );
  // Two lines is the band's capacity, and two lines is also the ceiling every
  // captioning style guide sets. Longer copy is a script problem, not a layout
  // problem, so it is reported here while it is still cheap to rewrite.
  if (lines > 2) log(`caption is ${lines} lines and will spill: ${text}`);
}

/** Move the drawn pointer onto a selector and click it for real. */
async function clickOn(expression, label) {
  const spot = await evaluate(`(() => {
    const element = ${expression};
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  if (!spot) throw new Error(`cannot click ${label}: it is not on the page`);

  await evaluate("window.__shootPointer.show()");
  await evaluate(`window.__shootPointer.move(${spot.x}, ${spot.y})`);
  await session.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: spot.x, y: spot.y, buttons: 0 },
    session.page,
  );
  await hold(420); // the pointer transition, and the button's hover state
  await evaluate("window.__shootPointer.press()");
  await session.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: spot.x, y: spot.y, button: "left", buttons: 1, clickCount: 1 },
    session.page,
  );
  await hold(90);
  await evaluate("window.__shootPointer.click(); window.__shootPointer.release();");
  await session.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: spot.x, y: spot.y, button: "left", buttons: 0, clickCount: 1 },
    session.page,
  );
  await hold(250);
  log(`clicked ${label}`);
}

const clickButton = (text) =>
  clickOn(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`, `"${text}"`);

/**
 * Scroll a panel to the top of the frame, or just below it.
 *
 * `clear` is the gap in CSS pixels between the top edge of the frame and the
 * top of the panel — the app's own 24px page margin by default. Nothing needs to
 * clear the caption: the band sits at the bottom, where the app scrolls behind
 * it, so a scrolled shot is never pushed down to make room for text.
 */
async function scrollTo(panelTitle, { clear = 24, prefix = false } = {}) {
  const top = await evaluate(`(() => {
    const wanted = ${JSON.stringify(panelTitle)};
    const panel = [...document.querySelectorAll(".panel")].find((p) => {
      const title = p.querySelector("h2")?.textContent.trim() ?? "";
      return ${prefix ? "title.startsWith(wanted)" : "title === wanted"};
    });
    if (!panel) return null;
    return Math.max(0, Math.round(window.scrollY + panel.getBoundingClientRect().top - ${clear}));
  })()`);
  if (top === null) throw new Error(`no panel titled "${panelTitle}"`);
  await evaluate(`window.scrollTo({ top: ${top}, behavior: "smooth" })`);
  await hold(1100);
}

const scrollTop = async () => {
  await evaluate('window.scrollTo({ top: 0, behavior: "smooth" })');
  await hold(900);
};

// ── recording ───────────────────────────────────────────────────────────────

/**
 * Screencast frames are paint-driven, not clock-driven: a still page sends one
 * frame and then silence. Two imperceptible opacity steps force a composite
 * while the segment is open, so a shot with no motion still has a frame to hold
 * for its whole duration — and the paint that shows the content is inside the
 * segment instead of being dropped before it opened.
 */
async function nudge() {
  await evaluate('document.documentElement.style.opacity = "0.999"');
  await sleep(160);
  await evaluate('document.documentElement.style.opacity = ""');
  await sleep(160);
}

async function startSegment(name, { timelapse = false } = {}) {
  const dir = join(SCRATCH, `seg-${name}`);
  mkdirSync(dir, { recursive: true });
  session.recorder = { name, dir, frames: [], open: true, startedAt: Date.now() / 1000, timelapse };
  log(`recording ${name}`);
  await nudge();
}

async function stopSegment() {
  const recorder = session.recorder;
  if (!recorder) throw new Error("no segment is recording");
  recorder.open = false;
  recorder.stoppedAt = Date.now() / 1000;
  await hold(150); // let the last frame arrive and be acked
  session.recorder = null;

  if (recorder.frames.length === 0) throw new Error(`segment ${recorder.name} captured no frames`);

  const lines = [];
  // A time-lapse ignores the real gaps between paints and gives every frame the
  // same slice, aimed at TIMELAPSE_SECONDS in total. The floor of one output
  // frame matters: a shorter slice than 1/30 s would be dropped by the encoder
  // and the shot would come out shorter than the frames justify.
  const slice = recorder.timelapse
    ? Math.min(0.5, Math.max(1 / FPS, TIMELAPSE_SECONDS / recorder.frames.length))
    : null;
  for (let i = 0; i < recorder.frames.length; i += 1) {
    const frame = recorder.frames[i];
    const next = recorder.frames[i + 1];
    const until = next ? next.t : recorder.stoppedAt;
    const duration = slice ?? Math.max(1 / 120, until - frame.t);
    lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(4)}`);
  }
  lines.push(`file '${recorder.frames[recorder.frames.length - 1].file}'`);
  const listPath = join(recorder.dir, "list.txt");
  writeFileSync(listPath, `${lines.join("\n")}\n`);

  const file = join(FILM, `${recorder.name}.mkv`);
  await ffmpeg([
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-fps_mode", "cfr", "-r", String(FPS),
    "-vf", `scale=${W}:${H}:flags=lanczos`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p",
    "-an", file,
  ]);
  rmSync(recorder.dir, { recursive: true, force: true });

  const seconds = recorder.timelapse
    ? (recorder.frames.length * slice).toFixed(1)
    : (recorder.stoppedAt - recorder.frames[0].t).toFixed(1);
  session.segments.push({ name: recorder.name, file, seconds: Number(seconds) });
  log(
    `${recorder.name}.mkv  ${seconds}s  ${recorder.frames.length} frames` +
      (recorder.timelapse ? ` (time-lapse of ${(recorder.stoppedAt - recorder.frames[0].t).toFixed(0)}s)` : ""),
  );
  writeManifest();
}

function writeManifest() {
  const list = session.segments.map((segment) => `file '${segment.file}'`).join("\n");
  writeFileSync(join(FILM, "list.txt"), `${list}\n`);
  writeFileSync(join(FILM, "manifest.json"), `${JSON.stringify(session.segments, null, 2)}\n`);
}

async function capture(name, milliseconds) {
  await startSegment(name);
  await hold(milliseconds);
  await stopSegment();
}

// ── cards ───────────────────────────────────────────────────────────────────

function card({ kicker, title, lines, footer }) {
  const html = `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    background: #0b0d10;
    color: #e6e9ef;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
    display: grid;
    place-items: center;
  }
  .wrap { width: 980px; }
  .kicker {
    font: 600 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #6ee7b7;
    margin-bottom: 26px;
  }
  h1 { font-size: 48px; line-height: 1.12; letter-spacing: -0.02em; margin: 0 0 26px; }
  p { font-size: 21px; line-height: 1.45; color: #9aa3b2; margin: 0 0 12px; max-width: 900px; }
  .rule { height: 1px; background: #22272e; margin: 30px 0 18px; }
  .footer {
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #6b7482;
  }
</style>
<div class="wrap">
  <div class="kicker">${kicker}</div>
  <h1>${title}</h1>
  ${lines.map((line) => `<p>${line}</p>`).join("\n  ")}
  <div class="rule"></div>
  <div class="footer">${footer}</div>
</div>`;
  const file = join(SCRATCH, `card-${Math.random().toString(36).slice(2, 8)}.html`);
  writeFileSync(file, html);
  return file;
}

// ── contract and API reads ──────────────────────────────────────────────────

async function api(path) {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

async function requireServers() {
  let health;
  try {
    health = await api("/api/health");
  } catch {
    throw new Error(`the API is not answering at ${API} — start ./scripts/go.sh first`);
  }
  try {
    if (!(await fetch(`${APP}/`)).ok) throw new Error("not ok");
  } catch {
    throw new Error(`the UI is not answering at ${APP} — start ./scripts/go.sh first`);
  }
  return health;
}

const YOCTO = 10n ** 24n;

const nearToYocto = (text) => {
  const [whole, fraction = ""] = String(text).trim().split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) throw new Error(`not a NEAR amount: ${text}`);
  return BigInt(whole) * YOCTO + BigInt(`${fraction}0`.padEnd(25, "0").slice(0, 24));
};

const LP_ACCOUNT = process.env.LP_ACCOUNT ?? "correlation-lp.testnet";

/** Read-only: the LP's spendable balance, the only capital a demo can deposit. */
async function lpBalance() {
  const rpc = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "balance",
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: LP_ACCOUNT },
    }),
  });
  const body = await response.json();
  if (!body.result) throw new Error(`${LP_ACCOUNT} balance unavailable: ${JSON.stringify(body.error ?? body)}`);
  return BigInt(body.result.amount);
}

const near = (yocto, places = 4) => {
  const value = BigInt(yocto);
  const whole = value / 10n ** 24n;
  const fraction = (value % 10n ** 24n).toString().padStart(24, "0").slice(0, places);
  return `${whole}.${fraction}`;
};

/** Exact decimal, for --limit: a rounded one would not equal the first policy. */
const nearExact = (yocto) => {
  const value = BigInt(yocto);
  return `${value / 10n ** 24n}.${(value % 10n ** 24n).toString().padStart(24, "0")}`;
};

async function policyView(policyId) {
  const view = await api(`/api/policy/${policyId}`);
  if (!view.policy) throw new Error(`policy ${policyId} has no view`);
  return view;
}

async function seed(args) {
  log(`seed ${args.join(" ")}`);
  await run("npm", ["run", "seed", "--workspace", "@correlation/api", "--silent", "--", ...args]);
}

/** The API caches the newest policy for 15s, so wait for the id to move. */
async function newestPolicyAbove(previous) {
  for (let i = 0; i < 60; i += 1) {
    const health = await api("/api/health");
    if (health.policyId && health.policyId > previous) return health.policyId;
    await sleep(1000);
  }
  throw new Error("the contract never showed a new policy");
}

const waitWindow = (policyId) => run(join(ROOT, "scripts/wait-window.sh"), [String(policyId)]);

/** Reads the claim transaction the page just wrote, for the closing card. */
const claimTxFromPage = () =>
  evaluate(`[...document.querySelectorAll(".row")].find((r) => r.textContent.trim().startsWith("claim tx"))
    ?.querySelector("strong")?.textContent ?? ""`);

// ── the dry run ─────────────────────────────────────────────────────────────

async function check() {
  const health = await requireServers();
  const policyId = health.policyId;
  if (!policyId) {
    throw new Error("the API reports no policy; run: npm run seed --workspace @correlation/api -- --new");
  }
  const { policy } = await policyView(policyId);
  const limit = near(policy.limit);
  log(`dry run against p-${policyId} (limit ${limit} NEAR) — no receipts, no payout`);

  await showCard(card({
    kicker: "NEAR HACKATHON 2026 · TESTNET · DRY RUN",
    title: "Twenty AI agents fail together. This contract pays for it.",
    lines: [
      "One model, one shared context, so an error repeats across the whole fleet.",
      "Correlation prices that, verifies every answer on chain, and pays out by itself.",
    ],
    footer: "step 1 / 5 · intro card · no model calls in this take",
  }));
  await capture("01-intro", 6000);

  await openApp(`/?policy=${policyId}`);
  await caption(
    "STEP 2 / 5 · THE POLICY",
    `An LP funded the pool. A buyer paid 0.10 NEAR for cover of up to ${limit} NEAR, for one hour.`,
  );
  await capture("02-policy", 7000);

  // The click path, on a target that cannot spend: this is the part that proves
  // the drawn pointer lands where the caption says it does.
  await caption(
    "STEP 3 / 5 · THE POINTER IS DRAWN BY THE CAPTURE SCRIPT",
    "No desktop is recorded: this window is rendered offscreen, so only this page can appear in a frame.",
  );
  await startSegment("03-pointer");
  await hold(1200);
  await clickOn('document.querySelector(".badge")', "the testnet badge");
  await hold(1800);
  await scrollTo("Receipts");
  await hold(2500);
  await stopSegment();

  // Parked on the same panel the run shots use, so the dry run proves the grid
  // clears the caption band before a take pays for twenty completions.
  await caption(
    "STEP 4 / 5 · LEGIBILITY CHECK",
    "Read this line at 720p: failed 0 of 20 started, index 0 bps, trigger 2500 bps, limit " + limit + " NEAR.",
  );
  await scrollTo("Swarm", { prefix: true });
  await capture("04-legibility", 6000);

  await showCard(card({
    kicker: "DRY RUN COMPLETE",
    title: "No receipts, no payout.",
    lines: [
      "This take exists to check framing, the drawn pointer, caption legibility and scroll positions.",
      "The paid take runs both arms on their own policy and ends on a real claim.",
    ],
    footer: "step 5 / 5 · dry run · nothing was spent",
  }));
  await capture("05-outro", 6000);

  log(`dry run done: ${session.segments.length} segments, ${totalSeconds().toFixed(1)}s`);
  log("next: ./scripts/edit.sh, then review film/correlation-demo.mp4");
}

// ── the real take ───────────────────────────────────────────────────────────

async function take() {
  if (!process.argv.includes("--yes-spend")) {
    throw new Error("the take runs forty completions: pass --yes-spend when you mean it");
  }
  const health = await requireServers();
  // The cover the README and the submission quote. It is set explicitly rather
  // than computed from free capital: the default is 90% of whatever is free, and
  // a stale policy still holding its commitment once bought 0.8 NEAR of cover
  // while every caption claimed the full number.
  const limit = process.env.LIMIT ?? "7.8284";
  const limitYocto = nearToYocto(limit);
  const fundTo = (Number(limit) + 0.8).toFixed(4);
  log(`model ${health.model} · contract ${health.contract} · limit ${limit} NEAR`);

  // Two policies have to be bought before either arm can post, and a policy's
  // limit comes from free capital. Check the money first: discovering a shortfall
  // at policy B would already have cost the control arm's twenty completions.
  const required = limitYocto * 2n + 8n * YOCTO / 10n;
  const poolNow = health.policyId ? (await policyView(health.policyId)).pool : { total: "0" };
  const spendable = BigInt(poolNow.total) + (await lpBalance()) - 15n * YOCTO / 100n;
  if (spendable < required) {
    throw new Error(
      `the pool and ${LP_ACCOUNT} hold ${near(spendable)} together; two policies of ${limit} NEAR need ${near(required)}. ` +
        `Transfer ${near(required - spendable)} NEAR to ${LP_ACCOUNT} first — nothing has been spent.`,
    );
  }

  // Policy A. Waiting for the window is not optional: the contract rejects
  // receipts posted before it opens (E03) and the page gives no hint.
  const before = health.policyId ?? 0;
  await seed(["--new", "--limit", limit, "--topup-to", fundTo]);
  const a = await newestPolicyAbove(before);
  await waitWindow(a);
  const viewA = await policyView(a);
  const limitA = near(viewA.policy.limit);
  log(`policy A = p-${a}, limit ${limitA} NEAR`);

  await showCard(card({
    kicker: "NEAR HACKATHON 2026 · TESTNET",
    title: "Twenty AI agents fail together. This contract pays for it.",
    lines: [
      "One model, one shared context, so an error repeats across the whole fleet.",
      "Correlation prices that, verifies every answer on chain, and pays out by itself.",
    ],
    footer: "step 1 / 10 · intro card",
  }));
  await capture("01-intro", 6500);

  await openApp(`/?policy=${a}`);
  await caption(
    "STEP 2 / 10 · THE POLICY",
    `An LP funded the pool. A buyer paid 0.10 NEAR for cover of up to ${limitA} NEAR, for one hour.`,
  );
  await capture("02-policy", 7500);

  await caption(
    "STEP 3 / 10 · CONTROL ARM · 20 AGENTS",
    "Twenty agents get the ordinary prompt. Each answer is signed inside the enclave and posted to the contract.",
  );
  await startSegment("03-control-click");
  await hold(1200);
  await clickButton("Run control");
  await hold(9000);
  await stopSegment();

  // Keep the camera running while the arm works and re-time the frames on the
  // way out. Screencast only emits a frame when something changes, so ninety
  // seconds of twenty agents costs a few dozen frames and becomes a few seconds
  // of visible filling instead of a jump cut that looks like nothing happened.
  await caption(
    "STEP 3 / 10 · CONTROL ARM · 20 AGENTS",
    "Answers land two at a time, each one posted to the contract. Sped up from about four minutes.",
  );
  // The grid is the shot. The band owns the bottom of the frame, so the page is
  // scrolled to it: its last row lands just above the band instead of behind it.
  await scrollTo("Swarm", { prefix: true });
  await startSegment("03b-control-run", { timelapse: true });
  log("recording the control arm (time-lapse)");
  await waitForProgress(
    `document.querySelector(".run-status")?.textContent.includes("control")
      && document.querySelector(".run-status")?.textContent.includes("complete")
      && document.querySelectorAll(".cell.pending").length === 0`,
    'document.querySelectorAll(".cell:not(.pending)").length',
    { label: "the control arm to finish", capMs: 25 * 60_000 },
  );
  await hold(1500); // let the last cells paint before closing the segment
  await stopSegment();

  // Captioned from the run, not from what the run was expected to do: a twenty
  // agent fleet does occasionally drop one, and the band must not say zero while
  // the gauge beside it says 500 bps.
  const control = await policyView(a);
  const controlBps = control.policy.started
    ? Math.round((control.policy.failed / control.policy.started) * 10_000)
    : 0;
  await caption(
    `STEP 4 / 10 · CONTROL ARM · ${control.policy.failed} FAILED OF ${control.policy.started}`,
    control.policy.failed === 0
      ? `Every answer was correct: index 0 bps, under the ${control.policy.trigger_bps} bps trigger. The policy stays open and pays nothing.`
      : `${control.policy.started - control.policy.failed} of ${control.policy.started} correct: index ${controlBps} bps, under the ${control.policy.trigger_bps} bps trigger, so it pays nothing.`,
  );
  // Held on the index, then a slow move down to the grid: one caption, two
  // pieces of evidence, and no cut in the middle of the argument.
  await startSegment("04-control-result");
  await hold(3200);
  await scrollTo("Swarm", { prefix: true });
  await hold(3600);
  await stopSegment();

  // Policy B. One receipt per agent per policy is a contract rule, so the second
  // arm cannot reuse A; the same limit keeps B's payout the same number on
  // screen, and free capital has to be raised again for it to fit.
  const limitB = nearExact(viewA.policy.limit);
  await seed(["--new", "--limit", limitB, "--topup-to", (Number(limitB) + 0.8).toFixed(4)]);
  const b = await newestPolicyAbove(a);
  await waitWindow(b);
  const viewB = await policyView(b);
  log(`policy B = p-${b}, limit ${near(viewB.policy.limit)} NEAR`);
  // Checkpoint: from here on the expensive work is done and on chain, so the
  // closing shots can be re-recorded with `shoot.mjs tail` if the run dies.
  writeFileSync(
    TAKE_STATE,
    `${JSON.stringify({ createdAt: new Date().toISOString(), policyA: a, policyB: b }, null, 2)}\n`,
  );

  await openApp(`/?policy=${b}`);
  await caption(
    "STEP 5 / 10 · SECOND POLICY",
    "A second policy for the second arm: the contract takes one receipt per agent per policy.",
  );
  await capture("05-policy-b", 7000);

  await caption(
    "STEP 6 / 10 · POISONED ARM · 20 AGENTS",
    "Same task, same model, one added sentence of shared context: round the number instead of computing it.",
  );
  await startSegment("06-poisoned-click");
  await hold(1200);
  await clickButton("Run poisoned");
  await hold(9000);
  await stopSegment();

  await caption(
    "STEP 6 / 10 · POISONED ARM · 20 AGENTS",
    "The same fleet on the poisoned context, answers landing two at a time. Sped up from about half an hour.",
  );
  await scrollTo("Swarm", { prefix: true });
  await startSegment("06b-poisoned-run", { timelapse: true });
  log("recording the poisoned arm (time-lapse)");
  await waitForProgress(
    '!!document.querySelector("button.pay")',
    'document.querySelectorAll(".cell:not(.pending)").length',
    { label: "the policy to trigger" },
  );
  await hold(1500);
  await stopSegment();

  await recordTail(b);

  log(`take done: ${session.segments.length} segments, ${totalSeconds().toFixed(1)}s`);
  log("next: ./scripts/edit.sh, then watch it once and check frames for anything private");
}

/**
 * Steps 7-10: the gauge, the receipts, the claim, the card. Everything here
 * needs only the policy id, which is why this is the part worth resuming: the
 * two arms are the half-hour, and they are already on chain when it runs.
 */
async function recordTail(b) {
  const triggered = await policyView(b);
  if (triggered.policy.status !== "Triggered" && triggered.policy.status !== "Paid") {
    throw new Error(`p-${b} is ${triggered.policy.status}: nothing has triggered, so there is no tail`);
  }
  const bps = triggered.policy.started
    ? Math.round((triggered.policy.failed / triggered.policy.started) * 10_000)
    : 0;
  log(`p-${b}: ${triggered.policy.failed} failed of ${triggered.policy.started}, ${bps} bps, ${triggered.policy.status}`);
  if (triggered.policy.failed === 0) throw new Error("the poisoned arm failed nobody: nothing to pay");

  await caption(
    `STEP 7 / 10 · INDEX ${bps} BPS · ${triggered.policy.status.toUpperCase()}`,
    `${triggered.policy.failed} of ${triggered.policy.started} wrong, all with the same wrong answer. ${bps} bps against a ${triggered.policy.trigger_bps} bps trigger.`,
  );
  await capture("07-gauge", 7500);

  await scrollTo("Receipts");
  await caption(
    "STEP 8 / 10 · 20 RECEIPTS ON CHAIN",
    "Request and response hashed, signature recovered, arithmetic redone. Tx is where each receipt landed.",
  );
  await capture("08-receipts", 10_000);

  await scrollTop();
  await caption(
    "STEP 9 / 10 · CLAIM",
    `The buyer claims. The pool pays ${near(triggered.policy.limit)} NEAR automatically: no approver, no key that can stop it.`,
  );
  await startSegment("09-claim");
  await hold(1200);
  await clickButton("Claim payout");
  await waitFor('document.body.innerText.includes("claim tx")', {
    timeout: 3 * 60_000,
    label: "the claim transaction",
  });
  await hold(5000); // the panel also flips to Paid on its own poll
  await stopSegment();

  const claimTx = await claimTxFromPage();
  const paidView = await policyView(b);
  log(`p-${b} is ${paidView.policy.status}, paid ${near(paidView.policy.paid_amount)} NEAR`);

  await showCard(card({
    kicker: "PAID",
    title: `${near(paidView.policy.paid_amount)} NEAR paid to the buyer`,
    lines: [
      `${triggered.policy.failed} of ${triggered.policy.started} agents failed the same way, ${bps} bps against a ${triggered.policy.trigger_bps} bps trigger.`,
      `claim tx ${claimTx || "(see the page)"}`,
    ],
    footer: "step 10 / 10 · correlation.testnet · NEAR HACKATHON 2026",
  }));
  await capture("10-outro", 7000);
  return { bps, status: paidView.policy.status };
}

/**
 * Re-record steps 7-10 against the policy the last take bought.
 *
 * The arms are the expensive half and they are already on chain when this is
 * useful: if a run dies on the closing shots, buying two more policies would
 * only buy another half-hour wait. Segments already on disk keep their place in
 * list.txt; the closing four are dropped first so a stale tail from an earlier
 * take cannot end up in this one.
 */
/** The steps are numbered on screen, so list.txt has to follow the numbers. */
function sortSegments() {
  const key = (name) => {
    const match = /^(\d+)([a-z]?)/.exec(name ?? "");
    return match ? [Number(match[1]), match[2] === "b" ? 1 : 0] : [99, 0];
  };
  session.segments.sort((left, right) => {
    const [leftStep, leftHalf] = key(left.name);
    const [rightStep, rightHalf] = key(right.name);
    return leftStep - rightStep || leftHalf - rightHalf;
  });
}

function readTakeState() {
  return existsSync(TAKE_STATE) ? JSON.parse(readFileSync(TAKE_STATE, "utf8")) : null;
}

async function tail(arg) {
  const policyId = Number(arg ?? readTakeState()?.policyB);
  if (!policyId) throw new Error("no film/take-state.json: pass the policy id to resume");
  const closing = ["07-gauge", "08-receipts", "09-claim", "10-outro"];
  const manifestPath = join(FILM, "manifest.json");
  if (existsSync(manifestPath)) {
    const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
    session.segments.push(
      ...previous.filter(
        (segment) => !closing.includes(segment.name) && existsSync(segment.file),
      ),
    );
  }

  await openApp(`/?policy=${policyId}`);
  const view = await policyView(policyId);
  log(`resuming the tail on p-${policyId} (${view.policy.status}, ${view.policy.failed} of ${view.policy.started} failed)`);
  await recordTail(policyId);
  sortSegments();
  writeManifest();
  log(`tail done: ${session.segments.length} segments, ${totalSeconds().toFixed(1)}s`);
  log("next: ./scripts/edit.sh, then watch it once and check frames for anything private");
}

/**
 * Re-record one view-only shot against a policy whose run already happened.
 *
 * The control result is the one shot whose caption depends on the numbers the
 * arm produced, so a take that guessed before the arm settled cannot be fixed
 * by editing afterwards: the caption is inside the frames. Re-recording it
 * costs a browser launch, not another twenty completions.
 */
async function seg(name, arg) {
  if (name !== "04-control-result") {
    throw new Error(`seg has no recipe for ${name ?? "(nothing)"}`);
  }
  const policyId = Number(arg ?? readTakeState()?.policyA);
  if (!policyId) throw new Error("pass the control policy id: shoot.mjs seg 04-control-result <id>");

  const view = await policyView(policyId);
  const bps = view.policy.started
    ? Math.round((view.policy.failed / view.policy.started) * 10_000)
    : 0;
  await openApp(`/?policy=${policyId}`);
  // The page replays the recorded run on load; the caption claims a split, so
  // the grid has to have painted that split before the shot starts.
  await waitFor('document.querySelectorAll(".cell:not(.pending)").length > 0', {
    label: "the recorded control run to load",
    timeout: 20_000,
  });
  await caption(
    `STEP 4 / 10 · CONTROL ARM · ${view.policy.failed} FAILED OF ${view.policy.started}`,
    view.policy.failed === 0
      ? `Every answer was correct: index 0 bps, under the ${view.policy.trigger_bps} bps trigger. The policy stays open and pays nothing.`
      : `${view.policy.started - view.policy.failed} of ${view.policy.started} correct: index ${bps} bps, under the ${view.policy.trigger_bps} bps trigger, so it pays nothing.`,
  );
  // Keep the segments already on disk, minus this one, in list.txt order.
  const manifestPath = join(FILM, "manifest.json");
  if (existsSync(manifestPath)) {
    const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
    session.segments.push(
      ...previous.filter(
        (segment) => segment.name !== name && existsSync(segment.file),
      ),
    );
  }
  await startSegment(name);
  await hold(3200);
  await scrollTo("Swarm", { prefix: true });
  await hold(3600);
  await stopSegment();
  sortSegments();
  writeManifest();
  log(`re-recorded ${name} against p-${policyId} (${view.policy.failed} failed of ${view.policy.started})`);
}

const totalSeconds = () => session.segments.reduce((sum, segment) => sum + segment.seconds, 0);
// ── frames, for a privacy and legibility review ─────────────────────────────

async function frames(video, outDir) {
  if (!video) throw new Error("usage: shoot.mjs frames <video> [out-dir]");
  const target = outDir ?? join(FILM, "frames");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  await ffmpeg(["-i", video, "-vf", "fps=1/2", join(target, "f-%03d.png")]);
  log(`one frame every two seconds -> ${target}`);
}

// ── entry ───────────────────────────────────────────────────────────────────

const usage = `usage:
  node scripts/shoot.mjs check                     dry run, no model calls
  node scripts/shoot.mjs take --yes-spend          the real take
  node scripts/shoot.mjs tail [policy-id]           re-record steps 7-10 only
  node scripts/shoot.mjs seg 04-control-result <id>  re-record the control result shot
  node scripts/shoot.mjs frames <video> [out-dir]  frames for review`;

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (!mode || mode === "--help" || mode === "-h") {
    process.stdout.write(`${usage}\n`);
    return;
  }

  if (mode === "frames") {
    await frames(rest[0], rest[1]);
    return;
  }

  if (!["check", "take", "tail", "seg"].includes(mode)) {
    throw new Error(`unknown mode ${mode}\n${usage}`);
  }

  try {
    await launch();
    if (mode === "check") await check();
    else if (mode === "tail") await tail(rest[0]);
    else if (mode === "seg") await seg(rest[0], rest[1]);
    else await take();
  } catch (error) {
    await shutdown({ keepScratch: true });
    throw error;
  }
  await shutdown();
}

try {
  await main();
} catch (error) {
  process.stderr.write(`shoot: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
