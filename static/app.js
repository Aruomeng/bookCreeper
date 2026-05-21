const $ = (id) => document.getElementById(id);

if (window.location.protocol === "file:") {
  document.body.className = "standalone-mode";
  document.body.innerHTML = `
    <div class="standalone-shell">
      <section class="standalone-card">
        <div class="standalone-eyebrow">bookCreeper</div>
        <h1>这个页面不能直接双击打开。</h1>
        <p>你现在打开的是静态文件，所以样式、接口和实时状态都不会正确工作。请通过本地服务启动控制台，再访问浏览器地址。</p>
        <ol class="standalone-steps">
          <li>
            <span class="standalone-step-no">1</span>
            <div>
              在项目根目录运行：
              <div class="standalone-command">python3 crawler_app.py</div>
            </div>
          </li>
          <li>
            <span class="standalone-step-no">2</span>
            <div>
              浏览器打开：
              <div class="standalone-command">http://127.0.0.1:8000</div>
            </div>
          </li>
        </ol>
        <a class="standalone-link" href="http://127.0.0.1:8000">打开本地控制台</a>
        <p class="standalone-note">如果本地服务还没启动，上面的地址会暂时无法访问。</p>
      </section>
    </div>
  `;
} else {
const fields = [
  "searchUrl",
  "startPage",
  "pages",
  "targetBooks",
  "workers",
  "minDelay",
  "maxDelay",
  "retries",
  "retryDelay",
  "output",
  "cookieFile",
  "cookie",
  "resume",
  "saveBlockHtml",
];

const numericFields = new Set([
  "startPage",
  "pages",
  "targetBooks",
  "workers",
  "minDelay",
  "maxDelay",
  "retries",
  "retryDelay",
]);

const CONFIG_KEY = "duxiuCrawlerConfig";
const UI_KEY = "duxiuCrawlerUi";

let lastLogSignature = "";
let configDirty = false;
let latestFocus = null;

function readConfig() {
  const config = {};
  for (const key of fields) {
    const el = $(key);
    if (!el) continue;
    if (el.type === "checkbox") {
      config[key] = el.checked;
    } else if (numericFields.has(key)) {
      const value = el.value.trim();
      config[key] = value === "" && key === "startPage" ? null : Number(value);
    } else {
      config[key] = el.value;
    }
  }
  return config;
}

function applyConfig(config) {
  for (const [key, value] of Object.entries(config)) {
    const el = $(key);
    if (!el) continue;
    if (el.type === "checkbox") {
      el.checked = Boolean(value);
    } else if (key === "cookie" && value === "已填写") {
      continue;
    } else {
      el.value = value ?? "";
    }
  }
}

function persistConfig() {
  const config = readConfig();
  const safeConfig = { ...config, cookie: "" };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(safeConfig));
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function statusClass(status) {
  return `status-badge ${status || "idle"}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadDefaults() {
  const cached = localStorage.getItem(CONFIG_KEY);
  if (cached) {
    try {
      applyConfig(JSON.parse(cached));
    } catch {
      localStorage.removeItem(CONFIG_KEY);
    }
    if (localStorage.getItem(CONFIG_KEY)) return;
  }
  const res = await fetch("/api/default-config");
  applyConfig(await res.json());
}

function readUiState() {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) || "{}");
  } catch {
    return {};
  }
}

function isFocusMode() {
  return document.body.classList.contains("focus-mode");
}

function persistUiState() {
  localStorage.setItem(
    UI_KEY,
    JSON.stringify({
      configCollapsed: document.body.classList.contains("config-collapsed"),
      rowsCollapsed: document.body.classList.contains("rows-collapsed"),
      focusMode: isFocusMode(),
    }),
  );
}

function setFocusButtonState() {
  const active = isFocusMode();
  const btn = $("focusBtn");
  if (btn) {
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
    const title = btn.querySelector("strong");
    const subtitle = btn.querySelector("small");
    if (title) title.textContent = active ? "专注中" : "专注模式";
    if (subtitle) subtitle.textContent = active ? "返回常规控制台" : "官方网页 + 实时日志";
  }
}

function updateLayoutButtons() {
  const configCollapsed = document.body.classList.contains("config-collapsed");
  const rowsCollapsed = document.body.classList.contains("rows-collapsed");
  $("toggleConfig")?.setAttribute("aria-expanded", String(!configCollapsed));
  $("expandConfig")?.setAttribute("aria-expanded", String(!configCollapsed));
  $("toggleRows")?.setAttribute("aria-expanded", String(!rowsCollapsed));
  $("expandRows")?.setAttribute("aria-expanded", String(!rowsCollapsed));
  setFocusButtonState();
}

function syncOfficialFrame(focus = latestFocus, options = {}) {
  const { force = false } = options;
  const frame = $("officialFrame");
  if (!frame || !focus) return;

  const stamp = focus.previewStamp || String(Date.now());
  const base = focus.frameUrl || "/proxy?view=live";
  const nextSrc = `${base}${base.includes("?") ? "&" : "?"}stamp=${encodeURIComponent(stamp)}`;
  if (force || !frame.getAttribute("src") || frame.dataset.previewStamp !== stamp) {
    frame.src = nextSrc;
    frame.dataset.previewStamp = stamp;
  }
  setText("focusUrl", focus.officialUrl || "https://book.duxiu.com/");
}

function enterFocusMode() {
  document.body.classList.add("focus-mode");
  updateLayoutButtons();
  persistUiState();
  syncOfficialFrame(latestFocus, { force: true });
}

function exitFocusMode() {
  document.body.classList.remove("focus-mode");
  updateLayoutButtons();
  persistUiState();
}

function toggleFocusMode(force) {
  const nextState = typeof force === "boolean" ? force : !isFocusMode();
  if (nextState) enterFocusMode();
  else exitFocusMode();
}

function setupLayout() {
  const state = readUiState();
  document.body.classList.toggle("config-collapsed", Boolean(state.configCollapsed));
  document.body.classList.toggle("rows-collapsed", state.rowsCollapsed !== false);
  document.body.classList.toggle("focus-mode", Boolean(state.focusMode));
  updateLayoutButtons();

  $("toggleConfig")?.addEventListener("click", () => {
    document.body.classList.add("config-collapsed");
    updateLayoutButtons();
    persistUiState();
  });
  $("expandConfig")?.addEventListener("click", () => {
    document.body.classList.remove("config-collapsed");
    updateLayoutButtons();
    persistUiState();
  });
  $("toggleRows")?.addEventListener("click", () => {
    document.body.classList.add("rows-collapsed");
    updateLayoutButtons();
    persistUiState();
  });
  $("expandRows")?.addEventListener("click", () => {
    document.body.classList.remove("rows-collapsed");
    updateLayoutButtons();
    persistUiState();
  });
  $("focusBtn")?.addEventListener("click", () => toggleFocusMode());
  $("focusStartBtn")?.addEventListener("click", () => startCrawl());
  $("focusExitBtn")?.addEventListener("click", () => toggleFocusMode(false));
  $("syncFocusPreview")?.addEventListener("click", () => syncOfficialFrame(latestFocus, { force: true }));
}

async function startCrawl(event) {
  event?.preventDefault();
  const config = readConfig();
  const res = await fetch("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showAlert(err.detail || "启动失败");
    return;
  }
  configDirty = false;
  persistConfig();
  hideAlert();
  await refreshStatus();
}

async function stopCrawl() {
  await fetch("/api/stop", { method: "POST" });
  await refreshStatus();
}

function showAlert(message) {
  for (const id of ["alertBox", "focusAlert"]) {
    const box = $(id);
    if (!box) continue;
    box.textContent = message;
    box.classList.remove("hidden");
  }
}

function hideAlert() {
  for (const id of ["alertBox", "focusAlert"]) {
    $(id)?.classList.add("hidden");
  }
}

function buildLogsHtml(logs) {
  return logs
    .map(
      (log) => `
      <div class="log-line">
        <span class="log-time">${escapeHtml(log.time)}</span>
        <span class="log-level level-${escapeHtml(log.level)}">${escapeHtml(log.level)}</span>
        <span class="log-message">${escapeHtml(log.message)}</span>
      </div>
    `,
    )
    .join("");
}

function renderLogs(logs) {
  const last = logs.at(-1);
  const signature = `${logs.length}:${last?.time || ""}:${last?.level || ""}:${last?.message || ""}`;
  if (signature === lastLogSignature && $("logs")?.children.length) return;
  lastLogSignature = signature;
  const html = buildLogsHtml(logs);
  for (const id of ["logs", "focusLogs"]) {
    const box = $(id);
    if (!box) continue;
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }
}

function renderRows(rows) {
  const list = $("recentRows");
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = `<div class="saved-list-empty">暂无记录</div>`;
    return;
  }
  list.innerHTML = [...rows]
    .reverse()
    .map(
      (row) => `
      <article class="saved-item" title="${escapeHtml(row["内容提要"] || "")}">
        <div class="saved-title">${escapeHtml(row["题名"] || "未命名")}</div>
        <div class="saved-meta">
          <span>${escapeHtml(row["作者"] || "作者空")}</span>
          <span>${escapeHtml(row["出版社"] || "出版社空")}</span>
          <span>${escapeHtml(row["发行时间"] || "时间空")}</span>
        </div>
        <div class="saved-sub">
          <span>${escapeHtml(row["ISBN号"] || "ISBN空")}</span>
          <span>${escapeHtml(row["主题词"] || "主题词空")}</span>
          ${row["详情页Url"] ? `<a class="saved-link" href="${escapeHtml(row["详情页Url"])}" target="_blank" rel="noreferrer">详情</a>` : ""}
        </div>
      </article>
    `,
    )
    .join("");
}

function renderFocusState(focus) {
  latestFocus = focus || null;
  if (!focus) return;

  setText("focusMessage", focus.message || "左侧保持官方网页；一旦发现验证，会自动切到对应页面。");
  setText("focusUrl", focus.officialUrl || "https://book.duxiu.com/");

  const statePill = $("focusStatePill");
  if (statePill) {
    statePill.textContent = focus.needsAttention ? "需要验证" : "待机观察";
    statePill.className = `focus-state-pill ${focus.status || "standby"}`;
  }

  const signal = $("focusSignal");
  if (signal) {
    signal.textContent = focus.needsAttention ? "发现验证，请在左侧处理" : "未发现验证";
    signal.className = `focus-signal ${focus.status || "standby"}`;
  }

  document.body.classList.toggle("needs-attention", Boolean(focus.needsAttention));
  if (isFocusMode()) syncOfficialFrame(focus);
}

function updateRunControls(status) {
  const running = ["starting", "running"].includes(status);
  const blocked = status === "blocked";
  const stopped = status === "stopped";
  const focusStartBtn = $("focusStartBtn");
  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");

  if (startBtn) startBtn.disabled = running;
  if (stopBtn) stopBtn.disabled = !running;
  if (focusStartBtn) {
    focusStartBtn.disabled = running;
    focusStartBtn.textContent = blocked ? "验证后继续" : stopped ? "继续任务" : "启动/继续";
  }
}

async function refreshStatus() {
  const res = await fetch("/api/status");
  const data = await res.json();
  const metrics = data.metrics || {};
  const files = data.files || {};
  const focus = data.focus || {};
  const status = metrics.status || "idle";

  setText("statusText", status);
  setText("booksSaved", metrics.books_saved ?? 0);
  setText("currentPage", metrics.current_page ?? 0);
  setText("currentItem", metrics.current_item ?? 0);
  setText("detailLinks", metrics.detail_links_seen ?? 0);
  setText("failedCount", metrics.failed_count ?? 0);
  setText("inFlight", metrics.in_flight ?? 0);
  setText("lastTitle", metrics.last_title || "-");
  setText("lastPosition", `最后位置：第 ${metrics.last_page || 0} 页第 ${metrics.last_item || 0} 条`);
  setText("csvPath", `CSV: ${files.csv || "-"}`);
  setText("jsonPath", `JSON: ${files.json || "-"}`);
  setText("statePath", `STATE: ${files.state || "-"}`);

  const badge = $("statusBadge");
  if (badge) {
    badge.textContent = status;
    badge.className = statusClass(status);
  }
  updateRunControls(status);

  const pagesTotal = metrics.pages_total || 0;
  const pagesCompleted = metrics.pages_completed || 0;
  setText("pageProgressLabel", `${pagesCompleted} / ${pagesTotal}`);
  const progress = $("pageProgress");
  if (progress) {
    progress.style.width = pagesTotal ? `${Math.min(100, (pagesCompleted / pagesTotal) * 100)}%` : "0%";
  }

  if (metrics.stop_reason) showAlert(metrics.stop_reason);
  else hideAlert();

  renderLogs(data.logs || []);
  renderRows(data.recentRows || []);
  renderFocusState(focus);
}

$("crawlForm")?.addEventListener("submit", startCrawl);
$("crawlForm")?.addEventListener("input", () => {
  configDirty = true;
  persistConfig();
});
$("crawlForm")?.addEventListener("change", () => {
  configDirty = true;
  persistConfig();
});
$("stopBtn")?.addEventListener("click", stopCrawl);
$("clearLogs")?.addEventListener("click", () => {
  $("logs").innerHTML = "";
  $("focusLogs").innerHTML = "";
  lastLogSignature = "";
});

setupLayout();
loadDefaults().then(refreshStatus);
setInterval(refreshStatus, 1500);
}
