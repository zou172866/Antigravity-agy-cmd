import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { deflateRawSync, gzipSync } from "node:zlib";

import { readSettings, updateSettings } from "../hooks/lib/settings.mjs";
import {
  AUTO_UPDATE_ACK_ROUTE,
  handlePluginUpdate,
  handleVersionCheck,
  isAutoUpdateInstallEnabled,
  isPluginUpdateBusy,
  resetUpdateRuntimeFlags,
  runAutoUpdateCycle
} from "../sidecars/panel/api-handler.mjs";
import { createStandaloneServer, registerSidecarRoutes, renderPanelHtml } from "../sidecars/panel/server.mjs";
import {
  computeCrc32,
  downloadArchive,
  readReleaseArchive,
  readTarGzArchive,
  readZipArchive,
  UpdateError,
  verifyArchiveSha256
} from "../sidecars/panel/update-archive.mjs";
import {
  compareVersions,
  createVersionChecker,
  LATEST_RELEASE_API,
  parseVersion,
  readLocalVersion,
  REPO,
  selectReleasePackageAsset,
  VERSION_ROUTE
} from "../sidecars/panel/version-check.mjs";
import {
  createPluginUpdater,
  evaluateAutoInstallEligibility,
  extractStaticRelativeImports,
  hasActiveUpdateMarker,
  isValidVerifierRole,
  preservePinnedNodeCommand,
  resolveInstalledRoot,
  shouldPreserveExecutableMode,
  UPDATE_MARKER_NAME,
  UPDATE_ROUTE
} from "../sidecars/panel/version-update.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function makeTmpDir(prefix = "agy-cmd-upd-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function makeTarHeader(name, size, typeChar = "0") {
  const header = Buffer.alloc(512, 0);
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.length <= 100) {
    nameBytes.copy(header, 0);
  } else {
    const slash = name.lastIndexOf("/");
    const prefix = name.slice(0, slash);
    const base = name.slice(slash + 1);
    Buffer.from(base, "utf8").copy(header, 0, 0, 100);
    Buffer.from(prefix, "utf8").copy(header, 345, 0, 155);
  }
  Buffer.from("0000644\0", "latin1").copy(header, 100);
  Buffer.from("0000000\0", "latin1").copy(header, 108);
  Buffer.from("0000000\0", "latin1").copy(header, 116);
  Buffer.from(`${size.toString(8).padStart(11, "0")}\0`, "latin1").copy(header, 124);
  Buffer.from("00000000000\0", "latin1").copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = typeChar.charCodeAt(0);
  Buffer.from("ustar\0", "latin1").copy(header, 257);
  Buffer.from("00", "latin1").copy(header, 263);
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "latin1").copy(header, 148);
  return header;
}

function padTarBlock(buf) {
  const rem = buf.length % 512;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem, 0)]);
}

function makePaxRecord(key, val) {
  const suffix = ` ${key}=${val}\n`;
  let len = Buffer.byteLength(suffix, "utf8") + 1;
  while (true) {
    const line = `${len}${suffix}`;
    const byteLen = Buffer.byteLength(line, "utf8");
    if (byteLen === len) return Buffer.from(line, "utf8");
    len = byteLen;
  }
}

function buildTarGz(entries, { globalCommentHex = "" } = {}) {
  const chunks = [];
  if (globalCommentHex) {
    const paxBody = makePaxRecord("comment", globalCommentHex);
    chunks.push(makeTarHeader("pax_global_header", paxBody.length, "g"), padTarBlock(paxBody));
  }
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content || "", "utf8");
    if (entry.paxRecords) {
      const paxBody = Buffer.isBuffer(entry.paxRecords)
        ? entry.paxRecords
        : Buffer.concat(entry.paxRecords.map(([k, v]) => makePaxRecord(k, v)));
      chunks.push(makeTarHeader("PaxHeaders/entry", paxBody.length, "x"), padTarBlock(paxBody));
    }
    const typeChar = entry.type || (entry.path.endsWith("/") ? "5" : "0");
    chunks.push(makeTarHeader(entry.headerPath || entry.path, typeChar === "5" ? 0 : data.length, typeChar));
    if (typeChar !== "5" && data.length > 0) {
      chunks.push(padTarBlock(data));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks));
}

function buildZip(entries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.path, "utf8");
    const localNameBytes = entry.localPath ? Buffer.from(entry.localPath, "utf8") : nameBytes;
    const rawData = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content || "", "utf8");
    const method = entry.method ?? (rawData.length > 0 ? 8 : 0);
    const compData = method === 8 ? deflateRawSync(rawData) : rawData;
    const crc = entry.crcOverride ?? computeCrc32(rawData);
    const flags = entry.flags ?? 0;
    const versionMadeBy = entry.versionMadeBy ?? 0x0314; // Unix
    const extAttr = entry.extAttr ?? (entry.path.endsWith("/") ? 0o040755 << 16 : 0o100644 << 16);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compData.length, 18);
    local.writeUInt32LE(rawData.length, 22);
    local.writeUInt16LE(localNameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, localNameBytes, compData);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(versionMadeBy, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(compData.length, 20);
    cd.writeUInt32LE(rawData.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(extAttr >>> 0, 38);
    cd.writeUInt32LE(offset, 42);

    cdParts.push(cd, nameBytes);
    offset += local.length + localNameBytes.length + compData.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function collectRepoBundleFiles(versionOverride = null, extraOverrides = {}) {
  const rootFiles = ["plugin.json", "hooks.json", "package.json", "README.md", "README.zh-CN.md", "install.ps1", "install.sh"];
  const dirs = ["assets", "rules", "agents", "hooks", "sidecars", "skills", "test"];
  const files = new Map();

  for (const rel of rootFiles) {
    const abs = path.join(REPO_ROOT, rel);
    if (fs.existsSync(abs)) files.set(rel, fs.readFileSync(abs));
  }

  function walk(dirRel) {
    const absDir = path.join(REPO_ROOT, dirRel);
    if (!fs.existsSync(absDir)) return;
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (ent.name === "__pycache__" || ent.name.endsWith(".pyc") || ent.name.endsWith(".pyo")) continue;
      const rel = `${dirRel}/${ent.name}`;
      if (ent.isDirectory()) walk(rel);
      else files.set(rel, fs.readFileSync(path.join(REPO_ROOT, rel)));
    }
  }
  for (const d of dirs) walk(d);

  if (versionOverride) {
    const pluginJson = JSON.parse(files.get("plugin.json").toString("utf8"));
    pluginJson.version = versionOverride;
    files.set("plugin.json", Buffer.from(JSON.stringify(pluginJson, null, 2) + "\n", "utf8"));

    const pkgJson = JSON.parse(files.get("package.json").toString("utf8"));
    pkgJson.version = versionOverride;
    files.set("package.json", Buffer.from(JSON.stringify(pkgJson, null, 2) + "\n", "utf8"));
  }

  for (const [rel, val] of Object.entries(extraOverrides)) {
    if (val === null) files.delete(rel);
    else files.set(rel, Buffer.isBuffer(val) ? val : Buffer.from(String(val), "utf8"));
  }
  return files;
}

function writeBundleToDir(targetRoot, filesMap) {
  for (const [rel, bytes] of filesMap) {
    const abs = path.join(targetRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
  }
}

function packBundleAsZip(filesMap, topDir = "agy-cmd-v2.5.0") {
  const entries = [{ path: `${topDir}/`, content: "", method: 0 }];
  for (const [rel, bytes] of filesMap) {
    entries.push({ path: `${topDir}/${rel}`, content: bytes });
  }
  return buildZip(entries);
}

function packBundleAsTarGz(filesMap, topDir = "zou172866-Antigravity-agy-cmd-abcdef0") {
  const entries = [{ path: `${topDir}/`, content: "", type: "5" }];
  for (const [rel, bytes] of filesMap) {
    entries.push({ path: `${topDir}/${rel}`, content: bytes });
  }
  return buildTarGz(entries, { globalCommentHex: "a".repeat(40) });
}

function httpRawRequest(port, urlPath, { method = "POST", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { Host: `127.0.0.1:${port}`, ...headers };
    if (body !== null && body !== undefined && reqHeaders["Content-Length"] === undefined) {
      reqHeaders["Content-Length"] = Buffer.byteLength(body, "utf8");
    }
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers: reqHeaders },
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

test("version-check: SemVer parsing, comparison, ZIP/TGZ asset selection, rate-limit backoff & no-error-cache", async () => {
  assert.equal(parseVersion("v2.4.1")?.version, "2.4.1");
  assert.equal(parseVersion("2.5.0-beta.1")?.version, "2.5.0-beta.1");
  assert.equal(parseVersion("2.5.0-01"), null);
  assert.equal(parseVersion("not-semver"), null);

  assert.equal(compareVersions("2.4.1", "2.4.0"), 1);
  assert.equal(compareVersions("2.4.1", "2.4.1"), 0);
  assert.equal(compareVersions("2.4.1", "2.10.0"), -1);
  assert.equal(compareVersions("2.5.0-rc.1", "2.5.0"), -1);
  assert.equal(compareVersions("bad", "2.4.1"), null);

  // Local version reads plugin.json cleanly
  assert.equal(readLocalVersion(REPO_ROOT), JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "plugin.json"), "utf8")).version);

  const validHash = "b".repeat(64);
  const zipAsset = selectReleasePackageAsset(
    [
      {
        name: "SHA256SUMS.txt",
        browser_download_url: `https://github.com/${REPO}/releases/download/v2.5.0/SHA256SUMS.txt`,
        digest: `sha256:${validHash}`
      },
      {
        name: "agy-cmd-v2.5.0.zip",
        browser_download_url: `https://github.com/${REPO}/releases/download/v2.5.0/agy-cmd-v2.5.0.zip`,
        digest: `sha256:${validHash}`
      }
    ],
    "2.5.0"
  );
  assert.deepEqual(zipAsset, {
    assetName: "agy-cmd-v2.5.0.zip",
    assetUrl: `https://github.com/${REPO}/releases/download/v2.5.0/agy-cmd-v2.5.0.zip`,
    assetSha256: validHash,
    assetFormat: "zip"
  });

  // Rejects bad host prefix or malformed digest
  assert.equal(
    selectReleasePackageAsset(
      [
        {
          name: "agy-cmd-v2.5.0.zip",
          browser_download_url: "https://evil.example/agy-cmd-v2.5.0.zip",
          digest: `sha256:${validHash}`
        },
        {
          name: "agy-cmd-2.5.0.tgz",
          browser_download_url: `https://github.com/${REPO}/releases/download/v2.5.0/agy-cmd-2.5.0.tgz`,
          digest: "sha256:short"
        }
      ],
      "2.5.0"
    ),
    null
  );

  // Error must NOT poison 5s manual dedupe cache; fresh:true forces refresh
  let t = 10_000;
  let calls = 0;
  const checker = createVersionChecker({
    getCurrentVersion: () => "2.4.1",
    now: () => t,
    fetchImpl: async (url, opts) => {
      assert.equal(url, LATEST_RELEASE_API);
      assert.equal(opts.redirect, "error");
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET");
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({
          tag_name: "v2.5.0",
          draft: false,
          prerelease: false,
          published_at: "2026-11-26T00:00:00Z",
          assets: [
            {
              name: "agy-cmd-v2.5.0.zip",
              browser_download_url: `https://github.com/${REPO}/releases/download/v2.5.0/agy-cmd-v2.5.0.zip`,
              digest: `sha256:${validHash}`
            }
          ]
        })
      };
    }
  });

  const errRes = await checker("manual");
  assert.equal(errRes.status, "error");
  assert.equal(errRes.reason, "network");

  // Retry 1s later immediately re-fetches instead of serving stale cached error
  t += 1000;
  const okRes = await checker("manual");
  assert.equal(okRes.status, "update");
  assert.equal(okRes.latestVersion, "2.5.0");
  assert.equal(okRes.assetName, "agy-cmd-v2.5.0.zip");
  assert.equal(calls, 2);

  // Within 5s, normal manual reuses cached success; fresh:true forces a new fetch
  t += 1000;
  assert.equal((await checker("manual")).latestVersion, "2.5.0");
  assert.equal(calls, 2);
  assert.equal((await checker("manual", { fresh: true })).latestVersion, "2.5.0");
  assert.equal(calls, 3);

  // Auto mode swallows errors quietly and returns idle; rate-limit 429 caches retryAt
  let rlCalls = 0;
  let rlNow = 50_000;
  const rlChecker = createVersionChecker({
    getCurrentVersion: () => "2.4.1",
    now: () => rlNow,
    fetchImpl: async () => {
      rlCalls += 1;
      return {
        ok: false,
        status: 429,
        headers: new Map([["retry-after", "120"]]),
        json: async () => ({ message: "API rate limit exceeded" })
      };
    }
  });
  const autoRl = await rlChecker("auto");
  assert.deepEqual(autoRl, { ok: true, status: "idle", currentVersion: "2.4.1" });
  const manualRl = await rlChecker("manual");
  assert.equal(manualRl.status, "error");
  assert.equal(manualRl.reason, "rateLimit");
  assert.equal(manualRl.retryAt, 50_000 + 120_000);
  assert.equal(rlCalls, 1, "Rate-limit deadline prevents hammering GitHub API");
});

test("update-archive: download allowlist + SHA-256 + pure-JS ZIP & TAR.GZ/PAX parsing & attack rejections", async () => {
  const payload = Buffer.from("hello-agy-cmd");
  const digest = sha256Hex(payload);
  verifyArchiveSha256(payload, digest);
  assert.throws(() => verifyArchiveSha256(payload, "0".repeat(64)), (e) => e instanceof UpdateError && e.reason === "integrity");

  // Multi-hop allowlisted redirect succeeds with SHA-256 check
  const visited = [];
  const dlBuf = await downloadArchive(`https://github.com/${REPO}/releases/download/v2.5.0/agy-cmd-v2.5.0.zip`, {
    expectedSha256: digest,
    fetchImpl: async (url) => {
      visited.push(url);
      if (visited.length === 1) {
        return {
          ok: false,
          status: 302,
          headers: new Map([["location", "https://release-assets.githubusercontent.com/pkg.zip"]])
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map([["content-length", String(payload.length)]]),
        arrayBuffer: async () => payload
      };
    }
  });
  assert.deepEqual(dlBuf, payload);
  assert.equal(visited.length, 2);

  // Disallowed redirect host rejected
  await assert.rejects(
    downloadArchive(`https://github.com/${REPO}/releases/download/v2.5.0/agy-cmd-v2.5.0.zip`, {
      fetchImpl: async () => ({
        ok: false,
        status: 302,
        headers: new Map([["location", "https://evil.example/payload.zip"]])
      })
    }),
    (e) => e instanceof UpdateError && e.reason === "redirect"
  );

  // Oversized archive rejected
  await assert.rejects(
    downloadArchive("https://codeload.github.com/a/b/tar.gz/v2.5.0", {
      maxBytes: 4,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Map([["content-length", "10"]]),
        arrayBuffer: async () => Buffer.alloc(10)
      })
    }),
    (e) => e instanceof UpdateError && e.reason === "size"
  );

  // ZIP Stored + Deflate extraction
  const goodZip = buildZip([
    { path: "agy-cmd-v2.5.0/", content: "", method: 0 },
    { path: "agy-cmd-v2.5.0/plugin.json", content: '{"name":"agy-cmd"}', method: 0 },
    { path: "agy-cmd-v2.5.0/hooks/stop.mjs", content: "export const ok = true;\n".repeat(20), method: 8 }
  ]);
  const zipMap = await readReleaseArchive(goodZip);
  assert.equal(zipMap.get("plugin.json").toString("utf8"), '{"name":"agy-cmd"}');
  assert.match(zipMap.get("hooks/stop.mjs").toString("utf8"), /export const ok = true;/);

  // ZIP security rejections: bad CRC, encrypted flag, symlink, path traversal, Windows reserved, local-vs-CD mismatch, size bomb
  await assert.rejects(
    readZipArchive(buildZip([{ path: "root/a.txt", content: "abc", crcOverride: 0xdeadbeef }])),
    (e) => e instanceof UpdateError && e.reason === "archive"
  );
  await assert.rejects(
    readZipArchive(buildZip([{ path: "root/a.txt", content: "abc", flags: 0x0001 }])),
    (e) => e instanceof UpdateError && e.reason === "archive"
  );
  await assert.rejects(
    readZipArchive(buildZip([{ path: "root/link", content: "/etc/passwd", extAttr: 0o120777 << 16 }])),
    (e) => e instanceof UpdateError && e.reason === "archive"
  );
  await assert.rejects(
    readZipArchive(buildZip([{ path: "root/../evil.txt", content: "x" }])),
    (e) => e instanceof UpdateError && e.reason === "archive"
  );
  await assert.rejects(
    readZipArchive(buildZip([{ path: "root/CON.txt", content: "x" }])),
    (e) => e instanceof UpdateError && e.reason === "archive"
  );
  await assert.rejects(
    readZipArchive(buildZip([{ path: "root/a.txt", localPath: "root/b.txt", content: "x" }])),
    (e) => e instanceof UpdateError && e.reason === "archive"
  );
  await assert.rejects(
    readZipArchive(buildZip([{ path: "root/big.txt", content: "x".repeat(2048), method: 8 }]), 512),
    (e) => e instanceof UpdateError && e.reason === "size"
  );

  // TAR.GZ with GitHub 64-hex global pax comment + per-entry PAX long path & size
  const longRel = `skills/agy-cmd/${"nested/".repeat(20)}guide.md`;
  const tarGz = buildTarGz(
    [
      {
        path: "root/short-placeholder",
        headerPath: "root/short-placeholder",
        content: "# ok\n",
        paxRecords: [
          ["path", `root/${longRel}`],
          ["size", "5"]
        ]
      }
    ],
    { globalCommentHex: "f".repeat(64) }
  );
  const tarMap = await readReleaseArchive(tarGz);
  assert.equal(tarMap.get(longRel).toString("utf8"), "# ok\n");

  // TAR.GZ rejects invalid UTF-8 inside PAX header cleanly as UpdateError("archive")
  const badPaxTar = buildTarGz([
    {
      path: "root/a.txt",
      content: "x",
      paxRecords: Buffer.concat([Buffer.from("12 path="), Buffer.from([0xff, 0xfe, 0xfd, 0x0a])])
    }
  ]);
  await assert.rejects(readTarGzArchive(badPaxTar), (e) => e instanceof UpdateError && e.reason === "archive");
});

test("version-update: atomic ZIP & TAR.GZ self-update, case-insensitive FS, rollback/recovery, stale locks, EPERM & verifier guard", async () => {
  const tmpBase = makeTmpDir("agy-cmd-install-");
  try {
    // 1. Static relative import extraction supports single-line and multi-line named imports
    const extracted = extractStaticRelativeImports(
      `import fs from "node:fs";\nimport {\n  foo,\n  bar\n} from "./api-handler.mjs";\nimport "./side-effect.mjs";\nexport { baz } from "../lib/helper.mjs";\n`
    );
    assert.deepEqual(extracted.sort(), ["../lib/helper.mjs", "./api-handler.mjs", "./side-effect.mjs"]);

    // 2. Verifier role check mirrors setup_auto_router.py
    const realVerifier = fs.readFileSync(path.join(REPO_ROOT, "agents/cmd-verifier.md"), "utf8");
    assert.equal(isValidVerifierRole(realVerifier), true);
    assert.equal(isValidVerifierRole(realVerifier.replace('["read_file"]', '["read_file", "run_command"]')), false);
    assert.equal(isValidVerifierRole(realVerifier.replace("inheritMcp: false", "inheritMcp: true")), false);

    // 3. Full ZIP self-update (2.4.0 -> 2.5.0): preserves Windows node.exe, rules/*.local.md, .gitignore, removes obsolete files
    const pluginsDir = path.join(tmpBase, "cfg", "plugins");
    const installedRoot = path.join(pluginsDir, "agy-cmd");
    const initialFiles = collectRepoBundleFiles("2.4.0", {
      "sidecars/panel/sidecar.json": JSON.stringify(
        {
          command: "C:\\Program Files\\nodejs\\node.exe",
          args: ["server.mjs"],
          restart_policy: "always"
        },
        null,
        2
      ),
      "obsolete-old-file.txt": "remove-me",
      "rules/user-note.local.md": "keep-local-rule",
      ".gitignore": "node_modules/\n",
      "skills/agy-cmd/CaseFile.md": "old-case"
    });
    writeBundleToDir(installedRoot, initialFiles);

    const nextFiles = collectRepoBundleFiles("2.5.0", {
      "skills/agy-cmd/casefile.md": "new-case-v250"
    });
    const nextZip = packBundleAsZip(nextFiles, "agy-cmd-v2.5.0");
    const nextSha = sha256Hex(nextZip);
    const assetUrl = `https://github.com/${REPO}/releases/download/v2.5.0/agy-cmd-v2.5.0.zip`;

    // Plant a dead-PID orphan lock to verify automatic reclamation
    fs.writeFileSync(
      path.join(installedRoot, UPDATE_MARKER_NAME),
      JSON.stringify({ pid: 99999999, startedAt: Date.now() - 5000, phase: "replacing" }) + "\n"
    );
    assert.equal(
      hasActiveUpdateMarker(path.join(installedRoot, UPDATE_MARKER_NAME), { isPidAlive: () => false }),
      false
    );

    const updater = createPluginUpdater({
      sidecarDirectory: path.join(installedRoot, "sidecars", "panel"),
      pluginsDirectory: pluginsDir,
      caseInsensitiveFs: true,
      markerOptions: { isPidAlive: (pid) => pid === process.pid },
      checkVersion: async () => ({
        ok: true,
        status: "update",
        currentVersion: "2.4.0",
        latestVersion: "2.5.0",
        releaseTag: "v2.5.0",
        releaseUrl: `https://github.com/${REPO}/releases/tag/v2.5.0`,
        assetName: "agy-cmd-v2.5.0.zip",
        assetUrl,
        assetSha256: nextSha,
        assetFormat: "zip"
      }),
      downloadOptions: {
        fetchImpl: async (url) => {
          assert.equal(url, assetUrl);
          return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => nextZip };
        }
      }
    });

    const updRes = await updater("2.5.0");
    assert.equal(updRes.ok, true);
    assert.equal(updRes.status, "updated");
    assert.equal(updRes.previousVersion, "2.4.0");
    assert.equal(updRes.version, "2.5.0");
    assert.equal(updRes.verifiedSha256, nextSha);
    assert.equal(readLocalVersion(installedRoot), "2.5.0");
    assert.equal(fs.existsSync(path.join(installedRoot, "obsolete-old-file.txt")), false);
    assert.equal(fs.readFileSync(path.join(installedRoot, "rules/user-note.local.md"), "utf8"), "keep-local-rule");
    assert.equal(fs.existsSync(path.join(installedRoot, ".gitignore")), true);
    assert.equal(fs.existsSync(path.join(installedRoot, UPDATE_MARKER_NAME)), false);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(installedRoot, "sidecars/panel/sidecar.json"), "utf8")).command,
      "C:\\Program Files\\nodejs\\node.exe",
      "Preserves explicit Windows node.exe sidecar launcher"
    );
    // On case-insensitive FS, case-only renamed file must survive obsolete cleanup
    assert.equal(
      fs.readFileSync(path.join(installedRoot, "skills/agy-cmd/casefile.md"), "utf8"),
      "new-case-v250"
    );

    // 4. TAR.GZ fallback upgrade (2.5.0 -> 2.6.0) when release has no verified ZIP asset
    const v260Tar = packBundleAsTarGz(collectRepoBundleFiles("2.6.0"));
    const tarUpdater = createPluginUpdater({
      sidecarDirectory: path.join(installedRoot, "sidecars", "panel"),
      pluginsDirectory: pluginsDir,
      checkVersion: async () => ({
        ok: true,
        status: "update",
        currentVersion: "2.5.0",
        latestVersion: "2.6.0",
        releaseTag: "v2.6.0",
        releaseUrl: `https://github.com/${REPO}/releases/tag/v2.6.0`
      }),
      downloadOptions: {
        fetchImpl: async (url) => {
          assert.equal(url, `https://api.github.com/repos/${REPO}/tarball/v2.6.0`);
          return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => v260Tar };
        }
      }
    });
    const tarRes = await tarUpdater("2.6.0");
    assert.equal(tarRes.ok, true);
    assert.equal(tarRes.status, "updated");
    assert.equal(readLocalVersion(installedRoot), "2.6.0");

    // 5. Tampered agents/cmd-verifier.md & broken relative import rejected before touching disk
    const badVerifierZip = packBundleAsZip(
      collectRepoBundleFiles("2.7.0", {
        "agents/cmd-verifier.md": realVerifier.replace('["read_file"]', '["read_file", "run_command"]')
      })
    );
    const badVerifierUpdater = createPluginUpdater({
      sidecarDirectory: path.join(installedRoot, "sidecars", "panel"),
      pluginsDirectory: pluginsDir,
      checkVersion: async () => ({
        ok: true,
        status: "update",
        currentVersion: "2.6.0",
        latestVersion: "2.7.0",
        releaseTag: "v2.7.0",
        releaseUrl: `https://github.com/${REPO}/releases/tag/v2.7.0`,
        assetUrl: `https://github.com/${REPO}/releases/download/v2.7.0/agy-cmd-v2.7.0.zip`,
        assetSha256: sha256Hex(badVerifierZip)
      }),
      downloadOptions: {
        fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), arrayBuffer: async () => badVerifierZip })
      }
    });
    const badVerRes = await badVerifierUpdater("2.7.0");
    assert.equal(badVerRes.ok, false);
    assert.equal(badVerRes.reason, "incomplete");
    assert.equal(readLocalVersion(installedRoot), "2.6.0");

    const brokenImportZip = packBundleAsZip(
      collectRepoBundleFiles("2.7.0", {
        "sidecars/panel/server.mjs": 'import {\n  nope\n} from "./does-not-exist.mjs";\n'
      })
    );
    const brokenImportUpdater = createPluginUpdater({
      sidecarDirectory: path.join(installedRoot, "sidecars", "panel"),
      pluginsDirectory: pluginsDir,
      checkVersion: async () => ({
        ok: true,
        status: "update",
        currentVersion: "2.6.0",
        latestVersion: "2.7.0",
        releaseTag: "v2.7.0",
        releaseUrl: `https://github.com/${REPO}/releases/tag/v2.7.0`,
        assetUrl: `https://github.com/${REPO}/releases/download/v2.7.0/agy-cmd-v2.7.0.zip`,
        assetSha256: sha256Hex(brokenImportZip)
      }),
      downloadOptions: {
        fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), arrayBuffer: async () => brokenImportZip })
      }
    });
    assert.equal((await brokenImportUpdater("2.7.0")).reason, "incomplete");

    // 6. Windows EPERM mid-replace triggers full rollback and maps to reason="locked" + restored=true
    const v270Zip = packBundleAsZip(collectRepoBundleFiles("2.7.0"));
    let moveCalls = 0;
    const epermUpdater = createPluginUpdater({
      sidecarDirectory: path.join(installedRoot, "sidecars", "panel"),
      pluginsDirectory: pluginsDir,
      checkVersion: async () => ({
        ok: true,
        status: "update",
        currentVersion: "2.6.0",
        latestVersion: "2.7.0",
        releaseTag: "v2.7.0",
        releaseUrl: `https://github.com/${REPO}/releases/tag/v2.7.0`,
        assetUrl: `https://github.com/${REPO}/releases/download/v2.7.0/agy-cmd-v2.7.0.zip`,
        assetSha256: sha256Hex(v270Zip)
      }),
      downloadOptions: {
        fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), arrayBuffer: async () => v270Zip })
      },
      move: async (from, to) => {
        moveCalls += 1;
        if (moveCalls === 4) {
          const err = new Error("EPERM: operation not permitted");
          err.code = "EPERM";
          throw err;
        }
        return fs.promises.rename(from, to);
      }
    });
    const epermRes = await epermUpdater("2.7.0");
    assert.equal(epermRes.ok, false);
    assert.equal(epermRes.reason, "locked");
    assert.equal(epermRes.diagnostics.restored, true);
    assert.equal(readLocalVersion(installedRoot), "2.6.0");
    assert.equal(fs.existsSync(path.join(installedRoot, UPDATE_MARKER_NAME)), false);

    // 7. Git checkout protection (self-contained fixture so tests also pass from unpacked release ZIPs)
    const fakeGitCheckout = path.join(tmpBase, "fake-git-checkout");
    writeBundleToDir(fakeGitCheckout, collectRepoBundleFiles("2.6.0"));
    fs.mkdirSync(path.join(fakeGitCheckout, ".git"), { recursive: true });
    await assert.rejects(
      resolveInstalledRoot(path.join(fakeGitCheckout, "sidecars", "panel"), { allowCustomRoot: true }),
      (e) => e instanceof UpdateError && e.reason === "gitCheckout"
    );

    // 8. Recovery marker blocks new updates and suppresses reload
    const markerPath = path.join(installedRoot, UPDATE_MARKER_NAME);
    fs.writeFileSync(markerPath, JSON.stringify({ pid: 99999999, startedAt: 1, phase: "recovery" }) + "\n");
    assert.equal(hasActiveUpdateMarker(markerPath, { isPidAlive: () => false }), true);
    assert.equal((await tarUpdater("2.7.0")).reason, "recovery");
    fs.unlinkSync(markerPath);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("server & api-handler: POST+CSRF security on /api/version and /api/update, autoUpdateCheck gating & busy flags", async () => {
  const stateDir = makeTmpDir("agy-cmd-api-");
  const csrf = "self-update-csrf-token-abcdef0123456789";
  resetUpdateRuntimeFlags();

  let checkerCalls = [];
  const fakeChecker = async (mode, opts) => {
    checkerCalls.push({ mode, opts });
    return {
      ok: true,
      status: "update",
      currentVersion: "2.4.1",
      latestVersion: "2.5.0",
      releaseTag: "v2.5.0",
      releaseUrl: `https://github.com/${REPO}/releases/tag/v2.5.0`
    };
  };

  let busyDuringUpdate = false;
  let onUpdatedCalled = false;
  const fakeUpdater = async (ver) => {
    busyDuringUpdate = isPluginUpdateBusy();
    return {
      ok: true,
      status: "updated",
      previousVersion: "2.4.1",
      version: ver,
      releaseTag: `v${ver}`,
      releaseUrl: `https://github.com/${REPO}/releases/tag/v${ver}`
    };
  };

  const server = createStandaloneServer({
    stateDir,
    csrfToken: csrf,
    versionChecker: fakeChecker,
    pluginUpdater: fakeUpdater,
    onUpdated: () => {
      onUpdatedCalled = true;
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // Method / CSRF / Origin / Content-Type enforcement
    for (const route of [VERSION_ROUTE, UPDATE_ROUTE]) {
      const getRes = await httpRawRequest(port, route, { method: "GET", headers: { "X-Agy-Cmd-Csrf": csrf } });
      assert.equal(getRes.status, 405);
      assert.equal(getRes.headers.allow, "POST");

      const noCsrf = await httpRawRequest(port, route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      assert.equal(noCsrf.status, 401);

      const crossSite = await httpRawRequest(port, route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agy-Cmd-Csrf": csrf,
          "Sec-Fetch-Site": "cross-site"
        },
        body: "{}"
      });
      assert.equal(crossSite.status, 403);

      const badCt = await httpRawRequest(port, route, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "X-Agy-Cmd-Csrf": csrf },
        body: "{}"
      });
      assert.equal(badCt.status, 415);
    }

    // Strict input validation -> 400
    for (const bad of [{ mode: "weird" }, { fresh: "yes" }, { mode: "manual", extra: 1 }]) {
      const r = await httpRawRequest(port, VERSION_ROUTE, {
        headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
        body: JSON.stringify(bad)
      });
      assert.equal(r.status, 400);
    }
    for (const bad of [{}, { version: "not-semver" }, { version: "2.5.0", extra: 1 }]) {
      const r = await httpRawRequest(port, UPDATE_ROUTE, {
        headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
        body: JSON.stringify(bad)
      });
      assert.equal(r.status, 400);
    }

    // autoUpdateCheck: false in settings.json blocks mode:"auto" but allows mode:"manual"
    updateSettings(stateDir, { autoUpdateCheck: false });
    const blockedAuto = await httpRawRequest(port, VERSION_ROUTE, {
      headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
      body: JSON.stringify({ mode: "auto" })
    });
    assert.equal(blockedAuto.status, 200);
    assert.equal(blockedAuto.json.status, "idle");
    assert.equal(blockedAuto.json.disabled, true);
    assert.equal(checkerCalls.length, 0);

    const manualAllowed = await httpRawRequest(port, VERSION_ROUTE, {
      headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
      body: JSON.stringify({ mode: "manual", fresh: true })
    });
    assert.equal(manualAllowed.status, 200);
    assert.equal(manualAllowed.json.status, "update");
    assert.deepEqual(checkerCalls, [{ mode: "manual", opts: { fresh: true } }]);

    // Env var AGY_CMD_DISABLE_AUTO_UPDATE_CHECK=1 overrides settings autoUpdateCheck:true
    updateSettings(stateDir, { autoUpdateCheck: true });
    const envBlocked = await handleVersionCheck(
      { mode: "auto" },
      { stateDir, checker: fakeChecker, env: { AGY_CMD_DISABLE_AUTO_UPDATE_CHECK: "1" } }
    );
    assert.equal(envBlocked.status, 200);
    assert.equal(envBlocked.body.disabled, true);

    // Valid POST /api/update sets busy flag in-flight and schedules restart via onUpdated
    const updRes = await httpRawRequest(port, UPDATE_ROUTE, {
      headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
      body: JSON.stringify({ version: "2.5.0" })
    });
    assert.equal(updRes.status, 200);
    assert.equal(updRes.json.status, "updated");
    assert.equal(busyDuringUpdate, true);
    assert.equal(onUpdatedCalled, true);
    assert.equal(isPluginUpdateBusy(), true);

    // /api/state exposes real local version
    const stateRes = await httpRawRequest(port, "/api/state", {
      headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
      body: "{}"
    });
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.json.version, readLocalVersion(REPO_ROOT));

    // SidecarApp registerSidecarRoutes registers POST /api/version and POST /api/update
    const routes = new Map();
    registerSidecarRoutes(
      {
        config: { conversationId: "c1" },
        api(p, fn, method) {
          assert.equal(method, "POST");
          routes.set(p, fn);
        }
      },
      { stateDir, versionChecker: fakeChecker, pluginUpdater: fakeUpdater }
    );
    assert.equal(typeof routes.get(VERSION_ROUTE), "function");
    assert.equal(typeof routes.get(UPDATE_ROUTE), "function");
    const sdkVer = await routes.get(VERSION_ROUTE)({ mode: "manual" });
    assert.equal(sdkVer.status, "update");
    const sdkUpd = await routes.get(UPDATE_ROUTE)({ version: "2.5.0" });
    assert.equal(sdkUpd.status, "updated");
  } finally {
    resetUpdateRuntimeFlags();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Sidecar UI index.html: startup auto-check, retry fresh:true, update flow, reload polling & autoUpdateCheck switch", async () => {
  const htmlSource = renderPanelHtml("vm-upd-csrf");
  assert.ok(htmlSource.includes('id="version-check-btn"'));
  assert.ok(htmlSource.includes('id="version-update-banner"'));
  assert.ok(htmlSource.includes('id="chk-auto-update-check"'));

  const scriptBlocks = [...htmlSource.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainScript = scriptBlocks[scriptBlocks.length - 1][1];

  const elements = new Map();
  const makeEl = (id) => {
    const listeners = new Map();
    const initiallyHidden =
      id === "version-update-banner" ||
      id === "version-check-dot" ||
      id === "version-detail-text" ||
      id === "version-update-btn" ||
      id === "version-release-link" ||
      id === "onboard-card" ||
      id === "star-milestone-banner";
    return {
      id,
      hidden: initiallyHidden,
      value: id === "inp-max" ? "3" : "",
      checked: id === "chk-auto-update-check",
      disabled: false,
      textContent: "",
      href: "",
      style: { getPropertyValue: () => "" },
      dataset: {},
      focused: false,
      scrolled: false,
      focus() {
        this.focused = true;
      },
      scrollIntoView() {
        this.scrolled = true;
      },
      classList: {
        _s: new Set(initiallyHidden ? ["hidden"] : []),
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
      async trigger(type, ev = { preventDefault() {} }) {
        for (const fn of listeners.get(type) || []) {
          await fn(ev);
        }
      }
    };
  };
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  const verPill = { textContent: "v2.4.1" };
  const requests = [];
  let stateVersion = "2.4.1";
  let versionReplyMode = "error";
  let reloaded = false;
  let autoUpdateSetting = true;
  const timers = [];

  const mockFetch = async (urlPath, opts = {}) => {
    const body = JSON.parse(opts.body || "{}");
    requests.push({ urlPath, body });
    const mk = (obj, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => structuredClone(obj)
    });
    if (urlPath === "/api/state") {
      return mk({
        ok: true,
        version: stateVersion,
        settings: {
          version: 3,
          planTier: "free",
          boostEnabled: false,
          autoRetryMode: "count",
          autoRetryMax: 3,
          autoRetryScope: "smart",
          freeFallbackEnabled: true,
          planFallbackEnabled: true,
          autoUpdateCheck: autoUpdateSetting,
          configuredByUser: true,
          onboardingShown: true,
          stats: { totalAutoRetries: 0 },
          starPrompt: { state: "pending", shouldShow: false }
        },
        summaryZh: "最多重试 3 次",
        boostStatusZh: "免费版安全模式",
        deliveryGateStatusZh: "交付测试门禁：关闭"
      });
    }
    if (urlPath === "/api/settings") {
      if ("autoUpdateCheck" in body) autoUpdateSetting = body.autoUpdateCheck;
      return mk({
        ok: true,
        version: stateVersion,
        settings: {
          version: 3,
          planTier: "free",
          boostEnabled: false,
          autoRetryMode: "count",
          autoRetryMax: 3,
          autoRetryScope: "smart",
          freeFallbackEnabled: true,
          planFallbackEnabled: true,
          autoUpdateCheck: autoUpdateSetting,
          configuredByUser: true,
          onboardingShown: true,
          stats: { totalAutoRetries: 0 },
          starPrompt: { state: "pending", shouldShow: false }
        }
      });
    }
    if (urlPath === VERSION_ROUTE) {
      assert.equal("conversationId" in body, false, "/api/version must never include conversationId");
      if (versionReplyMode === "error") {
        return mk({ ok: false, status: "error", currentVersion: "2.4.1", reason: "timeout" });
      }
      return mk({
        ok: true,
        status: "update",
        currentVersion: "2.4.1",
        latestVersion: "2.5.0",
        releaseTag: "v2.5.0",
        releaseUrl: `https://github.com/${REPO}/releases/tag/v2.5.0`
      });
    }
    if (urlPath === UPDATE_ROUTE) {
      assert.deepEqual(body, { version: "2.5.0" });
      stateVersion = "2.5.0";
      return mk({
        ok: true,
        status: "updated",
        previousVersion: "2.4.1",
        version: "2.5.0",
        releaseTag: "v2.5.0",
        releaseUrl: `https://github.com/${REPO}/releases/tag/v2.5.0`
      });
    }
    return mk({ ok: true });
  };

  const win = {
    location: {
      reload() {
        reloaded = true;
      }
    },
    addEventListener() {},
    fetch: mockFetch,
    sidecar: { conversationId: "conv-1", fetch: mockFetch }
  };

  const sandbox = {
    window: win,
    document: {
      hidden: false,
      activeElement: null,
      documentElement: { style: { getPropertyValue: () => "" }, setAttribute() {} },
      getElementById: getEl,
      querySelectorAll: (sel) => (sel === ".ver-pill" ? [verPill] : [])
    },
    navigator: {},
    Intl,
    requestAnimationFrame: (fn) => fn(),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {}
  };

  vm.createContext(sandbox);
  vm.runInContext(mainScript, sandbox);
  await new Promise((r) => setTimeout(r, 15));

  // 1. Fire startup auto-check timer -> error is silent in auto mode
  assert.equal(timers.length, 1);
  await timers.shift()();
  assert.deepEqual(requests.at(-1), { urlPath: VERSION_ROUTE, body: { mode: "auto" } });
  assert.equal(getEl("version-update-banner").hidden, true);

  // 2. Manual click triggers check -> error banner appears -> clicking Retry sends fresh:true
  await getEl("version-check-btn").trigger("click");
  assert.equal(getEl("version-update-banner").dataset.state, "check-error");
  assert.equal(getEl("version-update-btn").textContent, "重试");

  versionReplyMode = "update";
  await getEl("version-update-btn").trigger("click");
  assert.deepEqual(requests.at(-1), { urlPath: VERSION_ROUTE, body: { mode: "manual", fresh: true } });
  assert.equal(getEl("version-update-banner").dataset.state, "available");
  assert.equal(getEl("version-check-label").textContent, "更新 v2.5.0");

  // 3. Clicking header button while update is available focuses banner instead of re-fetching
  const reqCountBeforeFocus = requests.length;
  await getEl("version-check-btn").trigger("click");
  assert.equal(requests.length, reqCountBeforeFocus);
  assert.equal(getEl("version-update-btn").focused, true);

  // 4. Clicking Update runs POST /api/update -> updates version pill -> poll detects v2.5.0 -> reloads
  await getEl("version-update-btn").trigger("click");
  assert.equal(getEl("version-update-banner").dataset.state, "updated");
  assert.equal(verPill.textContent, "v2.5.0");
  assert.equal(timers.length, 1);
  await timers.shift()();
  assert.equal(reloaded, true);

  // 5. Toggling autoUpdateCheck switch saves autoUpdateCheck:false
  getEl("chk-auto-update-check").checked = false;
  await getEl("chk-auto-update-check").trigger("change");
  assert.equal(autoUpdateSetting, false);
});

test("auto-update-install: 4 guardrails (opt-in default off, SHA-256 required, same-major only, circuit breaker), notice ack & UI toggle", async () => {
  const validSha = "c".repeat(64);
  const baseRelease = {
    ok: true,
    status: "update",
    currentVersion: "2.5.0",
    latestVersion: "2.5.1",
    releaseTag: "v2.5.1",
    releaseUrl: `https://github.com/${REPO}/releases/tag/v2.5.1`,
    assetName: "agy-cmd-v2.5.1.zip",
    assetUrl: `https://github.com/${REPO}/releases/download/v2.5.1/agy-cmd-v2.5.1.zip`,
    assetSha256: validSha,
    assetFormat: "zip"
  };

  // 1. Pure 4-guardrail eligibility checks
  assert.deepEqual(
    evaluateAutoInstallEligibility({ release: baseRelease, currentVersion: "2.5.0" }),
    { eligible: true, skipReason: null, targetVersion: "2.5.1" }
  );
  assert.equal(
    evaluateAutoInstallEligibility({
      release: { ...baseRelease, latestVersion: "3.0.0", releaseTag: "v3.0.0" },
      currentVersion: "2.5.0"
    }).skipReason,
    "majorUpgrade"
  );
  assert.equal(
    evaluateAutoInstallEligibility({
      release: { ...baseRelease, assetUrl: "", assetSha256: "" },
      currentVersion: "2.5.0"
    }).skipReason,
    "noVerifiedAsset"
  );
  assert.equal(
    evaluateAutoInstallEligibility({
      release: baseRelease,
      currentVersion: "2.5.0",
      failedVersion: "2.5.1"
    }).skipReason,
    "failedCircuitOpen"
  );
  assert.equal(
    evaluateAutoInstallEligibility({
      release: baseRelease,
      currentVersion: "2.5.0",
      failedVersion: "2.5.0"
    }).eligible,
    true
  );

  // 2. Lifecycle cycle: default OFF -> opt-in ON -> env disable -> circuit breaker -> manual clear -> auto success notice + ack
  const stateDir = makeTmpDir("agy-cmd-autoinst-");
  resetUpdateRuntimeFlags();
  try {
    assert.equal(readSettings(stateDir).autoUpdateInstall, false);
    assert.equal(isAutoUpdateInstallEnabled(stateDir, {}), false);

    let updateCalls = [];
    const checker = async () => baseRelease;
    let updaterMode = "locked";
    const updater = async (ver) => {
      updateCalls.push(ver);
      if (updaterMode === "locked") {
        return { ok: false, status: "error", reason: "locked", diagnostics: { step: "replace", restored: true } };
      }
      if (updaterMode === "git") {
        return { ok: false, status: "error", reason: "gitCheckout", diagnostics: { step: "inspect" } };
      }
      return {
        ok: true,
        status: "updated",
        previousVersion: "2.5.0",
        version: ver,
        releaseTag: `v${ver}`,
        releaseUrl: baseRelease.releaseUrl
      };
    };

    // Default OFF: checks but never installs
    const offRes = await runAutoUpdateCycle({ stateDir, checker, updater, currentVersion: "2.5.0", env: {} });
    assert.equal(offRes.action, "checked");
    assert.equal(offRes.autoInstallSkipped, "installDisabled");
    assert.equal(updateCalls.length, 0);

    // Turning autoUpdateInstall ON while autoUpdateCheck was OFF automatically re-enables autoUpdateCheck
    updateSettings(stateDir, { autoUpdateCheck: false });
    const enabled = updateSettings(stateDir, { autoUpdateInstall: true });
    assert.equal(enabled.autoUpdateInstall, true);
    assert.equal(enabled.autoUpdateCheck, true);

    // Env hard disable overrides settings.json
    assert.equal(isAutoUpdateInstallEnabled(stateDir, { AGY_CMD_DISABLE_AUTO_UPDATE_INSTALL: "1" }), false);
    assert.equal(isAutoUpdateInstallEnabled(stateDir, { AGY_CMD_AUTO_UPDATE_INSTALL: "0" }), false);
    assert.equal(isAutoUpdateInstallEnabled(stateDir, { AGY_CMD_DISABLE_AUTO_UPDATE_CHECK: "1" }), false);

    // gitCheckout failure does NOT trip circuit breaker
    updaterMode = "git";
    const gitFail = await runAutoUpdateCycle({ stateDir, checker, updater, currentVersion: "2.5.0", env: {} });
    assert.equal(gitFail.action, "failed");
    assert.equal(readSettings(stateDir).autoUpdateState.failedVersion, "");

    // locked failure trips per-version circuit breaker; second cycle skips 2.5.1 automatically
    updaterMode = "locked";
    const lockFail = await runAutoUpdateCycle({
      stateDir,
      checker,
      updater,
      currentVersion: "2.5.0",
      env: {},
      nowIso: "2026-11-26T16:00:00.000Z"
    });
    assert.equal(lockFail.action, "failed");
    assert.equal(readSettings(stateDir).autoUpdateState.failedVersion, "2.5.1");
    assert.equal(readSettings(stateDir).autoUpdateState.failedReason, "locked");

    const skippedRes = await runAutoUpdateCycle({ stateDir, checker, updater, currentVersion: "2.5.0", env: {} });
    assert.equal(skippedRes.action, "checked");
    assert.equal(skippedRes.autoInstallSkipped, "failedCircuitOpen");
    assert.equal(updateCalls.length, 2);

    // Manual update success clears circuit breaker
    updaterMode = "ok";
    const manualOk = await handlePluginUpdate({ version: "2.5.1" }, { stateDir, updater });
    assert.equal(manualOk.body.status, "updated");
    assert.equal(readSettings(stateDir).autoUpdateState.failedVersion, "");

    // Automatic update success writes autoUpdateNotice and triggers onUpdated callback
    let restarted = false;
    const autoOk = await runAutoUpdateCycle({
      stateDir,
      checker: async () => ({
        ...baseRelease,
        latestVersion: readLocalVersion(REPO_ROOT) || "2.5.0",
        releaseTag: `v${readLocalVersion(REPO_ROOT) || "2.5.0"}`
      }),
      updater,
      currentVersion: "2.4.0",
      env: {},
      nowIso: "2026-11-26T16:05:00.000Z",
      onUpdated: () => {
        restarted = true;
      }
    });
    assert.equal(autoOk.action, "updated");
    assert.equal(restarted, true);
    const localVer = readLocalVersion(REPO_ROOT);
    assert.equal(readSettings(stateDir).autoUpdateState.lastAutoUpdatedVersion, localVer);

    // HTTP /api/state exposes autoUpdateNotice; /api/auto-update-ack enforces CSRF/POST/schema and clears notice
    resetUpdateRuntimeFlags();
    let autoTriggerFired = false;
    const csrf = "auto-ack-csrf-0123456789abcdef";
    const srv = createStandaloneServer({
      stateDir,
      csrfToken: csrf,
      onAutoInstallEnabled: () => {
        autoTriggerFired = true;
      }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    try {
      const stBefore = await httpRawRequest(port, "/api/state", {
        headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
        body: "{}"
      });
      assert.equal(stBefore.status, 200);
      assert.equal(stBefore.json.autoUpdateNotice?.version, localVer);

      assert.equal((await httpRawRequest(port, AUTO_UPDATE_ACK_ROUTE, { method: "GET" })).status, 405);
      assert.equal(
        (await httpRawRequest(port, AUTO_UPDATE_ACK_ROUTE, { headers: { "Content-Type": "application/json" }, body: "{}" })).status,
        401
      );
      assert.equal(
        (
          await httpRawRequest(port, AUTO_UPDATE_ACK_ROUTE, {
            headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
            body: JSON.stringify({ extra: 1 })
          })
        ).status,
        400
      );

      const ackOk = await httpRawRequest(port, AUTO_UPDATE_ACK_ROUTE, {
        headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
        body: JSON.stringify({ dismissNotice: true })
      });
      assert.equal(ackOk.status, 200);
      assert.equal(ackOk.json.autoUpdateNotice, null);

      const stAfter = await httpRawRequest(port, "/api/state", {
        headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
        body: "{}"
      });
      assert.equal(stAfter.json.autoUpdateNotice, null);

      const toggleRes = await httpRawRequest(port, "/api/settings", {
        headers: { "Content-Type": "application/json", "X-Agy-Cmd-Csrf": csrf },
        body: JSON.stringify({ autoUpdateInstall: true })
      });
      assert.equal(toggleRes.status, 200);
      assert.equal(autoTriggerFired, true);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }

    // 3. Panel UI VM test: renders auto-updated notice banner and dismisses via /api/auto-update-ack + topbar toggle button
    const htmlSource = renderPanelHtml("vm-auto-csrf");
    assert.ok(htmlSource.includes('id="auto-update-install-btn"'));
    const scriptBlocks = [...htmlSource.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    const mainScript = scriptBlocks[scriptBlocks.length - 1][1];
    const els = new Map();
    const getEl = (id) => {
      if (!els.has(id)) {
        const listeners = new Map();
        els.set(id, {
          id,
          hidden: id === "version-update-banner" || id === "onboard-card" || id === "star-milestone-banner",
          value: id === "inp-max" ? "3" : "",
          checked: id === "chk-auto-update-check",
          disabled: false,
          textContent: "",
          href: "",
          style: { getPropertyValue: () => "" },
          dataset: {},
          classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle() {}, contains() { return false; } },
          setAttribute() {},
          addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
          },
          async trigger(type, ev = { preventDefault() {} }) {
            for (const fn of listeners.get(type) || []) await fn(ev);
          }
        });
      }
      return els.get(id);
    };
    const uiCalls = [];
    let uiAutoInstall = false;
    const uiFetch = async (urlPath, opts = {}) => {
      const body = JSON.parse(opts.body || "{}");
      uiCalls.push({ urlPath, body });
      const mk = (obj) => ({ ok: true, status: 200, json: async () => structuredClone(obj) });
      if (urlPath === "/api/settings") {
        if ("autoUpdateInstall" in body) uiAutoInstall = body.autoUpdateInstall;
        return mk({
          ok: true,
          version: "2.5.1",
          autoUpdateNotice: null,
          settings: {
            version: 3,
            planTier: "free",
            boostEnabled: false,
            autoRetryMode: "count",
            autoRetryMax: 3,
            autoRetryScope: "smart",
            freeFallbackEnabled: true,
            planFallbackEnabled: true,
            autoUpdateCheck: true,
            autoUpdateInstall: uiAutoInstall,
            configuredByUser: true,
            onboardingShown: true,
            stats: { totalAutoRetries: 0 },
            starPrompt: { state: "pending", shouldShow: false }
          }
        });
      }
      if (urlPath === "/api/state") {
        return mk({
          ok: true,
          version: "2.5.1",
          autoUpdateNotice: {
            version: "2.5.1",
            previousVersion: "2.5.0",
            updatedAt: "2026-11-26T16:05:00.000Z",
            releaseUrl: baseRelease.releaseUrl
          },
          settings: {
            version: 3,
            planTier: "free",
            boostEnabled: false,
            autoRetryMode: "count",
            autoRetryMax: 3,
            autoRetryScope: "smart",
            freeFallbackEnabled: true,
            planFallbackEnabled: true,
            autoUpdateCheck: true,
            autoUpdateInstall: uiAutoInstall,
            configuredByUser: true,
            onboardingShown: true,
            stats: { totalAutoRetries: 0 },
            starPrompt: { state: "pending", shouldShow: false }
          }
        });
      }
      return mk({ ok: true, autoUpdateNotice: null });
    };
    const sandbox = {
      window: { location: {}, addEventListener() {}, fetch: uiFetch, sidecar: null },
      document: {
        hidden: false,
        activeElement: null,
        documentElement: { style: { getPropertyValue: () => "" }, setAttribute() {} },
        getElementById: getEl,
        querySelectorAll: () => []
      },
      navigator: {},
      Intl,
      requestAnimationFrame: (fn) => fn(),
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {}
    };
    vm.createContext(sandbox);
    vm.runInContext(mainScript, sandbox);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(getEl("auto-update-install-btn").textContent, "自动更新：关");
    assert.equal(getEl("version-update-banner").dataset.state, "auto-updated");
    assert.match(getEl("version-status-text").textContent, /已自动更新至 v2\.5\.1（原 v2\.5\.0）/);

    await getEl("version-dismiss-btn").trigger("click");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(getEl("version-update-banner").hidden, true);
    assert.ok(uiCalls.some((c) => c.urlPath === AUTO_UPDATE_ACK_ROUTE && c.body.dismissNotice === true));

    await getEl("auto-update-install-btn").trigger("click");
    assert.equal(uiAutoInstall, true);
    assert.equal(getEl("auto-update-install-btn").textContent, "自动更新：开");
  } finally {
    resetUpdateRuntimeFlags();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("v2.7.0 hardening: plugin.json schema contract, managedByHost guard, POSIX node/0755 preservation & forward-compatible verifier invariants", async () => {
  // 1. plugin.json satisfies official Antigravity JSON Schema contract
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "plugin.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(manifest.$schema, "https://antigravity.google/schemas/v1/plugin.json");
  assert.equal(typeof manifest.repository, "string");
  assert.match(manifest.repository, /^https:\/\/github\.com\//);
  assert.equal(manifest.version, pkg.version);
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0);
  assert.equal(typeof manifest.author?.name, "string");

  // 2. POSIX executable mode detection & pinned node path preservation
  assert.equal(shouldPreserveExecutableMode("install.sh", Buffer.from("echo hi\n")), true);
  assert.equal(shouldPreserveExecutableMode("hooks/stop.mjs", Buffer.from("#!/usr/bin/env node\n")), true);
  assert.equal(shouldPreserveExecutableMode("plugin.json", Buffer.from("{}\n")), false);

  const baseSidecarBuf = Buffer.from(JSON.stringify({ command: "node", args: ["server.mjs"], restart_policy: "always" }) + "\n");
  const posixPreserved = JSON.parse(
    preservePinnedNodeCommand(baseSidecarBuf, { command: "/home/alice/.nvm/versions/node/v22.1.0/bin/node" }).toString("utf8")
  );
  assert.equal(posixPreserved.command, "/home/alice/.nvm/versions/node/v22.1.0/bin/node");
  const rejectedShell = JSON.parse(
    preservePinnedNodeCommand(baseSidecarBuf, { command: "/bin/sh" }).toString("utf8")
  );
  assert.equal(rejectedShell.command, "node");

  // 3. Forward-compatible security-invariant verifier validation
  const realVerifier = fs.readFileSync(path.join(REPO_ROOT, "agents/cmd-verifier.md"), "utf8");
  assert.equal(isValidVerifierRole(realVerifier), true);
  assert.equal(
    isValidVerifierRole(
      realVerifier
        .replace('tools: ["read_file"]', 'tools: ["read_file", "view_file", "grep_search"]')
        .replace("model: inherit", "model: inherit\ncommandExecutionPolicy: off")
    ),
    true
  );
  assert.equal(
    isValidVerifierRole(realVerifier.replace("model: inherit", "model: inherit\ncommandExecutionPolicy: auto")),
    false
  );
  assert.equal(
    isValidVerifierRole(realVerifier.replace('tools: ["read_file"]', 'tools: ["read_file", "edit_file"]')),
    false
  );
  assert.equal(
    isValidVerifierRole(realVerifier.replace("tools:", "unknownKey: true\ntools:")),
    false
  );

  // 4. Host-managed installation (`config.json` -> `plugins["agy-cmd"].installedFrom`) blocks self-update without tripping circuit breaker
  const tmpBase = makeTmpDir("agy-cmd-managed-");
  const stateDir = makeTmpDir("agy-cmd-managed-st-");
  resetUpdateRuntimeFlags();
  try {
    const cfgDir = path.join(tmpBase, "cfg");
    const installedRoot = path.join(cfgDir, "plugins", "agy-cmd");
    writeBundleToDir(installedRoot, collectRepoBundleFiles("2.7.0"));
    fs.writeFileSync(
      path.join(cfgDir, "config.json"),
      JSON.stringify({
        plugins: {
          "agy-cmd": {
            enabled: true,
            installedFrom: { id: "antigravity-plugins-partners/plugin/agy-cmd", version: "2.7.0" }
          }
        }
      })
    );
    await assert.rejects(
      resolveInstalledRoot(path.join(installedRoot, "sidecars", "panel")),
      (e) => e instanceof UpdateError && e.reason === "managedByHost"
    );

    updateSettings(stateDir, { autoUpdateInstall: true });
    const release = {
      ok: true,
      status: "update",
      currentVersion: "2.7.0",
      latestVersion: "2.7.1",
      releaseTag: "v2.7.1",
      releaseUrl: `https://github.com/${REPO}/releases/tag/v2.7.1`,
      assetUrl: `https://github.com/${REPO}/releases/download/v2.7.1/agy-cmd-v2.7.1.zip`,
      assetSha256: "a".repeat(64)
    };
    const cycleRes = await runAutoUpdateCycle({
      stateDir,
      checker: async () => release,
      updater: async () => ({ ok: false, status: "error", reason: "managedByHost", diagnostics: { step: "inspect" } }),
      currentVersion: "2.7.0",
      env: {}
    });
    assert.equal(cycleRes.action, "failed");
    assert.equal(readSettings(stateDir).autoUpdateState.failedVersion, "");
  } finally {
    resetUpdateRuntimeFlags();
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
