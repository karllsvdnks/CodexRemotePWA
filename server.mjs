import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const appRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")));
const publicRoot = join(appRoot, "public");
const envFile = join(appRoot, ".env");
const fileEnv = await readEnvFile(envFile);
const config = { ...fileEnv, ...process.env };

const password = config.REMOTE_PASSWORD;
if (!password || password === "replace-with-a-long-random-password") {
  console.error("REMOTE_PASSWORD must be configured in .env before starting Codex Remote.");
  process.exit(1);
}

const host = config.HOST || "127.0.0.1";
const port = parsePort(config.PORT, 8787);
const workspaceRoot = resolve(config.WORKSPACE_ROOT || appRoot);
const dataRoot = resolve(config.APP_DATA_DIR || join(appRoot, "data"));
const desktopCodexHome = resolve(config.DESKTOP_CODEX_HOME || join(process.env.USERPROFILE || appRoot, ".codex"));
const desktopSessionsRoot = join(desktopCodexHome, "sessions");
const publicOrigin = config.PUBLIC_ORIGIN?.replace(/\/$/, "") || null;
const threadsFile = join(dataRoot, "threads.json");
const sandbox = ["read-only", "workspace-write", "danger-full-access"].includes(config.CODEX_SANDBOX)
  ? config.CODEX_SANDBOX
  : "workspace-write";
const maxPromptLength = 12_000;
const maxDesktopSessionMessages = 240;
const maxDesktopSessions = 120;
const maxPreviewBytes = 1_000_000;
const maxDownloadBytes = 100 * 1024 * 1024;
const maxUploadBytes = 25 * 1024 * 1024;
const maxAttachmentsPerMessage = 5;
const maxStoredUploads = 160;
const desktopSessionCacheTtlMs = 15_000;
const sessionLifetimeMs = 1000 * 60 * 60 * 24 * 14;
const sessions = new Map();
const loginAttempts = new Map();
const activeRuns = new Map();
const completedRuns = new WeakSet();
const eventClients = new Map();
let saveQueue = Promise.resolve();
let desktopSessionCache = { expiresAt: 0, sessions: [], byId: new Map() };

await mkdir(dataRoot, { recursive: true });
await assertDirectory(workspaceRoot, "WORKSPACE_ROOT");
const workspaceRealRoot = await realpath(workspaceRoot);
const threads = await loadThreads();
await backfillDesktopMirrors();

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    if (status >= 500) console.error(error);
    sendJson(response, status, { error: status >= 500 ? "服务器发生错误。" : error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Codex Remote is listening on http://${host}:${port}`);
  console.log(`Workspace: ${workspaceRoot}`);
  console.log(`Sandbox: ${sandbox}`);
});

async function route(request, response) {
  const baseUrl = `http://${request.headers.host || "localhost"}`;
  const url = new URL(request.url || "/", baseUrl);
  const pathname = decodeURIComponent(url.pathname);

  setSecurityHeaders(response);

  if (pathname === "/api/login" && request.method === "POST") {
    return handleLogin(request, response);
  }
  if (pathname === "/api/logout" && request.method === "POST") {
    requireOrigin(request);
    sessions.delete(readCookie(request.headers.cookie).remote_session);
    response.setHeader("Set-Cookie", clearSessionCookie());
    return sendJson(response, 200, { ok: true });
  }
  if (pathname === "/api/me" && request.method === "GET") {
    const session = getSession(request);
    return sendJson(response, 200, { authenticated: Boolean(session) });
  }

  if (!pathname.startsWith("/api/")) {
    return serveStatic(pathname, response);
  }

  const session = getSession(request);
  if (!session) return sendJson(response, 401, { error: "需要登录。" });

  if (pathname === "/api/config" && request.method === "GET") {
    return sendJson(response, 200, {
      workspaceRoot,
      sandbox,
      model: config.CODEX_MODEL || null,
      desktopHistoryEnabled: config.ENABLE_DESKTOP_SESSION_HISTORY !== "0",
      activeCount: activeRuns.size
    });
  }
  if (pathname === "/api/local-sessions" && request.method === "GET") {
    const sessions = await listDesktopSessions();
    return sendJson(response, 200, { sessions: sessions.map(publicDesktopSession) });
  }
  if (pathname === "/api/files" && request.method === "GET") return handleListFiles(url, response);
  if (pathname === "/api/files/preview" && request.method === "GET") return handleFilePreview(url, response);
  if (pathname === "/api/files/download" && request.method === "GET") return handleFileDownload(url, response);

  const localSessionMatch = pathname.match(/^\/api\/local-sessions\/([a-f0-9-]+)(?:\/(attach))?$/i);
  if (localSessionMatch) {
    const [, sessionId, action] = localSessionMatch;
    const desktopSession = await getDesktopSession(sessionId);
    if (!desktopSession) return sendJson(response, 404, { error: "找不到当前工作目录的本机会话。" });
    if (!action && request.method === "GET") return sendJson(response, 200, { session: publicDesktopSessionDetail(desktopSession) });
    if (action === "attach" && request.method === "POST") {
      requireOrigin(request);
      const thread = createDesktopThread(desktopSession);
      threads.unshift(thread);
      await saveThreads();
      return sendJson(response, 201, { thread: publicThread(thread) });
    }
    return sendJson(response, 405, { error: "不支持此方法。" });
  }

  if (pathname === "/api/threads" && request.method === "GET") {
    return sendJson(response, 200, { threads: publicThreadList() });
  }
  if (pathname === "/api/threads" && request.method === "POST") {
    requireOrigin(request);
    const thread = createThread();
    threads.unshift(thread);
    await saveThreads();
    return sendJson(response, 201, { thread: publicThread(thread) });
  }

  const threadMatch = pathname.match(/^\/api\/threads\/([a-f0-9-]+)(?:\/(messages|uploads|approve|reject|cancel|pin|archive|restore|category|events))?$/i);
  if (!threadMatch) return sendJson(response, 404, { error: "找不到此接口。" });

  const [, threadId, action] = threadMatch;
  const thread = threads.find((entry) => entry.id === threadId);
  if (!thread) return sendJson(response, 404, { error: "找不到此会话。" });

  if (!action && request.method === "GET") return sendJson(response, 200, { thread: publicThread(thread) });
  if (action === "events" && request.method === "GET") return openEventStream(thread.id, request, response);
  if (action === "uploads" && request.method === "POST") {
    requireOrigin(request);
    return handleUpload(request, response, thread);
  }
  if (action === "messages" && request.method === "POST") {
    requireOrigin(request);
    return handleMessage(request, response, thread);
  }
  if (action === "approve" && request.method === "POST") {
    requireOrigin(request);
    return handleApprove(response, thread);
  }
  if (action === "reject" && request.method === "POST") {
    requireOrigin(request);
    return handleReject(response, thread);
  }
  if (action === "cancel" && request.method === "POST") {
    requireOrigin(request);
    return handleCancel(response, thread);
  }
  if (action === "pin" && request.method === "POST") {
    requireOrigin(request);
    return handlePin(request, response, thread);
  }
  if (action === "archive" && request.method === "POST") {
    requireOrigin(request);
    return handleArchive(response, thread);
  }
  if (action === "restore" && request.method === "POST") {
    requireOrigin(request);
    return handleRestore(response, thread);
  }
  if (action === "category" && request.method === "POST") {
    requireOrigin(request);
    return handleCategory(request, response, thread);
  }
  return sendJson(response, 405, { error: "不支持此方法。" });
}

async function handleLogin(request, response) {
  requireOrigin(request, { allowMissing: true });
  const ip = request.socket.remoteAddress || "unknown";
  const attempt = loginAttempts.get(ip);
  if (attempt?.blockedUntil > Date.now()) {
    return sendJson(response, 429, { error: "登录尝试过多，请稍后再试。" });
  }

  const body = await readJson(request);
  if (!secureEqual(String(body.password || ""), password)) {
    const failures = (attempt?.failures || 0) + 1;
    loginAttempts.set(ip, {
      failures: failures >= 5 ? 0 : failures,
      blockedUntil: failures >= 5 ? Date.now() + 10 * 60 * 1000 : 0
    });
    return sendJson(response, 401, { error: "密码不正确。" });
  }

  loginAttempts.delete(ip);
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { expiresAt: Date.now() + sessionLifetimeMs });
  response.setHeader("Set-Cookie", sessionCookie(token));
  return sendJson(response, 200, { ok: true });
}

async function handleListFiles(url, response) {
  const directory = await resolveWorkspaceEntry(url.searchParams.get("path") || "");
  if (!directory.stats.isDirectory()) return sendJson(response, 400, { error: "该路径不是目录。" });
  const entries = await readdir(directory.absolutePath, { withFileTypes: true });
  const visible = entries
    .filter((entry) => !entry.isSymbolicLink() && !isSensitivePathSegment(entry.name))
    .sort((left, right) => {
      const leftRank = left.isDirectory() ? 0 : 1;
      const rightRank = right.isDirectory() ? 0 : 1;
      return leftRank - rightRank || left.name.localeCompare(right.name, "zh-CN");
    })
    .slice(0, 250);
  const files = await Promise.all(visible.map(async (entry) => {
    const absolutePath = join(directory.absolutePath, entry.name);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) return null;
    return {
      name: entry.name,
      path: formatWorkspacePath(join(directory.relativePath, entry.name)),
      kind: info.isDirectory() ? "directory" : "file",
      size: info.isFile() ? info.size : null,
      updatedAt: info.mtimeMs
    };
  }));
  return sendJson(response, 200, {
    path: directory.relativePath,
    parentPath: directory.relativePath ? formatWorkspacePath(dirname(directory.relativePath)) : null,
    entries: files.filter(Boolean),
    truncated: entries.length > visible.length
  });
}

async function handleFilePreview(url, response) {
  const entry = await resolveWorkspaceEntry(url.searchParams.get("path") || "");
  if (!entry.stats.isFile()) return sendJson(response, 400, { error: "只能预览普通文件。" });
  if (entry.stats.size > maxPreviewBytes) return sendJson(response, 413, { error: "文件超过 1 MB，不能在浏览器中预览。" });
  const kind = previewKind(entry.absolutePath);
  const file = publicFileEntry(entry);
  if (kind === "text") {
    return sendJson(response, 200, { file, kind, content: await readFile(entry.absolutePath, "utf8") });
  }
  if (["image", "audio", "video"].includes(kind)) {
    return sendJson(response, 200, { file, kind, contentUrl: `/api/files/download?inline=1&path=${encodeURIComponent(entry.relativePath)}` });
  }
  return sendJson(response, 200, { file, kind: "unsupported" });
}

async function handleFileDownload(url, response) {
  const entry = await resolveWorkspaceEntry(url.searchParams.get("path") || "");
  if (!entry.stats.isFile()) return sendJson(response, 400, { error: "只能下载普通文件。" });
  if (entry.stats.size > maxDownloadBytes) return sendJson(response, 413, { error: "文件超过 100 MB，不能通过此工具下载。" });
  const inline = url.searchParams.get("inline") === "1" && ["image", "audio", "video"].includes(previewKind(entry.absolutePath));
  const disposition = inline ? "inline" : "attachment";
  response.writeHead(200, {
    "Content-Type": mimeType(entry.absolutePath),
    "Content-Length": entry.stats.size,
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(basename(entry.absolutePath))}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  createReadStream(entry.absolutePath).on("error", () => response.destroy()).pipe(response);
}

async function resolveWorkspaceEntry(pathValue) {
  const rawPath = String(pathValue || "").trim();
  const absolutePath = resolve(workspaceRoot, rawPath || ".");
  const requestedRelative = relative(workspaceRoot, absolutePath);
  if (isAbsolute(requestedRelative) || requestedRelative.startsWith("..") || hasSensitivePathSegment(requestedRelative)) {
    const error = new Error("不允许访问该路径。");
    error.statusCode = 403;
    throw error;
  }
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      error.statusCode = 404;
      error.message = "找不到该文件或目录。";
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    const error = new Error("不允许访问符号链接。");
    error.statusCode = 403;
    throw error;
  }
  const actualPath = await realpath(absolutePath);
  const actualRelative = relative(workspaceRealRoot, actualPath);
  if (isAbsolute(actualRelative) || actualRelative.startsWith("..")) {
    const error = new Error("不允许访问工作目录之外的文件。");
    error.statusCode = 403;
    throw error;
  }
  return { absolutePath, stats, relativePath: formatWorkspacePath(actualRelative) };
}

function publicFileEntry(entry) {
  return {
    name: basename(entry.absolutePath),
    path: entry.relativePath,
    kind: "file",
    size: entry.stats.size,
    updatedAt: entry.stats.mtimeMs
  };
}

function hasSensitivePathSegment(value) {
  return String(value).split(/[\\/]+/).filter(Boolean).some(isSensitivePathSegment);
}

function isSensitivePathSegment(value) {
  return value === "node_modules" || String(value).startsWith(".");
}

function formatWorkspacePath(value) {
  return value === "." ? "" : String(value || "").replace(/\\/g, "/");
}

function previewKind(filePath) {
  const extension = extname(filePath).toLowerCase();
  if ([".txt", ".md", ".mdx", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".html", ".xml", ".yml", ".yaml", ".toml", ".ini", ".py", ".java", ".c", ".cpp", ".h", ".cs", ".go", ".rs", ".sh", ".ps1", ".sql", ".csv", ".log"].includes(extension)) return "text";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) return "image";
  if ([".mp3", ".wav", ".ogg", ".m4a"].includes(extension)) return "audio";
  if ([".mp4", ".webm", ".mov"].includes(extension)) return "video";
  return "unsupported";
}

async function handleUpload(request, response, thread) {
  if (thread.archivedAt) return sendJson(response, 409, { error: "已归档的会话需要恢复后才能上传文件。" });
  if (activeRuns.has(thread.id) || thread.pendingApproval) return sendJson(response, 409, { error: "请在当前任务完成且没有待批准消息时上传文件。" });
  const filename = uploadFilename(request);
  const bytes = await readUploadBody(request);
  const id = randomUUID();
  const directory = join(workspaceRoot, ".codex-remote-uploads", thread.id);
  const absolutePath = join(directory, `${id}-${filename}`);
  await mkdir(directory, { recursive: true });
  await writeFile(absolutePath, bytes, { flag: "wx" });
  const attachment = {
    id,
    name: filename,
    path: formatWorkspacePath(relative(workspaceRoot, absolutePath)),
    size: bytes.length,
    type: String(request.headers["content-type"] || "application/octet-stream").slice(0, 120)
  };
  thread.uploads = [...(thread.uploads || []), attachment].slice(-maxStoredUploads);
  thread.updatedAt = Date.now();
  await saveThreads();
  publish(thread.id, { type: "thread", thread: publicThread(thread) });
  return sendJson(response, 201, { attachment });
}

function uploadFilename(request) {
  const header = request.headers["x-file-name"];
  if (typeof header !== "string" || !header) {
    const error = new Error("缺少文件名。");
    error.statusCode = 400;
    throw error;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    const error = new Error("文件名格式无效。");
    error.statusCode = 400;
    throw error;
  }
  const name = basename(decoded).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 120);
  if (!name || /^\.+$/.test(name)) {
    const error = new Error("文件名无效。");
    error.statusCode = 400;
    throw error;
  }
  return name;
}

async function readUploadBody(request) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
    const error = new Error(`单个文件不能超过 ${Math.floor(maxUploadBytes / (1024 * 1024))} MB。`);
    error.statusCode = 413;
    throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxUploadBytes) {
      const error = new Error(`单个文件不能超过 ${Math.floor(maxUploadBytes / (1024 * 1024))} MB。`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) {
    const error = new Error("不能上传空文件。");
    error.statusCode = 400;
    throw error;
  }
  return Buffer.concat(chunks);
}

async function handleMessage(request, response, thread) {
  if (thread.archivedAt) return sendJson(response, 409, { error: "已归档的会话需要恢复后才能继续。" });
  if (activeRuns.has(thread.id) || thread.pendingApproval) return sendJson(response, 409, { error: "此会话已有正在运行或待批准的任务。" });
  const body = await readJson(request);
  const attachments = resolveThreadAttachments(thread, body.attachments);
  const text = String(body.text || "").trim() || (attachments.length ? "请检查已附加的文件。" : "");
  if (!text) return sendJson(response, 400, { error: "请输入内容或添加文件。" });
  if (text.length > maxPromptLength) return sendJson(response, 400, { error: `单条消息不能超过 ${maxPromptLength} 个字符。` });

  thread.pendingApproval = {
    id: randomUUID(),
    text,
    attachments,
    sandbox: approvedSandbox(body.sandbox),
    createdAt: Date.now()
  };
  thread.updatedAt = Date.now();
  thread.status = "awaiting_approval";
  if (!thread.title) thread.title = compactTitle(text || attachments[0]?.name || "新任务");
  await saveThreads();
  publish(thread.id, { type: "thread", thread: publicThread(thread) });
  return sendJson(response, 202, { thread: publicThread(thread) });
}

async function handleApprove(response, thread) {
  if (activeRuns.has(thread.id)) return sendJson(response, 409, { error: "此会话仍在运行。" });
  const pending = thread.pendingApproval;
  if (!pending) return sendJson(response, 409, { error: "没有待批准的任务。" });

  thread.pendingApproval = null;
  thread.messages.push({ id: pending.id, role: "user", text: pending.text, attachments: pending.attachments, createdAt: pending.createdAt });
  if (thread.source === "desktop") thread.desktopMirrorState = { userMessageId: pending.id, assistantMessageIds: [], mirroredAt: null };
  thread.updatedAt = Date.now();
  thread.status = "running";
  await saveThreads();
  publish(thread.id, { type: "thread", thread: publicThread(thread) });
  startRun(thread, codexPrompt(pending.text, pending.attachments), pending.sandbox);
  return sendJson(response, 202, { thread: publicThread(thread) });
}

function resolveThreadAttachments(thread, requested) {
  if (requested == null) return [];
  if (!Array.isArray(requested) || requested.length > maxAttachmentsPerMessage) {
    const error = new Error(`每条消息最多添加 ${maxAttachmentsPerMessage} 个文件。`);
    error.statusCode = 400;
    throw error;
  }
  const known = new Map((thread.uploads || []).map((attachment) => [attachment.id, attachment]));
  const result = [];
  for (const id of new Set(requested)) {
    if (typeof id !== "string" || !known.has(id)) {
      const error = new Error("有文件尚未上传或不属于当前会话。");
      error.statusCode = 400;
      throw error;
    }
    result.push(known.get(id));
  }
  return result;
}

function codexPrompt(text, attachments = []) {
  if (!attachments.length) return text;
  const files = attachments.map((attachment) => `- ${attachment.path}`).join("\n");
  return `${text}\n\nAttached files are available in the workspace:\n${files}`;
}

async function handleReject(response, thread) {
  if (!thread.pendingApproval) return sendJson(response, 409, { error: "没有待批准的任务。" });
  thread.pendingApproval = null;
  thread.status = "idle";
  thread.updatedAt = Date.now();
  appendLog(thread, "已拒绝待批准任务。", "event");
  await saveThreads();
  publish(thread.id, { type: "thread", thread: publicThread(thread) });
  return sendJson(response, 200, { thread: publicThread(thread) });
}

function startRun(thread, text, approvedRunSandbox) {
  try {
    const child = launchCodex(thread, text, approvedRunSandbox);
    activeRuns.set(thread.id, child);
    child.on("error", async (error) => {
      activeRuns.delete(thread.id);
      await finishRun(thread, "error", `无法启动 Codex：${error.message}`);
    });
    child.on("close", async (code, signal) => {
      const completed = completedRuns.delete(child);
      activeRuns.delete(thread.id);
      if (thread.status === "cancelled") return;
      if (completed) return;
      const status = code === 0 ? "idle" : "error";
      const message = code === 0 ? null : `Codex 以状态码 ${code ?? "未知"}${signal ? `（${signal}）` : ""} 退出。`;
      await finishRun(thread, status, message);
    });
  } catch (error) {
    void finishRun(thread, "error", `无法启动 Codex：${error.message}`);
  }
}

function launchCodex(thread, prompt, approvedRunSandbox = sandbox) {
  const args = thread.codexSessionId
    ? ["exec", "resume", thread.codexSessionId, "--json", "--skip-git-repo-check", prompt]
    : ["exec", "--json", "-C", workspaceRoot, "--skip-git-repo-check", "-s", approvedRunSandbox, ...(config.CODEX_MODEL ? ["-m", config.CODEX_MODEL] : []), prompt];
  const childEnv = { ...process.env };
  // Some Windows service shells omit HOME even when USERPROFILE is available.
  if (!childEnv.HOME && childEnv.USERPROFILE) childEnv.HOME = childEnv.USERPROFILE;
  for (const key of ["OPENAI_API_KEY", "CODEX_HOME"]) {
    if (config[key]) childEnv[key] = config[key];
  }
  if (thread.source === "desktop") childEnv.CODEX_HOME = desktopCodexHome;

  const command = resolveCodexCommand();
  const child = spawn(command.command, [...command.prefixArgs, ...args], {
    cwd: workspaceRoot,
    env: childEnv,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) processCodexLine(thread, child, line);
  });
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf8");
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || "";
    for (const line of lines) appendLog(thread, line, "stderr");
  });
  return child;
}

function resolveCodexCommand() {
  const configured = config.CODEX_COMMAND;
  if (configured) {
    const [command, ...prefixArgs] = configured.split("|").map((entry) => entry.trim()).filter(Boolean);
    if (!command) throw new Error("CODEX_COMMAND 不能为空。");
    return { command, prefixArgs };
  }
  if (process.platform === "win32") {
    const globalEntrypoint = join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(globalEntrypoint)) return { command: process.execPath, prefixArgs: [globalEntrypoint] };
    throw new Error("找不到 Codex CLI。请在 .env 中设置 CODEX_COMMAND=Node 路径|codex.js 路径。");
  }
  return { command: "codex", prefixArgs: [] };
}

function processCodexLine(thread, child, line) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    appendLog(thread, line, "stdout");
    return;
  }

  if (event.type === "thread.started" && event.thread_id) {
    thread.codexSessionId = event.thread_id;
    void saveThreads();
  }
  const item = event.item;
  if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
    const messageId = item.id || randomUUID();
    thread.messages.push({ id: messageId, role: "assistant", text: item.text, createdAt: Date.now() });
    if (thread.source === "desktop" && thread.desktopMirrorState) {
      const ids = desktopAssistantMessageIds(thread.desktopMirrorState);
      if (!ids.includes(messageId)) ids.push(messageId);
      thread.desktopMirrorState.assistantMessageIds = ids;
      delete thread.desktopMirrorState.assistantMessageId;
    }
    thread.updatedAt = Date.now();
    void saveThreads();
  }
  if (event.type === "turn.completed" && thread.status === "running") {
    void finishCompletedTurn(thread, child);
  }
  const summary = eventSummary(event);
  if (summary) appendLog(thread, summary, "event");
  publish(thread.id, { type: "event", event: publicEvent(event), thread: publicThread(thread) });
}

async function finishCompletedTurn(thread, child) {
  if (activeRuns.get(thread.id) !== child) return;
  // Codex can emit its final event before closing its CLI process on Windows.
  // Treat that protocol event as authoritative so the next user message is not blocked.
  completedRuns.add(child);
  activeRuns.delete(thread.id);
  thread.status = "idle";
  thread.updatedAt = Date.now();
  await mirrorDesktopTurn(thread);
  await synchronizeDesktopThread(thread);
  await saveThreads();
  publish(thread.id, { type: "thread", thread: publicThread(thread) });
  child.kill();
}

async function handleCancel(response, thread) {
  const child = activeRuns.get(thread.id);
  if (thread.pendingApproval) return handleReject(response, thread);
  if (!child) return sendJson(response, 409, { error: "此会话当前没有任务。" });
  thread.status = "cancelled";
  thread.updatedAt = Date.now();
  child.kill();
  activeRuns.delete(thread.id);
  await saveThreads();
  publish(thread.id, { type: "thread", thread: publicThread(thread) });
  return sendJson(response, 200, { thread: publicThread(thread) });
}

async function handlePin(request, response, thread) {
  if (rejectUnmanagedThread(response, thread)) return;
  const body = await readJson(request);
  if (typeof body.pinned !== "boolean") return sendJson(response, 400, { error: "pinned 必须是布尔值。" });
  thread.pinned = body.pinned;
  return saveManagedThread(response, thread);
}

async function handleArchive(response, thread) {
  if (rejectUnmanagedThread(response, thread)) return;
  if (activeRuns.has(thread.id) || thread.pendingApproval || ["running", "awaiting_approval"].includes(thread.status)) {
    return sendJson(response, 409, { error: "运行中或待批准的会话不能归档。" });
  }
  thread.archivedAt = thread.archivedAt || Date.now();
  return saveManagedThread(response, thread);
}

async function handleRestore(response, thread) {
  if (rejectUnmanagedThread(response, thread)) return;
  thread.archivedAt = null;
  return saveManagedThread(response, thread);
}

async function handleCategory(request, response, thread) {
  if (rejectUnmanagedThread(response, thread)) return;
  const body = await readJson(request);
  if (typeof body.category !== "string") return sendJson(response, 400, { error: "分类必须是文本。" });
  thread.category = normalizeCategory(body.category);
  return saveManagedThread(response, thread);
}

function rejectUnmanagedThread(response, thread) {
  if (thread.source === "remote") return false;
  sendJson(response, 409, { error: "只有远程会话可以管理。" });
  return true;
}

async function saveManagedThread(response, thread) {
  thread.updatedAt = Date.now();
  await saveThreads();
  const publicValue = publicThread(thread);
  publish(thread.id, { type: "thread", thread: publicValue });
  return sendJson(response, 200, { thread: publicValue });
}

function normalizeCategory(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 40) : "";
}

async function finishRun(thread, status, errorMessage) {
  thread.status = status;
  thread.updatedAt = Date.now();
  if (errorMessage) appendLog(thread, errorMessage, "error");
  if (thread.source === "desktop") await mirrorDesktopTurn(thread);
  if (status === "idle") await synchronizeDesktopThread(thread);
  await saveThreads();
  publish(thread.id, { type: "thread", thread: publicThread(thread) });
}

function appendLog(thread, text, kind) {
  if (!text?.trim()) return;
  thread.logs.push({ text: text.trim().slice(0, 2000), kind, createdAt: Date.now() });
  thread.logs = thread.logs.slice(-80);
  publish(thread.id, { type: "log", log: thread.logs.at(-1) });
}

function eventSummary(event) {
  if (event.type === "turn.started") return "Codex 开始处理";
  if (event.type === "turn.completed") return "Codex 已完成本轮";
  if (event.type === "error") return event.message || event.error?.message || "Codex 返回错误";
  if (event.type === "item.started" && event.item?.type === "command_execution") return `执行：${event.item.command || "命令"}`;
  if (event.type === "item.completed" && event.item?.type === "command_execution") return "命令已完成";
  return null;
}

function createThread() {
  return {
    id: randomUUID(),
    title: "",
    codexSessionId: null,
    source: "remote",
    desktopSessionId: null,
    pinned: false,
    archivedAt: null,
    category: "",
    status: "idle",
    pendingApproval: null,
    desktopMirrorState: null,
    uploads: [],
    messages: [],
    logs: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function createDesktopThread(session) {
  const thread = createThread();
  thread.title = session.title;
  thread.codexSessionId = session.id;
  thread.source = "desktop";
  thread.desktopSessionId = session.id;
  thread.messages = session.messages;
  thread.pendingApproval = null;
  thread.desktopMirrorState = null;
  thread.logs.push({ text: "已载入本机 Codex 会话；下一条消息会直接继续该历史。", kind: "event", createdAt: Date.now() });
  thread.createdAt = session.createdAt;
  thread.updatedAt = session.updatedAt;
  return thread;
}

function approvedSandbox(value) {
  if (sandbox === "read-only") return "read-only";
  return value === "read-only" ? "read-only" : "workspace-write";
}

async function synchronizeDesktopThread(thread) {
  if (thread.source !== "desktop" || !thread.desktopSessionId) return;
  desktopSessionCache.expiresAt = 0;
  const session = await getDesktopSession(thread.desktopSessionId);
  if (!session) return;
  thread.messages = mergeTranscriptMessages(session.messages, thread.messages);
  thread.title = session.title || thread.title;
  thread.updatedAt = Math.max(thread.updatedAt, session.updatedAt);
}

async function mirrorDesktopTurn(thread) {
  const state = thread.desktopMirrorState;
  if (thread.source !== "desktop" || !thread.desktopSessionId || !state || state.mirroredAt) return;
  const userMessage = thread.messages.find((message) => message.id === state.userMessageId && message.role === "user");
  const assistantMessages = desktopAssistantMessageIds(state)
    .map((messageId) => thread.messages.find((message) => message.id === messageId && message.role === "assistant"))
    .filter(Boolean);
  if (!userMessage) return;

  desktopSessionCache.expiresAt = 0;
  const session = await getDesktopSession(thread.desktopSessionId);
  if (!session?.filePath) return;
  const existing = (await readDesktopMirrorIndex(session.filePath)).keys;
  const records = [];
  appendMissingDesktopMirrorRecord(records, existing, "user", userMessage);
  for (const assistantMessage of assistantMessages) appendMissingDesktopMirrorRecord(records, existing, "assistant", assistantMessage);
  if (records.length) await appendFile(session.filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  state.mirroredAt = Date.now();
  desktopSessionCache.expiresAt = 0;
}

async function backfillDesktopMirrors() {
  for (const thread of threads) {
    if (thread.source !== "desktop" || !thread.desktopSessionId || !thread.messages.length) continue;
    try {
      await backfillDesktopMirror(thread);
    } catch (error) {
      console.error(`Unable to backfill desktop session ${thread.desktopSessionId}:`, error.message);
    }
  }
}

async function backfillDesktopMirror(thread) {
  desktopSessionCache.expiresAt = 0;
  const session = await getDesktopSession(thread.desktopSessionId);
  if (!session?.filePath) return;
  const existing = await readDesktopMirrorIndex(session.filePath);
  const records = [];
  for (const message of thread.messages) {
    if (!message?.text || !["user", "assistant"].includes(message.role)) continue;
    // The PWA transcript is the source of attached remote turns. Its event keys
    // make this safe even when later Desktop activity changed timestamp ordering.
    appendMissingDesktopMirrorRecord(records, existing.keys, message.role, message);
  }
  if (records.length) await appendFile(session.filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  desktopSessionCache.expiresAt = 0;
}

async function readDesktopMirrorIndex(filePath) {
  const keys = new Set();
  let latestTimestamp = 0;
  const raw = await readFile(filePath, "utf8");
  for (const record of parseDesktopRecords(raw)) {
    if (record.type !== "event_msg" || !["user_message", "agent_message"].includes(record.payload?.type)) continue;
    const role = record.payload.type === "user_message" ? "user" : "assistant";
    if (typeof record.payload.message !== "string") continue;
    keys.add(desktopMirrorKey(role, record.payload.message));
    const timestamp = Date.parse(record.timestamp || "");
    if (Number.isFinite(timestamp)) latestTimestamp = Math.max(latestTimestamp, timestamp);
  }
  return { keys, latestTimestamp };
}

function appendMissingDesktopMirrorRecord(records, existing, role, message) {
  const key = desktopMirrorKey(role, message.text);
  if (existing.has(key)) return;
  records.push(desktopMirrorRecord(role, message));
  existing.add(key);
}

function desktopAssistantMessageIds(state) {
  const ids = Array.isArray(state?.assistantMessageIds) ? state.assistantMessageIds : [state?.assistantMessageId];
  return ids.filter((id) => typeof id === "string" && id);
}

function desktopMirrorKey(role, text) {
  return `${role}:${createHash("sha256").update(text).digest("hex")}`;
}

function desktopMirrorRecord(role, message) {
  const timestamp = new Date(message.createdAt || Date.now()).toISOString();
  if (role === "user") {
    return {
      timestamp,
      type: "event_msg",
      payload: { type: "user_message", message: message.text, client_id: "codex-remote-pwa", images: [], local_images: [], audio: [], local_audio: [], text_elements: [] }
    };
  }
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "agent_message", message: message.text, phase: "final", memory_citation: null }
  };
}

function mergeTranscriptMessages(primary, secondary) {
  const merged = [];
  const byKey = new Map();
  for (const message of [...primary, ...secondary]) {
    if (!message?.text || !["user", "assistant"].includes(message.role)) continue;
    const key = `${message.role}\u0000${message.text}\u0000${Math.round(Number(message.createdAt) / 1000)}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.attachments?.length && message.attachments?.length) existing.attachments = message.attachments;
      continue;
    }
    byKey.set(key, message);
    merged.push(message);
  }
  return merged.sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
}

function publicThreadList() {
  return threads
    .slice()
    .sort(compareThreads)
    .map((thread) => ({
      id: thread.id,
      title: thread.title || "新任务",
      status: thread.status,
      codexSessionId: thread.codexSessionId,
      source: thread.source,
      desktopSessionId: thread.desktopSessionId,
      pinned: thread.pinned,
      archivedAt: thread.archivedAt,
      category: thread.category,
      pendingApproval: thread.pendingApproval,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      preview: thread.messages.at(-1)?.text?.slice(0, 120) || ""
    }));
}

function compareThreads(left, right) {
  return Number(right.pinned) - Number(left.pinned) || Number(right.updatedAt) - Number(left.updatedAt);
}

function publicThread(thread) {
  return {
    id: thread.id,
    title: thread.title || "新任务",
    status: thread.status,
    codexSessionId: thread.codexSessionId,
    source: thread.source,
    desktopSessionId: thread.desktopSessionId,
    pinned: thread.pinned,
    archivedAt: thread.archivedAt,
    category: thread.category,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    pendingApproval: thread.pendingApproval,
    messages: thread.messages,
    logs: thread.logs
  };
}

function publicEvent(event) {
  const safe = { type: event.type || "unknown" };
  if (event.item?.type) safe.itemType = event.item.type;
  return safe;
}

function openEventStream(threadId, request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.write("retry: 2000\n\n");
  const clients = eventClients.get(threadId) || new Set();
  clients.add(response);
  eventClients.set(threadId, clients);
  request.on("close", () => {
    clients.delete(response);
    if (clients.size === 0) eventClients.delete(threadId);
  });
}

function publish(threadId, payload) {
  const clients = eventClients.get(threadId);
  if (!clients) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(data);
}

function getSession(request) {
  const token = readCookie(request.headers.cookie).remote_session;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function requireOrigin(request, { allowMissing = false } = {}) {
  const origin = request.headers.origin;
  if (!origin && allowMissing) return;
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const isSecure = Boolean(request.socket.encrypted) || (config.TRUST_PROXY === "1" && forwardedProtocol === "https");
  const expected = `${isSecure ? "https" : "http"}://${request.headers.host}`;
  const allowedOrigins = publicOrigin ? new Set([expected, publicOrigin]) : new Set([expected]);
  if (!origin || !allowedOrigins.has(origin)) {
    const error = new Error("不允许跨站请求。");
    error.statusCode = 403;
    throw error;
  }
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(publicRoot, requested));
  if (!filePath.startsWith(publicRoot)) return sendJson(response, 403, { error: "无权访问。" });
  try {
    const contents = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeType(filePath),
      "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600"
    });
    response.end(contents);
  } catch {
    if (extname(filePath)) return sendJson(response, 404, { error: "找不到文件。" });
    const contents = await readFile(join(publicRoot, "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    response.end(contents);
  }
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function sessionCookie(token) {
  const flags = ["remote_session=" + token, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(sessionLifetimeMs / 1000)}`];
  if (config.COOKIE_SECURE === "1") flags.push("Secure");
  return flags.join("; ");
}

function clearSessionCookie() {
  const flags = ["remote_session=", "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (config.COOKIE_SECURE === "1") flags.push("Secure");
  return flags.join("; ");
}

function readCookie(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim().split(/=(.*)/s, 2)).filter(([key]) => key));
}

function secureEqual(left, right) {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      const error = new Error("请求过大。");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("请求格式无效。");
    error.statusCode = 400;
    throw error;
  }
}

async function readEnvFile(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const values = {};
    for (const sourceLine of raw.split(/\r?\n/)) {
      const line = sourceLine.trim();
      if (!line || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index === -1) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
      values[key] = value;
    }
    return values;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function listDesktopSessions() {
  if (config.ENABLE_DESKTOP_SESSION_HISTORY === "0") return [];
  if (desktopSessionCache.expiresAt > Date.now()) return desktopSessionCache.sessions;

  const files = await collectSessionFiles(desktopSessionsRoot);
  const sessions = [];
  for (const filePath of files) {
    const session = await readDesktopSessionFile(filePath);
    if (session && isWorkspaceSession(session.cwd)) sessions.push(session);
  }
  sessions.sort((left, right) => right.updatedAt - left.updatedAt);
  const limited = sessions.slice(0, maxDesktopSessions);
  desktopSessionCache = {
    expiresAt: Date.now() + desktopSessionCacheTtlMs,
    sessions: limited,
    byId: new Map(limited.map((session) => [session.id.toLowerCase(), session]))
  };
  return limited;
}

async function getDesktopSession(sessionId) {
  let sessions = await listDesktopSessions();
  let session = desktopSessionCache.byId.get(sessionId.toLowerCase());
  if (!session) {
    desktopSessionCache.expiresAt = 0;
    sessions = await listDesktopSessions();
    session = sessions.find((entry) => entry.id.toLowerCase() === sessionId.toLowerCase());
  }
  return session || null;
}

async function collectSessionFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectSessionFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
  }
  return files;
}

async function readDesktopSessionFile(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  const records = parseDesktopRecords(raw);
  const metadata = records.find((record) => record.type === "session_meta")?.payload;
  const id = typeof metadata?.session_id === "string" ? metadata.session_id : metadata?.id;
  if (typeof id !== "string" || !id) return null;
  const { messages, total } = extractTranscriptMessages(records);
  const firstUserMessage = messages.find((message) => message.role === "user");
  const lastMessage = messages.at(-1);
  const timestamps = records.map((record) => Date.parse(record.timestamp || "")).filter(Number.isFinite);
  const createdAt = timestampOrNow(metadata?.timestamp);
  const updatedAt = timestamps.at(-1) || createdAt;

  return {
    id,
    cwd: typeof metadata?.cwd === "string" ? metadata.cwd : "",
    title: compactTitle(firstUserMessage?.text || lastMessage?.text || "本机 Codex 会话"),
    preview: lastMessage?.text?.replace(/\s+/g, " ").trim().slice(0, 120) || "无可显示消息",
    createdAt,
    updatedAt,
    messageCount: total,
    messages,
    filePath
  };
}

function parseDesktopRecords(raw) {
  const records = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (start === -1) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth !== 0) continue;
    const source = raw.slice(start, index + 1);
    const record = parseDesktopRecord(source);
    if (record) records.push(record);
    start = -1;
  }
  return records;
}

function parseDesktopRecord(source) {
  try {
    return JSON.parse(source);
  } catch {
    try {
      return JSON.parse(escapeJsonStringControls(source));
    } catch {
      return null;
    }
  }
}

function escapeJsonStringControls(source) {
  let escapedSource = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (!inString) {
      if (character === '"') inString = true;
      escapedSource += character;
      continue;
    }
    if (escaped) {
      escaped = false;
      escapedSource += character;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      escapedSource += character;
      continue;
    }
    if (character === '"') {
      inString = false;
      escapedSource += character;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code >= 0x20) {
      escapedSource += character;
      continue;
    }
    if (character === "\r" && source[index + 1] === "\n") index += 1;
    if (character === "\n" || character === "\r") escapedSource += "\\n";
    else if (character === "\t") escapedSource += "\\t";
    else escapedSource += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return escapedSource;
}

function extractTranscriptMessages(records) {
  const messages = [];
  const hasExplicitUserMessages = records.some((record) => record.type === "event_msg" && record.payload?.type === "user_message" && typeof record.payload.message === "string");
  for (const record of records) {
    const payload = record.payload;
    const isExplicitUserMessage = record.type === "event_msg" && payload?.type === "user_message" && typeof payload.message === "string";
    const isExplicitAgentMessage = record.type === "event_msg" && payload?.type === "agent_message" && typeof payload.message === "string";
    const isResponseMessage = record.type === "response_item" && payload?.type === "message" && ["user", "assistant"].includes(payload.role);
    if (!isExplicitUserMessage && !isExplicitAgentMessage && !isResponseMessage) continue;
    if (hasExplicitUserMessages && isResponseMessage && payload.role === "user") continue;
    const role = isExplicitUserMessage ? "user" : (isExplicitAgentMessage ? "assistant" : payload.role);
    const text = isExplicitUserMessage || isExplicitAgentMessage
      ? payload.message.trim()
      : Array.isArray(payload.content)
        ? payload.content.filter((item) => ["input_text", "output_text"].includes(item?.type)).map((item) => item.text || "").join("\n").trim()
        : "";
    if (!text || isInfrastructureTranscript(text)) continue;
    const candidate = {
      id: typeof payload.id === "string" ? payload.id : randomUUID(),
      role,
      text: text.slice(0, 80_000),
      createdAt: timestampOrNow(record.timestamp)
    };
    if (messages.some((message) => message.role === candidate.role && message.text === candidate.text && Math.abs(message.createdAt - candidate.createdAt) < 5_000)) continue;
    messages.push(candidate);
  }
  return { messages: messages.slice(-maxDesktopSessionMessages), total: messages.length };
}

function isInfrastructureTranscript(text) {
  return /^\s*<(environment_context|permissions instructions|skills_instructions|app-context|in-app-browser-context|collaboration_mode)|^\s*(The following is the Codex agent history|# AGENTS\.md instructions)/i.test(text);
}

function isWorkspaceSession(cwd) {
  if (!cwd) return false;
  const relation = relative(workspaceRoot, resolve(cwd));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function timestampOrNow(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function publicDesktopSession(session) {
  return {
    id: session.id,
    source: "desktop",
    title: session.title,
    preview: session.preview,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount
  };
}

function publicDesktopSessionDetail(session) {
  return { ...publicDesktopSession(session), messages: session.messages };
}

async function loadThreads() {
  try {
    const data = JSON.parse(await readFile(threadsFile, "utf8"));
    if (!Array.isArray(data)) throw new Error("threads.json 格式无效。");
    return data.map(normalizeThread).filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function normalizeThread(value) {
  if (!value || typeof value.id !== "string") return null;
  const interrupted = value.status === "running";
  const logs = Array.isArray(value.logs) ? value.logs.slice(-80) : [];
  const source = value.source === "desktop" ? "desktop" : "remote";
  const uploads = Array.isArray(value.uploads) ? value.uploads.map(normalizeAttachment).filter(Boolean).slice(-maxStoredUploads) : [];
  const pendingApproval = value.pendingApproval && typeof value.pendingApproval.text === "string" ? {
    id: typeof value.pendingApproval.id === "string" ? value.pendingApproval.id : randomUUID(),
    text: value.pendingApproval.text.slice(0, maxPromptLength),
    attachments: storedAttachments(value.pendingApproval.attachments, uploads),
    sandbox: approvedSandbox(value.pendingApproval.sandbox),
    createdAt: Number(value.pendingApproval.createdAt) || Date.now()
  } : null;
  const messages = Array.isArray(value.messages) ? value.messages.map((message) => {
    if (!message?.text || !["user", "assistant"].includes(message.role)) return null;
    return {
      id: typeof message.id === "string" ? message.id : randomUUID(),
      role: message.role,
      text: String(message.text).slice(0, 80_000),
      attachments: storedAttachments(message.attachments, uploads),
      createdAt: Number(message.createdAt) || Date.now()
    };
  }).filter(Boolean) : [];
  if (interrupted) logs.push({ text: "服务在任务完成前重启，该任务已停止。", kind: "error", createdAt: Date.now() });
  return {
    id: value.id,
    title: typeof value.title === "string" ? value.title : "",
    codexSessionId: typeof value.codexSessionId === "string" ? value.codexSessionId : null,
    source,
    desktopSessionId: typeof value.desktopSessionId === "string" ? value.desktopSessionId : null,
    pinned: source === "remote" && value.pinned === true,
    archivedAt: source === "remote" && Number(value.archivedAt) > 0 ? Number(value.archivedAt) : null,
    category: source === "remote" ? normalizeCategory(value.category || "") : "",
    status: interrupted ? "error" : (value.status === "awaiting_approval" ? (pendingApproval ? "awaiting_approval" : "idle") : (typeof value.status === "string" ? value.status : "idle")),
    pendingApproval,
    desktopMirrorState: source === "desktop" && typeof value.desktopMirrorState?.userMessageId === "string" ? {
      userMessageId: value.desktopMirrorState.userMessageId,
      assistantMessageIds: desktopAssistantMessageIds(value.desktopMirrorState),
      mirroredAt: Number(value.desktopMirrorState.mirroredAt) || null
    } : null,
    uploads,
    messages,
    logs: logs.slice(-80),
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now()
  };
}

function normalizeAttachment(value) {
  if (!value || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.path !== "string") return null;
  const path = value.path.replace(/\\/g, "/");
  const size = Number(value.size);
  if (!path.startsWith(".codex-remote-uploads/") || !Number.isFinite(size) || size <= 0 || size > maxUploadBytes) return null;
  return {
    id: value.id,
    name: basename(value.name).slice(0, 120),
    path,
    size,
    type: typeof value.type === "string" ? value.type.slice(0, 120) : "application/octet-stream"
  };
}

function storedAttachments(value, uploads) {
  if (!Array.isArray(value)) return [];
  const known = new Map(uploads.map((attachment) => [attachment.id, attachment]));
  return [...new Set(value.map((attachment) => typeof attachment === "string" ? attachment : attachment?.id))]
    .map((id) => known.get(id))
    .filter(Boolean)
    .slice(0, maxAttachmentsPerMessage);
}

function saveThreads() {
  saveQueue = saveQueue.then(async () => {
    const temporary = `${threadsFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(threads, null, 2), "utf8");
    await rename(temporary, threadsFile);
  }).catch((error) => console.error("Unable to save threads:", error));
  return saveQueue;
}

async function assertDirectory(pathname, name) {
  const info = await stat(pathname).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${name} is not an existing directory: ${pathname}`);
}

function compactTitle(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 42);
}

function parsePort(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number < 65536 ? number : fallback;
}

function mimeType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8"
  }[extname(filePath)] || "application/octet-stream";
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}
