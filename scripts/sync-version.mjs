#!/usr/bin/env node
/**
 * Single-source version synchronization & verification for agy-cmd.
 * Source of truth: `package.json` -> `version` (or explicit `--set X.Y.Z`).
 *
 * Usage:
 *   node scripts/sync-version.mjs --check
 *   node scripts/sync-version.mjs --set 2.8.0
 *   node scripts/sync-version.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function readUtf8(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function writeUtf8(relPath, content) {
  fs.writeFileSync(path.join(REPO_ROOT, relPath), content, "utf8");
}

function buildTargets(version) {
  const tag = `v${version}`;
  return [
    {
      relPath: "package.json",
      check: (txt) => JSON.parse(txt).version === version,
      update: (txt) => txt.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`)
    },
    {
      relPath: "plugin.json",
      check: (txt) => {
        const obj = JSON.parse(txt);
        return obj.version === version && typeof obj.description === "string" && obj.description.includes(`（${tag}）`);
      },
      update: (txt) =>
        txt
          .replace(/"version":\s*"[^"]+"/, `"version": "${version}"`)
          .replace(/（v\d+\.\d+\.\d+）/, `（${tag}）`)
    },
    {
      relPath: "sidecars/panel/index.html",
      check: (txt) => txt.includes(`<span class="ver-pill">${tag}</span>`),
      update: (txt) => txt.replace(/<span class="ver-pill">v[^<]*<\/span>/, `<span class="ver-pill">${tag}</span>`)
    },
    {
      relPath: "skills/agy-cmd/SKILL.md",
      check: (txt) => txt.includes(`# agy-cmd：高阶能力自动路由与指令参谋（${tag}）`),
      update: (txt) =>
        txt.replace(
          /# agy-cmd：高阶能力自动路由与指令参谋（v\d+\.\d+\.\d+）/,
          `# agy-cmd：高阶能力自动路由与指令参谋（${tag}）`
        )
    },
    {
      relPath: "install.ps1",
      check: (txt) =>
        txt.includes(`$DefaultVersion = "${tag}"`) &&
        txt.includes(`Antigravity-agy-cmd/${tag}/install.ps1`) &&
        txt.includes(`agy-cmd-${tag}.zip`),
      update: (txt) =>
        txt
          .replace(/\$DefaultVersion = "v\d+\.\d+\.\d+"/, `$DefaultVersion = "${tag}"`)
          .replace(/Antigravity-agy-cmd\/v\d+\.\d+\.\d+\/install\.ps1/g, `Antigravity-agy-cmd/${tag}/install.ps1`)
          .replace(/agy-cmd-v\d+\.\d+\.\d+\.zip/g, `agy-cmd-${tag}.zip`)
    },
    {
      relPath: "install.sh",
      check: (txt) =>
        txt.includes(`DEFAULT_VERSION="${tag}"`) &&
        txt.includes(`Antigravity-agy-cmd/${tag}/install.sh`) &&
        txt.includes(`agy-cmd-${tag}.zip`),
      update: (txt) =>
        txt
          .replace(/DEFAULT_VERSION="v\d+\.\d+\.\d+"/, `DEFAULT_VERSION="${tag}"`)
          .replace(/Antigravity-agy-cmd\/v\d+\.\d+\.\d+\/install\.sh/g, `Antigravity-agy-cmd/${tag}/install.sh`)
          .replace(/agy-cmd-v\d+\.\d+\.\d+\.zip/g, `agy-cmd-${tag}.zip`)
    },
    {
      relPath: "README.md",
      check: (txt) =>
        txt.includes(`Antigravity-agy-cmd/${tag}/install.ps1`) &&
        txt.includes(`Antigravity-agy-cmd/${tag}/install.sh`) &&
        txt.includes(`agy-cmd-${tag}.zip`),
      update: (txt) =>
        txt
          .replace(/Antigravity-agy-cmd\/v\d+\.\d+\.\d+\/install\.(ps1|sh)/g, `Antigravity-agy-cmd/${tag}/install.$1`)
          .replace(/agy-cmd-v\d+\.\d+\.\d+\.zip/g, `agy-cmd-${tag}.zip`)
    },
    {
      relPath: "README.zh-CN.md",
      check: (txt) =>
        txt.includes(`Antigravity-agy-cmd/${tag}/install.ps1`) &&
        txt.includes(`Antigravity-agy-cmd/${tag}/install.sh`) &&
        txt.includes(`agy-cmd-${tag}.zip`),
      update: (txt) =>
        txt
          .replace(/Antigravity-agy-cmd\/v\d+\.\d+\.\d+\/install\.(ps1|sh)/g, `Antigravity-agy-cmd/${tag}/install.$1`)
          .replace(/agy-cmd-v\d+\.\d+\.\d+\.zip/g, `agy-cmd-${tag}.zip`)
    }
  ];
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const setIdx = args.indexOf("--set");
  const rawSet = setIdx >= 0 ? String(args[setIdx + 1] || "").trim().replace(/^v/, "") : "";
  const pkgVersion = JSON.parse(readUtf8("package.json")).version;
  const version = rawSet || pkgVersion;

  if (!SEMVER_RE.test(version)) {
    console.error(`Invalid SemVer version: '${version}'`);
    process.exit(1);
  }

  const targets = buildTargets(version);
  if (checkOnly) {
    const drifted = [];
    for (const t of targets) {
      if (!t.check(readUtf8(t.relPath))) {
        drifted.push(t.relPath);
      }
    }
    if (drifted.length > 0) {
      console.error(`Version drift detected (expected ${version}): ${drifted.join(", ")}`);
      process.exit(2);
    }
    console.log(`OK: all ${targets.length} version targets match ${version}`);
    return;
  }

  for (const t of targets) {
    const before = readUtf8(t.relPath);
    const after = t.update(before);
    if (!t.check(after)) {
      console.error(`Failed to sync version ${version} into ${t.relPath}`);
      process.exit(1);
    }
    if (after !== before) {
      writeUtf8(t.relPath, after);
    }
  }
  console.log(`Synced version ${version} across ${targets.length} files.`);
}

main();
