import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const password = `fixture-${randomUUID()}`;
const dataDir = await mkdtemp(join(tmpdir(), "codex-remote-test-"));
const desktopHome = await mkdtemp(join(tmpdir(), "codex-remote-desktop-history-"));
const workspace = await mkdtemp(join(tmpdir(), "codex-remote-workspace-"));
const fixture = join(root, "test", "fake-codex.mjs");
await mkdir(join(workspace, "nested"), { recursive: true });
await writeFile(join(workspace, "note.txt"), "preview content", "utf8");
await writeFile(join(workspace, ".env"), "hidden=true", "utf8");
await createDesktopSessionFixture();
const child = spawn(process.execPath, [join(root, "server.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    REMOTE_PASSWORD: password,
    PORT: String(port),
    APP_DATA_DIR: dataDir,
    WORKSPACE_ROOT: workspace,
    DESKTOP_CODEX_HOME: desktopHome,
    CODEX_COMMAND: `${process.execPath}|${fixture}`
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

try {
  await waitForServer();
  const cookie = await login();
  const files = await request("/api/files", { cookie });
  assert(files.entries.some((entry) => entry.path === "note.txt"), "Workspace files were not listed.");
  assert(!files.entries.some((entry) => entry.name === ".env"), "Sensitive environment files were exposed.");
  const preview = await request("/api/files/preview?path=note.txt", { cookie });
  assert(preview.content === "preview content", "Text file preview did not return content.");
  const downloaded = await fetch(`${base}/api/files/download?path=note.txt`, { headers: { Cookie: cookie } });
  assert(downloaded.ok && await downloaded.text() === "preview content", "File download did not return content.");

  const localSessions = await request("/api/local-sessions", { cookie });
  assert(localSessions.sessions.length === 1, "The current workspace desktop session was not indexed.");
  const localSession = localSessions.sessions[0];
  assert(localSession.title === "desktop history prompt", "Desktop session metadata was not parsed.");
  const localDetail = await request(`/api/local-sessions/${localSession.id}`, { cookie });
  assert(localDetail.session.messages.length === 3, "Desktop session messages were not returned.");
  assert(localDetail.session.messages.at(-1).text === "historical note\nwith newline", "A desktop record containing a newline was not parsed.");
  const attached = await request(`/api/local-sessions/${localSession.id}/attach`, { method: "POST", cookie, body: {} });
  assert(attached.thread.source === "desktop", "Desktop session attach did not mark the thread source.");
  await queueAndApprove(attached.thread.id, cookie, "continue desktop");
  const continued = await waitForIdle(attached.thread.id, cookie);
  assert(continued.messages.at(-1).text === "resumed: continue desktop", "The attached desktop session did not resume.");
  const desktopHistory = await readFile(join(desktopHome, "sessions", "2026", "08", "03", `rollout-${localSession.id}.jsonl`), "utf8");
  assert(desktopHistory.includes('"type":"user_message","message":"continue desktop","client_id":"codex-remote-pwa"'), "The remote user message was not mirrored into the desktop session.");
  assert(desktopHistory.includes('"type":"agent_message","message":"resumed: continue desktop","phase":"final"'), "The remote assistant message was not mirrored into the desktop session.");
  const storedAttachedThreads = JSON.parse(await readFile(join(dataDir, "threads.json"), "utf8"));
  const storedAttachedThread = storedAttachedThreads.find((entry) => entry.id === attached.thread.id);
  assert(storedAttachedThread?.desktopMirrorState?.mirroredAt, "Desktop mirror state was not persisted.");

  const thread = await request("/api/threads", { method: "POST", cookie, body: {} });
  const threadId = thread.thread.id;

  const categorized = await request(`/api/threads/${threadId}/category`, { method: "POST", cookie, body: { category: "Release" } });
  assert(categorized.thread.category === "Release", "Thread category was not saved.");
  const pinned = await request(`/api/threads/${threadId}/pin`, { method: "POST", cookie, body: { pinned: true } });
  assert(pinned.thread.pinned, "Thread pin state was not saved.");
  const pinnedList = await request("/api/threads", { cookie });
  assert(pinnedList.threads[0]?.id === threadId, "Pinned threads were not sorted before other threads.");
  const persistedThreads = JSON.parse(await readFile(join(dataDir, "threads.json"), "utf8"));
  const persistedThread = persistedThreads.find((entry) => entry.id === threadId);
  assert(persistedThread?.pinned && persistedThread.category === "Release", "Thread management fields were not persisted.");
  const archived = await request(`/api/threads/${threadId}/archive`, { method: "POST", cookie, body: {} });
  assert(archived.thread.archivedAt, "Thread was not archived.");
  const archivedList = await request("/api/threads", { cookie });
  assert(archivedList.threads.find((entry) => entry.id === threadId)?.archivedAt, "Archived thread was missing from the list response.");
  const archivedMessage = await requestStatus(`/api/threads/${threadId}/messages`, { method: "POST", cookie, body: { text: "blocked while archived" } });
  assert(archivedMessage.status === 409, "Archived threads accepted a new task.");
  const restored = await request(`/api/threads/${threadId}/restore`, { method: "POST", cookie, body: {} });
  assert(!restored.thread.archivedAt, "Thread was not restored.");

  const upload = await uploadFixture(threadId, cookie, "fixture.txt", "uploaded fixture content");
  assert(upload.name === "fixture.txt" && upload.path.startsWith(".codex-remote-uploads/"), "The uploaded file was not stored in the protected workspace area.");
  const queued = await request(`/api/threads/${threadId}/messages`, { method: "POST", cookie, body: { text: "first task", attachments: [upload.id] } });
  assert(queued.thread.status === "awaiting_approval", "A new prompt was not queued for approval.");
  assert(queued.thread.pendingApproval?.text === "first task", "The pending approval did not retain the prompt.");
  assert(queued.thread.pendingApproval?.attachments?.[0]?.id === upload.id, "The pending approval did not retain the uploaded file.");
  await request(`/api/threads/${threadId}/approve`, { method: "POST", cookie, body: {} });
  const first = await waitForIdle(threadId, cookie);
  assert(first.codexSessionId === "fixture-session-001", "The first run did not store the Codex session id.");
  assert(first.messages.some((message) => message.role === "user" && message.attachments?.[0]?.id === upload.id), "The approved user message did not retain the uploaded file.");
  assert(first.messages.at(-1).text.startsWith("started: first task"), "The first response was not recorded.");

  await queueAndApprove(threadId, cookie, "second task", "read-only");
  const resumed = await waitForIdle(threadId, cookie);
  assert(resumed.messages.at(-1).text === "resumed: second task", "The second run did not resume the stored session.");
  const rejectThread = await request("/api/threads", { method: "POST", cookie, body: {} });
  await request(`/api/threads/${rejectThread.thread.id}/messages`, { method: "POST", cookie, body: { text: "do not run" } });
  const pendingArchive = await requestStatus(`/api/threads/${rejectThread.thread.id}/archive`, { method: "POST", cookie, body: {} });
  assert(pendingArchive.status === 409, "A pending-approval thread was archived.");
  const rejected = await request(`/api/threads/${rejectThread.thread.id}/reject`, { method: "POST", cookie, body: {} });
  assert(rejected.thread.status === "idle" && !rejected.thread.pendingApproval, "Rejecting a pending prompt did not restore the idle state.");
  console.log("Integration test passed: session creation and resume work with JSONL streaming.");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
  await rm(desktopHome, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}

async function createDesktopSessionFixture() {
  const sessionDirectory = join(desktopHome, "sessions", "2026", "08", "03");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const timestamp = "2026-08-03T00:00:00.000Z";
  const records = [
    { timestamp, type: "session_meta", payload: { session_id: sessionId, cwd: workspace, timestamp } },
    { timestamp: "2026-08-03T00:00:01.000Z", type: "response_item", payload: { type: "message", id: "user-1", role: "user", content: [{ type: "input_text", text: "desktop history prompt" }] } },
    { timestamp: "2026-08-03T00:00:02.000Z", type: "response_item", payload: { type: "message", id: "assistant-1", role: "assistant", content: [{ type: "output_text", text: "desktop history response" }] } },
    { timestamp: "2026-08-03T00:00:03.000Z", type: "event_msg", payload: { type: "agent_message", message: "historical note\nwith newline", phase: "final" } }
  ];
  await mkdir(sessionDirectory, { recursive: true });
  const serialized = records.map((record) => JSON.stringify(record));
  serialized[3] = serialized[3].replace("\\n", "\n");
  await writeFile(join(sessionDirectory, `rollout-${sessionId}.jsonl`), `${serialized.join("\n")}\n`, "utf8");
}

async function login() {
  const response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  assert(response.ok, "Login failed.");
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function request(path, { method = "GET", cookie, body } = {}) {
  const result = await requestStatus(path, { method, cookie, body });
  assert(result.response.ok, result.data.error || `Request failed: ${path}`);
  return result.data;
}

async function requestStatus(path, { method = "GET", cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (method !== "GET") {
    headers.Origin = base;
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  return { response, status: response.status, data };
}

async function uploadFixture(threadId, cookie, name, content) {
  const response = await fetch(`${base}/api/threads/${threadId}/uploads`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "text/plain",
      "X-File-Name": encodeURIComponent(name)
    },
    body: content
  });
  const data = await response.json();
  assert(response.ok, data.error || "Fixture upload failed.");
  return data.attachment;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/me`);
      if (response.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error("The fixture server did not start.");
}

async function queueAndApprove(threadId, cookie, text, sandbox = "workspace-write") {
  const queued = await request(`/api/threads/${threadId}/messages`, { method: "POST", cookie, body: { text, sandbox } });
  assert(queued.thread.status === "awaiting_approval", "Prompt was not queued for approval.");
  return request(`/api/threads/${threadId}/approve`, { method: "POST", cookie, body: {} });
}

async function waitForIdle(threadId, cookie) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { thread } = await request(`/api/threads/${threadId}`, { cookie });
    if (thread.status !== "running") {
      assert(thread.status === "idle", `The Codex run ended as ${thread.status}.`);
      return thread;
    }
    await wait(100);
  }
  throw new Error("The Codex fixture did not finish.");
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
