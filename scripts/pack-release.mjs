#!/usr/bin/env node
/**
 * Deterministic, zero-dependency release packager & self-verifier for agy-cmd.
 *
 * Guarantees every published ZIP satisfies all release invariants:
 *   1. Includes strictly BUNDLE_ROOT_FILES + BUNDLE_DIRS (no scripts/, docs/, __pycache__, .git).
 *   2. Verifies `install.sh` is pure LF and `install.ps1` uses CRLF.
 *   3. Sets POSIX `0o100755` executable mode on `.sh` and `#!` scripts (`0o100644` otherwise).
 *   4. Writes `agy-cmd-v<version>.zip` and `SHA256SUMS.txt` (LF).
 *   5. Immediately round-trip verifies the ZIP with `verifyArchiveSha256` & `readReleaseArchive`.
 *
 * Usage:
 *   node scripts/pack-release.mjs [--out-dir <path>]
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { computeCrc32, readReleaseArchive, verifyArchiveSha256 } from "../sidecars/panel/update-archive.mjs";
import { shouldPreserveExecutableMode } from "../sidecars/panel/version-update.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const BUNDLE_ROOT_FILES = [
  "plugin.json",
  "hooks.json",
  "package.json",
  "README.md",
  "README.zh-CN.md",
  "install.ps1",
  "install.sh",
  "LICENSE",
  "SECURITY.md"
];
const BUNDLE_DIRS = ["assets", "rules", "agents", "hooks", "sidecars", "skills", "test"];

function collectBundleEntries(repoRoot) {
  const entries = [];
  for (const name of BUNDLE_ROOT_FILES) {
    const abs = path.join(repoRoot, name);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      entries.push({ rel: name, bytes: fs.readFileSync(abs) });
    }
  }
  const walk = (dirRel) => {
    const absDir = path.join(repoRoot, dirRel);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return;
    const names = fs.readdirSync(absDir).sort();
    for (const name of names) {
      if (name === "__pycache__" || name.endsWith(".pyc") || name.endsWith(".pyo")) continue;
      const rel = `${dirRel}/${name}`;
      const abs = path.join(repoRoot, rel);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to package symlink: ${rel}`);
      }
      if (st.isDirectory()) {
        walk(rel);
      } else if (st.isFile()) {
        entries.push({ rel, bytes: fs.readFileSync(abs) });
      }
    }
  };
  for (const dir of BUNDLE_DIRS) {
    walk(dir);
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return entries;
}

function buildDeterministicZip(topDir, fileEntries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  // Fixed DOS timestamp: 2026-01-01 00:00:00 for deterministic builds
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  const allEntries = [
    { path: `${topDir}/`, bytes: Buffer.alloc(0), isDir: true, exec: true },
    ...fileEntries.map((e) => ({
      path: `${topDir}/${e.rel}`,
      bytes: e.bytes,
      isDir: false,
      exec: shouldPreserveExecutableMode(e.rel, e.bytes)
    }))
  ];

  for (const entry of allEntries) {
    const nameBytes = Buffer.from(entry.path, "utf8");
    const rawData = entry.bytes;
    const useDeflate = !entry.isDir && rawData.length > 0;
    const method = useDeflate ? 8 : 0;
    const compData = useDeflate ? deflateRawSync(rawData, { level: 9 }) : rawData;
    const crc = computeCrc32(rawData);
    const flags = 0x0800; // UTF-8 filename flag
    const versionMadeBy = 0x0314; // Unix (3) + ZIP 2.0 (20)
    const unixMode = entry.isDir ? 0o040755 : entry.exec ? 0o100755 : 0o100644;
    const extAttr = (unixMode << 16) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compData.length, 18);
    local.writeUInt32LE(rawData.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compData);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(versionMadeBy, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(compData.length, 20);
    cd.writeUInt32LE(rawData.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(extAttr, 38);
    cd.writeUInt32LE(offset, 42);
    cdParts.push(cd, nameBytes);

    offset += local.length + nameBytes.length + compData.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(allEntries.length, 8);
  eocd.writeUInt16LE(allEntries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out-dir");
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "plugin.json"), "utf8"));
  if (!pkg.version || pkg.version !== manifest.version) {
    throw new Error(`Version mismatch: package.json=${pkg.version} vs plugin.json=${manifest.version}`);
  }
  const version = pkg.version;
  const tag = `v${version}`;
  const outDir =
    outIdx >= 0 && args[outIdx + 1]
      ? path.resolve(args[outIdx + 1])
      : path.resolve(REPO_ROOT, "..", "agy-cmd-releases", tag);

  const entries = collectBundleEntries(REPO_ROOT);
  const byRel = new Map(entries.map((e) => [e.rel, e.bytes]));
  const installSh = byRel.get("install.sh");
  const installPs1 = byRel.get("install.ps1");
  if (!installSh || installSh.includes(0x0d)) {
    throw new Error("install.sh must exist and use pure LF line endings (no CR bytes).");
  }
  if (!installPs1 || !installPs1.includes(Buffer.from("\r\n"))) {
    throw new Error("install.ps1 must exist and use CRLF line endings.");
  }

  const topDir = `agy-cmd-${tag}`;
  const assetName = `${topDir}.zip`;
  const zipBuf = buildDeterministicZip(topDir, entries);
  const sha256 = createHash("sha256").update(zipBuf).digest("hex");

  // Self-verify round-trip extraction & SHA-256 integrity before writing output
  verifyArchiveSha256(zipBuf, sha256);
  const extracted = await readReleaseArchive(zipBuf);
  if (extracted.size !== entries.length) {
    throw new Error(`Archive entry count mismatch: expected ${entries.length}, extracted ${extracted.size}`);
  }
  const extractedManifest = JSON.parse(extracted.get("plugin.json").toString("utf8"));
  if (extractedManifest.version !== version) {
    throw new Error(`Extracted plugin.json version mismatch: ${extractedManifest.version}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, assetName);
  const sumsPath = path.join(outDir, "SHA256SUMS.txt");
  fs.writeFileSync(zipPath, zipBuf);
  fs.writeFileSync(sumsPath, `${sha256}  ${assetName}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        ok: true,
        version,
        assetName,
        zipPath,
        sumsPath,
        bytes: zipBuf.length,
        entries: entries.length,
        sha256
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(`ERROR: ${err?.message || err}`);
  process.exit(1);
});
