const $ = (id) => document.getElementById(id);

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

let lastLogCount = 0;
let configDirty = false;
const CONFIG_KEY = "duxiuCrawlerConfig";
const UI_KEY = "duxiuCrawlerUi";

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

function persistUiState() {
  localStorage.setItem(
    UI_KEY,
    JSON.stringify({
      configCollapsed: document.body.classList.contains("config-collapsed"),
      rowsCollapsed: document.body.classList.contains("rows-collapsed"),
    }),
  );
}

function updateLayoutButtons() {
  const configCollapsed = document.body.classList.contains("config-collapsed");
  const rowsCollapsed = document.body.classList.contains("rows-collapsed");
  $("toggleConfig").setAttribute("aria-expanded", String(!configCollapsed));
  $("expandConfig").setAttribute("aria-expanded", String(!configCollapsed));
  $("toggleRows").setAttribute("aria-expanded", String(!rowsCollapsed));
  $("expandRows").setAttribute("aria-expanded", String(!rowsCollapsed));
}

function setupLayout() {
  const state = readUiState();
  document.body.classList.toggle("config-collapsed", Boolean(state.configCollapsed));
  document.body.classList.toggle("rows-collapsed", state.rowsCollapsed !== false);
  updateLayoutButtons();

  $("toggleConfig").addEventListener("click", () => {
    document.body.classList.add("config-collapsed");
    updateLayoutButtons();
    persistUiState();
  });
  $("expandConfig").addEventListener("click", () => {
    document.body.classList.remove("config-collapsed");
    updateLayoutButtons();
    persistUiState();
  });
  $("toggleRows").addEventListener("click", () => {
    document.body.classList.add("rows-collapsed");
    updateLayoutButtons();
    persistUiState();
  });
  $("expandRows").addEventListener("click", () => {
    document.body.classList.remove("rows-collapsed");
    updateLayoutButtons();
    persistUiState();
  });
}

async function startCrawl(event) {
  event.preventDefault();
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
  const box = $("alertBox");
  box.textContent = message;
  box.classList.remove("hidden");
}

function hideAlert() {
  $("alertBox").classList.add("hidden");
}

function renderLogs(logs) {
  const box = $("logs");
  if (logs.length === lastLogCount && box.children.length) return;
  lastLogCount = logs.length;
  box.innerHTML = logs
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
  box.scrollTop = box.scrollHeight;
}

function renderRows(rows) {
  const list = $("recentRows");
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

async function refreshStatus() {
  const res = await fetch("/api/status");
  const data = await res.json();
  const metrics = data.metrics || {};
  const files = data.files || {};
  const status = metrics.status || "idle";

  setText("statusText", status);
  setText("booksSaved", metrics.books_saved ?? 0);
  setText("currentPage", metrics.current_page ?? 0);
  setText("currentItem", metrics.current_item ?? 0);
  setText("detailLinks", metrics.detail_links_seen ?? 0);
  setText("failedCount", metrics.failed_count ?? 0);
  setText("inFlight", metrics.in_flight ?? 0);
  setText("lastTitle", metrics.last_title || "-");
  setText(
    "lastPosition",
    `最后位置：第 ${metrics.last_page || 0} 页第 ${metrics.last_item || 0} 条`,
  );
  setText("csvPath", `CSV: ${files.csv || "-"}`);
  setText("jsonPath", `JSON: ${files.json || "-"}`);
  setText("statePath", `STATE: ${files.state || "-"}`);

  const badge = $("statusBadge");
  badge.textContent = status;
  badge.className = statusClass(status);

  const pagesTotal = metrics.pages_total || 0;
  const pagesCompleted = metrics.pages_completed || 0;
  setText("pageProgressLabel", `${pagesCompleted} / ${pagesTotal}`);
  $("pageProgress").style.width = pagesTotal ? `${Math.min(100, (pagesCompleted / pagesTotal) * 100)}%` : "0%";

  if (metrics.stop_reason) showAlert(metrics.stop_reason);
  else hideAlert();

  renderLogs(data.logs || []);
  renderRows(data.recentRows || []);
}

$("crawlForm").addEventListener("submit", startCrawl);
$("crawlForm").addEventListener("input", () => {
  configDirty = true;
  persistConfig();
});
$("crawlForm").addEventListener("change", () => {
  configDirty = true;
  persistConfig();
});
$("stopBtn").addEventListener("click", stopCrawl);
$("clearLogs").addEventListener("click", () => {
  $("logs").innerHTML = "";
  lastLogCount = 0;
});

setupLayout();
loadDefaults().then(refreshStatus);
setInterval(refreshStatus, 1500);
