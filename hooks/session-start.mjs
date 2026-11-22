#!/usr/bin/env node
/**
 * agy-cmd SessionStart hook:
 * Emits a ONE-TIME post-install onboarding reminder on the very first main
 * user session (reminding the user to open the right-hand `agy-cmd` panel to
 * set auto-retry count and whether to enable paid `/boost` integration).
 * On all subsequent sessions (`onboardingShown: true` or `configuredByUser: true`),
 * returns `{}` immediately with zero token overhead and zero prefix impact.
 */
import {
  isDirectRun,
  isSubagentPayload,
  parseHookPayload,
  readStdin,
  resolveStateDir
} from "./lib/common.mjs";
import { readSettings, updateSettings } from "./lib/settings.mjs";
import { isSubagentTranscript, resolveTranscriptPath } from "./lib/transcript.mjs";

export async function runSessionStart(rawInput, env = process.env, nowIso = new Date().toISOString()) {
  const payload = parseHookPayload(rawInput);
  if (!payload || isSubagentPayload(payload, env)) {
    return {};
  }

  // Ignore internal sidecar/background host containers that have an explicit empty workspacePaths array
  const wsPaths = payload.workspacePaths ?? payload.workspace_paths;
  if (Array.isArray(wsPaths) && wsPaths.length === 0) {
    return {};
  }

  const transcriptPath = resolveTranscriptPath(payload);
  if (transcriptPath && isSubagentTranscript(transcriptPath)) {
    return {};
  }

  const stateDir = resolveStateDir(env);
  try {
    const settings = readSettings(stateDir);
    if (settings.onboardingShown || settings.configuredByUser) {
      return {};
    }

    updateSettings(
      stateDir,
      { onboardingShown: true },
      { markConfigured: false, nowIso }
    );

    const text =
      "[agy-cmd 首次启用引导] agy-cmd 已就绪（当前默认：免费版安全模式、Boost 自动接入关闭、智能无感自动重试 3 次）。" +
      "请在正常回答完用户本轮问题后，于回复末尾顺带附 1 句简短提醒：可点击 [agy-cmd 自动路由](sidecar://agy-cmd/panel/) 打开右侧边栏面板，手动调节「自动重试次数（不用重试 / N 次 / 一直重试）」及「是否开启 Boost（Pro/Ultra 会员）自动接入」。";

    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: text
          }
        }
      ]
    };
  } catch {
    return {};
  }
}

async function main() {
  const raw = await readStdin(1000);
  const out = await runSessionStart(raw, process.env);
  process.stdout.write(JSON.stringify(out) + "\n");
}

if (isDirectRun(import.meta.url)) {
  main().catch(() => {
    process.stdout.write("{}\n");
  });
}
