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
const QUEUE_KEY = "duxiuCrawlerKeywordQueue";

let lastLogSignature = "";
let configDirty = false;
let latestFocus = null;
let latestStatus = "idle";
let keywordQueue = loadKeywordQueue();

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

function emptyKeywordQueue() {
  return {
    items: [],
    activeIndex: -1,
    waiting: false,
    started: false,
    baseOutput: "",
    continuous: false,
  };
}

function loadKeywordQueue() {
  try {
    const value = JSON.parse(localStorage.getItem(QUEUE_KEY) || "null");
    if (!value || !Array.isArray(value.items)) return emptyKeywordQueue();
    return {
      ...emptyKeywordQueue(),
      ...value,
      items: value.items.map((item) => ({
        keyword: String(item.keyword || "").trim(),
        url: String(item.url || "").trim(),
        status: item.status || "pending",
      })),
    };
  } catch {
    localStorage.removeItem(QUEUE_KEY);
    return emptyKeywordQueue();
  }
}

function persistKeywordQueue() {
  const continuous = $("keywordContinuous");
  if (continuous) keywordQueue.continuous = continuous.checked;
  localStorage.setItem(QUEUE_KEY, JSON.stringify(keywordQueue));
}

function keywordFromSearchUrl(value) {
  try {
    const url = new URL(value.trim());
    if (!url.hostname.endsWith("duxiu.com")) return "";
    return (url.searchParams.get("sw") || "").trim();
  } catch {
    return "";
  }
}

function buildKeywordSearchUrl(keyword) {
  const url = new URL("https://book.duxiu.com/search");
  const params = [
    ["channel", "search"],
    ["gtag", ""],
    ["sw", keyword],
    ["ecode", "utf-8"],
    ["Field", "all"],
    ["Sort", ""],
    ["adminid", ""],
    ["btype", ""],
    ["seb", "0"],
    ["pid", "0"],
    ["year", ""],
    ["sectyear", ""],
    ["showc", "0"],
    ["fenleiID", ""],
    ["searchtype", ""],
    ["authid", "0"],
    ["exp", "0"],
    ["expertsw", ""],
  ];
  for (const [key, value] of params) url.searchParams.set(key, value);
  return url.toString();
}

function parseKeywordEntry(raw) {
  const value = raw.trim();
  if (!value) return null;
  const keyword = keywordFromSearchUrl(value);
  if (keyword) return { keyword, url: value, status: "pending" };
  return { keyword: value, url: buildKeywordSearchUrl(value), status: "pending" };
}

function parseKeywordEntries(text) {
  const rows = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/https?:\/\/\S*duxiu\.com\/search/i.test(line)) {
      rows.push(line);
    } else {
      rows.push(...line.split(/[，,;；]/).map((item) => item.trim()).filter(Boolean));
    }
  }
  const seen = new Set();
  return rows
    .map(parseKeywordEntry)
    .filter(Boolean)
    .filter((item) => {
      const key = `${item.keyword}|${item.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sanitizeOutputSuffix(keyword, index) {
  const compact = String(keyword || "")
    .trim()
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  return compact || `keyword_${index + 1}`;
}

function splitOutputBase(baseOutput) {
  const normalized = (baseOutput || "output/duxiu_books").trim().replace(/\/+$/g, "") || "output/duxiu_books";
  const slash = normalized.lastIndexOf("/");
  const dir = slash >= 0 ? normalized.slice(0, slash) : "";
  const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  return {
    rootDir: dir ? `${dir}/${name || "duxiu_books"}` : name || "duxiu_books",
    fileBase: name || "duxiu_books",
  };
}

function outputFolderForKeyword(baseOutput, keyword, index) {
  const { rootDir } = splitOutputBase(baseOutput);
  return `${rootDir}/${sanitizeOutputSuffix(keyword, index)}`;
}

function outputForKeyword(baseOutput, keyword, index) {
  const { fileBase } = splitOutputBase(baseOutput);
  return `${outputFolderForKeyword(baseOutput, keyword, index)}/${fileBase}`;
}

function stripGeneratedKeywordOutput(value, items = keywordQueue.items) {
  let normalized = (value || "output/duxiu_books").trim().replace(/\/+$/g, "") || "output/duxiu_books";
  const candidates = items.length ? items : keywordQueue.items;
  for (const [index, item] of candidates.entries()) {
    const suffix = sanitizeOutputSuffix(item.keyword, index);
    const oldSuffix = `_${suffix}`;
    if (normalized.endsWith(oldSuffix)) {
      normalized = normalized.slice(0, -oldSuffix.length);
      break;
    }

    const parts = normalized.split("/");
    if (parts.length >= 3 && parts.at(-2) === suffix) {
      const fileBase = parts.at(-1);
      const root = parts.slice(0, -2).join("/");
      normalized = root && root.split("/").at(-1) === fileBase ? root : root ? `${root}/${fileBase}` : fileBase;
      break;
    }
  }
  return normalized || "output/duxiu_books";
}

function baseOutputFromCurrentValue() {
  const current = ($("output")?.value || keywordQueue.baseOutput || "output/duxiu_books").trim();
  const activeItem = keywordQueue.items[keywordQueue.activeIndex];
  if (!activeItem) return stripGeneratedKeywordOutput(current);
  const currentNormalized = current.replace(/\/+$/g, "");
  const expected = outputForKeyword(keywordQueue.baseOutput, activeItem.keyword, keywordQueue.activeIndex);
  if (currentNormalized === expected) return keywordQueue.baseOutput || "output/duxiu_books";
  return stripGeneratedKeywordOutput(currentNormalized);
}

function setQueueItemStatus(index, status) {
  keywordQueue.items = keywordQueue.items.map((item, itemIndex) => ({
    ...item,
    status: itemIndex === index ? status : item.status === "active" ? "pending" : item.status,
  }));
}

function applyKeywordItem(index) {
  const item = keywordQueue.items[index];
  if (!item) return false;
  const search = $("searchUrl");
  if (search) search.value = item.url;
  const startPage = $("startPage");
  if (startPage) startPage.value = "";
  const output = $("output");
  if (output) {
    output.value = outputForKeyword(keywordQueue.baseOutput, item.keyword, index);
  }
  keywordQueue.activeIndex = index;
  keywordQueue.waiting = false;
  keywordQueue.started = false;
  setQueueItemStatus(index, "active");
  configDirty = true;
  persistConfig();
  persistKeywordQueue();
  renderKeywordQueue();
  return true;
}

function renderKeywordQueue() {
  const badge = $("queueBadge");
  const status = $("keywordQueueStatus");
  const outputPreview = $("keywordOutputPreview");
  const list = $("keywordQueueList");
  const nextBtn = $("keywordNextBtn");
  const continuous = $("keywordContinuous");
  if (continuous) continuous.checked = Boolean(keywordQueue.continuous);

  const total = keywordQueue.items.length;
  const doneCount = keywordQueue.items.filter((item) => item.status === "done").length;
  const activeItem = keywordQueue.items[keywordQueue.activeIndex];
  const hasNext = keywordQueue.activeIndex >= 0 && keywordQueue.activeIndex < total - 1;

  if (badge) badge.textContent = total ? `${doneCount}/${total}` : "未导入";
  if (nextBtn) {
    nextBtn.disabled = keywordQueue.continuous || !(keywordQueue.waiting && hasNext);
    nextBtn.textContent = keywordQueue.continuous && hasNext ? "连续模式中" : hasNext ? "确认进入下一个" : "队列已完成";
  }
  if (status) {
    if (!total) {
      status.textContent = "尚未导入关键词。";
    } else if (keywordQueue.continuous && hasNext) {
      status.textContent = `连续模式已开启，“${activeItem?.keyword || "-"}”完成后会自动进入下一个关键词。`;
    } else if (keywordQueue.waiting && hasNext) {
      status.textContent = `“${activeItem?.keyword || "-"}”已完成。可先修改参数，然后确认载入下一个关键词。`;
    } else if (keywordQueue.waiting) {
      status.textContent = "关键词队列已全部完成。";
    } else if (activeItem) {
      status.textContent = `当前关键词 ${keywordQueue.activeIndex + 1}/${total}：${activeItem.keyword}`;
    } else {
      status.textContent = `关键词队列已导入 ${total} 个。`;
    }
  }
  if (outputPreview) {
    if (activeItem) {
      outputPreview.textContent = `当前输出目录：${outputFolderForKeyword(keywordQueue.baseOutput, activeItem.keyword, keywordQueue.activeIndex)}`;
      outputPreview.classList.remove("hidden");
    } else {
      outputPreview.classList.add("hidden");
    }
  }
  if (!list) return;
  list.innerHTML = keywordQueue.items
    .map((item, index) => {
      const state = item.status || "pending";
      const label = state === "done" ? "完成" : state === "active" ? "当前" : "待处理";
      return `
        <button class="queue-item ${state}" type="button" data-index="${index}" title="${escapeHtml(item.url)}">
          <span>${index + 1}</span>
          <strong>${escapeHtml(item.keyword)}</strong>
          <em>${label}</em>
        </button>
      `;
    })
    .join("");
}

function importKeywordQueue() {
  const items = parseKeywordEntries($("keywordText")?.value || "");
  if (!items.length) {
    showAlert("请先上传或粘贴关键词列表。");
    return;
  }
  const output = stripGeneratedKeywordOutput(readConfig().output || "output/duxiu_books", items);
  keywordQueue = {
    ...emptyKeywordQueue(),
    items,
    baseOutput: output,
    continuous: $("keywordContinuous")?.checked === true,
  };
  applyKeywordItem(0);
  hideAlert();
}

function clearKeywordQueue() {
  keywordQueue = emptyKeywordQueue();
  localStorage.removeItem(QUEUE_KEY);
  const text = $("keywordText");
  if (text) text.value = "";
  renderKeywordQueue();
}

function goToNextKeyword() {
  if (!keywordQueue.waiting) return;
  const nextIndex = keywordQueue.activeIndex + 1;
  keywordQueue.baseOutput = baseOutputFromCurrentValue();
  if (!applyKeywordItem(nextIndex)) return;
  showAlert("已载入下一个关键词。确认参数后点击“启动”。");
}

async function startNextKeywordAutomatically() {
  const nextIndex = keywordQueue.activeIndex + 1;
  if (!applyKeywordItem(nextIndex)) return;
  showAlert(`连续模式：已自动载入“${keywordQueue.items[nextIndex]?.keyword || "下一个关键词"}”并启动。`);
  await startCrawl();
}

function updateKeywordQueueForStatus(status) {
  if (!keywordQueue.items.length || keywordQueue.activeIndex < 0) return;
  if (["starting", "running"].includes(status)) {
    keywordQueue.started = true;
    keywordQueue.waiting = false;
    setQueueItemStatus(keywordQueue.activeIndex, "active");
    persistKeywordQueue();
    renderKeywordQueue();
    return;
  }
  if (status !== "completed" || !keywordQueue.started || keywordQueue.waiting) return;
  setQueueItemStatus(keywordQueue.activeIndex, "done");
  keywordQueue.started = false;
  if (keywordQueue.continuous && keywordQueue.activeIndex < keywordQueue.items.length - 1) {
    persistKeywordQueue();
    renderKeywordQueue();
    startNextKeywordAutomatically();
    return;
  }
  keywordQueue.waiting = true;
  persistKeywordQueue();
  renderKeywordQueue();
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
  $("keywordImportBtn")?.addEventListener("click", importKeywordQueue);
  $("keywordClearBtn")?.addEventListener("click", clearKeywordQueue);
  $("keywordNextBtn")?.addEventListener("click", goToNextKeyword);
  $("keywordContinuous")?.addEventListener("change", () => {
    persistKeywordQueue();
    renderKeywordQueue();
  });
  $("keywordFile")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    $("keywordText").value = await file.text();
    importKeywordQueue();
  });
  $("keywordQueueList")?.addEventListener("click", (event) => {
    const item = event.target.closest(".queue-item");
    if (!item) return;
    if (["starting", "running"].includes(latestStatus)) {
      showAlert("任务运行中，不能切换关键词。");
      return;
    }
    applyKeywordItem(Number(item.dataset.index));
  });
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
  if (keywordQueue.items.length && keywordQueue.activeIndex >= 0) {
    keywordQueue.started = true;
    keywordQueue.waiting = false;
    setQueueItemStatus(keywordQueue.activeIndex, "active");
    persistKeywordQueue();
    renderKeywordQueue();
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
  latestStatus = status;

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
  updateKeywordQueueForStatus(status);

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
renderKeywordQueue();
loadDefaults().then(refreshStatus);
setInterval(refreshStatus, 1500);
}
