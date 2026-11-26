#!/usr/bin/env node
/**
 * agy-cmd Right-Hand Auxiliary Sidecar Server:
 * Runs natively inside Antigravity via `sidecar_sdk` (`SidecarApp` with POST-only
 * token-authenticated `/api/*` endpoints), and supports standalone loopback HTTP
 * mode (`127.0.0.1`) for local browser preview and automated integration tests.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDirectRun, resolveStateDir } from "../../hooks/lib/common.mjs";
import {
  AUTO_UPDATE_ACK_ROUTE,
  dispatchPanelApi,
  handleAutoUpdateAck,
  handlePluginUpdate,
  handleVersionCheck,
  isAllowedLocalRequest,
  isPluginUpdateBusy,
  NO_STORE_HEADERS,
  runAutoUpdateCycle,
  timingSafeEqualStr
} from "./api-handler.mjs";
import { readLocalVersion, VERSION_ROUTE } from "./version-check.mjs";
import { hasActiveUpdateMarker, UPDATE_MARKER_NAME, UPDATE_ROUTE } from "./version-update.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "index.html");
const MAX_BODY_BYTES = 32 * 1024;
const WATCHED_BACKEND_FILES = [
  fileURLToPath(import.meta.url),
  path.resolve(__dirname, "../../plugin.json"),
  path.join(__dirname, "api-handler.mjs"),
  path.join(__dirname, "version-check.mjs"),
  path.join(__dirname, "update-archive.mjs"),
  path.join(__dirname, "version-update.mjs"),
  path.resolve(__dirname, "../../hooks/lib/settings.mjs"),
  path.resolve(__dirname, "../../hooks/lib/state.mjs"),
  path.resolve(__dirname, "../../hooks/lib/common.mjs")
];

function snapshotBackendMtimes() {
  return WATCHED_BACKEND_FILES.map((fp) => {
    try {
      return fs.statSync(fp).mtimeMs;
    } catch {
      return 0;
    }
  }).join("|");
}

export function renderPanelHtml(csrfToken = "") {
  const tpl = fs.readFileSync(HTML_PATH, "utf8");
  const localVer = readLocalVersion();
  const withVersion = localVer
    ? tpl.replace(/<span class="ver-pill">v[^<]*<\/span>/, `<span class="ver-pill">v${localVer}</span>`)
    : tpl;
  return withVersion.replace(/__AGY_CMD_CSRF__/g, csrfToken);
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const declaredLenRaw = req.headers?.["content-length"];
    if (declaredLenRaw !== undefined) {
      const declaredLen = Number(declaredLenRaw);
      if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
        req.on("error", () => {});
        try {
          req.pause();
        } catch {}
        finish({ ok: false, status: 413, error: "Payload too large" });
        return;
      }
    }

    let raw = "";
    let bytes = 0;
    let overflow = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (settled || overflow) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > maxBytes) {
        overflow = true;
        raw = "";
        try {
          req.pause();
        } catch {}
        finish({ ok: false, status: 413, error: "Payload too large" });
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (settled || overflow) return;
      if (!raw.trim()) {
        finish({ ok: true, data: {} });
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          finish({ ok: false, status: 400, error: "Request body must be a JSON object" });
          return;
        }
        finish({ ok: true, data: parsed });
      } catch {
        finish({ ok: false, status: 400, error: "Malformed JSON body" });
      }
    });
    req.on("error", () => {
      finish({ ok: false, status: 400, error: "Request stream error" });
    });
  });
}

function scheduleOversizedSocketClose(req, res) {
  res.once("finish", () => {
    const closeTimer = setTimeout(() => {
      try {
        req.destroy();
      } catch {}
    }, 150);
    closeTimer.unref?.();
  });
}

export function createStandaloneServer({
  stateDir = resolveStateDir(process.env),
  csrfToken = crypto.randomBytes(24).toString("hex"),
  versionChecker = null,
  pluginUpdater = null,
  autoUpdateCheckEnabled = null,
  onUpdated = null,
  onAutoInstallEnabled = null
} = {}) {
  const sendJson = (res, status, payload, extraHeaders = {}) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      ...NO_STORE_HEADERS,
      ...extraHeaders
    });
    res.end(JSON.stringify(payload));
  };

  return http.createServer(async (req, res) => {
    try {
      if (!isAllowedLocalRequest(req)) {
        sendJson(res, 403, { ok: false, error: "Forbidden origin or host" });
        return;
      }

      const rawUrl = typeof req.url === "string" ? req.url : "/";
      let url;
      try {
        if (!rawUrl.startsWith("/")) {
          throw new Error("Origin-form request target required");
        }
        url = new URL(rawUrl, "http://127.0.0.1");
      } catch {
        sendJson(res, 400, { ok: false, error: "Malformed request URL" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        const html = renderPanelHtml(csrfToken);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          ...NO_STORE_HEADERS
        });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/preload.js") {
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          ...NO_STORE_HEADERS
        });
        res.end("/* standalone noop preload */\n");
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "Method Not Allowed (use POST)" }, { Allow: "POST" });
          return;
        }
        const providedToken = String(req.headers["x-agy-cmd-csrf"] || "");
        if (!timingSafeEqualStr(providedToken, csrfToken)) {
          sendJson(res, 401, { ok: false, error: "Invalid or missing CSRF token" });
          return;
        }
        const contentType = String(req.headers["content-type"] || "").trim();
        if (!/^application\/json(?:\s*;.*)?$/i.test(contentType)) {
          sendJson(res, 415, { ok: false, error: "Unsupported Media Type (expected application/json)" });
          return;
        }
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          if (parsed.status === 413) {
            scheduleOversizedSocketClose(req, res);
          }
          sendJson(
            res,
            parsed.status,
            { ok: false, error: parsed.error },
            parsed.status === 413 ? { Connection: "close" } : {}
          );
          return;
        }
        if (url.pathname === VERSION_ROUTE) {
          const out = await handleVersionCheck(parsed.data, {
            stateDir,
            checker: versionChecker,
            autoCheckEnabled: autoUpdateCheckEnabled
          });
          sendJson(res, out.status, out.body);
          return;
        }
        if (url.pathname === UPDATE_ROUTE) {
          const out = await handlePluginUpdate(parsed.data, {
            stateDir,
            updater: pluginUpdater,
            onUpdated
          });
          sendJson(res, out.status, out.body);
          return;
        }
        if (url.pathname === AUTO_UPDATE_ACK_ROUTE) {
          const out = handleAutoUpdateAck(stateDir, parsed.data);
          sendJson(res, out.status, out.body);
          return;
        }
        const out = dispatchPanelApi(url.pathname, parsed.data, { stateDir });
        if (
          url.pathname === "/api/settings" &&
          out.status === 200 &&
          parsed.data?.autoUpdateInstall === true &&
          typeof onAutoInstallEnabled === "function"
        ) {
          void Promise.resolve(onAutoInstallEnabled()).catch(() => {});
        }
        sendJson(res, out.status, out.body);
        return;
      }

      res.writeHead(404, NO_STORE_HEADERS);
      res.end("Not Found");
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: "Internal server error" });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
}

export function registerSidecarRoutes(
  app,
  {
    stateDir = resolveStateDir(process.env),
    csrfToken = "",
    SidecarResponse = null,
    versionChecker = null,
    pluginUpdater = null,
    autoUpdateCheckEnabled = null,
    onUpdated = null,
    onAutoInstallEnabled = null
  } = {}
) {
  const wrapJson = (out) => {
    const serialized = JSON.stringify(out.body);
    if (SidecarResponse) {
      return new SidecarResponse(serialized, {
        status: out.status,
        contentType: "application/json; charset=utf-8",
        headers: NO_STORE_HEADERS
      });
    }
    if (out.status >= 400) {
      return { ...out.body, status: out.status };
    }
    return out.body;
  };

  if (typeof app.page === "function") {
    app.page("/", () => {
      const html = renderPanelHtml(csrfToken);
      if (SidecarResponse) {
        return new SidecarResponse(html, {
          status: 200,
          contentType: "text/html; charset=utf-8",
          headers: NO_STORE_HEADERS
        });
      }
      return html;
    });
  }

  for (const route of ["/api/state", "/api/settings", "/api/dismiss-onboarding", "/api/star-prompt"]) {
    app.api(
      route,
      (rawData) => {
        const out = dispatchPanelApi(route, rawData, {
          stateDir,
          defaultConvId: app.config?.conversationId || ""
        });
        if (
          route === "/api/settings" &&
          out.status === 200 &&
          rawData?.autoUpdateInstall === true &&
          typeof onAutoInstallEnabled === "function"
        ) {
          void Promise.resolve(onAutoInstallEnabled()).catch(() => {});
        }
        return wrapJson(out);
      },
      "POST"
    );
  }

  app.api(
    VERSION_ROUTE,
    async (rawData) =>
      wrapJson(
        await handleVersionCheck(rawData, {
          stateDir,
          checker: versionChecker,
          autoCheckEnabled: autoUpdateCheckEnabled
        })
      ),
    "POST"
  );

  app.api(
    UPDATE_ROUTE,
    async (rawData) =>
      wrapJson(
        await handlePluginUpdate(rawData, {
          stateDir,
          updater: pluginUpdater,
          onUpdated
        })
      ),
    "POST"
  );

  app.api(
    AUTO_UPDATE_ACK_ROUTE,
    (rawData) => wrapJson(handleAutoUpdateAck(stateDir, rawData)),
    "POST"
  );
}

function shouldUseSidecarSdk(env, hasSidecarApp) {
  if (!hasSidecarApp) return false;
  if (env.SIDECAR_FORCE_HTTP === "1") return false;
  return Boolean(
    env.ANTIGRAVITY_LS_ADDRESS?.trim() &&
      env.ANTIGRAVITY_CSRF_TOKEN?.trim() &&
      env.ANTIGRAVITY_SIDECAR_WEB_PORT?.trim() &&
      env.ANTIGRAVITY_SIDECAR_UI_TOKEN?.trim()
  );
}

async function start() {
  const stateDir = resolveStateDir(process.env);
  const csrfToken = crypto.randomBytes(24).toString("hex");

  let SidecarApp = null;
  let SidecarResponse = null;
  try {
    const userSdk = path.join(os.homedir(), ".gemini", "config", "node_modules", "sidecar_sdk", "index.mjs");
    const mod = await import(pathToFileURL(userSdk).href);
    SidecarApp = mod.SidecarApp;
    SidecarResponse = mod.Response || null;
  } catch {
    try {
      const mod = await import("sidecar_sdk");
      SidecarApp = mod.SidecarApp;
      SidecarResponse = mod.Response || null;
    } catch {
      // Standalone mode
    }
  }

  if (shouldUseSidecarSdk(process.env, Boolean(SidecarApp))) {
    const bootSig = snapshotBackendMtimes();
    const updateMarkerPath = path.join(__dirname, "../..", UPDATE_MARKER_NAME);
    const reloadTimer = setInterval(() => {
      if (isPluginUpdateBusy() || hasActiveUpdateMarker(updateMarkerPath)) {
        return;
      }
      const nextSig = snapshotBackendMtimes();
      if (nextSig !== bootSig && !nextSig.split("|").includes("0")) {
        clearInterval(reloadTimer);
        // sidecar.json configures `"restart_policy": "always"`, so exiting 0 lets
        // Antigravity respawn server.mjs with newly synced ESM modules automatically.
        process.exit(0);
      }
    }, 2500);
    reloadTimer.unref?.();

    const scheduleSidecarRestart = () => {
      const restartTimer = setTimeout(() => {
        process.exit(0);
      }, 450);
      restartTimer.unref?.();
    };
    const triggerBackgroundAutoUpdate = () =>
      runAutoUpdateCycle({ stateDir, onUpdated: scheduleSidecarRestart }).catch(() => {});

    const app = new SidecarApp();
    registerSidecarRoutes(app, {
      stateDir,
      csrfToken,
      SidecarResponse,
      onUpdated: scheduleSidecarRestart,
      onAutoInstallEnabled: triggerBackgroundAutoUpdate
    });
    await app.run();

    const startupCheckTimer = setTimeout(() => {
      void triggerBackgroundAutoUpdate();
    }, 1500);
    startupCheckTimer.unref?.();

    const periodicAutoCheckTimer = setInterval(() => {
      void triggerBackgroundAutoUpdate();
    }, 6 * 60 * 60_000);
    periodicAutoCheckTimer.unref?.();
    return;
  }

  const rawPort = Number.parseInt(process.env.AGY_CMD_PANEL_PORT || "0", 10);
  const port = Number.isFinite(rawPort) && rawPort >= 0 ? rawPort : 0;
  const server = createStandaloneServer({ stateDir, csrfToken });
  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    console.log(`[agy-cmd panel] listening at http://127.0.0.1:${boundPort}`);
  });
}

if (isDirectRun(import.meta.url)) {
  start().catch((err) => {
    console.error("[agy-cmd panel] fatal startup error:", err?.message || err);
    process.exit(1);
  });
}
