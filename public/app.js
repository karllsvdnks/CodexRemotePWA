const app = document.querySelector("#app");
const state = {
  authenticated: false,
  config: null,
  threads: [],
  desktopSessions: [],
  currentThread: null,
  currentDesktopSession: null,
  view: "remote",
  eventSource: null,
  compactSidebar: false,
  search: "",
  remoteListMode: "active",
  categoryFilter: "",
  managerThreadId: null,
  panelMode: null,
  installPrompt: null,
  draftSandbox: "workspace-write",
  files: { path: "", parentPath: null, entries: [], selected: null, loading: false, error: "" },
  attachments: [],
  uploading: false,
  scrollToLatest: true
};

boot();

async function boot() {
  registerServiceWorker();
  try {
    const session = await api("/api/me");
    state.authenticated = session.authenticated;
    if (state.authenticated) await loadWorkspace();
    else renderLogin();
  } catch {
    renderUnavailable();
  }
}

async function loadWorkspace() {
  const [config, list, desktop] = await Promise.all([
    api("/api/config"),
    api("/api/threads"),
    api("/api/local-sessions").catch(() => ({ sessions: [] }))
  ]);
  state.config = config;
  state.draftSandbox = config.sandbox === "read-only" ? "read-only" : "workspace-write";
  state.threads = list.threads;
  state.desktopSessions = desktop.sessions;
  state.view = "remote";
  renderShell();
  const initialThread = state.threads.find((thread) => !thread.archivedAt) || state.threads[0];
  if (initialThread?.archivedAt) state.remoteListMode = "archived";
  if (initialThread) await selectThread(initialThread.id);
  else renderWorkspace();
}

function renderLogin(error = "") {
  app.innerHTML = `
    <section class="login-screen">
      <form class="login-card" id="login-form">
        <div class="login-mark" aria-hidden="true"><img src="/icon.svg" alt=""></div>
        <p class="eyebrow">PRIVATE REMOTE</p>
        <h1>Remote Codex</h1>
        <label for="password">访问密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
        <p class="form-error" role="alert">${escapeHtml(error)}</p>
        <button class="button primary" type="submit">进入工作台</button>
      </form>
    </section>`;
  document.querySelector("#login-form").addEventListener("submit", login);
}

function renderUnavailable() {
  app.innerHTML = `
    <section class="login-screen">
      <div class="login-card compact">
        <p class="eyebrow">OFFLINE</p>
        <h1>连接不可用</h1>
        <button class="button primary" type="button" id="retry">重试</button>
      </div>
    </section>`;
  document.querySelector("#retry").addEventListener("click", boot);
}

async function login(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/login", { method: "POST", body: { password: form.password.value } });
    state.authenticated = true;
    await loadWorkspace();
  } catch (error) {
    renderLogin(error.message);
  }
}

function renderShell() {
  app.innerHTML = `
    <section class="remote-shell ${state.compactSidebar ? "sidebar-open" : ""}">
      <aside class="sidebar" aria-label="会话导航">
        <header class="brand-row">
          <div class="brand"><img src="/icon.svg" alt=""><span>Remote Codex</span></div>
          <button class="icon-button mobile-only" type="button" id="close-sidebar" aria-label="关闭会话侧栏" title="关闭会话侧栏">×</button>
        </header>
        <button class="button primary new-thread" type="button" id="new-thread">新任务</button>
        <div class="side-tabs" role="tablist" aria-label="会话来源">
          <button type="button" class="side-tab" id="show-remote" role="tab">远程 <span>${state.threads.length}</span></button>
          <button type="button" class="side-tab" id="show-desktop" role="tab">本机 <span>${state.desktopSessions.length}</span></button>
        </div>
        <section class="remote-filters" id="remote-filters" aria-label="远程会话筛选">
          <div class="archive-tabs" role="tablist" aria-label="远程会话状态">
            <button class="archive-tab" type="button" id="show-active" role="tab">活跃 <span id="active-count"></span></button>
            <button class="archive-tab" type="button" id="show-archived" role="tab">归档 <span id="archived-count"></span></button>
          </div>
          <label class="category-filter" for="category-filter">
            <span>分类</span>
            <select id="category-filter"></select>
          </label>
        </section>
        <label class="search-box" for="session-search">
          <span aria-hidden="true">⌕</span>
          <input id="session-search" type="search" autocomplete="off" placeholder="搜索会话">
        </label>
        <div class="session-heading"><span id="session-heading">会话</span><span id="session-count"></span></div>
        <nav class="thread-list" id="thread-list"></nav>
        <footer class="sidebar-footer">
          <span class="status-dot"></span>
          <span>私有连接</span>
          <button class="text-control" type="button" id="logout">退出</button>
        </footer>
      </aside>
      <main class="workbench ${state.panelMode ? "activity-open" : ""}">
        <header class="workspace-header">
          <button class="icon-button mobile-only" type="button" id="open-sidebar" aria-label="打开会话侧栏" title="打开会话侧栏">☰</button>
          <div class="context-line">
            <div class="title-row"><strong id="thread-title">新任务</strong><span class="source-badge" id="source-badge" hidden></span></div>
            <span id="connection-detail"></span>
          </div>
          <div class="header-actions">
            <button class="icon-button" type="button" id="manage-current" aria-label="管理当前会话" title="管理当前会话" hidden>...</button>
            <button class="text-control" type="button" id="toggle-activity">活动</button>
            <button class="text-control" type="button" id="toggle-files">文件</button>
            <button class="text-control" type="button" id="install" hidden>安装</button>
            <button class="button danger" type="button" id="cancel" hidden>中止</button>
          </div>
        </header>
        <div class="workspace-body">
          <section class="conversation-panel">
            <div class="message-area" id="message-area"></div>
            <section class="composer-wrap" id="composer-wrap"></section>
          </section>
          <aside class="activity-panel" id="activity-panel" aria-label="运行活动"></aside>
        </div>
      </main>
      <div id="thread-manager-root"></div>
    </section>`;

  document.querySelector("#new-thread").addEventListener("click", newThread);
  document.querySelector("#show-remote").addEventListener("click", () => openView("remote"));
  document.querySelector("#show-desktop").addEventListener("click", () => openView("desktop"));
  document.querySelector("#show-active").addEventListener("click", () => setRemoteListMode("active"));
  document.querySelector("#show-archived").addEventListener("click", () => setRemoteListMode("archived"));
  document.querySelector("#category-filter").addEventListener("change", (event) => {
    state.categoryFilter = event.currentTarget.value;
    renderThreadList();
  });
  document.querySelector("#session-search").addEventListener("input", (event) => {
    state.search = event.currentTarget.value;
    renderThreadList();
  });
  document.querySelector("#logout").addEventListener("click", logout);
  document.querySelector("#cancel").addEventListener("click", cancelRun);
  document.querySelector("#toggle-activity").addEventListener("click", () => togglePanel("activity"));
  document.querySelector("#toggle-files").addEventListener("click", () => togglePanel("files"));
  document.querySelector("#open-sidebar").addEventListener("click", () => toggleSidebar(true));
  document.querySelector("#close-sidebar").addEventListener("click", () => toggleSidebar(false));
  document.querySelector("#install").addEventListener("click", installApp);
  document.querySelector("#manage-current").addEventListener("click", () => openThreadManager(state.currentThread?.id));
  renderThreadList();
  renderWorkspace();
  renderThreadManager();
  syncInstallButton();
}

async function openView(view) {
  if (view === "desktop") {
    try {
      const response = await api("/api/local-sessions");
      state.desktopSessions = response.sessions;
    } catch (error) {
      showTransientError(error.message);
      return;
    }
  }
  state.view = view;
  renderThreadList();
  if (view === "remote") {
    if (state.currentThread) renderWorkspace();
    else renderWorkspace();
  } else if (state.currentDesktopSession) {
    renderWorkspace();
  } else {
    renderWorkspace();
  }
}

function renderThreadList() {
  const list = document.querySelector("#thread-list");
  const heading = document.querySelector("#session-heading");
  const count = document.querySelector("#session-count");
  const remoteTab = document.querySelector("#show-remote");
  const desktopTab = document.querySelector("#show-desktop");
  const remoteFilters = document.querySelector("#remote-filters");
  const activeTab = document.querySelector("#show-active");
  const archivedTab = document.querySelector("#show-archived");
  const activeCount = document.querySelector("#active-count");
  const archivedCount = document.querySelector("#archived-count");
  const categoryFilter = document.querySelector("#category-filter");
  if (!list) return;
  const query = state.search.trim().toLocaleLowerCase();
  const remoteThreads = state.threads;
  const entries = state.view === "desktop"
    ? state.desktopSessions
    : remoteThreads.filter((entry) => Boolean(entry.archivedAt) === (state.remoteListMode === "archived"));
  const categories = [...new Set(remoteThreads.map((entry) => entry.category).filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN"));
  if (state.categoryFilter && !categories.includes(state.categoryFilter)) state.categoryFilter = "";
  if (categoryFilter) {
    categoryFilter.innerHTML = `<option value="">全部分类</option>${categories.map((category) => `<option value="${escapeHtml(category)}" ${category === state.categoryFilter ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}`;
  }
  const filtered = entries.filter((entry) => {
    const matchesCategory = state.view === "desktop" || !state.categoryFilter || entry.category === state.categoryFilter;
    const searchable = `${entry.title} ${entry.preview || ""} ${entry.category || ""}`.toLocaleLowerCase();
    return matchesCategory && (!query || searchable.includes(query));
  });
  heading.textContent = state.view === "desktop" ? "本机历史" : "远程会话";
  count.textContent = String(filtered.length);
  remoteFilters.hidden = state.view !== "remote";
  activeCount.textContent = String(remoteThreads.filter((entry) => !entry.archivedAt).length);
  archivedCount.textContent = String(remoteThreads.filter((entry) => entry.archivedAt).length);
  activeTab.classList.toggle("selected", state.remoteListMode === "active");
  archivedTab.classList.toggle("selected", state.remoteListMode === "archived");
  activeTab.setAttribute("aria-selected", String(state.remoteListMode === "active"));
  archivedTab.setAttribute("aria-selected", String(state.remoteListMode === "archived"));
  remoteTab.classList.toggle("selected", state.view === "remote");
  desktopTab.classList.toggle("selected", state.view === "desktop");
  remoteTab.setAttribute("aria-selected", String(state.view === "remote"));
  desktopTab.setAttribute("aria-selected", String(state.view === "desktop"));
  list.innerHTML = filtered.length ? filtered.map((entry) => state.view === "desktop" ? desktopRow(entry) : remoteRow(entry)).join("") : `<p class="empty-list">没有匹配的会话</p>`;
  list.querySelectorAll("[data-thread-id]").forEach((button) => button.addEventListener("click", () => selectThread(button.dataset.threadId)));
  list.querySelectorAll("[data-desktop-session-id]").forEach((button) => button.addEventListener("click", () => selectDesktopSession(button.dataset.desktopSessionId)));
  list.querySelectorAll("[data-manage-thread-id]").forEach((button) => button.addEventListener("click", () => openThreadManager(button.dataset.manageThreadId)));
}

function remoteRow(thread) {
  const manageable = thread.source === "remote";
  const category = thread.category ? `<span class="category-tag">${escapeHtml(thread.category)}</span>` : "";
  return `
    <div class="thread-item ${thread.id === state.currentThread?.id && state.view === "remote" ? "selected" : ""}">
      <button class="thread-row" type="button" data-thread-id="${thread.id}">
        <span class="thread-status ${thread.status}"></span>
        <span class="thread-copy"><strong>${thread.pinned ? '<span class="pin-mark" title="已置顶">★</span>' : ""}${escapeHtml(thread.title)}</strong><small>${escapeHtml(thread.preview || statusLabel(thread.status))}</small>${category}</span>
        ${thread.source === "desktop" ? '<span class="row-source">本机</span>' : ""}
      </button>
      ${manageable ? `<button class="thread-manage-button" type="button" data-manage-thread-id="${thread.id}" aria-label="管理 ${escapeHtml(thread.title)}" title="管理会话">...</button>` : ""}
    </div>`;
}

function desktopRow(session) {
  return `
    <button class="thread-row desktop ${session.id === state.currentDesktopSession?.id && state.view === "desktop" ? "selected" : ""}" type="button" data-desktop-session-id="${session.id}">
      <span class="history-mark" aria-hidden="true"></span>
      <span class="thread-copy"><strong>${escapeHtml(session.title)}</strong><small>${escapeHtml(session.preview)}</small></span>
      <span class="row-time">${formatTime(session.updatedAt)}</span>
    </button>`;
}

function setRemoteListMode(mode) {
  state.remoteListMode = mode === "archived" ? "archived" : "active";
  state.view = "remote";
  renderThreadList();
  renderWorkspace();
}

function openThreadManager(threadId) {
  const thread = state.threads.find((entry) => entry.id === threadId);
  if (!thread || thread.source !== "remote") return;
  state.managerThreadId = thread.id;
  renderThreadManager();
}

function closeThreadManager() {
  state.managerThreadId = null;
  renderThreadManager();
}

function renderThreadManager() {
  const root = document.querySelector("#thread-manager-root");
  if (!root) return;
  const thread = state.threads.find((entry) => entry.id === state.managerThreadId && entry.source === "remote");
  if (!thread) {
    state.managerThreadId = null;
    root.innerHTML = "";
    return;
  }
  const categories = [...new Set(state.threads.map((entry) => entry.category).filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN"));
  const busy = ["running", "awaiting_approval"].includes(thread.status) || Boolean(thread.pendingApproval);
  root.innerHTML = `
    <div class="thread-manager-backdrop" data-close-thread-manager></div>
    <section class="thread-manager" role="dialog" aria-modal="true" aria-labelledby="thread-manager-title">
      <header class="thread-manager-head">
        <div><span class="eyebrow">会话管理</span><strong id="thread-manager-title">${escapeHtml(thread.title)}</strong></div>
        <button class="icon-button" type="button" data-close-thread-manager aria-label="关闭会话管理" title="关闭">×</button>
      </header>
      <div class="manager-actions">
        <button class="manager-action" type="button" id="toggle-thread-pin">${thread.pinned ? "取消置顶" : "置顶"}</button>
        <button class="manager-action ${thread.archivedAt ? "restore" : "archive"}" type="button" id="toggle-thread-archive" ${!thread.archivedAt && busy ? "disabled" : ""}>${thread.archivedAt ? "恢复会话" : "归档会话"}</button>
      </div>
      <form class="manager-category-form" id="thread-category-form">
        <label for="thread-category">分类</label>
        <input id="thread-category" type="text" maxlength="40" list="thread-category-options" value="${escapeHtml(thread.category || "")}" placeholder="未分类">
        <datalist id="thread-category-options">${categories.map((category) => `<option value="${escapeHtml(category)}"></option>`).join("")}</datalist>
        <div class="manager-category-actions"><button class="button primary" type="submit">保存分类</button></div>
      </form>
    </section>`;
  root.querySelectorAll("[data-close-thread-manager]").forEach((button) => button.addEventListener("click", closeThreadManager));
  root.querySelector("#toggle-thread-pin")?.addEventListener("click", () => manageThread("pin", { pinned: !thread.pinned }));
  root.querySelector("#toggle-thread-archive")?.addEventListener("click", () => manageThread(thread.archivedAt ? "restore" : "archive"));
  root.querySelector("#thread-category-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    manageThread("category", { category: root.querySelector("#thread-category").value });
  });
}

async function manageThread(action, body = undefined) {
  const thread = state.threads.find((entry) => entry.id === state.managerThreadId);
  if (!thread) return;
  try {
    const { thread: updated } = await api(`/api/threads/${thread.id}/${action}`, { method: "POST", body: body || {} });
    if (action === "archive") {
      state.remoteListMode = "archived";
      state.managerThreadId = null;
    }
    if (action === "restore") {
      state.remoteListMode = "active";
      state.managerThreadId = null;
    }
    applyThreadUpdate(updated);
  } catch (error) {
    showTransientError(error.message);
  }
}

async function restoreArchivedThread() {
  const thread = state.currentThread;
  if (!thread?.archivedAt || thread.source !== "remote") return;
  try {
    const { thread: updated } = await api(`/api/threads/${thread.id}/restore`, { method: "POST", body: {} });
    state.remoteListMode = "active";
    applyThreadUpdate(updated);
  } catch (error) {
    showTransientError(error.message);
  }
}

function applyThreadUpdate(thread) {
  if (state.currentThread?.id === thread.id) state.currentThread = thread;
  upsertListItem(thread);
  renderThreadList();
  renderWorkspace();
  renderThreadManager();
}

async function selectThread(id) {
  try {
    const { thread } = await api(`/api/threads/${id}`);
    state.view = "remote";
    state.currentThread = thread;
    state.currentDesktopSession = null;
    state.attachments = [];
    state.scrollToLatest = true;
    closeSidebarAfterSelection();
    renderThreadList();
    renderWorkspace();
    connectThreadStream(id);
  } catch (error) {
    showTransientError(error.message);
  }
}

async function selectDesktopSession(id) {
  try {
    const { session } = await api(`/api/local-sessions/${id}`);
    state.eventSource?.close();
    state.eventSource = null;
    state.view = "desktop";
    state.currentDesktopSession = session;
    state.currentThread = null;
    state.scrollToLatest = true;
    closeSidebarAfterSelection();
    renderThreadList();
    renderWorkspace();
  } catch (error) {
    showTransientError(error.message);
  }
}

function renderWorkspace() {
  const area = document.querySelector("#message-area");
  const composer = document.querySelector("#composer-wrap");
  const title = document.querySelector("#thread-title");
  const detail = document.querySelector("#connection-detail");
  const badge = document.querySelector("#source-badge");
  const cancel = document.querySelector("#cancel");
  const manage = document.querySelector("#manage-current");
  const activity = document.querySelector("#activity-panel");
  if (!area || !composer || !title) return;

  const isDesktop = state.view === "desktop";
  const current = isDesktop ? state.currentDesktopSession : state.currentThread;
  title.textContent = current?.title || (isDesktop ? "本机历史" : "新任务");
  detail.textContent = isDesktop
    ? `${current?.messageCount || 0} 条消息 · ${shortPath(state.config?.workspaceRoot || "")}`
    : `${shortPath(state.config?.workspaceRoot || "")} · ${state.config?.sandbox || "workspace-write"}`;
  badge.hidden = !isDesktop && current?.source !== "desktop";
  badge.textContent = isDesktop ? "只读历史" : "本机续接";
  cancel.hidden = isDesktop || !["running", "awaiting_approval"].includes(current?.status);
  manage.hidden = isDesktop || current?.source !== "remote";

  const shouldFollow = state.scrollToLatest || isNearBottom(area);
  const previousScroll = area.scrollTop;
  area.innerHTML = current?.messages?.length
    ? current.messages.map((message) => messageMarkup(message)).join("")
    : emptyState(isDesktop);
  if (shouldFollow) scrollToLatest(area);
  else area.scrollTop = Math.min(previousScroll, area.scrollHeight);
  state.scrollToLatest = false;
  renderSidePanel(activity, current, isDesktop);
  composer.innerHTML = composerMarkup(current, isDesktop);
  bindWorkspaceControls();
}

function messageMarkup(message) {
  return `
    <article class="message ${message.role}">
      <div class="message-meta"><span>${message.role === "user" ? "你" : "Codex"}</span><time>${formatTime(message.createdAt)}</time></div>
      <div class="message-body">${formatMessage(message.text)}</div>
      ${messageAttachmentsMarkup(message.attachments)}
    </article>`;
}

function messageAttachmentsMarkup(attachments = [], removable = false) {
  if (!attachments.length) return "";
  return `<div class="message-attachments">${attachments.map((attachment) => `
    <span class="attachment-chip" title="${escapeHtml(attachment.name)}">
      <span>${escapeHtml(attachment.name)}</span><small>${formatBytes(attachment.size)}</small>
      ${removable ? `<button type="button" data-remove-attachment="${escapeHtml(attachment.id)}" title="移除 ${escapeHtml(attachment.name)}" aria-label="移除 ${escapeHtml(attachment.name)}">×</button>` : ""}
    </span>`).join("")}</div>`;
}

function emptyState(isDesktop) {
  return `<div class="empty-state"><img src="/icon.svg" alt=""><p>${isDesktop ? "本机历史" : "新任务"}</p></div>`;
}

function activityMarkup(current, isDesktop) {
  const logs = isDesktop ? [] : (current?.logs || []).slice(-18).reverse();
  return `
    <div class="inspector-head"><div><span class="eyebrow">${isDesktop ? "LOCAL SESSION" : "ACTIVITY"}</span><strong>${isDesktop ? "本机 Codex 历史" : statusLabel(current?.status)}</strong></div><span class="inspector-dot ${current?.status || "idle"}"></span></div>
    <div class="inspector-details">
      <span>会话</span><code>${escapeHtml(shortId(isDesktop ? current?.id : current?.codexSessionId))}</code>
      <span>目录</span><code>${escapeHtml(shortPath(state.config?.workspaceRoot || ""))}</code>
    </div>
    <div class="log-list">${logs.length ? logs.map((log) => `<div class="log-row ${escapeHtml(log.kind)}"><time>${formatTime(log.createdAt)}</time><span>${escapeHtml(log.text)}</span></div>`).join("") : '<p class="empty-activity">暂无运行记录</p>'}</div>`;
}

function renderSidePanel(panel, current, isDesktop) {
  const activityButton = document.querySelector("#toggle-activity");
  const filesButton = document.querySelector("#toggle-files");
  activityButton?.classList.toggle("selected", state.panelMode === "activity");
  filesButton?.classList.toggle("selected", state.panelMode === "files");
  activityButton?.setAttribute("aria-pressed", String(state.panelMode === "activity"));
  filesButton?.setAttribute("aria-pressed", String(state.panelMode === "files"));
  if (!state.panelMode) {
    panel.innerHTML = "";
    return;
  }
  if (state.panelMode === "files") {
    panel.innerHTML = filePanelMarkup();
    bindFileControls();
    return;
  }
  panel.innerHTML = activityMarkup(current, isDesktop);
}

function filePanelMarkup() {
  const files = state.files;
  const breadcrumbs = fileBreadcrumbs(files.path);
  const selected = files.selected;
  return `
    <div class="file-panel-head">
      <div><span class="eyebrow">WORKSPACE FILES</span><strong>文件</strong></div>
      <button class="icon-button panel-close" type="button" id="close-panel" title="关闭文件面板" aria-label="关闭文件面板">×</button>
    </div>
    <nav class="file-breadcrumbs" aria-label="文件路径">${breadcrumbs.map((crumb) => `<button type="button" data-browse-path="${escapeHtml(crumb.path)}">${escapeHtml(crumb.label)}</button>`).join("<span>/</span>")}</nav>
    <div class="file-list">
      ${files.loading ? '<p class="empty-activity">正在读取文件…</p>' : files.error ? `<p class="empty-activity error">${escapeHtml(files.error)}</p>` : files.entries.length ? files.entries.map(fileRow).join("") : '<p class="empty-activity">此目录为空</p>'}
      ${files.truncated ? '<p class="file-limit">仅显示前 250 项</p>' : ""}
    </div>
    <section class="file-preview" aria-label="文件预览">${filePreviewMarkup(selected)}</section>`;
}

function fileRow(entry) {
  const label = entry.kind === "directory" ? "目录" : fileExtension(entry.name) || "文件";
  const details = entry.kind === "directory" ? "" : formatBytes(entry.size);
  return `
    <button class="file-row ${state.files.selected?.file?.path === entry.path ? "selected" : ""}" type="button" data-file-path="${escapeHtml(entry.path)}" data-file-kind="${entry.kind}">
      <span class="file-type">${escapeHtml(label)}</span>
      <span class="file-name">${escapeHtml(entry.name)}</span>
      <small>${escapeHtml(details)}</small>
    </button>`;
}

function filePreviewMarkup(selected) {
  if (!selected) return '<p class="empty-activity">选择一个文件以预览</p>';
  const file = selected.file;
  const downloadUrl = `/api/files/download?path=${encodeURIComponent(file.path)}`;
  let preview = '<p class="empty-activity">此文件不支持预览</p>';
  if (selected.kind === "text") preview = `<pre class="file-preview-text"><code>${escapeHtml(selected.content || "")}</code></pre>`;
  if (selected.kind === "image") preview = `<img class="file-preview-image" src="${escapeHtml(selected.contentUrl)}" alt="${escapeHtml(file.name)}">`;
  if (selected.kind === "audio") preview = `<audio class="file-preview-media" controls src="${escapeHtml(selected.contentUrl)}"></audio>`;
  if (selected.kind === "video") preview = `<video class="file-preview-media" controls src="${escapeHtml(selected.contentUrl)}"></video>`;
  return `
    <div class="file-preview-head"><strong>${escapeHtml(file.name)}</strong><a class="text-control" href="${escapeHtml(downloadUrl)}">下载</a></div>
    <small class="file-preview-meta">${escapeHtml(file.path)} · ${formatBytes(file.size)}</small>
    ${preview}`;
}

function fileBreadcrumbs(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  const crumbs = [{ label: "工作目录", path: "" }];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

function bindFileControls() {
  document.querySelector("#close-panel")?.addEventListener("click", () => togglePanel(state.panelMode));
  document.querySelectorAll("[data-browse-path]").forEach((button) => button.addEventListener("click", () => loadFiles(button.dataset.browsePath || "")));
  document.querySelectorAll("[data-file-path]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.fileKind === "directory") return loadFiles(button.dataset.filePath);
    return previewFile(button.dataset.filePath);
  }));
}

function togglePanel(mode) {
  state.panelMode = state.panelMode === mode ? null : mode;
  document.querySelector(".workbench")?.classList.toggle("activity-open", Boolean(state.panelMode));
  if (state.panelMode === "files" && !state.files.entries.length && !state.files.loading) void loadFiles(state.files.path);
  renderWorkspace();
}

async function loadFiles(path = "") {
  state.files = { ...state.files, path, selected: null, loading: true, error: "" };
  renderWorkspace();
  try {
    const result = await api(`/api/files?path=${encodeURIComponent(path)}`);
    state.files = { ...state.files, ...result, loading: false, error: "" };
  } catch (error) {
    state.files = { ...state.files, loading: false, error: error.message };
  }
  renderWorkspace();
}

async function previewFile(path) {
  state.files = { ...state.files, loading: true, error: "" };
  renderWorkspace();
  try {
    const selected = await api(`/api/files/preview?path=${encodeURIComponent(path)}`);
    state.files = { ...state.files, loading: false, error: "", selected };
  } catch (error) {
    state.files = { ...state.files, loading: false, error: error.message };
  }
  renderWorkspace();
}

function composerMarkup(thread, isDesktop) {
  if (isDesktop) {
    return `<div class="history-actions"><button class="button primary" type="button" id="attach-desktop-session" ${thread ? "" : "disabled"}>继续此会话</button></div>`;
  }
  if (thread?.archivedAt) {
    return `<div class="archived-actions"><span>已归档</span><button class="button primary" type="button" id="restore-archived-thread">恢复</button></div>`;
  }
  if (thread?.pendingApproval) {
    return approvalMarkup(thread.pendingApproval);
  }
  const disabled = thread?.status === "running" || state.uploading;
  const canWrite = state.config?.sandbox !== "read-only";
  return `
    <div class="activity-line ${thread?.status === "error" ? "error" : ""}">${escapeHtml(state.uploading ? "正在上传文件" : (thread?.status === "running" ? lastLog(thread) || "Codex 正在处理" : ""))}</div>
    <form class="composer" id="message-form">
      ${messageAttachmentsMarkup(state.attachments, true)}
      <input class="sr-only" id="attachment-input" type="file" multiple ${disabled ? "disabled" : ""}>
      <button class="icon-button attachment-button" type="button" id="add-attachment" title="添加附件" aria-label="添加附件" ${disabled ? "disabled" : ""}>+</button>
      <label class="sr-only" for="message-input">发送给 Codex</label>
      <textarea id="message-input" rows="1" maxlength="12000" placeholder="输入任务" autocomplete="off" ${disabled ? "disabled" : ""}></textarea>
      <label class="sr-only" for="sandbox-input">本轮权限</label>
      <select id="sandbox-input" ${disabled ? "disabled" : ""}>
        ${canWrite ? `<option value="workspace-write" ${state.draftSandbox === "workspace-write" ? "selected" : ""}>可写</option>` : ""}
        <option value="read-only" ${state.draftSandbox === "read-only" ? "selected" : ""}>只读</option>
      </select>
      <button class="button primary send" type="submit" ${disabled ? "disabled" : ""}>发送</button>
    </form>`;
}

function approvalMarkup(pending) {
  const mode = pending.sandbox === "read-only" ? "只读" : "可写";
  return `
    <section class="approval-card" aria-label="待批准任务">
      <div class="approval-heading"><span>待批准</span><small>${mode}</small></div>
      <p>${escapeHtml(pending.text)}</p>
      ${messageAttachmentsMarkup(pending.attachments)}
      <div class="approval-actions">
        <button class="button secondary" type="button" id="reject-pending">拒绝</button>
        <button class="button primary" type="button" id="approve-pending">批准运行</button>
      </div>
    </section>`;
}

function bindWorkspaceControls() {
  document.querySelector("#message-form")?.addEventListener("submit", sendMessage);
  const input = document.querySelector("#message-input");
  input?.addEventListener("input", autoGrow);
  input?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") event.currentTarget.form.requestSubmit();
  });
  document.querySelector("#sandbox-input")?.addEventListener("change", (event) => {
    state.draftSandbox = event.currentTarget.value;
  });
  document.querySelector("#add-attachment")?.addEventListener("click", () => document.querySelector("#attachment-input")?.click());
  document.querySelector("#attachment-input")?.addEventListener("change", uploadSelectedFiles);
  document.querySelectorAll("[data-remove-attachment]").forEach((button) => button.addEventListener("click", () => {
    state.attachments = state.attachments.filter((attachment) => attachment.id !== button.dataset.removeAttachment);
    renderWorkspace();
  }));
  document.querySelector("#attach-desktop-session")?.addEventListener("click", attachDesktopSession);
  document.querySelector("#restore-archived-thread")?.addEventListener("click", restoreArchivedThread);
  document.querySelector("#approve-pending")?.addEventListener("click", approvePending);
  document.querySelector("#reject-pending")?.addEventListener("click", rejectPending);
}

async function attachDesktopSession() {
  const session = state.currentDesktopSession;
  if (!session) return;
  const button = document.querySelector("#attach-desktop-session");
  button.disabled = true;
  try {
    const { thread } = await api(`/api/local-sessions/${session.id}/attach`, { method: "POST", body: {} });
    upsertListItem(thread);
    state.view = "remote";
    state.currentDesktopSession = null;
    state.currentThread = thread;
    state.attachments = [];
    state.scrollToLatest = true;
    renderThreadList();
    renderWorkspace();
    connectThreadStream(thread.id);
    document.querySelector("#message-input")?.focus();
  } catch (error) {
    button.disabled = false;
    showTransientError(error.message);
  }
}

async function newThread() {
  try {
    const { thread } = await api("/api/threads", { method: "POST", body: {} });
    state.remoteListMode = "active";
    state.categoryFilter = "";
    upsertListItem(thread);
    state.view = "remote";
    state.currentDesktopSession = null;
    state.currentThread = thread;
    state.attachments = [];
    state.scrollToLatest = true;
    renderThreadList();
    renderWorkspace();
    connectThreadStream(thread.id);
    document.querySelector("#message-input")?.focus();
  } catch (error) {
    showTransientError(error.message);
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.querySelector("#message-input");
  const sandbox = form.querySelector("#sandbox-input")?.value || "workspace-write";
  const text = input.value.trim();
  if (!text && !state.attachments.length) return;
  if (!state.currentThread) await newThread();
  const button = form.querySelector("button");
  button.disabled = true;
  input.disabled = true;
  try {
    const { thread } = await api(`/api/threads/${state.currentThread.id}/messages`, { method: "POST", body: { text, sandbox, attachments: state.attachments.map((attachment) => attachment.id) } });
    state.currentThread = thread;
    state.scrollToLatest = true;
    upsertListItem(thread);
    input.value = "";
    input.style.height = "";
    renderThreadList();
    renderWorkspace();
  } catch (error) {
    showTransientError(error.message);
    button.disabled = false;
    input.disabled = false;
  }
}

async function approvePending() {
  if (!state.currentThread) return;
  try {
    const { thread } = await api(`/api/threads/${state.currentThread.id}/approve`, { method: "POST", body: {} });
    state.currentThread = thread;
    state.attachments = [];
    state.scrollToLatest = true;
    upsertListItem(thread);
    renderThreadList();
    renderWorkspace();
  } catch (error) {
    showTransientError(error.message);
  }
}

async function rejectPending() {
  if (!state.currentThread) return;
  try {
    const { thread } = await api(`/api/threads/${state.currentThread.id}/reject`, { method: "POST", body: {} });
    state.currentThread = thread;
    upsertListItem(thread);
    renderThreadList();
    renderWorkspace();
  } catch (error) {
    showTransientError(error.message);
  }
}

async function cancelRun() {
  if (!state.currentThread) return;
  try {
    const { thread } = await api(`/api/threads/${state.currentThread.id}/cancel`, { method: "POST", body: {} });
    state.currentThread = thread;
    upsertListItem(thread);
    renderThreadList();
    renderWorkspace();
  } catch (error) {
    showTransientError(error.message);
  }
}

async function logout() {
  await api("/api/logout", { method: "POST", body: {} });
  state.authenticated = false;
  state.currentThread = null;
  state.currentDesktopSession = null;
  state.attachments = [];
  state.uploading = false;
  state.threads = [];
  state.desktopSessions = [];
  state.eventSource?.close();
  renderLogin();
}

function connectThreadStream(id) {
  state.eventSource?.close();
  const source = new EventSource(`/api/threads/${id}/events`);
  state.eventSource = source;
  source.onmessage = (message) => {
    const payload = JSON.parse(message.data);
    if (state.currentThread?.id !== id) return;
    if (payload.thread) {
      state.currentThread = payload.thread;
      upsertListItem(payload.thread);
      if (payload.thread.source === "desktop" && payload.thread.status === "idle") void refreshDesktopSessions();
    } else if (payload.log) {
      state.currentThread.logs = [...(state.currentThread.logs || []), payload.log].slice(-80);
    }
    renderThreadList();
    renderWorkspace();
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED && state.currentThread?.id === id) window.setTimeout(() => connectThreadStream(id), 2000);
  };
}

function upsertListItem(thread) {
  const item = toListItem(thread);
  const index = state.threads.findIndex((entry) => entry.id === item.id);
  if (index === -1) state.threads.unshift(item);
  else state.threads[index] = item;
  state.threads.sort(compareThreads);
}

function toListItem(thread) {
  return {
    id: thread.id,
    title: thread.title || "新任务",
    status: thread.status,
    codexSessionId: thread.codexSessionId,
    source: thread.source || "remote",
    desktopSessionId: thread.desktopSessionId || null,
    pinned: thread.pinned === true,
    archivedAt: Number(thread.archivedAt) || null,
    category: typeof thread.category === "string" ? thread.category : "",
    pendingApproval: thread.pendingApproval || null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    preview: thread.pendingApproval?.text?.slice(0, 120) || thread.messages?.at(-1)?.text?.slice(0, 120) || ""
  };
}

function compareThreads(left, right) {
  return Number(right.pinned) - Number(left.pinned) || Number(right.updatedAt) - Number(left.updatedAt);
}

function toggleSidebar(open) {
  state.compactSidebar = open;
  document.querySelector(".remote-shell")?.classList.toggle("sidebar-open", open);
}

function closeSidebarAfterSelection() {
  if (!window.matchMedia("(max-width: 760px)").matches) return;
  toggleSidebar(false);
}

function isNearBottom(element) {
  return element.scrollHeight - element.clientHeight - element.scrollTop < 80;
}

function scrollToLatest(element) {
  element.scrollTop = element.scrollHeight;
  requestAnimationFrame(() => {
    if (document.contains(element)) element.scrollTop = element.scrollHeight;
  });
}

async function uploadSelectedFiles(event) {
  const files = [...(event.currentTarget.files || [])];
  event.currentTarget.value = "";
  if (!files.length) return;
  if (!state.currentThread) await newThread();
  if (!state.currentThread) return;
  const available = 5 - state.attachments.length;
  if (files.length > available) {
    showTransientError(`每条消息最多添加 5 个文件，还可添加 ${available} 个。`);
    return;
  }
  state.uploading = true;
  renderWorkspace();
  try {
    const uploaded = [];
    for (const file of files) uploaded.push(await uploadFile(state.currentThread.id, file));
    state.attachments = [...state.attachments, ...uploaded];
  } catch (error) {
    showTransientError(error.message);
  } finally {
    state.uploading = false;
    renderWorkspace();
  }
}

async function uploadFile(threadId, file) {
  const response = await fetch(`/api/threads/${threadId}/uploads`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name)
    },
    body: file,
    credentials: "same-origin"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "文件上传失败。");
  return data.attachment;
}

async function refreshDesktopSessions() {
  try {
    const result = await api("/api/local-sessions");
    state.desktopSessions = result.sessions;
    renderThreadList();
  } catch {}
}

function autoGrow(event) {
  const input = event.currentTarget;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
}

function lastLog(thread) {
  return thread?.logs?.at(-1)?.text || "";
}

function statusLabel(status) {
  return ({ running: "运行中", idle: "已完成", cancelled: "已中止", error: "需要处理" })[status] || "新任务";
}

function shortPath(value) {
  const normalized = String(value).replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : normalized;
}

function shortId(value) {
  const text = String(value || "未创建");
  return text.length > 16 ? `${text.slice(0, 8)}...${text.slice(-4)}` : text;
}

function fileExtension(name) {
  const index = String(name).lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toUpperCase().slice(0, 8) : "";
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function formatTime(value) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  const now = new Date();
  if (time.toDateString() === now.toDateString()) return time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return time.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function formatMessage(value) {
  return escapeHtml(value)
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

function showTransientError(message) {
  const node = document.querySelector(".activity-line");
  if (!node) return;
  node.textContent = message;
  node.classList.add("error");
  window.setTimeout(() => node.classList.remove("error"), 5_000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败。");
  return data;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    syncInstallButton();
  });
}

function syncInstallButton() {
  const button = document.querySelector("#install");
  if (button) button.hidden = !state.installPrompt;
}

async function installApp() {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  syncInstallButton();
}
