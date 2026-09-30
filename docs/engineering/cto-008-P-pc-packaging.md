# CTO-008-P: PC 端打包方案设计

| 属性       | 值                                                                               |
| ---------- | -------------------------------------------------------------------------------- |
| 状态       | 设计完成 / 待实现                                                                |
| 版本       | v1.0.0                                                                           |
| 作者       | 小全执笔，小柯验证，小狄审核                                                     |
| 依赖       | TriPilot（已有）/ TriRLC（已有）/ TriCode（待初始化）/ cto-008-m-comm-protocol（已设计） |
| 最后更新   | 2026-07-16                                                                       |

## 1. 目标

将 TriMetaverse 四模块整合为 **单一 PC 桌面应用**，以 VSCodium 为 Electron 壳，TriPilot 为交互入口，TriRLC 为本地执行引擎，TriCode 为工具 glue 层。各模块保持独立 git 仓，通过分发脚本统一组装。

---

## 2. 现状基线

| 模块       | 当前形态                                   | 打包就绪度 | 缺口                                         |
| ---------- | ------------------------------------------ | ---------- | -------------------------------------------- |
| **TriPilot** | VS Code 扩展（`vsce package` 可用）        | 🟡 70%     | VSCodium 兼容性需验证；需预配置默认 provider  |
| **TriRLC**  | Node.js HTTP 服务器 + agentLoop            | 🟡 60%     | 缺少 CLI 入口（start/stop/status）；需自启动  |
| **TriCode** | 纯产品规格，无代码                         | 🔴 5%      | 模块骨架、glue 接口、各工具 adapter 均待实现  |
| **TriMMC**  | 中央调度服务器（远端）                     | 🟢 N/A     | 不参与 PC 打包（云端部署）                    |

### 2.1 TriPilot 现状

- VS Code 扩展，支持 3 种 chat provider：`vscode-lm` / `copilot-direct` / `models-direct`
- 已有 VSCodium 兼容：`tripilot.copilotDirect.deviceFlow.enabled`（OAuth device flow 回退，专为 VSCodium 设计）
- 已有 `"package": "vsce package"` 脚本
- 支持 MCP servers、agent profiles、45+ built-in tools
- **关键配置**（桌面版预计配置）：
  ```json
  {
    "tripilot.chatProvider": "models-direct",
    "tripilot.modelsDirect.baseUrl": "http://127.0.0.1:8711",
    "tripilot.modelsDirect.defaultModel": "deepseek-v4-pro"
  }
  ```
  — TriPilot 通过 `models-direct` 模式直连 TriRLC，TriRLC 负责代理到 TriMMC

### 2.2 TriRLC 现状

- `src/index.ts`：启动 daemon + HTTP 服务器（端口默认 8711）
- `POST /internal/v1/agent`：SSE/JSON 双模式，自动 proxy 到 TriMMC 或本地 agentLoop
- `ConnectionManager`：3 态切换（connected/degraded/local）
- **预配置 `vscodiumGlueBaseUrl`**：`process.env.VSCODIUM_GLUE_BASE_URL ?? 'http://127.0.0.1:8730'`
- **缺口**：无 CLI 命令（`trilc start` / `trilc stop` / `trilc status`），需添加

### 2.3 TriCode 现状

- 产品规格完成（`docs/registry/product-state.md`），明确多工具接入 tier 模型
- Tier 1: opencode → Tier 2: Claude Code → Tier 3: Codex/zcode/Copilot
- **工程代码为零**，需从骨架初始化开始
- PC 打包的 TriCode glue 角色：作为 TriPilot 可 import 的 npm 包，提供统一的 `executeCodeTask()` 接口

---

## 3. 桌面应用架构

### 3.1 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│                   TriMetaverse Desktop                       │
│                   (VSCodium Electron)                        │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              TriPilot Extension (预装)                │   │
│  │  ┌─────────┐  ┌──────────┐  ┌────────────────────┐  │   │
│  │  │ Chat UI │  │   MCP    │  │   Agent Profiles   │  │   │
│  │  │(webview)│  │ Servers  │  │ (ceo/cpo/cto/...)  │  │   │
│  │  └────┬────┘  └──────────┘  └────────────────────┘  │   │
│  │       │                                              │   │
│  │       │  models-direct (HTTP to TriRLC)               │   │
│  │       ▼                                              │   │
│  │  ┌──────────────────────────────────────────────┐   │   │
│  │  │            TriCode Glue (npm pkg)             │   │   │
│  │  │  • executeCodeTask(task, tool?)               │   │   │
│  │  │  • listAvailableTools()                       │   │   │
│  │  │  • getToolStatus(tool)                        │   │   │
│  │  └────────────────────┬─────────────────────────┘   │   │
│  └───────────────────────┼─────────────────────────────┘   │
│                          │                                  │
│  ┌───────────────────────┼──────────────────────────────┐  │
│  │                  TriRLC Daemon                        │  │
│  │  ┌────────────────────▼──────────────────────────┐  │  │
│  │  │  HTTP Server (:8711)                          │  │  │
│  │  │  POST /internal/v1/agent  ← TriPilot 调用     │  │  │
│  │  │  GET  /healthz            ← 健康检查           │  │  │
│  │  └────────────────────┬──────────────────────────┘  │  │
│  │  ┌────────────────────▼──────────────────────────┐  │  │
│  │  │  ConnectionManager                            │  │  │
│  │  │  connected → proxy to TriMMC                   │  │  │
│  │  │  degraded  → local agentLoop                  │  │  │
│  │  └───────────────────────────────────────────────┘  │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │  LocalNode + LocalPlanner + TaskRuntime        │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                          │
                          │ HTTP (在线时)
                          ▼
              ┌──────────────────────┐
              │     TriMMC (云端)      │
              │  POST /internal/v1/  │
              │  agent               │
              └──────────────────────┘
```

### 3.2 数据流

```
用户输入 → TriPilot Chat UI
           │ models-direct POST /v1/chat/completions
           ▼
         TriRLC (:8711)
           │ POST /internal/v1/agent
           ├── TriMMC 在线 → proxy → TriMMC agentLoop
           └── TriMMC 离线 → local agentLoop (agent-core)
           │
           ▼ SSE/JSON 流式响应
         TriPilot Chat UI 渲染
```

### 3.3 端口分配

| 端口  | 服务                       | 说明                       |
| ----- | -------------------------- | -------------------------- |
| 8710  | TriMMC（云端）              | PC 桌面不捆绑              |
| 8711  | TriRLC daemon               | PC 本地自启动              |
| 8730  | VSCodium Glue（预留）      | 当前未使用，未来扩展用     |

---

## 4. 模块打包方案

### 4.1 TriPilot — VS Code 扩展

**当前形态**：标准 VS Code 扩展（`.vsix`），通过 `vsce package` 打包。

**PC 打包需求**：
1. 编译 `tsc -p .` → `out/`
2. 复制 `resources/`、`media/`、`package.json` 到扩展目录
3. 预注入默认配置（`models-direct` provider → `http://127.0.0.1:8711`）
4. 打包为 `.vsix`

**预配置注入**（安装时写入 VSCodium `argv.json` 或 `settings.json`）：
```json
{
  "tripilot.chatProvider": "models-direct",
  "tripilot.modelsDirect.baseUrl": "http://127.0.0.1:8711",
  "tripilot.modelsDirect.defaultModel": "deepseek-v4-pro"
}
```

**VSCodium 兼容性**：
- 已有 device-flow OAuth 回退（`tripilot.copilotDirect.deviceFlow.enabled`）
- `vscode.lm` API 在 VSCodium 中可能不可用 → 桌面版默认使用 `models-direct`
- 扩展签名：VSCodium 接受未签名扩展，vsce 打包时 `--allow-missing-repository`

### 4.2 TriRLC — CLI Daemon

**当前形态**：`node dist/index.js` 启动 HTTP 服务器。

**PC 打包需求**：添加 CLI 入口。

#### 4.2.1 CLI 命令设计

```bash
# 启动 daemon（后台运行）
trilc start [--port 8711] [--trimc http://127.0.0.1:8710]

# 停止 daemon
trilc stop

# 查看状态
trilc status
# → { "pid": 12345, "port": 8711, "trimc": "connected", "uptime": 3600 }

# 前台运行（调试用）
trilc run [--port 8711]
```

#### 4.2.2 package.json 修改

```json
{
  "bin": {
    "trilc": "./dist/cli.js"
  }
}
```

#### 4.2.3 CLI 实现（`src/cli.ts`）

```typescript
// 命令行解析 + start/stop/status/run 子命令
// start: spawn detached child process，写入 PID 文件
// stop: 读取 PID 文件，发 SIGTERM
// status: 读 PID 文件 + GET /healthz
// run: 等同于当前 index.ts 的前台模式
```

#### 4.2.4 自启动方案

**方案 A（推荐）**：VSCodium 扩展激活时自动 spawn TriRLC

```typescript
// TriPilot extension.ts activate()
if (isDesktopMode()) {
  const trilcProcess = cp.spawn('trilc', ['start', '--port', '8711'], {
    detached: true,
    stdio: 'ignore'
  });
  trilcProcess.unref();
}
```

- 优点：用户无感，打开 VSCodium 即启动
- 缺点：TriPilot 需要知道 TriRLC 的安装路径

**方案 B**：操作系统级自启动（Windows 服务 / macOS launchd）

```
Windows: 注册为 Windows Service 或 Startup 快捷方式
macOS:   ~/Library/LaunchAgents/com.trimetaverse.trilc.plist
Linux:   ~/.config/autostart/trilc.desktop
```

- 优点：独立于 VSCodium 生命周期
- 缺点：跨平台复杂度高

**推荐**：Phase 1 用方案 A（VSCodium 激活时启动），Phase 2 迁移到方案 B。

### 4.3 TriCode — Glue 层

**当前形态**：纯产品规格，无代码。PC 打包需要的最小实现：

#### 4.3.1 工程骨架

```
TriCode/
├── package.json          # @trimetaverse/tricode
├── tsconfig.json
├── src/
│   ├── index.ts          # 主入口：executeCodeTask()
│   ├── adapters/
│   │   ├── opencode.ts   # Tier 1: opencode glue
│   │   └── claude.ts     # Tier 2: Claude Code glue (future)
│   ├── router.ts          # 工具选择路由（tier + 可用性）
│   └── types.ts           # 公共类型
└── test/
    └── smoke.test.ts
```

#### 4.3.2 核心接口

```typescript
// src/types.ts
export interface CodeTaskRequest {
  task: string;              // 自然语言任务描述
  tool?: 'opencode' | 'claude' | 'auto';
  cwd?: string;              // 工作目录
  mode?: 'execute' | 'plan'; // 执行或仅规划
}

export interface CodeTaskResult {
  tool: string;              // 实际使用的工具
  success: boolean;
  output: string;            // 工具输出
  durationMs: number;
  error?: string;
}

// src/index.ts
export async function executeCodeTask(req: CodeTaskRequest): Promise<CodeTaskResult>;
export function listAvailableTools(): string[];
export function getToolStatus(tool: string): 'available' | 'unavailable' | 'unknown';
```

#### 4.3.3 与 TriPilot 集成

TriPilot 通过 npm 依赖 TriCode：

```json
// TriPilot package.json
{
  "dependencies": {
    "@trimetaverse/tricode": "file:../TriCode"
  }
}
```

TriPilot 工具调用 TriCode：
```typescript
// TriPilot 侧 tool handler
import { executeCodeTask } from '@trimetaverse/tricode';

async function handleCodeTool(params: { task: string }) {
  const result = await executeCodeTask({
    task: params.task,
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });
  return result.output;
}
```

### 4.4 统一分发

#### 4.4.1 目录布局（分发后）

```
TriMetaverse Desktop/
├── VSCodium/                  # VSCodium 可执行文件
│   ├── VSCodium.exe           # (Windows)
│   ├── resources/
│   └── ...
├── extensions/
│   └── tripilot-chat-0.0.1/   # TriPilot 扩展（解压 .vsix）
│       ├── package.json
│       ├── out/
│       └── node_modules/
│           └── @trimetaverse/
│               └── tricode/   # TriCode glue（内联依赖）
├── trilc/                     # TriRLC daemon
│   ├── dist/                  # 编译后的 JS
│   ├── node_modules/          # @trimetaverse/agent-core + trimodel
│   └── package.json
├── tri-code/                  # TriCode（独立，供 import）
│   ├── dist/
│   └── package.json
├── config/
│   └── settings.json          # 预配置（注入到 VSCodium）
└── scripts/
    ├── install.bat            # Windows 安装脚本
    ├── install.sh             # macOS/Linux 安装脚本
    └── start.bat / start.sh   # 启动脚本
```

#### 4.4.2 构建流水线

```
1. TriMMC/packages/agent-core  →  npm pack  →  trilc-v0.1.0.tgz
                              →  npm pack  →  tricode-v0.1.0.tgz
2. TriCode/                   →  tsc + npm pack → tricode-v0.1.0.tgz
3. TriRLC/                     →  tsc + npm install (指向本地 .tgz)
                              →  打包 trilc/
4. TriPilot/                  →  npm install @trimetaverse/tricode (file:)
                              →  tsc + vsce package → tripilot-chat-0.0.1.vsix
5. 下载 VSCodium portable     →  解压到 VSCodium/
6. 组装脚本                   →  复制 extensions/ + trilc/ + config/
                              →  生成 TriMetaverse-Desktop-v0.1.0-{platform}.zip
```

#### 4.4.3 安装脚本（`install.bat`）

```batch
@echo off
:: 1. 注册 TriRLC 为 Windows 自启动（可选）
:: 2. 安装 TriPilot 扩展到 VSCodium
".\VSCodium\VSCodium.exe" --install-extension ".\extensions\tripilot-chat-0.0.1"
:: 3. 注入预配置
copy /Y ".\config\settings.json" "%APPDATA%\VSCodium\User\settings.json"
:: 4. 启动
".\VSCodium\VSCodium.exe"
```

---

## 5. 实现计划

### 5.1 优先级拆分

| 步骤  | 内容                                           | 估时   | 负责人     | 依赖       |
| ----- | ---------------------------------------------- | ------ | ---------- | ---------- |
| P.1   | TriRLC CLI 入口（`src/cli.ts` + `package.json` bin）| 1.5h | 小全       | -           |
| P.2   | TriCode 工程骨架（package.json + 核心接口）    | 2h     | 小全       | -           |
| P.3   | TriPilot ↔ TriCode 集成验证（npm link 链路）   | 1h     | 小全       | P.2         |
| P.4   | TriPilot 自启动 TriRLC（extension.ts spawn）    | 1.5h   | 小柯       | P.1, P.3    |
| P.5   | 统一分发脚本（组装 + 安装脚本）                | 2h     | 小柯       | P.1-P.4     |
| P.6   | 跨平台验证（Windows + macOS + Linux）          | 3h     | 小柯       | P.5         |
| P.7   | 文档 + code-state.md 更新                      | 1h     | 小狄       | P.6         |

**预估总时：12h**

### 5.2 依赖关系

```
P.1 (TriRLC CLI) ──┐
                  ├──► P.4 (自启动) ──┐
P.2 (TriCode) ────┤                  ├──► P.5 (分发) ──► P.6 (验证) ──► P.7 (审核)
                  └──► P.3 (集成) ───┘
```

- P.1 和 P.2 可并行
- P.3 依赖 P.2
- P.4 依赖 P.1 + P.3
- P.5 依赖 P.1-P.4
- P.6 依赖 P.5
- P.7 依赖 P.6

### 5.3 MVP 裁剪

如果时间紧张，Phase 1 MVP 可裁剪为：

| 步骤  | 内容                                | 理由                           |
| ----- | ----------------------------------- | ------------------------------ |
| ✅ P.1 | TriRLC CLI                          | 必须——没有 CLI 无法独立运行    |
| ✅ P.2 | TriCode 骨架（仅接口定义，无 adapter）| MVP：先定义接口，Tier 1 后续   |
| ✅ P.4 | 自启动（方案 A）                     | 必须——用户体验                 |
| ✅ P.5 | 简单分发（Windows 优先）             | MVP：先跑通 Windows            |
| ⏸️ P.3 | 延迟——TriCode 尚无 adapter，无法真实验证 |
| ⏸️ P.6 | macOS/Linux 后续                    |

MVP 裁剪后：**7h**

---

## 6. 风险与缓解

| 风险                           | 概率 | 影响 | 缓解措施                                         |
| ------------------------------ | ---- | ---- | ------------------------------------------------ |
| VSCodium 对 `vscode.lm` 不兼容 | 高   | 低   | 桌面版默认 `models-direct`，绕过 `vscode.lm`     |
| TriRLC `file:` 依赖无法跨机分发  | 中   | 高   | 分发时用 `npm pack` 打 `.tgz`，安装时本地解引用  |
| TriCode 无 adapter 时无法真实验证 | 高   | 中   | MVP 先定义接口，`executeCodeTask` 初始实现为 stub |
| 自启动 spawn 路径问题           | 中   | 中   | 分发脚本写死相对路径，TriPilot 读环境变量         |
| VSCodium 版本更新导致扩展不兼容 | 低   | 中   | 锁定 VSCodium 版本，扩展 `engines.vscode` 固定   |

---

## 7. 附录：VSCodium vs VS Code

| 特性               | VS Code              | VSCodium                     |
| -------------------| ---------------------| ---------------------------- |
| MS 遥测            | 有（可关闭）         | 无                           |
| MS 扩展市场        | 内置                 | 需配置 open-vsx.org          |
| 扩展签名           | 要求                 | 不强制                       |
| `vscode.lm` API    | 可用（含 Copilot）   | 可能不可用（取决于构建）     |
| 许可证             | MS 专有               | MIT                          |
| 品牌               | MS 品牌              | 中性                          |

**选择 VSCodium 原因**：无遥测、MIT 许可、可重新分发、不受 MS 品牌限制。TriPilot 已有 device-flow 回退兼容 VSCodium 认证差异。
