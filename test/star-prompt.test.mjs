import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  evaluateStarPrompt,
  GH_STAR_COMMAND,
  GITHUB_REPO_URL,
  normalizeStarPromptState,
  readSettings,
  recordAutoRetryStat,
  setStarPromptState,
  STAR_PROMPT_MIN_AUTO_RETRIES,
  updateSettings
} from "../hooks/lib/settings.mjs";
import { maybeGcStaleSessions } from "../hooks/lib/state.mjs";
import { runPostToolUse } from "../hooks/post-tool-use.mjs";
import { runPreInvocation } from "../hooks/pre-invocation.mjs";
import { runSessionStart } from "../hooks/session-start.mjs";
import { runStop } from "../hooks/stop.mjs";
import { createStandaloneServer, registerSidecarRoutes } from "../sidecars/panel/server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function makeTmpDir(prefix = "agy-cmd-star-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function httpRawRequest(port, urlPath, { method = "POST", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { Host: `127.0.0.1:${port}`, ...headers };
    if (body !== null && body !== undefined && reqHeaders["Content-Length"] === undefined) {
      reqHeaders["Content-Length"] = Buffer.byteLength(body, "utf8");
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: reqHeaders
      },
      (res) => {
        let raw = "";
        res.on("data", (d) => {
          raw += d.toString("utf8");
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    req.on("error", reject);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

test("star-1: Legacy settings.json / missing or malformed starPrompt defaults cleanly to pending", () => {
  const tmpDir = makeTmpDir();
  try {
    const badCases = [
      null,
      undefined,
      "",
      "{corrupt json",
      "[]",
      JSON.stringify({ autoRetryMax: 3 }),
      JSON.stringify({ starPrompt: {} }),
      JSON.stringify({ state: "unknown_evil_state", triggeredAt: 123, milestoneAutoRetries: -5 }),
      { starPrompt: "not-an-object" },
      { state: "pending", triggeredAt: "   ", resolvedAt: "x".repeat(80), milestoneAutoRetries: "nan" }
    ];
    for (const c of badCases) {
      assert.deepEqual(normalizeStarPromptState(c), {
        state: "pending",
        triggeredAt: null,
        resolvedAt: null,
        milestoneAutoRetries: 0
      });
    }

    assert.deepEqual(normalizeStarPromptState(JSON.stringify({ starPrompt: { milestoneAutoRetries: 7 } })), {
      state: "pending",
      triggeredAt: null,
      resolvedAt: null,
      milestoneAutoRetries: 7
    });

    assert.deepEqual(
      normalizeStarPromptState({
        starPrompt: {
          state: "dismissed",
          triggeredAt: "2026-11-20T00:00:00.000Z",
          resolvedAt: "2026-11-20T00:01:00.000Z",
          milestoneAutoRetries: 4
        }
      }),
      {
        state: "dismissed",
        triggeredAt: "2026-11-20T00:00:00.000Z",
        resolvedAt: "2026-11-20T00:01:00.000Z",
        milestoneAutoRetries: 4
      }
    );

    // Legacy v2.1.1 settings.json without starPrompt field reads cleanly as pending
    fs.writeFileSync(
      path.join(tmpDir, "settings.json"),
      JSON.stringify({
        version: 2,
        planTier: "free",
        boostEnabled: false,
        autoRetryMode: "count",
        autoRetryMax: 3,
        autoRetryScope: "smart",
        stats: { totalAutoRetries: 1 }
      }) + "\n",
      "utf8"
    );
    assert.deepEqual(readSettings(tmpDir).starPrompt, {
      state: "pending",
      triggeredAt: null,
      resolvedAt: null,
      milestoneAutoRetries: 0
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("star-2: Milestone gating (<3 auto-retries hidden; >=3 triggers once without flipping configuredByUser)", () => {
  const tmpDir = makeTmpDir();
  try {
    assert.equal(STAR_PROMPT_MIN_AUTO_RETRIES, 3);

    // 0, 1, 2 auto-retries stay hidden
    for (let i = 0; i < 2; i++) {
      recordAutoRetryStat(tmpDir, `conv-${i}`, `2026-11-22T00:0${i}:00.000Z`);
      const evBelow = evaluateStarPrompt(tmpDir, { markTriggered: true });
      assert.equal(evBelow.state, "pending");
      assert.equal(evBelow.totalAutoRetries, i + 1);
      assert.equal(evBelow.shouldShow, false);
      assert.equal(evBelow.triggeredAt, null);
      assert.equal(evBelow.triggerReason, null);
    }

    // 3rd auto-retry reaches milestone -> triggers & persists triggeredAt once
    recordAutoRetryStat(tmpDir, "conv-3", "2026-11-22T00:03:00.000Z");
    const evTrig = evaluateStarPrompt(tmpDir, {
      markTriggered: true,
      nowIso: "2026-11-22T01:00:00.000Z"
    });
    assert.equal(evTrig.state, "pending");
    assert.equal(evTrig.shouldShow, true);
    assert.equal(evTrig.triggerReason, "auto_retry_milestone");
    assert.equal(evTrig.triggeredAt, "2026-11-22T01:00:00.000Z");
    assert.equal(evTrig.milestoneAutoRetries, 3);
    assert.equal(readSettings(tmpDir).configuredByUser, false, "Must not silently dismiss onboarding");

    // Subsequent poll preserves original triggeredAt without rewriting settings.json
    const settingsPath = path.join(tmpDir, "settings.json");
    const mtimeBefore = fs.statSync(settingsPath).mtimeMs;
    const evPoll = evaluateStarPrompt(tmpDir, {
      markTriggered: true,
      nowIso: "2026-11-22T02:00:00.000Z"
    });
    const mtimeAfter = fs.statSync(settingsPath).mtimeMs;
    assert.equal(evPoll.shouldShow, true);
    assert.equal(evPoll.triggeredAt, "2026-11-22T01:00:00.000Z");
    assert.equal(mtimeAfter, mtimeBefore, "Repeated /api/state polls must not rewrite settings.json");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("star-3: Terminal states persist permanently across resetStats, GC, settings patches & Python CLI", () => {
  const tmpDir = makeTmpDir();
  try {
    for (const terminalState of ["clicked", "dismissed", "copied_cli"]) {
      const stateDir = path.join(tmpDir, `term-${terminalState}`);
      fs.mkdirSync(stateDir, { recursive: true });

      for (let i = 0; i < 3; i++) {
        recordAutoRetryStat(stateDir, `c-${i}`);
      }
      assert.equal(evaluateStarPrompt(stateDir, { markTriggered: true }).shouldShow, true);

      const res = setStarPromptState(stateDir, terminalState, {
        nowIso: "2026-11-22T12:00:00.000Z"
      });
      assert.equal(res.ok, true);
      assert.equal(res.alreadyResolved, false);
      assert.equal(res.starPrompt.state, terminalState);
      assert.equal(res.starPrompt.resolvedAt, "2026-11-22T12:00:00.000Z");
      assert.equal(res.starPrompt.shouldShow, false);

      // Survives resetStats ("清零统计"), 5 more retries, session GC, and settings updates
      updateSettings(stateDir, { resetStats: true, autoRetryMax: 5 });
      for (let i = 0; i < 5; i++) {
        recordAutoRetryStat(stateDir, `after-${i}`);
      }
      maybeGcStaleSessions(stateDir, Date.now() + 30 * 86400 * 1000, 0);
      assert.equal(evaluateStarPrompt(stateDir, { markTriggered: true }).shouldShow, false);
      assert.equal(readSettings(stateDir).starPrompt.state, terminalState);

      // Subsequent mutation does NOT overwrite original terminal state
      const second = setStarPromptState(
        stateDir,
        terminalState === "clicked" ? "dismissed" : "clicked",
        { nowIso: "2026-11-22T13:00:00.000Z" }
      );
      assert.equal(second.ok, true);
      assert.equal(second.alreadyResolved, true);
      assert.equal(second.starPrompt.state, terminalState);
      assert.equal(second.starPrompt.resolvedAt, "2026-11-22T12:00:00.000Z");
    }

    // Pre-milestone header Star click (0 retries) permanently suppresses future banner
    const earlyDir = path.join(tmpDir, "early-header-click");
    const earlyRes = setStarPromptState(earlyDir, "clicked", { nowIso: "2026-11-22T09:00:00.000Z" });
    assert.equal(earlyRes.ok, true);
    for (let i = 0; i < 4; i++) {
      recordAutoRetryStat(earlyDir, `early-${i}`);
    }
    assert.equal(evaluateStarPrompt(earlyDir, { markTriggered: true }).shouldShow, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("star-4: Sidecar UI index.html renders header Star + milestone banner, handles SidecarApp host & clipboard fallbacks", async () => {
  const htmlSource = fs.readFileSync(path.join(ROOT, "sidecars", "panel", "index.html"), "utf8");
  assert.ok(htmlSource.includes('id="github-star-link"'));
  assert.ok(htmlSource.includes(`href="${GITHUB_REPO_URL}"`));
  assert.ok(htmlSource.includes('id="star-milestone-banner"'));
  assert.ok(htmlSource.includes('id="star-banner-open-btn"'));
  assert.ok(htmlSource.includes('id="star-banner-dismiss-btn"'));
  assert.ok(htmlSource.includes('id="star-banner-copy-cli-btn"'));

  const scriptBlocks = [...htmlSource.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert.ok(scriptBlocks.length >= 1);
  const mainScript = scriptBlocks[scriptBlocks.length - 1][1].replace(/__AGY_CMD_CSRF__/g, "vm-csrf-token");

  const runUiScenario = async ({
    initialStarPrompt,
    useSidecarBridge = false,
    clipboardMode = "navigator"
  }) => {
    const elements = new Map();
    const makeEl = (id) => {
      const initiallyHidden =
        id === "onboard-card" ||
        id === "star-milestone-banner" ||
        id === "star-banner-feedback" ||
        id === "toast";
      const listeners = new Map();
      return {
        id,
        hidden: initiallyHidden,
        value: id === "inp-max" ? "3" : "",
        checked: false,
        disabled: false,
        textContent: "",
        style: { getPropertyValue: () => "" },
        dataset: {},
        classList: {
          _s: new Set(
            id === "star-milestone-banner" || id === "star-banner-feedback" ? ["hidden"] : []
          ),
          add(c) {
            this._s.add(c);
          },
          remove(c) {
            this._s.delete(c);
          },
          toggle(c, force) {
            const on = force === undefined ? !this._s.has(c) : Boolean(force);
            if (on) this._s.add(c);
            else this._s.delete(c);
            return on;
          },
          contains(c) {
            return this._s.has(c);
          }
        },
        setAttribute() {},
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(fn);
        },
        async click() {
          for (const fn of listeners.get("click") || []) {
            await fn({ preventDefault() {} });
          }
        }
      };
    };

    const getEl = (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    };

    const copiedTexts = [];
    const rawStarBodies = [];
    let currentSp = structuredClone(initialStarPrompt);

    const handleFetch = async (urlPath, opts = {}) => {
      const mkJson = (obj, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => structuredClone(obj)
      });
      if (urlPath === "/api/star-prompt") {
        assert.equal(opts.method, "POST");
        const body = JSON.parse(opts.body);
        rawStarBodies.push(body);
        assert.deepEqual(
          Object.keys(body),
          ["state"],
          "/api/star-prompt payload must never include extra fields like conversationId"
        );
        currentSp = {
          ...currentSp,
          state: body.state,
          shouldShow: false,
          resolvedAt: "2026-11-22T12:30:00.000Z"
        };
        return mkJson({ ok: true, starPrompt: currentSp });
      }
      if (urlPath === "/api/state") {
        return mkJson({
          ok: true,
          settings: {
            version: 2,
            planTier: "free",
            boostEnabled: false,
            autoRetryMode: "count",
            autoRetryMax: 3,
            autoRetryScope: "smart",
            freeFallbackEnabled: true,
            planFallbackEnabled: true,
            configuredByUser: true,
            onboardingShown: true,
            stats: { totalAutoRetries: currentSp.totalAutoRetries || 0 },
            starPrompt: currentSp
          },
          starPrompt: currentSp,
          summaryZh: "最多重试 3 次（智能无感触发）",
          boostStatusZh: "免费版安全模式 · 已屏蔽付费口令防报错"
        });
      }
      return mkJson({ ok: true });
    };

    let activeTextarea = null;
    const timers = [];
    const intervals = [];
    const windowObj = {
      location: { search: "" },
      addEventListener() {},
      fetch: handleFetch,
      sidecar: useSidecarBridge
        ? { conversationId: "host-conv-999", fetch: handleFetch }
        : null
    };

    const sandbox = {
      window: windowObj,
      document: {
        hidden: false,
        activeElement: null,
        documentElement: {
          style: { getPropertyValue: () => "" },
          setAttribute() {}
        },
        body: {
          appendChild(node) {
            activeTextarea = node;
          },
          removeChild(node) {
            if (activeTextarea === node) activeTextarea = null;
          }
        },
        createElement() {
          return {
            value: "",
            style: {},
            setAttribute() {},
            focus() {},
            select() {}
          };
        },
        execCommand(cmd) {
          if (cmd === "copy" && clipboardMode === "execCommand" && activeTextarea) {
            copiedTexts.push(activeTextarea.value);
            return true;
          }
          return false;
        },
        getElementById: getEl,
        querySelectorAll: () => []
      },
      navigator: {
        clipboard:
          clipboardMode === "navigator"
            ? {
                writeText: async (txt) => {
                  copiedTexts.push(txt);
                }
              }
            : {
                writeText: async () => {
                  throw new Error("NotAllowedError");
                }
              }
      },
      requestAnimationFrame: (fn) => fn(),
      setInterval: (fn) => {
        intervals.push(fn);
        return intervals.length;
      },
      clearInterval: () => {},
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeout: () => {}
    };

    vm.createContext(sandbox);
    vm.runInContext(mainScript, sandbox);
    await new Promise((r) => setTimeout(r, 25));
    return { getEl, copiedTexts, rawStarBodies, timers, intervals };
  };

  // 1. Hidden below milestone
  const below = await runUiScenario({
    initialStarPrompt: { state: "pending", shouldShow: false, totalAutoRetries: 2 }
  });
  assert.equal(below.getEl("star-milestone-banner").hidden, true);
  assert.equal(below.getEl("star-milestone-banner").classList.contains("hidden"), true);

  // 2. Visible at >=3 retries; Dismiss in SidecarApp bridge mode sends strictly { state: "dismissed" }
  const dismissUi = await runUiScenario({
    initialStarPrompt: { state: "pending", shouldShow: true, totalAutoRetries: 4 },
    useSidecarBridge: true
  });
  assert.equal(dismissUi.getEl("star-milestone-banner").hidden, false);
  assert.match(dismissUi.getEl("star-banner-msg").textContent, /累计自动拦截续跑 4 次/);
  await dismissUi.getEl("star-banner-dismiss-btn").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(dismissUi.rawStarBodies, [{ state: "dismissed" }]);
  assert.equal(dismissUi.getEl("star-milestone-banner").hidden, true);
  for (const poll of dismissUi.intervals) await poll();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dismissUi.getEl("star-milestone-banner").hidden, true);

  // 3. Copy CLI via navigator.clipboard: copies GH_STAR_COMMAND, shows notice, survives poll, collapses after timer
  const copyNav = await runUiScenario({
    initialStarPrompt: { state: "pending", shouldShow: true, totalAutoRetries: 3 }
  });
  await copyNav.getEl("star-banner-copy-cli-btn").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(copyNav.copiedTexts, [GH_STAR_COMMAND]);
  assert.deepEqual(copyNav.rawStarBodies, [{ state: "copied_cli" }]);
  assert.equal(copyNav.getEl("star-banner-feedback").hidden, false);
  assert.equal(copyNav.getEl("star-banner-feedback").textContent, "已复制，需自行在终端运行");
  assert.equal(copyNav.getEl("star-milestone-banner").hidden, false, "Stays visible during 2.5s feedback window");
  for (const poll of copyNav.intervals) await poll();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(copyNav.getEl("star-milestone-banner").hidden, false, "Background poll must not prematurely hide feedback");
  for (const fn of copyNav.timers) fn();
  assert.equal(copyNav.getEl("star-milestone-banner").hidden, true);

  // 4. Copy CLI fallback via execCommand('copy') and graceful manual notice when all copy methods fail
  const copyExec = await runUiScenario({
    initialStarPrompt: { state: "pending", shouldShow: true, totalAutoRetries: 3 },
    clipboardMode: "execCommand"
  });
  await copyExec.getEl("star-banner-copy-cli-btn").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(copyExec.copiedTexts, [GH_STAR_COMMAND]);
  assert.equal(copyExec.getEl("star-banner-feedback").textContent, "已复制，需自行在终端运行");

  const copyFail = await runUiScenario({
    initialStarPrompt: { state: "pending", shouldShow: true, totalAutoRetries: 3 },
    clipboardMode: "fail"
  });
  await copyFail.getEl("star-banner-copy-cli-btn").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(copyFail.getEl("star-banner-feedback").textContent.includes(GH_STAR_COMMAND));

  // 5. Primary Open button & Header Star link both persist 'clicked' once and collapse banner
  const openUi = await runUiScenario({
    initialStarPrompt: { state: "pending", shouldShow: true, totalAutoRetries: "oops-nan" }
  });
  assert.match(openUi.getEl("star-banner-msg").textContent, /累计自动拦截续跑 3 次/);
  await openUi.getEl("star-banner-open-btn").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(openUi.rawStarBodies, [{ state: "clicked" }]);
  assert.equal(openUi.getEl("star-milestone-banner").hidden, true);

  const headerUi = await runUiScenario({
    initialStarPrompt: { state: "pending", shouldShow: true, totalAutoRetries: 3 }
  });
  await headerUi.getEl("github-star-link").click();
  await headerUi.getEl("github-star-link").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(headerUi.rawStarBodies, [{ state: "clicked" }]);
  assert.equal(headerUi.getEl("star-milestone-banner").hidden, true);
});

test("star-5: /api/star-prompt security hardening, SidecarApp contract & zero AI context pollution", async () => {
  const tmpDir = makeTmpDir();
  try {
    for (let i = 0; i < 3; i++) {
      recordAutoRetryStat(tmpDir, `sec-${i}`);
    }

    // 1. SidecarApp route contract check
    const routes = new Map();
    const mockApp = {
      config: { conversationId: "sec-conv" },
      api(routePath, handler, method) {
        assert.equal(method, "POST");
        routes.set(routePath, handler);
      }
    };
    registerSidecarRoutes(mockApp, { stateDir: tmpDir });
    const spHandler = routes.get("/api/star-prompt");
    assert.equal(typeof spHandler, "function");
    for (const bad of [
      null,
      [],
      "clicked",
      {},
      { state: "pending" },
      { state: "clicked", extra: 1 },
      { state: "clicked", conversationId: "sec-conv" }
    ]) {
      const r = await spHandler(bad);
      assert.equal(r?.status, 400, `SidecarApp /api/star-prompt must reject ${JSON.stringify(bad)} with 400`);
    }

    // Also verify SidecarResponse class wrapping in registerSidecarRoutes
    class MockSidecarResponse {
      constructor(body, opts = {}) {
        this.body = body;
        this.status = opts.status;
        this.contentType = opts.contentType;
        this.headers = opts.headers;
      }
    }
    const sdkRoutes = new Map();
    let pageHandler = null;
    registerSidecarRoutes(
      {
        config: { conversationId: "sec-conv" },
        page(p, fn) {
          if (p === "/") pageHandler = fn;
        },
        api(p, fn) {
          sdkRoutes.set(p, fn);
        }
      },
      { stateDir: tmpDir, csrfToken: "sdk-tok", SidecarResponse: MockSidecarResponse }
    );
    const sdkPage = pageHandler();
    assert.equal(sdkPage.status, 200);
    assert.ok(sdkPage.body.includes('id="github-star-link"'));
    const sdkBad = sdkRoutes.get("/api/star-prompt")({ state: "evil" });
    assert.equal(sdkBad.status, 400);

    // 2. Standalone HTTP security checks
    const token = "test-star-csrf-token-0123456789abcdef";
    const srv = createStandaloneServer({ stateDir: tmpDir, csrfToken: token });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;

    try {
      // GET -> 405 Allow: POST
      const getRes = await httpRawRequest(port, "/api/star-prompt", {
        method: "GET",
        headers: { "X-Agy-Cmd-Csrf": token }
      });
      assert.equal(getRes.status, 405);
      assert.equal(getRes.headers.allow, "POST");

      // Missing / wrong CSRF token -> 401
      assert.equal(
        (
          await httpRawRequest(port, "/api/star-prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ state: "clicked" })
          })
        ).status,
        401
      );
      assert.equal(
        (
          await httpRawRequest(port, "/api/star-prompt", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Agy-Cmd-Csrf": "0".repeat(token.length)
            },
            body: JSON.stringify({ state: "clicked" })
          })
        ).status,
        401
      );

      // Host / Origin / Referer / Sec-Fetch-Site rejections -> 403
      for (const badHeaders of [
        { Host: `evil.test:${port}` },
        { Origin: "https://evil.example" },
        { Origin: `http://localhost:${port}` },
        { Referer: "https://evil.example/page" },
        { Referer: `http://localhost:${port}/` },
        { "Sec-Fetch-Site": "same-site" },
        { "Sec-Fetch-Site": "cross-site" }
      ]) {
        const res = await httpRawRequest(port, "/api/star-prompt", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Agy-Cmd-Csrf": token,
            ...badHeaders
          },
          body: JSON.stringify({ state: "clicked" })
        });
        assert.equal(res.status, 403, `Expected 403 for headers ${JSON.stringify(badHeaders)}`);
      }

      // Non-JSON Content-Type -> 415
      assert.equal(
        (
          await httpRawRequest(port, "/api/star-prompt", {
            method: "POST",
            headers: { "Content-Type": "text/plain", "X-Agy-Cmd-Csrf": token },
            body: JSON.stringify({ state: "clicked" })
          })
        ).status,
        415
      );

      // Oversized > 32 KB body -> 413 (both Content-Length and chunked streaming without Content-Length)
      assert.equal(
        (
          await httpRawRequest(port, "/api/star-prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": token },
            body: JSON.stringify({ state: "x".repeat(40000) })
          })
        ).status,
        413
      );

      const chunked413 = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/star-prompt",
            method: "POST",
            headers: {
              Host: `127.0.0.1:${port}`,
              "Content-Type": "application/json",
              "Transfer-Encoding": "chunked",
              "X-Agy-Cmd-Csrf": token
            }
          },
          (res) => {
            let raw = "";
            res.on("data", (d) => {
              raw += d.toString("utf8");
            });
            res.on("end", () => resolve({ status: res.statusCode, raw }));
          }
        );
        req.on("error", reject);
        req.write('{"state":"');
        req.write("y".repeat(20000));
        req.write("z".repeat(20000));
        req.end('"}');
      });
      assert.equal(chunked413.status, 413);

      // Invalid state values & injected extra fields -> 400
      for (const badBody of [
        {},
        { state: "" },
        { state: "pending" },
        { state: "auto_star" },
        { state: 123 },
        { state: "clicked", injected: true },
        { state: "dismissed", command: GH_STAR_COMMAND }
      ]) {
        const res = await httpRawRequest(port, "/api/star-prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": token },
          body: JSON.stringify(badBody)
        });
        assert.equal(res.status, 400, `Payload ${JSON.stringify(badBody)} must return 400`);
      }

      // Valid same-origin POST /api/state shows pending & shouldShow=true
      const beforeState = await httpRawRequest(port, "/api/state", {
        method: "POST",
        headers: {
          Origin: `http://127.0.0.1:${port}`,
          Referer: `http://127.0.0.1:${port}/`,
          "Content-Type": "application/json",
          "X-Agy-Cmd-Csrf": token
        },
        body: "{}"
      });
      assert.equal(beforeState.status, 200);
      assert.equal(beforeState.json.starPrompt.state, "pending");
      assert.equal(beforeState.json.starPrompt.shouldShow, true);

      // Valid vscode-webview:// Origin + same-origin POST /api/star-prompt -> 200 & permanent suppression
      const okMut = await httpRawRequest(port, "/api/star-prompt", {
        method: "POST",
        headers: {
          Origin: "vscode-webview://agy-cmd-panel",
          Referer: "vscode-webview://agy-cmd-panel/index.html",
          "Sec-Fetch-Site": "none",
          "Content-Type": "application/json",
          "X-Agy-Cmd-Csrf": token
        },
        body: JSON.stringify({ state: "clicked" })
      });
      assert.equal(okMut.status, 200);
      assert.equal(okMut.json.ok, true);
      assert.equal(okMut.json.starPrompt.state, "clicked");
      assert.equal(okMut.json.starPrompt.shouldShow, false);

      const afterState = await httpRawRequest(port, "/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": token },
        body: "{}"
      });
      assert.equal(afterState.status, 200);
      assert.equal(afterState.json.starPrompt.state, "clicked");
      assert.equal(afterState.json.starPrompt.shouldShow, false);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }

    // 3. Static & AI hook red-line audits: zero auto-Star execution, zero AI context pollution
    for (const rel of [
      "sidecars/panel/server.mjs",
      "sidecars/panel/api-handler.mjs",
      "hooks/session-start.mjs",
      "hooks/pre-invocation.mjs",
      "hooks/post-tool-use.mjs",
      "hooks/stop.mjs"
    ]) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.equal(/gh\s+api/i.test(src), false, `${rel} must never execute gh api`);
      assert.equal(/api\.github\.com/i.test(src), false, `${rel} must never call GitHub APIs`);
    }

    const rulesMd = fs.readFileSync(path.join(ROOT, "rules", "AGENTS.md"), "utf8");
    assert.equal(rulesMd.includes("zou172866/Antigravity-agy-cmd"), false);
    assert.equal(rulesMd.includes("gh api"), false);

    const hookDir = path.join(tmpDir, "hook-audit");
    for (let i = 0; i < 4; i++) recordAutoRetryStat(hookDir, `ha-${i}`);
    const env = {
      ...process.env,
      AGY_CMD_STATE_DIR: hookDir,
      ANTIGRAVITY_PARENT_CONVERSATION_ID: "",
      ANTIGRAVITY_SUBAGENT: ""
    };
    const hStart = JSON.stringify(await runSessionStart({ conversationId: "ha-main" }, env));
    await runPostToolUse(
      { conversationId: "ha-main", toolCall: { name: "run_command", args: { CommandLine: "pytest" } }, error: "exit status 1" },
      env
    );
    const hPre = JSON.stringify(
      await runPreInvocation({ conversationId: "ha-main", invocationNum: 0, initialNumSteps: 1, lastUserInput: "修好 pytest" }, env)
    );
    const hStop = JSON.stringify(
      await runStop({ conversationId: "ha-main", executionNum: 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true, lastUserInput: "修好 pytest" }, env)
    );
    for (const blob of [hStart, hPre, hStop]) {
      assert.equal(blob.includes("zou172866/Antigravity-agy-cmd"), false, "Hooks must emit zero GitHub URL context pollution");
      assert.equal(blob.includes("gh api"), false, "Hooks must emit zero gh CLI context pollution");
    }

    // Also verify Python CLI preserves terminal starPrompt state written by Node
    const pyCheck = spawnSync(
      "python",
      [
        path.join(ROOT, "skills", "agy-cmd", "scripts", "setup_auto_router.py"),
        "--auto-retry",
        "6",
        "--state-dir",
        tmpDir
      ],
      { encoding: "utf8", windowsHide: true }
    );
    if (!pyCheck.error && pyCheck.status === 0) {
      assert.equal(readSettings(tmpDir).starPrompt.state, "clicked");
      assert.equal(readSettings(tmpDir).autoRetryMax, 6);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("star-6: Sidecar UI retries transient /api/star-prompt failures on header re-click and background poll", async () => {
  const htmlSource = fs.readFileSync(path.join(ROOT, "sidecars", "panel", "index.html"), "utf8");
  const scriptBlocks = [...htmlSource.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainScript = scriptBlocks[scriptBlocks.length - 1][1].replace(/__AGY_CMD_CSRF__/g, "vm-retry-csrf");

  const bootVmWithFlakyStarPost = async () => {
    const elements = new Map();
    const getEl = (id) => {
      if (!elements.has(id)) {
        const listeners = new Map();
        const hiddenInit =
          id === "onboard-card" ||
          id === "star-milestone-banner" ||
          id === "star-banner-feedback" ||
          id === "toast";
        elements.set(id, {
          id,
          hidden: hiddenInit,
          value: id === "inp-max" ? "3" : "",
          checked: false,
          disabled: false,
          textContent: "",
          style: { getPropertyValue: () => "" },
          dataset: {},
          classList: {
            _s: new Set(id === "star-milestone-banner" || id === "star-banner-feedback" ? ["hidden"] : []),
            add(c) { this._s.add(c); },
            remove(c) { this._s.delete(c); },
            toggle(c, force) {
              const on = force === undefined ? !this._s.has(c) : Boolean(force);
              if (on) this._s.add(c); else this._s.delete(c);
              return on;
            },
            contains(c) { return this._s.has(c); }
          },
          setAttribute() {},
          addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
          },
          async click() {
            for (const fn of listeners.get("click") || []) {
              await fn({ preventDefault() {} });
            }
          }
        });
      }
      return elements.get(id);
    };

    let failNextStarPost = true;
    let currentSp = { state: "pending", shouldShow: true, totalAutoRetries: 3 };
    const starAttempts = [];
    const intervals = [];

    const handleFetch = async (urlPath, opts = {}) => {
      const mkJson = (obj, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => structuredClone(obj)
      });
      if (urlPath === "/api/star-prompt") {
        const body = JSON.parse(opts.body);
        starAttempts.push(body);
        if (failNextStarPost) {
          failNextStarPost = false;
          return mkJson({ ok: false, error: "Sidecar restarting" }, 503);
        }
        currentSp = { ...currentSp, state: body.state, shouldShow: false };
        return mkJson({ ok: true, starPrompt: currentSp });
      }
      if (urlPath === "/api/state") {
        return mkJson({
          ok: true,
          settings: {
            version: 2,
            planTier: "free",
            boostEnabled: false,
            autoRetryMode: "count",
            autoRetryMax: 3,
            autoRetryScope: "smart",
            freeFallbackEnabled: true,
            planFallbackEnabled: true,
            configuredByUser: true,
            onboardingShown: true,
            stats: { totalAutoRetries: 3 },
            starPrompt: currentSp
          },
          starPrompt: currentSp
        });
      }
      return mkJson({ ok: true });
    };

    const sandbox = {
      window: { location: { search: "" }, addEventListener() {}, fetch: handleFetch, sidecar: null },
      document: {
        hidden: false,
        activeElement: null,
        documentElement: { style: { getPropertyValue: () => "" }, setAttribute() {} },
        body: { appendChild() {}, removeChild() {} },
        createElement: () => ({ value: "", style: {}, setAttribute() {}, focus() {}, select() {} }),
        execCommand: () => true,
        getElementById: getEl,
        querySelectorAll: () => []
      },
      navigator: { clipboard: { writeText: async () => {} } },
      requestAnimationFrame: (fn) => fn(),
      setInterval: (fn) => { intervals.push(fn); return intervals.length; },
      clearInterval: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {}
    };
    vm.createContext(sandbox);
    vm.runInContext(mainScript, sandbox);
    await new Promise((r) => setTimeout(r, 20));
    return { getEl, starAttempts, intervals, getServerState: () => currentSp.state };
  };

  // Case A: First header click hits 503 -> second header click retries and persists 'clicked'
  const headerCase = await bootVmWithFlakyStarPost();
  await headerCase.getEl("github-star-link").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(headerCase.getServerState(), "pending");
  await headerCase.getEl("github-star-link").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(headerCase.getServerState(), "clicked");
  assert.deepEqual(headerCase.starAttempts, [{ state: "clicked" }, { state: "clicked" }]);

  // Case B: Banner dismiss hits 503 -> banner stays hidden & next background poll flushes 'dismissed'
  const dismissCase = await bootVmWithFlakyStarPost();
  await dismissCase.getEl("star-banner-dismiss-btn").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dismissCase.getEl("star-milestone-banner").hidden, true);
  assert.equal(dismissCase.getServerState(), "pending");
  for (const poll of dismissCase.intervals) await poll();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dismissCase.getServerState(), "dismissed");
  assert.equal(dismissCase.getEl("star-milestone-banner").hidden, true);
});

test("star-7: Multi-process lock prevents lost updates; SidecarApp blocks __proto__ smuggling; HTTP server handles malformed URLs", async () => {
  const tmpDir = makeTmpDir("agy-cmd-race-");
  try {
    // 1. Multi-process stress test: 5 workers x 8 retry increments + 1 concurrent starPrompt writer
    const workerCode = `
      import { recordAutoRetryStat, setStarPromptState } from "./hooks/lib/settings.mjs";
      const [mode, dir] = process.argv.slice(1);
      if (mode === "star") {
        setStarPromptState(dir, "clicked");
      } else {
        for (let i = 0; i < 8; i++) {
          recordAutoRetryStat(dir, "conv-" + i);
        }
      }
    `;
    const procs = [];
    for (let i = 0; i < 6; i++) {
      const mode = i === 3 ? "star" : "retry";
      procs.push(
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", workerCode, mode, tmpDir], {
            cwd: ROOT,
            stdio: "ignore",
            windowsHide: true
          });
          child.on("error", reject);
          child.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`worker ${mode} exited ${code}`))
          );
        })
      );
    }
    await Promise.all(procs);
    const finalSettings = readSettings(tmpDir);
    assert.equal(finalSettings.stats.totalAutoRetries, 40, "Zero retry increments may be lost under concurrency");
    assert.equal(finalSettings.starPrompt.state, "clicked", "Terminal starPrompt must survive concurrent retry writes");

    // 2. SidecarApp Object.assign(__proto__) smuggling must return 400
    const routes = new Map();
    registerSidecarRoutes(
      {
        config: { conversationId: "proto-conv" },
        api(p, fn) {
          routes.set(p, fn);
        }
      },
      { stateDir: path.join(tmpDir, "proto-state") }
    );
    const protoSmuggled = Object.assign({}, JSON.parse('{"__proto__":{"state":"clicked","evil":1}}'));
    const protoRes = await routes.get("/api/star-prompt")(protoSmuggled);
    assert.equal(protoRes?.status, 400, "__proto__ smuggled state must be rejected with 400");

    // 3. Standalone HTTP server rejects malformed request targets (400) & missing Host (403) without crashing
    const srv = createStandaloneServer({ stateDir: tmpDir, csrfToken: "url-guard-token" });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    try {
      const sendRawHttp = (rawReq) =>
        new Promise((resolve, reject) => {
          const sock = net.connect(port, "127.0.0.1", () => sock.write(rawReq));
          let resp = "";
          sock.on("data", (d) => {
            resp += d.toString("utf8");
          });
          sock.on("end", () => resolve(resp));
          sock.on("error", reject);
        });

      const badUrlResp = await sendRawHttp(
        `GET http://[::1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`
      );
      assert.match(badUrlResp, /^HTTP\/1\.1 400 /);

      const emptyHostResp = await sendRawHttp(
        `GET / HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n`
      );
      assert.match(emptyHostResp, /^HTTP\/1\.1 403 /);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
