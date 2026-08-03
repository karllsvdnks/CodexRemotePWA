# Codex Remote PWA

一个只部署在自己电脑上的手机端 Codex 控制台。手机只登录此服务的独立密码；提供商密钥、Codex 本地会话和工作目录都留在运行服务的电脑上。

当前发布版本：`0.0.3`

这是面向 Windows 的独立发行包，只包含运行所需文件、本说明和 [教程.md](./教程.md)。

## 安装与运行

要求：Node.js 20+、已安装并可在该电脑上运行的 Codex CLI。需要 iPhone 私网访问时，发行包已附带官方 Windows x64 Tailscale 安装程序。

1. 将 ZIP 解压到固定目录，例如 `C:\CodexRemotePWA`。
2. 双击 `Start-CodexRemotePWA.cmd`。首次运行会自动打开 `CodexRemoteSetup.exe`；它会引导你生成访问密码、选择工作目录、设置独立 Codex 状态目录，并配置可选的 API 登录和 Tailscale HTTPS。
3. 需要 iPhone 私网访问时，在向导中运行 `installers\tailscale-setup-1.98.10.exe`，完成 Tailscale 安装并登录自己的 tailnet。安装程序需要联网；它只安装 Tailscale，不会创建本项目的 Windows 自启动任务。
4. 向导保存配置后会打开控制台。在控制台中点击“启动服务”。

服务默认只监听 `127.0.0.1:8787`。浏览器打开 `http://127.0.0.1:8787` 可先在电脑本机验证。前台排错可运行 `scripts/start-codex-remote.ps1`；关闭该窗口或按 `Ctrl+C` 会停止前台服务。

本机控制台可手动启动或停止 PWA、查看日志、管理 Tailscale、编辑非敏感运行设置及打开本教程。入口优先运行独立的 `CodexRemoteConsole.exe`，不会注册 Windows 自启动任务。

`OPENAI_API_KEY` 是可选配置，只会传给本机 Codex CLI。它不会被任何 API 返回、不会写入浏览器代码，也不会发送到手机。也可以不在 `.env` 写 Key，改为让此服务进程继承已经设置好的系统环境变量。

首次为独立 `CODEX_HOME` 配置 API 身份时，执行：

```powershell
npm run auth:api
```

该命令将 `.env` 中的 Key 通过标准输入交给 Codex CLI，在独立状态目录中保存 API 登录；它不会打印 Key。使用自定义提供商时，该命令会跳过仅适用于 `api.openai.com` 的官方 API Key 校验。

发行 ZIP 不包含开发测试文件。安装后请按上面的启动步骤访问 `http://127.0.0.1:8787`，使用配置的独立密码完成本机验证。

## 私网访问

建议电脑与 iPhone 同时加入 Tailscale，并通过 `tailscale serve --bg 8787` 将本服务的 loopback 地址发布到你的 tailnet。此服务不要直接绑定公网 IP，也不要把 8787 端口映射到路由器。HTTPS listener 需要先在 tailnet 的 DNS 管理页启用 HTTPS certificates。

通过 HTTPS 访问时，在 `.env` 设置：

```text
COOKIE_SECURE=1
TRUST_PROXY=1
PUBLIC_ORIGIN=https://<设备>.<tailnet>.ts.net
```

`TRUST_PROXY=1` 只应在 Tailscale Serve 这类由本机可信反向代理转发 HTTPS 的场景启用；它使跨站保护按代理传入的 HTTPS 协议校验 Origin。使用 Tailscale Serve 时，还应设置 `PUBLIC_ORIGIN=https://<设备>.<tailnet>.ts.net`，避免代理改写 `Host` 后拒绝手机端登录。

用 iPhone Safari 打开 Tailscale 提供的 HTTPS 地址，然后使用「添加到主屏幕」安装。iOS 不需要登录 ChatGPT，且 PWA 不会接触 ChatGPT 的登录状态。

## Codex 会话与隔离

首次发送消息时，服务使用 `codex exec --json` 创建一个本地 Codex session，并记录返回的 session ID。后续消息自动使用 `codex exec resume <session-id>`，所以每个远程任务会持续保留 Codex 上下文。服务自己的会话索引保存在 `data/threads.json`。

`WORKSPACE_ROOT` 是服务端的固定工作目录。手机不能替换它，也不能传入 Codex 命令行参数。默认沙箱是 `workspace-write`，不要为便捷性启用危险的跳过审批或沙箱选项。

若你要把远程 API 身份与 Codex Desktop 的 ChatGPT 登录彻底隔开，请为服务设置独立的 `CODEX_HOME` 路径，并仅给服务进程提供 `OPENAI_API_KEY`。这样不会要求 iOS 或 Desktop App 切换 ChatGPT 账号。

## 本机历史

侧栏的「本机」会扫描 `DESKTOP_CODEX_HOME/sessions`，但只显示保存工作目录位于 `WORKSPACE_ROOT` 内的用户与助手消息；系统提示、工具调用、文件路径和其他工作目录不会返回到手机。默认的 `DESKTOP_CODEX_HOME` 是 Windows 用户目录下的 `.codex`，可在 `.env` 覆盖。

选择一条本机历史时先以只读方式查看。点击「继续此会话」会创建一个远程入口；下一条消息使用桌面端的 `CODEX_HOME` 续接原始 Codex session，因此会将新回合写回原始历史。普通远程会话仍使用独立的 `CODEX_HOME`。

将 `ENABLE_DESKTOP_SESSION_HISTORY=0` 写入 `.env` 可完全隐藏本机历史。

## Windows 的 Codex CLI

默认会尝试启动标准全局 npm 安装位置的 Codex CLI。若 Codex 安装在其他位置，在 `.env` 设置：

```text
CODEX_COMMAND=C:\\Program Files\\nodejs\\node.exe|C:\\path\\to\\@openai\\codex\\bin\\codex.js
```

## 批准与文件

每条远程消息先进入“待批准”状态；在手机上检查任务内容与本轮权限（只读或可写）后，点击“批准运行”才会启动 Codex。“拒绝”会丢弃尚未执行的消息。该批准闸门控制整轮 Codex 运行；CLI 的 JSON 执行模式不提供逐条命令的交互审批回调。

消息输入框左侧的“+”可添加最多 5 个文件，每个文件最大 25 MB。文件只写入 `WORKSPACE_ROOT/.codex-remote-uploads/`，不会离开这台电脑；批准后，Codex 会收到这些文件在工作目录内的路径。附件名会显示在消息与待批准区域中。

顶部“文件”面板只允许浏览 `WORKSPACE_ROOT` 内的普通文件。文本、图片、音频和视频可预览，所有普通文件可下载，单次下载上限为 100 MB。符号链接、隐藏文件、`.env*`、`.git` 和 `node_modules` 不会暴露给手机端。

从“本机”续接的任务会使用 Desktop 的 `CODEX_HOME` 写回原始 session。v7 还会为每个已完成的远程回合追加 Desktop 所识别的会话事件；升级时会补写已连接会话中最后一个本机事件之后缺失的远程记录。完成后 PWA 会强制重新读取该 JSONL 并刷新本机列表。若 Codex Desktop 当时已经打开旧会话，请返回会话列表后重新打开该会话；Desktop 没有公开接口可让外部进程强制其正在显示的会话热重载。

竖线前是 Node 可执行文件，后是 Codex 的 `bin/codex.js`。不要把 API Key 放在 URL、PWA 页面、浏览器 Local Storage 或第三方托管平台。
