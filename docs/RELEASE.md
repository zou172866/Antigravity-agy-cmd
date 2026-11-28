# agy-cmd 发版与兼容性防踩坑指南

本文档仅供本仓库维护者发版自查，不随插件运行时规则注入用户对话。

---

## 1. 修改 `agents/cmd-verifier.md` frontmatter 必须分两版发布（硬规则）

### 为什么不能单版直接改？
已安装旧版 `agy-cmd` 的用户在侧栏点击「在线自更新」时，执行校验的是**本地旧版** `sidecars/panel/version-update.mjs` 中的 `isValidVerifierRole()`（`validate-archive` 阶段）。
如果新版压缩包直接给 `agents/cmd-verifier.md` 新增或变更了旧版校验器不认识的 frontmatter 字段（例如 `commandExecutionPolicy` 或额外只读工具），旧版自更新器会立即把新包判为 `incomplete` 并拒绝升级（`v2.6.0 → v2.7.0` 离线自更新验证已实测暴露该问题）。

### 标准两版升级步骤
1. **第 N 版（先放宽校验器，不动角色文件）**：
   - 同步放宽 [sidecars/panel/version-update.mjs](../sidecars/panel/version-update.mjs) 的 `isValidVerifierRole` 与 [skills/agy-cmd/scripts/setup_auto_router.py](../skills/agy-cmd/scripts/setup_auto_router.py) 的 `validate_verifier`（仅放宽经确认安全的只读工具白名单或无害元数据字段，严禁放行写/shell/MCP 权限）。
   - 保持 `agents/cmd-verifier.md` frontmatter 不变，补充新旧版本离线自更新回归测试后发布第 N 版。
2. **第 N+1 版（确认存量升级后再改角色字段）**：
   - 待存量用户基本升至第 N 版及以上，再修改 [agents/cmd-verifier.md](../agents/cmd-verifier.md) 的 frontmatter，并在离线自更新测试中验证 `N → N+1` 顺利通过。

### `agents/cmd-verifier.md` 下线与删除进度（Antigravity #1890 · 4× 自定义 Agent 计费）
因 Antigravity `1.5.17+` 对自定义/插件 Agent 计约 4× 配额，独立复核与卡壳换视角已迁回官方内置只读 `research`（1× 原价）。为避免 `<= 2.8.1` 存量用户在侧栏在线自更新时因旧版 `REQUIRED_FILES` 缺文件触发 `UpdateError("incomplete")`，`agents/cmd-verifier.md` 至少保留 2 个版本再删除：
1. **本版（第 N 版）**：钩子、Skill 与文档全部改派内置 `research` / `self`；新版 `version-update.mjs` 与 `setup_auto_router.py` 已放宽为 `agents/cmd-verifier.md` 可选存在（存在时仍严检只读安全不变量）；`agents/cmd-verifier.md` 保留兼容 `v2.8.1` 的 frontmatter，仅把 `description` 改为 YAML 安全 `DEPRECATED` 文案（不含 `: ` 与 ` #`）。
2. **第 N+1 版**：继续保留 `agents/cmd-verifier.md` 占位文件，为跳过第 N 版的存量用户留出升级缓冲（若实测发现未调用的占位文件仍影响默认会话扣额，可评估提前至 N+1 删除）。
3. **第 N+2 版（删除占位文件）**：删除 `agents/cmd-verifier.md` 与空 `agents/` 目录；发版说明必须附**跳版直升兜底提示**：「`<= 2.8.1` 用户若跨版在线更新提示 `incomplete`，请改用 `python skills/agy-cmd/scripts/setup_auto_router.py --install` 脚本安装（或先升至中间版本）」。

---

## 2. 其他发版兼容性红线

- **保留 `hooks.json` 跨工作区引导器**：不得删除 `hooks.json` 中的跨工作区路径解析引导器，避免旧版 IDE 在外部业务仓库 `cwd` 下找不到插件钩子脚本。
- **不将 Sidecar 面板迁移为 MCP Apps**：保持独立 `sidecars/panel` 架构，确保设置页与钩子低延迟互通。
- **版本号多处同步**：正式切版时需同步更新 `package.json`、`plugin.json`（含 `description`）、`sidecars/panel/index.html`（`.ver-pill`）、`skills/agy-cmd/SKILL.md` 标题版本，以及远程首装固定标签引用（`install.ps1`、`install.sh` 的默认标签与 `README.md`、`README.zh-CN.md` 的固定标签安装命令）；未附带正式 `LICENSE` 文件前不在 `plugin.json` 虚填 `license` 字段。
- **单机同步与零漂移**：源码改动后若需在本机立即生效并消除同步漂移，先运行：
  ```bash
  python skills/agy-cmd/scripts/setup_auto_router.py --install
  ```

---

## 3. 发版前标准验收命令

在 `e:/work/agy-cmd` 根目录执行，全部通过且无告警方可打 Tag / 发 Release：

```bash
npm test && python -m unittest discover -s test -p "test_*.py" -v && python skills/agy-cmd/scripts/setup_auto_router.py --sync-check --json && agy plugin validate --strict --json .
```
