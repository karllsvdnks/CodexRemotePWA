# Codex Remote PWA 交接文档

本文件是此项目的 agent 工作约定与运维交接说明。开始改动前先阅读本文件、`README.md`、`教程.md`，再按需要阅读对应源码。用户面向手机的说明在 `客户端使用说明.md`。

## 1. 项目目标与边界

Codex Remote PWA 是一套仅自托管在这台 Windows 电脑上的 Codex 远程控制台：

- iPhone 通过 Tailscale HTTPS 访问 PWA，只输入此服务的独立访问密码。
- Node 服务仅监听回环地址，代表手机在固定的 `WORKSPACE_ROOT` 中启动本机 Codex CLI。
- 提供商密钥、Codex 状态、桌面会话和工作目录始终留在电脑上，不能通过浏览器 API 返回。
- 每轮远程任务先进入批准状态，只有手机端明确批准才会调用 Codex。
- PWA 可以读取并续接本机 Codex 历史；从本机历史继续的远程回合必须写回原始 Desktop JSONL，以便电脑端能继续看到记录。

这是个人私网工具，不是多租户服务。不要将它改为绑定公网 IP、端口转发、第三方托管、无密码访问、跳过审批或跳过沙箱的服务。

## 2. 当前部署约束

### 启动策略

- PWA **没有** Windows 登录或开机自启动任务。用户要求手动启动，禁止重新创建名为 `CodexRemotePWA` 或其他名称的计划任务、Run 注册表项或启动文件夹入口。
- `Tailscale` 是官方安装程序创建的 Windows 服务。它是否随 Windows 自启由 Tailscale 管理；不要更改其启动类型，除非用户明确要求。
- 项目根目录的 `Start-CodexRemotePWA.cmd` 是唯一推荐入口。它优先运行 `CodexRemoteConsole.exe`，若 EXE 缺失才回退到 `scripts/codex-remote-client.ps1`。
- `CodexRemoteConsole.exe` 是独立 WinForms 客户端，不会启动 PWA，只有用户点击“启动服务”时才启动 Node 服务。当前客户端运行时可留在桌面上。
- 需要停止服务时，只停止已确认属于本项目、且由客户端记录的 Node 进程。绝不能按端口或名称盲目结束未知进程。

### 网络与安全

- 服务默认地址是 `127.0.0.1:8787`。外部访问通过 `tailscale serve --bg <port>` 代理，不直接暴露 `8787`。
- 已使用 Tailscale HTTPS 时，`.env` 中应保持 `COOKIE_SECURE=1`、`TRUST_PROXY=1` 和正确的 `PUBLIC_ORIGIN=https://...ts.net`。这三个值必须与实际入口同时更新。
- `.env`、`data/`、`node_modules/` 被忽略。不要打印、提交、上传或在响应中复述 `REMOTE_PASSWORD`、`OPENAI_API_KEY`、cookie、Tailscale 凭据或任何 `.env` 值。
- `OPENAI_API_KEY` 是 Codex CLI 的通用 OpenAI 兼容环境变量名，不意味着流量一定发往 OpenAI。已知本机 Codex 配置使用自定义 `apexcode` 提供商，修复认证时必须保留该 `model_provider`，不得擅自切回 `openai`。

## 3. 架构与数据流

```text
iPhone PWA
  -> Tailscale HTTPS / tailscale serve
  -> Node server.mjs (127.0.0.1)
  -> Codex CLI (独立 API CODEX_HOME，普通远程任务)
  -> 固定 WORKSPACE_ROOT

Codex Desktop sessions JSONL
  <-> server.mjs (只读索引、续接、完成后追加镜像事件)
  <-> iPhone 的“本机”会话列表
```

1. `POST /api/login` 校验 `REMOTE_PASSWORD`，以 HttpOnly、SameSite=Strict cookie 建立 14 天本地会话；同一 IP 连续 5 次失败会限制 10 分钟。
2. 手机创建 thread、上传附件或提交消息。消息只会写入 `pendingApproval`，状态为 `awaiting_approval`。
3. `approve` 将消息落入 thread，并用 `codex exec --json` 启动或用 `codex exec resume <session-id>` 续接。
4. `server.mjs` 解析 Codex JSONL 事件，推送 SSE 到手机、保存 `data/threads.json`，并在 `turn.completed` 后立即解除运行锁。
5. `source === "desktop"` 的 thread 还会读取/追加 Desktop session JSONL，完成后重新合并本机转录，保证双端可见。

## 4. 关键文件

| 路径 | 责任 | 修改注意事项 |
| --- | --- | --- |
| `server.mjs` | HTTP API、认证、Codex CLI、PWA 状态、文件安全、Desktop JSONL 同步 | 单文件核心；保持无依赖 Node 20 ESM 风格，所有状态改动都要 `saveThreads()`。 |
| `public/app.js` | 手机端交互、PWA 会话列表、批准、文件、SSE | 登录表单使用 `form.querySelector('button[type="submit"]')`，不要改回依赖全局 `form.submit` 的写法。 |
| `public/styles.css` | 响应式手机/桌面 UI | 修改 PWA 静态文件时同步更新 service worker 缓存版本。 |
| `public/sw.js` 与 `public/index.html` | 离线外壳与资源版本 | 当前为 `v9`；改变 `app.js`、`styles.css` 或 shell 资源时同时递增 cache 名和 query 版本，避免 iOS 继续使用旧 UI。 |
| `data/threads.json` | 远程 thread、消息、附件、Desktop 镜像状态 | 用户数据；不得删除或用无关结构覆盖。做迁移前先备份。 |
| `WORKSPACE_ROOT/.codex-remote-uploads/` | 每个 thread 的上传附件 | 只允许服务内部写入，不允许列出为普通文件。 |
| `scripts/bootstrap-codex-api-auth.mjs` | 以标准输入为独立 `CODEX_HOME` 初始化 API 登录 | 不打印 Key；自定义 provider 会跳过 `api.openai.com` 校验。 |
| `scripts/start-codex-remote.ps1` | 前台诊断运行 Node | 关闭窗口或 `Ctrl+C` 会停止本次前台服务。 |
| `scripts/codex-remote-client.ps1` | WinForms 后备客户端 | Windows PowerShell 解析中文时依赖 UTF-8 BOM，保留 BOM。 |
| `client/CodexRemoteConsole.cs` | 当前独立 WinForms 客户端源码 | 可执行文件无 PowerShell UI 依赖，适合作为手动启动入口。 |
| `scripts/build-codex-remote-client.ps1` | 用 .NET Framework C# 编译器构建 EXE | 目标是项目根的 `CodexRemoteConsole.exe`。 |
| `scripts/manage-tailscale.ps1` | 管理员权限启动/停止 Tailscale 服务 | 只能从客户端的显式用户操作调用。 |
| `test/integration.mjs` | 无真实模型的端到端替身测试 | 覆盖认证、审批、上传、文件和 Desktop 镜像。 |

## 5. 配置模型

配置优先级是 `process.env` 覆盖项目根 `.env`。发行 ZIP 会由 `scripts/release-default.env` 生成一份仅含安全缺省值的 `.env`；只读取真实 `.env` 来诊断，不在输出中显示它。

| 配置 | 是否必需 | 说明 |
| --- | --- | --- |
| `REMOTE_PASSWORD` | 是 | 手机登录服务的独立长随机密码。 |
| `WORKSPACE_ROOT` | 是 | 远程 Codex 与文件 API 唯一允许操作的根目录。 |
| `OPENAI_API_KEY` | API 模式需要 | 仅传给本机 Codex 子进程；可承载 ApexCode 等兼容提供商凭据。 |
| `CODEX_HOME` | 推荐 | 普通远程会话的独立 Codex 状态目录，避免切换 Desktop App 的 ChatGPT 登录。此目录内必须有适用于远程 provider 的 `config.toml`。 |
| `DESKTOP_CODEX_HOME` | 可选 | Desktop App 历史位置，默认 `%USERPROFILE%\\.codex`。 |
| `ENABLE_DESKTOP_SESSION_HISTORY` | 可选 | 设为 `0` 可隐藏“本机”入口。 |
| `HOST` / `PORT` | 可选 | 默认 `127.0.0.1:8787`。不要设为公网地址。 |
| `PUBLIC_ORIGIN` | HTTPS 时需要 | Tailscale HTTPS 的不带末尾 `/` 地址，用于 Origin 校验。 |
| `COOKIE_SECURE` / `TRUST_PROXY` | HTTPS 时需要 | 分别使 cookie 标记 Secure，并信任 Tailscale 代理的 HTTPS 协议头。 |
| `CODEX_MODEL` | 可选 | 传给新建远程会话的模型参数。 |
| `CODEX_SANDBOX` | 可选 | 正常应为 `workspace-write` 或 `read-only`；不要设为 `danger-full-access`。 |
| `CODEX_COMMAND` | 可选 | Windows 非默认 CLI 安装位置，格式为 `node.exe 路径|codex.js 路径`。 |
| `APP_DATA_DIR` | 测试/高级可选 | 覆盖 `data/` 状态目录。 |

### Provider 与身份排错

当出现 `401 Missing bearer or basic authentication`：

1. 不要先把 provider 改成 OpenAI。
2. 检查远程进程使用的 `CODEX_HOME/config.toml` 是否包含正确的自定义 `model_provider`。
3. 检查 `OPENAI_API_KEY` 是否只在本机 `.env` 或服务环境中可用。
4. 执行 `npm run auth:api` 为**该远程 `CODEX_HOME`**初始化登录。该脚本会根据该目录内 `config.toml` 判断是否跳过官方 API 校验。
5. 在客户端停止并重新启动 PWA，使 Node 子进程读取最新环境。

不能通过更换 Desktop App 账号或重置 `C:\Users\<用户>\\.codex` 来处理此问题；这会破坏用户已有会话记录。

## 6. 会话与 Desktop 同步不变量

Desktop 历史的相关逻辑集中于 `server.mjs` 的 `createDesktopThread`、`synchronizeDesktopThread`、`mirrorDesktopTurn`、`backfillDesktopMirrors` 和 JSONL 解析函数。

- “本机”列表只暴露工作目录位于 `WORKSPACE_ROOT` 内的 Desktop session；系统提示、工具调用和其他目录不应返回给手机。
- 附加本机会话时，thread 记录 `source: "desktop"`、原始 `desktopSessionId` 和已有的 `codexSessionId`；下一条批准消息必须续接该 ID。
- 对 desktop thread，子进程 `CODEX_HOME` 强制使用 `DESKTOP_CODEX_HOME`，以便续接同一原始会话；普通远程 thread 使用独立 `CODEX_HOME`。
- 远程完成后只向对应 Desktop JSONL **追加** `event_msg` 记录，分别为 `user_message` 与 `agent_message`。不能重写、排序或截断原始 session 文件。
- 去重键是 `role + SHA-256(message text)`；保留此幂等性，以便服务重启后的 backfill 不产生重复消息。
- Desktop JSONL 可能出现原始换行而非转义 `\\n`。解析代码必须继续支持这种记录，不能用简单 `split("\\n")` 假设每行都是完整 JSON。
- 同步完成后会清空 15 秒的 Desktop cache 并重新合并转录。若 Desktop App 已打开旧页面，用户可能仍需返回会话列表后重新进入；没有公开 API 能强制其热重载。

修改这一部分时，先执行完整 `npm test`，再使用真实的“本机 -> 继续此会话 -> 手机批准一轮 -> Desktop 重开历史”的人工验证。

## 7. 文件、批准与 API 不变量

### 批准和任务状态

- 合法状态主要是 `idle`、`awaiting_approval`、`running`、`cancelled`、`error`。同一 thread 运行或待批准时不能再次提交。
- 新消息 API 只创建 pending approval；不要把它直接送入 `launchCodex`。
- 归档的 thread 不能发送消息；恢复后才可使用。pin/category/archive 只对 PWA 自己管理的 thread 生效。
- `turn.completed` 是 Windows 上及时释放运行锁的权威信号，因为 CLI 可能稍后才真正退出。保留 `completedRuns` 逻辑，避免重复 finish。

### 上传与文件浏览

- 每条消息最多 5 个附件，每个最大 25 MiB；上传留在 `.codex-remote-uploads/<thread-id>/`。
- 文件 API 只解析 `WORKSPACE_ROOT` 内路径，必须继续拒绝符号链接、隐藏项、`.env*`、`.git` 与 `node_modules`。
- 文本预览上限 1 MiB，下载上限 100 MiB。只允许普通文件；目录不能预览或下载。
- 变更文件 API 时优先使用 `realpath` 与相对路径校验，不能仅靠字符串 `startsWith` 防御路径逃逸。

### 主要接口

认证后的前端依赖这些接口：

- `GET /api/config`、`GET /api/threads`、`POST /api/threads`
- `GET /api/threads/:id`、`POST /messages`、`/approve`、`/reject`、`/cancel`
- `POST /pin`、`/archive`、`/restore`、`/category`，`GET /events`（SSE）
- `POST /uploads`
- `GET /api/local-sessions`、`GET /api/local-sessions/:id`、`POST /attach`
- `GET /api/files`、`/preview`、`/download`

所有改变状态的 API 都要调用 `requireOrigin`。`/api/login` 允许首次请求缺少 Origin，但仍校验已有 Origin 与 `PUBLIC_ORIGIN`/Host。

## 8. 日常运维

### 正常手动操作

1. 双击 `Start-CodexRemotePWA.cmd`。
2. 在 `Codex Remote 控制台` 中确认 PWA 与 Tailscale 状态。
3. 仅在用户需要远程访问时点击“启动服务”；手机仍通过 Tailscale HTTPS 地址访问。
4. 修改设置后，点击“停止服务”再“启动服务”应用 `.env` 的非敏感配置。
5. 结束时，按用户意图停止 PWA。关闭控制台窗口本身不会停止后台 PWA。

“启动/停止 Tailscale”会触发 Windows 管理员确认；停止会立刻断开 iPhone 的私网访问。不要在后台、脚本安装或测试中自动执行这两个动作。

### 前台诊断

```powershell
cd <项目根目录>
.\scripts\start-codex-remote.ps1
```

前台服务会将错误直接输出到窗口，适合诊断端口、Node、`.env` 或 CLI 问题。关闭它会停止服务。

### 重建桌面客户端

```powershell
cd <项目根目录>
.\scripts\build-codex-remote-client.ps1
```

构建使用 `%WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe`，生成项目根 `CodexRemoteConsole.exe`。修改 C# 源码后必须重建并实际打开窗口确认。不要用隐藏 PowerShell 窗口替代 EXE；这曾导致“控制台已经打开”但界面不可见的问题。

## 9. 开发与验证

### 必做检查

```powershell
cd <项目根目录>
npm test
```

该测试使用 `test/fake-codex.mjs`，不会请求真实模型或读取真实 `.env`。它覆盖：

- 登录、thread 创建、审批、取消、归档、pin 和分类；
- 首次 Codex session 创建以及下一轮 resume；
- 文件浏览、隐藏 `.env`、文本预览、下载和上传路径；
- Desktop JSONL 解析、从本机附加、远程回合写回和重启补写。

按改动面补充以下人工检查：

| 改动 | 额外验证 |
| --- | --- |
| `server.mjs` / 安全路径 | 运行 `npm test`；确认 `/api/me` 未登录时返回 `authenticated: false`，且不是连接失败。 |
| `public/*` | iPhone 通过 HTTPS 刷新后检查登录、会话、批准和文件界面；递增 SW/资源版本。 |
| Desktop 同步 | 完成一次真实 Desktop 续接并重开电脑端历史核对。 |
| `.env` / 认证 | 用客户端重启 PWA；不在终端输出密钥。 |
| C# 客户端 | 重建 EXE，双击 `Start-CodexRemotePWA.cmd`，确认窗口中所有按钮与状态文字可见。 |
| Tailscale 配置 | 仅在用户允许时检查 `tailscale serve status` 与手机 HTTPS；不要改变服务自启。 |

## 10. 变更原则

- 先读源码和已有测试，保持项目无框架、原生 Node HTTP 的风格，不为小需求引入前端或服务端依赖。
- 对 server 状态变更，确保持久化、SSE 发布、并发限制和测试同步更新。
- 使用 `apply_patch` 做手工编辑；不要为读取/写入简单文本额外引入 Python。
- Windows PowerShell 解析包含中文的脚本时需要 UTF-8 BOM。新增或改写 `.ps1` 后验证 parser，避免出现乱码或字符串未闭合。
- 不要修改用户无关的 Desktop Codex 配置、会话文件、Tailscale 服务设置或项目外文件。
- 文件更新、服务停止、计划任务删除等破坏性操作前必须确认目标并保留用户数据；不要删除 `data/` 或 Desktop `sessions/` 来“修复”同步。
- 交接时报告已修改文件、服务是否实际运行、验证结果和未处理风险；不要只给出计划。

## 11. 常见故障速查

| 现象 | 优先检查 | 不应采取的做法 |
| --- | --- | --- |
| 手机无法访问 | PWA 是否运行、Tailscale 服务、`tailscale serve`、HTTPS Origin/cookie 设置 | 绑定 `0.0.0.0` 或开放路由器端口。 |
| `401 Missing bearer...` | 远程 `CODEX_HOME` 的 provider 配置与 `OPENAI_API_KEY` 传递 | 删除 Desktop 历史或强制改用 OpenAI。 |
| “控制台已打开”却无界面 | 从项目根运行当前 `Start-CodexRemotePWA.cmd`，重建/使用 EXE | 恢复旧 mutex/隐藏 PowerShell launcher。 |
| 手机继续后 Desktop 无记录 | `source: desktop`、`desktopMirrorState`、目标 JSONL 可写、`npm test` | 覆盖或重新生成整个 Desktop JSONL。 |
| 手机仍是旧界面 | `public/sw.js` cache/query 版本与 iOS PWA cache | 只改 `app.js` 而不升级 service worker 版本。 |
| 无法停止 PWA | 是否由当前客户端记录了 PID；否则用原启动窗口处理 | 依据端口强杀任意 Node 进程。 |
| “打开工作台”无反应 | 本地服务状态、浏览器地址、登录 cookie 和 `app.js` 控制器 | 自动创建新的开机任务或重置所有状态。 |
