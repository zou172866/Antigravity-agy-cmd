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
  detectHostSurface,
  formatRouterCliCommand,
  isDirectRun,
  isSubagentPayload,
  parseHookPayload,
  readStdin,
  resolveConversationId,
  resolveStateDir
} from "./lib/common.mjs";
import { readSettings, updateSettings } from "./lib/settings.mjs";
import { resolveTranscriptPath, resolveWorkerTranscriptIdentity } from "./lib/transcript.mjs";

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

  const stateDir = resolveStateDir(env);
  const convId = resolveConversationId(payload, env);
  const transcriptPath = resolveTranscriptPath(payload);
  if (transcriptPath && resolveWorkerTranscriptIdentity(transcriptPath, { stateDir, convId }).isSubagent) {
    return {};
  }
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

    const surface = detectHostSurface(payload);
    const cliStatusCmd = formatRouterCliCommand("--status");
    const panelOrCliHint =
      surface === "ide" || surface === "cli"
        ? `请在正常回答完用户本轮问题后，于回复末尾顺带附 1 句简短提醒：当前环境无右侧边栏面板，可运行 \`${cliStatusCmd}\` 调节「自动重试次数（off / N / infinite）」及「是否开启 Boost（Pro/Ultra 会员）自动接入」。`
        : "请在正常回答完用户本轮问题后，于回复末尾顺带附 1 句简短提醒：附上 [agy-cmd 自动路由](sidecar://agy-cmd/panel/)（Antigravity App v2.35.1+ 将自动在右侧打开面板），方便手动调节「自动重试次数（不用重试 / N 次 / 一直重试）」及「是否开启 Boost（Pro/Ultra 会员）自动接入」。";
    const text =
      "[agy-cmd 首次启用引导] agy-cmd 已就绪（当前默认：免费版安全模式、Boost 自动接入关闭、智能无感自动重试 3 次）。" +
      panelOrCliHint;

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
