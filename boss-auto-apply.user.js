// ==UserScript==
// @name         Boss直聘自动投递助手
// @namespace    https://github.com/muyuniao/boss-auto-apply
// @version      0.1.0
// @description  在 Boss 直聘职位列表页按筛选规则自动批量发起沟通。
// @author       muyuniao
// @license      MIT
// @match        https://www.zhipin.com/web/geek/job*
// @match        https://www.zhipin.com/web/geek/jobs*
// @match        https://www.zhipin.com/web/geek/job-recommend*
// @match        https://www.zhipin.com/web/geek/overseas*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// ==/UserScript==

(() => {
  "use strict";

  const APP_ID = "boss-auto-apply-lite";
  const CONFIG_KEY = `${APP_ID}:config`;
  const HISTORY_KEY = `${APP_ID}:history`;
  const PANEL_ID = `${APP_ID}-panel`;
  const STYLE_ID = `${APP_ID}-style`;
  const VERSION = "0.1.0";

  const DEFAULT_CONFIG = {
    autoNextPage: true,
    fetchDetail: true,
    debug: false,
    skipAppliedHistory: true,
    skipHeadhunter: true,
    onlyOnlineBoss: false,
    treatChatRemindAsSuccess: true,
    maxApplyCount: 9999,
    dailyLimit: 150,
    delayMinSec: 4,
    delayMaxSec: 10,
    pageDelaySec: 3,
    activeWithinDays: 14,
    includeDescriptionKeywords: "",
    excludeDescriptionKeywords: "",
  };

  const SELECTORS = {
    jobCards: [
      ".job-card-wrapper",
      ".job-card-wrap",
      ".job-card-box",
      ".job-list-box .job-card-body",
      ".rec-job-list .job-card-wrapper",
    ],
    scrollContainers: [
      ".job-list-container",
      ".job-list",
      ".recommend-job-list",
      ".job-recommend-result",
      ".recommend-result-inner",
      ".page-job-inner",
    ],
    nextIcon: ".ui-icon-arrow-right",
  };

  const state = {
    running: false,
    stopping: false,
    collapsed: false,
    scanned: 0,
    matched: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    platformRemainingQuota: null,
    current: "未开始",
    logs: [],
    processedKeys: new Set(),
  };

  let config = loadConfig();
  let cachedPanel = null;

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
    } catch (error) {
      console.warn(`[${APP_ID}] GM_getValue failed`, error);
    }

    try {
      const raw = window.localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
        return;
      }
    } catch (error) {
      console.warn(`[${APP_ID}] GM_setValue failed`, error);
    }

    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn(`[${APP_ID}] localStorage set failed`, error);
    }
  }

  function loadConfig() {
    const stored = gmGet(CONFIG_KEY, {});
    return normalizeConfig({ ...DEFAULT_CONFIG, ...(stored || {}) });
  }

  function normalizeConfig(input) {
    const output = { ...DEFAULT_CONFIG, ...(input || {}) };

    // 强行锁死固定参数，忽略存储的旧数据
    output.maxApplyCount = DEFAULT_CONFIG.maxApplyCount;
    output.dailyLimit = DEFAULT_CONFIG.dailyLimit;
    output.delayMinSec = DEFAULT_CONFIG.delayMinSec;
    output.delayMaxSec = DEFAULT_CONFIG.delayMaxSec;
    output.pageDelaySec = DEFAULT_CONFIG.pageDelaySec;
    output.activeWithinDays = DEFAULT_CONFIG.activeWithinDays;

    // 强制锁定默认开启的配置
    output.autoNextPage = true;
    output.fetchDetail = true;
    output.skipAppliedHistory = true;
    output.skipHeadhunter = true;
    output.treatChatRemindAsSuccess = true;

    return output;
  }

  function saveConfig(nextConfig, silent = false) {
    config = normalizeConfig(nextConfig);
    gmSet(CONFIG_KEY, config);
    if (!silent) {
      renderPanel();
    }
  }

  function getToday() {
    const date = new Date();
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function loadHistory() {
    const today = getToday();
    const history = gmGet(HISTORY_KEY, null) || {};
    if (history.date !== today) {
      return { date: today, dailyCount: 0, appliedKeys: [] };
    }
    if (!Array.isArray(history.appliedKeys)) history.appliedKeys = [];
    if (!Number.isFinite(Number(history.dailyCount)))
      history.dailyCount = history.appliedKeys.length;
    return history;
  }

  function saveHistory(history) {
    gmSet(HISTORY_KEY, history);
  }

  function recordApplied(job) {
    const history = loadHistory();
    const key = getJobUniqueKey(job);
    if (!history.appliedKeys.includes(key)) history.appliedKeys.push(key);
    history.dailyCount = Math.max(
      Number(history.dailyCount) || 0,
      history.appliedKeys.length,
    );
    saveHistory(history);
  }

  function hasAppliedToday(job) {
    const history = loadHistory();
    return history.appliedKeys.includes(getJobUniqueKey(job));
  }

  function getCookie(name) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(
      new RegExp(`(?:^|; )${escapedName}=([^;]*)`),
    );
    return match ? decodeURIComponent(match[1]) : "";
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    if (max <= min) return min;
    return min + Math.random() * (max - min);
  }

  async function sleepHumanDelay() {
    const seconds = randomBetween(config.delayMinSec, config.delayMaxSec);
    await sleep(seconds * 1000);
  }

  function isBossJobPage() {
    return /https:\/\/www\.zhipin\.com\/web\/geek\/(job|jobs|job-recommend|overseas)/.test(
      location.href,
    );
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitKeywords(value) {
    return String(value || "")
      .split(/[，,\n;]/)
      .map((item) => normalizeText(item).toLowerCase())
      .filter(Boolean);
  }

  function textHasAny(text, keywords) {
    const normalized = normalizeText(text).toLowerCase();
    return keywords.some((keyword) => normalized.includes(keyword));
  }

  function textHasInclude(text, keywords) {
    if (keywords.length === 0) return true;
    return textHasAny(text, keywords);
  }

  function fuzzyText(job, detail) {
    return [
      job.jobName,
      job.brandName,
      job.salaryDesc,
      job.cityName,
      job.areaDistrict,
      job.businessDistrict,
      job.brandScaleName,
      job.brandIndustry,
      Array.isArray(job.jobLabels) ? job.jobLabels.join(" ") : job.jobLabels,
      Array.isArray(job.skills) ? job.skills.join(" ") : job.skills,
      detail?.postDescription,
      detail?.address,
      detail?.activeTimeDesc,
    ]
      .map(normalizeText)
      .filter(Boolean)
      .join(" ");
  }

  function log(level, message, data) {
    if (level === "debug" && !config.debug) return;
    const time = new Date().toLocaleTimeString();
    const entry = { time, level, message, data };
    state.logs.unshift(entry);
    state.logs = state.logs.slice(0, 120);

    const prefix = `[${APP_ID}] ${message}`;
    if (level === "error") console.error(prefix, data || "");
    else if (level === "warn") console.warn(prefix, data || "");
    else if (level === "debug") console.debug(prefix, data || "");
    else console.log(prefix, data || "");

    renderPanel();
  }

  function notify(title, text) {
    try {
      if (typeof GM_notification === "function") {
        GM_notification({ title, text, timeout: 3500 });
      }
    } catch (error) {
      console.warn(`[${APP_ID}] notification failed`, error);
    }
  }

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      #${PANEL_ID} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        width: 380px;
        max-height: calc(100vh - 36px);
        overflow: hidden;
        border-radius: 14px;
        background: #ffffff;
        color: #1f2937;
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.22), 0 0 0 1px rgba(15, 23, 42, 0.08);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} .aj-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        color: #fff;
        background: linear-gradient(135deg, #00bebd, #12a0a8);
      }
      #${PANEL_ID} .aj-title { font-weight: 700; font-size: 14px; }
      #${PANEL_ID} .aj-subtitle { opacity: .88; font-size: 11px; }
      #${PANEL_ID} .aj-icon-btn {
        border: 0;
        border-radius: 8px;
        padding: 4px 8px;
        cursor: pointer;
        color: #fff;
        background: rgba(255,255,255,.18);
      }
      #${PANEL_ID}.is-collapsed { width: 240px; }
      #${PANEL_ID}.is-collapsed .aj-body { display: none; }
      #${PANEL_ID} .aj-body {
        max-height: calc(100vh - 92px);
        overflow: auto;
        padding: 10px 12px 12px;
      }
      #${PANEL_ID} .aj-status {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 6px;
        margin-bottom: 10px;
      }
      #${PANEL_ID} .aj-stat {
        border-radius: 10px;
        padding: 6px 4px;
        background: #f8fafc;
        text-align: center;
        border: 1px solid #e5e7eb;
      }
      #${PANEL_ID} .aj-stat b { display: block; font-size: 15px; color: #0f766e; }
      #${PANEL_ID} .aj-stat span { font-size: 11px; color: #64748b; }
      #${PANEL_ID} .aj-current {
        margin: 8px 0 10px;
        padding: 7px 9px;
        border-radius: 10px;
        background: #f0fdfa;
        color: #115e59;
        border: 1px solid #ccfbf1;
        word-break: break-word;
      }
      #${PANEL_ID} .aj-form {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      #${PANEL_ID} .aj-field { display: flex; flex-direction: column; gap: 4px; }
      #${PANEL_ID} .aj-field.aj-wide { grid-column: 1 / -1; }
      #${PANEL_ID} label { color: #334155; font-size: 12px; }
      #${PANEL_ID} input[type="text"],
      #${PANEL_ID} input[type="number"],
      #${PANEL_ID} textarea {
        width: 100%;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        padding: 6px 8px;
        outline: none;
        font: inherit;
        background: #fff;
      }
      #${PANEL_ID} textarea { min-height: 42px; resize: vertical; }
      #${PANEL_ID} input:focus,
      #${PANEL_ID} textarea:focus { border-color: #14b8a6; box-shadow: 0 0 0 3px rgba(20,184,166,.14); }
      #${PANEL_ID} .aj-checks {
        grid-column: 1 / -1;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px 8px;
        padding: 8px;
        border-radius: 10px;
        background: #f8fafc;
        border: 1px solid #e5e7eb;
      }
      #${PANEL_ID} .aj-check {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      #${PANEL_ID} .aj-check input { accent-color: #0d9488; }
      #${PANEL_ID} .aj-actions {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 7px;
        margin: 10px 0;
      }
      #${PANEL_ID} .aj-btn {
        border: 0;
        border-radius: 9px;
        padding: 7px 8px;
        cursor: pointer;
        font-weight: 650;
        color: #0f172a;
        background: #e2e8f0;
      }
      #${PANEL_ID} .aj-btn:hover { filter: brightness(.98); }
      #${PANEL_ID} .aj-btn-primary { background: #14b8a6; color: #fff; }
      #${PANEL_ID} .aj-btn-danger { background: #ef4444; color: #fff; }
      #${PANEL_ID} .aj-btn:disabled { opacity: .55; cursor: not-allowed; }
      #${PANEL_ID} .aj-logs {
        max-height: 190px;
        overflow: auto;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        background: #0f172a;
        padding: 8px;
      }
      #${PANEL_ID} .aj-log {
        color: #cbd5e1;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        line-height: 1.45;
        padding: 2px 0;
        white-space: pre-wrap;
        word-break: break-word;
      }
      #${PANEL_ID} .aj-log-success { color: #86efac; }
      #${PANEL_ID} .aj-log-warn { color: #fde68a; }
      #${PANEL_ID} .aj-log-error { color: #fca5a5; }
      #${PANEL_ID} .aj-log-debug { color: #93c5fd; }
    `;

    if (typeof GM_addStyle === "function") {
      GM_addStyle(css);
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function htmlEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderPanel() {
    if (!cachedPanel) return;
    const history = loadHistory();
    cachedPanel.classList.toggle("is-collapsed", state.collapsed);
    const runningText = state.running
      ? state.stopping
        ? "停止中"
        : "运行中"
      : "空闲";
    const quotaText =
      state.platformRemainingQuota == null
        ? ""
        : ` · 平台剩余 ${state.platformRemainingQuota}`;
    const logsHtml = state.logs.length
      ? state.logs
        .map(
          (item) =>
            `<div class="aj-log aj-log-${item.level}">[${htmlEscape(item.time)}] ${htmlEscape(item.message)}</div>`,
        )
        .join("")
      : '<div class="aj-log">暂无日志。点击“开始”按钮进行自动投递。</div>';

    cachedPanel.innerHTML = `
      <div class="aj-header">
        <div>
          <div class="aj-title">Boss 自动投递助手</div>
          <div class="aj-subtitle">v${VERSION} · ${runningText} · 今日已投 ${history.dailyCount}/150${quotaText}</div>
        </div>
        <button class="aj-icon-btn" data-action="toggle-collapse">${state.collapsed ? "展开" : "收起"}</button>
      </div>
      <div class="aj-body">
        <div class="aj-status">
          <div class="aj-stat"><b>${state.scanned}</b><span>扫描</span></div>
          <div class="aj-stat"><b>${state.matched}</b><span>匹配</span></div>
          <div class="aj-stat"><b>${state.applied}</b><span>成功</span></div>
          <div class="aj-stat"><b>${state.skipped}</b><span>跳过</span></div>
          <div class="aj-stat"><b>${state.failed}</b><span>失败</span></div>
        </div>
        <div class="aj-current">当前：${htmlEscape(state.current)}</div>
        <form class="aj-form" data-role="config-form">
          <div class="aj-checks">
            ${checkboxHtml("onlyOnlineBoss", "仅在线 BOSS")}
            ${checkboxHtml("debug", "调试日志")}
          </div>
          ${textAreaHtml("includeDescriptionKeywords", "岗位详情包含关键词")}
          ${textAreaHtml("excludeDescriptionKeywords", "岗位详情排除关键词")}
        </form>
        <div class="aj-actions">
          <button class="aj-btn aj-btn-primary" data-action="start" ${state.running ? "disabled" : ""}>开始</button>
          <button class="aj-btn aj-btn-danger" data-action="stop" ${state.running ? "" : "disabled"}>停止</button>
        </div>
        <div class="aj-logs">${logsHtml}</div>
      </div>
    `;
  }

  function checkboxHtml(name, label) {
    return `<label class="aj-check"><input type="checkbox" name="${name}" ${config[name] ? "checked" : ""}> ${label}</label>`;
  }

  function textAreaHtml(name, label) {
    return `
      <div class="aj-field aj-wide">
        <label>${label}</label>
        <textarea name="${name}">${htmlEscape(config[name])}</textarea>
      </div>
    `;
  }

  function collectFormConfig() {
    const form = cachedPanel?.querySelector('[data-role="config-form"]');
    if (!form) return config;
    const next = { ...config };
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      const field = form.elements.namedItem(key);
      if (!field) continue;
      if (field instanceof HTMLInputElement && field.type === "checkbox") {
        next[key] = field.checked;
      } else if (field instanceof HTMLInputElement && field.type === "number") {
        next[key] = Number(field.value);
      } else if (
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLInputElement
      ) {
        next[key] = field.value;
      }
    }
    return normalizeConfig(next);
  }

  function mountPanel() {
    if (!document.body || cachedPanel) return;
    addStyles();
    cachedPanel = document.createElement("div");
    cachedPanel.id = PANEL_ID;
    document.body.appendChild(cachedPanel);
    cachedPanel.addEventListener("click", handlePanelClick);
    cachedPanel.addEventListener("input", handleFormInput);
    cachedPanel.addEventListener("change", handleFormInput);
    renderPanel();
  }

  function handleFormInput(event) {
    const form = cachedPanel?.querySelector('[data-role="config-form"]');
    if (!form || !form.contains(event.target)) return;
    saveConfig(collectFormConfig(), true);
  }

  function handlePanelClick(event) {
    const target =
      event.target instanceof Element
        ? event.target.closest("[data-action]")
        : null;
    if (!target) return;
    event.preventDefault();
    const action = target.getAttribute("data-action");

    if (action === "toggle-collapse") {
      state.collapsed = !state.collapsed;
      renderPanel();
      return;
    }

    if (action === "start") {
      saveConfig(collectFormConfig());
      startApply().catch((error) => {
        state.running = false;
        state.stopping = false;
        state.current = "异常停止";
        log("error", `运行异常：${error.message || error}`, error);
      });
      return;
    }

    if (action === "stop") {
      stopApply();
      return;
    }

  }

  function canApplyFieldsReady(job) {
    return Boolean(job?.securityId && job?.encryptJobId && job?.lid);
  }

  function resetRunCounters() {
    state.scanned = 0;
    state.matched = 0;
    state.applied = 0;
    state.skipped = 0;
    state.failed = 0;
    state.platformRemainingQuota = null;
    state.current = "准备开始";
    state.processedKeys = new Set();
  }

  async function startApply() {
    if (state.running) return;
    if (!isBossJobPage()) {
      log(
        "warn",
        "请先打开 Boss 直聘职位列表页面，例如 https://www.zhipin.com/web/geek/job",
      );
      return;
    }

    const token = getCookie("bst");
    if (!token) {
      log("error", "未读取到登录 token。请先在浏览器里自行登录 Boss 直聘。");
      return;
    }

    const history = loadHistory();
    if (history.dailyCount >= config.dailyLimit) {
      log("warn", "已达每日上限");
      return;
    }

    state.running = true;
    state.stopping = false;
    resetRunCounters();
    log("success", "开始自动投递");

    try {
      await runApplyLoop();
    } finally {
      state.running = false;
      state.stopping = false;
      state.current = state.current || "已结束";
      log(
        "success",
        `任务结束：扫描 ${state.scanned}，匹配 ${state.matched}，成功 ${state.applied}，跳过 ${state.skipped}，失败 ${state.failed}`,
      );
      notify(
        "Boss 自动投递助手",
        `任务结束：成功 ${state.applied} 条`,
      );
      renderPanel();
    }
  }

  function stopApply() {
    if (!state.running) return;
    state.stopping = true;
    state.current = "正在停止，等待当前请求结束";
    log("warn", "已请求停止");
    renderPanel();
  }

  async function runApplyLoop() {
    let pageRound = 1;

    while (!state.stopping) {
      state.current = `读取第 ${pageRound} 页职位`;
      renderPanel();
      const jobs = await collectJobsWithWait();
      if (jobs.length === 0) {
        log("warn", "当前页未找到可读取的职位卡片。");
      }

      for (const job of jobs) {
        if (state.stopping) break;
        if (state.applied >= config.maxApplyCount) {
          state.current = "达到单次上限";
          return;
        }

        const history = loadHistory();
        if (history.dailyCount >= config.dailyLimit) {
          state.current = "已达每日上限";
          log("warn", "已达每日上限");
          return;
        }

        await handleOneJob(job);
      }

      if (state.stopping) break;
      if (state.applied >= config.maxApplyCount) {
        state.current = "达到单次上限";
        return;
      }
      if (!config.autoNextPage) {
        state.current = "当前页处理完成（未开启自动翻页）";
        return;
      }

      const moved = await goNextPageOrScroll();
      if (!moved) {
        state.current = "没有更多职位";
        return;
      }

      pageRound += 1;
      await sleep(config.pageDelaySec * 1000);
    }

    state.current = "已手动停止";
  }

  async function collectJobsWithWait() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const cards = getJobCardElements();
      if (cards.length > 0) {
        const jobs = cards
          .map((card, index) => buildJobDetail(card, index))
          .filter(Boolean);
        return dedupeJobs(jobs).filter(
          (job) => !state.processedKeys.has(getJobUniqueKey(job)),
        );
      }
      await sleep(500);
    }
    return [];
  }

  function getJobCardElements() {
    const rawElements = [];
    const seen = new Set();
    for (const selector of SELECTORS.jobCards) {
      for (const item of document.querySelectorAll(selector)) {
        if (!seen.has(item)) {
          seen.add(item);
          rawElements.push(item);
        }
      }
    }

    const result = [];
    for (const item of rawElements) {
      const isDescendant = rawElements.some(
        (other) => other !== item && other.contains(item),
      );
      if (!isDescendant) {
        result.push(item);
      }
    }
    return result;
  }

  function dedupeJobs(jobs) {
    const result = [];
    const seen = new Set();
    for (const job of jobs) {
      const key = getJobUniqueKey(job);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(job);
    }
    return result;
  }

  function getJobUniqueKey(job) {
    return [
      job.securityId,
      job.encryptJobId,
      job.lid,
      job.jobName,
      job.brandName,
    ]
      .map((item) => normalizeText(item))
      .join("|");
  }

  async function handleOneJob(job) {
    const key = getJobUniqueKey(job);
    state.processedKeys.add(key);
    state.scanned += 1;
    state.current = formatJob(job);
    renderPanel();

    try {
      const detail = config.fetchDetail ? await safeFetchJobDetail(job) : null;
      const filter = applyFilters(job, detail);
      if (!filter.ok) {
        state.skipped += 1;
        log("warn", `跳过【${formatJob(job)}】：${filter.reason}`);
        return;
      }

      state.matched += 1;

      const result = await applyJob(job);
      if (result.ok) {
        state.applied += 1;
        recordApplied(job);
        if (Number.isFinite(result.remainingQuota)) {
          state.platformRemainingQuota = result.remainingQuota;
        }
        if (result.softSuccess) {
          const quotaNote = Number.isFinite(result.remainingQuota)
            ? `（平台剩余 ${result.remainingQuota} 次）`
            : "";
          log(
            "success",
            `投递成功${quotaNote}【${formatJob(job)}】：${result.message}`,
          );
        } else {
          log("success", `投递成功【${formatJob(job)}】`);
        }
        if (
          Number.isFinite(result.remainingQuota) &&
          result.remainingQuota <= 3
        ) {
          log(
            "warn",
            `平台沟通机会仅剩 ${result.remainingQuota} 次`,
          );
        }
      } else if (result.limited) {
        state.failed += 1;
        log(
          "error",
          `平台限制或需人工处理【${formatJob(job)}】：${result.message}`,
        );
        state.current = result.message || "平台限制";
        state.stopping = true;
        return;
      } else {
        state.failed += 1;
        log("error", `投递失败【${formatJob(job)}】：${result.message}`);
      }

      await sleepHumanDelay();
    } catch (error) {
      state.failed += 1;
      log(
        "error",
        `处理失败【${formatJob(job)}】：${error.message || error}`,
        error,
      );
      await sleepHumanDelay();
    } finally {
      renderPanel();
    }
  }

  function buildJobDetail(card, index) {
    const raw = pickJobData(card) || {};
    const text = normalizeText(card.innerText || card.textContent || "");
    const jobName =
      pickFirstString(raw, ["jobName", "jobTitle", "title", "positionName"]) ||
      pickDomText(card, [
        ".job-name",
        ".job-title",
        ".job-card-left .job-name",
      ]);
    const brandName =
      pickFirstString(raw, [
        "brandName",
        "companyName",
        "brandFullName",
        "companyFullName",
      ]) ||
      pickDomText(card, [
        ".company-name",
        ".company-text .name",
        ".company-info .name",
      ]);
    const salaryDesc =
      pickFirstString(raw, ["salaryDesc", "salary", "salaryName"]) ||
      pickDomText(card, [".salary", ".job-salary", ".salary-desc"]);

    const job = {
      index,
      card,
      raw,
      rawText: text,
      securityId: pickFirstString(raw, ["securityId", "securityID"]),
      encryptJobId: pickFirstString(raw, [
        "encryptJobId",
        "jobId",
        "encryptJobID",
      ]),
      lid: pickFirstString(raw, ["lid", "listId"]),
      encryptBossId: pickFirstString(raw, [
        "encryptBossId",
        "bossId",
        "encryptBossID",
      ]),
      jobName,
      brandName,
      salaryDesc,
      cityName: pickFirstString(raw, ["cityName", "city"]),
      areaDistrict: pickFirstString(raw, [
        "areaDistrict",
        "districtName",
        "area",
      ]),
      businessDistrict: pickFirstString(raw, [
        "businessDistrict",
        "businessArea",
      ]),
      brandScaleName: pickFirstString(raw, [
        "brandScaleName",
        "companyScaleName",
        "scaleName",
      ]),
      brandIndustry: pickFirstString(raw, ["brandIndustry", "industryName"]),
      jobLabels: raw.jobLabels || raw.labels || raw.skills || [],
      skills: raw.skills || [],
      contact: Boolean(
        raw.contact ||
        raw.friendStatus === 1 ||
        raw.friendStatus === "1" ||
        /已沟通|继续沟通/.test(text),
      ),
      bossOnline: pickBoolean(raw, ["bossOnline", "online", "isOnline"]),
      goldHunter: raw.goldHunter,
    };

    if (!job.jobName && !job.brandName && !job.securityId) return null;
    return job;
  }

  function pickDomText(root, selectors) {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const text = normalizeText(
        element?.innerText || element?.textContent || "",
      );
      if (text) return text;
    }
    return "";
  }

  function pickFirstString(obj, keys) {
    for (const key of keys) {
      const value = getDeepValue(obj, key);
      if (value !== undefined && value !== null && String(value).trim() !== "")
        return String(value).trim();
    }
    return "";
  }

  function pickBoolean(obj, keys) {
    for (const key of keys) {
      const value = getDeepValue(obj, key);
      if (typeof value === "boolean") return value;
      if (value === 0 || value === 1) return Boolean(value);
      if (value === "true") return true;
      if (value === "false") return false;
    }
    return undefined;
  }

  function getDeepValue(obj, wantedKey) {
    if (!obj || typeof obj !== "object") return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, wantedKey))
      return obj[wantedKey];

    const queue = [obj];
    const seen = new WeakSet();
    let depthGuard = 0;
    while (queue.length && depthGuard < 120) {
      depthGuard += 1;
      const current = queue.shift();
      if (!current || typeof current !== "object" || seen.has(current))
        continue;
      seen.add(current);
      if (Object.prototype.hasOwnProperty.call(current, wantedKey))
        return current[wantedKey];
      for (const value of Object.values(current).slice(0, 40)) {
        if (value && typeof value === "object") queue.push(value);
      }
    }
    return undefined;
  }

  function pickJobData(card) {
    const candidates = [];
    const directKeys = [
      "__vue__",
      "__vue_app__",
      "__vueParentComponent",
      "_vnode",
    ];

    for (const key of directKeys) {
      if (card[key]) candidates.push(card[key]);
    }

    if (card.__vue__) {
      candidates.push(
        card.__vue__.data,
        card.__vue__._data,
        card.__vue__._props,
        card.__vue__.$props,
      );
    }
    if (card.__vueParentComponent) {
      candidates.push(
        card.__vueParentComponent.props,
        card.__vueParentComponent.ctx,
        card.__vueParentComponent.setupState,
        card.__vueParentComponent.proxy,
      );
    }

    const found = findJobLikeObject(candidates);
    return found || null;
  }

  function findJobLikeObject(seedList) {
    const queue = seedList
      .filter(Boolean)
      .map((value) => ({ value, depth: 0 }));
    const seen = new WeakSet();

    while (queue.length) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);

      if (looksLikeJobData(value)) return value;
      if (depth >= 4) continue;

      const values = Object.values(value).slice(0, 80);
      for (const child of values) {
        if (child && typeof child === "object")
          queue.push({ value: child, depth: depth + 1 });
      }
    }
    return null;
  }

  function looksLikeJobData(obj) {
    if (!obj || typeof obj !== "object") return false;
    const hasApplyFields = Boolean(
      (obj.securityId || obj.securityID) &&
      (obj.encryptJobId || obj.jobId) &&
      obj.lid,
    );
    const hasJobText = Boolean(
      obj.jobName ||
      obj.jobTitle ||
      obj.title ||
      obj.brandName ||
      obj.companyName,
    );
    return hasApplyFields || (hasJobText && Boolean(obj.securityId || obj.lid));
  }

  async function safeFetchJobDetail(job) {
    if (!job.securityId || !job.lid) {
      log("debug", `缺少详情字段，跳过详情请求：${formatJob(job)}`);
      return null;
    }

    try {
      const detail = await fetchJobDetail(job);
      return detail;
    } catch (error) {
      log(
        "warn",
        `获取详情失败，继续使用基础信息过滤【${formatJob(job)}】：${error.message || error}`,
      );
      return null;
    }
  }

  async function fetchJobDetail(job) {
    const params = new URLSearchParams({
      lid: job.lid,
      securityId: job.securityId,
      sessionId: "",
    });
    const response = await fetch(
      `/wapi/zpgeek/job/card.json?${params.toString()}`,
      {
        method: "GET",
        credentials: "include",
        headers: buildBossHeaders(),
      },
    );
    const data = await parseResponse(response);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (
      data &&
      typeof data === "object" &&
      data.code !== undefined &&
      data.code !== 0
    ) {
      throw new Error(data.message || `接口返回 code=${data.code}`);
    }

    return data?.zpData?.jobCard || data?.zpData || data?.data || null;
  }

  function applyFilters(job, detail) {
    if (!canApplyFieldsReady(job)) {
      return {
        ok: false,
        reason: "缺少 securityId / encryptJobId / lid，无法调用投递接口",
      };
    }

    if (job.contact) return { ok: false, reason: "已经沟通过" };

    if (config.skipAppliedHistory && hasAppliedToday(job)) {
      return { ok: false, reason: "今日历史中已投递" };
    }

    if (
      config.skipHeadhunter &&
      (job.goldHunter === 1 ||
        job.goldHunter === "1" ||
        /猎头/.test(job.rawText))
    ) {
      return { ok: false, reason: "过滤猎头" };
    }

    if (config.onlyOnlineBoss) {
      const canConfirmOnline =
        job.bossOnline === true || /在线/.test(job.rawText);
      if (!canConfirmOnline) return { ok: false, reason: "无法确认 BOSS 在线" };
    }

    if (config.activeWithinDays > 0 && detail?.activeTimeDesc) {
      const activeDays = parseActiveDays(detail.activeTimeDesc);
      if (Number.isFinite(activeDays) && activeDays > config.activeWithinDays) {
        return {
          ok: false,
          reason: "boss活跃度未达标,已过滤",
        };
      }
    }

    const includeDesc = splitKeywords(config.includeDescriptionKeywords);
    const excludeDesc = splitKeywords(config.excludeDescriptionKeywords);
    if (includeDesc.length || excludeDesc.length) {
      const text = fuzzyText(job, detail);
      if (!textHasInclude(text, includeDesc))
        return { ok: false, reason: "岗位详情不包含指定关键词" };
      if (excludeDesc.length && textHasAny(text, excludeDesc))
        return { ok: false, reason: "岗位详情命中排除关键词" };
    }

    if (detail?.friendStatus === 1 || detail?.friendStatus === "1") {
      return { ok: false, reason: "详情接口显示已沟通" };
    }

    return { ok: true, reason: "" };
  }

  function parseActiveDays(value) {
    const text = String(value || "");
    if (!text || /刚刚|今日|今天|当前|在线|分钟|小时/.test(text)) return 0;

    let match = text.match(/(\d+)\s*日/);
    if (match) return Number(match[1]);

    match = text.match(/(\d+)\s*天/);
    if (match) return Number(match[1]);

    match = text.match(/(\d+)\s*周/);
    if (match) return Number(match[1]) * 7;

    match = text.match(/(\d+)\s*月/);
    if (match) return Number(match[1]) * 30;

    match = text.match(/(\d+)\s*年/);
    if (match) return Number(match[1]) * 365;

    if (/周/.test(text)) return 7;
    if (/月/.test(text)) return 30;
    if (/年/.test(text)) return 365;
    return Number.POSITIVE_INFINITY;
  }

  async function applyJob(job) {
    const params = new URLSearchParams({
      securityId: job.securityId,
      jobId: job.encryptJobId,
      lid: job.lid,
    });

    const response = await fetch(
      `/wapi/zpgeek/friend/add.json?${params.toString()}`,
      {
        method: "POST",
        credentials: "include",
        headers: buildBossHeaders(),
      },
    );
    const data = await parseResponse(response);
    debugBossResponse(job, response, data);

    if (!response.ok) {
      return {
        ok: false,
        limited: response.status === 403 || response.status === 429,
        message: `HTTP ${response.status}`,
        raw: data,
      };
    }

    const message = extractBossMessage(data);
    const chatRemindDialog = getChatRemindDialog(data);
    const chatRemindText = chatRemindDialog
      ? dialogToText(chatRemindDialog)
      : "";
    const fullMessage = normalizeText(
      [message, chatRemindText].filter(Boolean).join("；"),
    );
    const remainingQuota = parseRemainingQuota(fullMessage);

    if (
      data?.code === 0 ||
      data?.message === "Success" ||
      message === "Success"
    ) {
      return {
        ok: true,
        message: message || "Success",
        remainingQuota,
        raw: data,
      };
    }

    const limited = isHardLimitMessage(fullMessage);
    const isChatRemind =
      Boolean(chatRemindDialog) || /开聊提醒/.test(fullMessage);
    if (isChatRemind && !limited && config.treatChatRemindAsSuccess) {
      return {
        ok: true,
        softSuccess: true,
        message: chatRemindText || message || "开聊提醒",
        remainingQuota,
        raw: data,
      };
    }

    return {
      ok: false,
      limited,
      message: fullMessage || `接口返回 code=${data?.code}`,
      raw: data,
    };
  }

  function buildBossHeaders() {
    const token = getCookie("bst");
    const headers = {
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
    };
    if (token) headers.Zp_token = token;
    return headers;
  }

  async function parseResponse(response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      return { code: response.ok ? 0 : response.status, message: text };
    }
  }

  function extractBossMessage(data) {
    if (!data) return "";
    const dialogText = dialogToText(getChatRemindDialog(data));
    return normalizeText(
      dialogText ||
      data.message ||
      data.msg ||
      data?.zpData?.message ||
      data?.zpData?.bizData?.toast ||
      data?.zpData?.toast ||
      "",
    );
  }

  function getChatRemindDialog(data) {
    if (!data || typeof data !== "object") return null;
    return (
      data?.zpData?.bizData?.chatRemindDialog ||
      data?.zpData?.chatRemindDialog ||
      data?.chatRemindDialog ||
      null
    );
  }

  function dialogToText(dialog) {
    if (!dialog || typeof dialog !== "object") return "";
    const values = [];
    const visit = (value, depth = 0) => {
      if (value == null || depth > 3) return;
      if (typeof value === "string" || typeof value === "number") {
        const text = normalizeText(value);
        if (text) values.push(text);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, depth + 1));
        return;
      }
      if (typeof value === "object") {
        for (const key of [
          "title",
          "content",
          "subTitle",
          "desc",
          "text",
          "buttonText",
          "confirmText",
          "cancelText",
        ]) {
          if (Object.prototype.hasOwnProperty.call(value, key))
            visit(value[key], depth + 1);
        }
      }
    };
    visit(dialog);
    return [...new Set(values)].join("；");
  }

  function parseRemainingQuota(message) {
    const text = normalizeText(message || "");
    const match = text.match(/(?:还剩|剩余)\s*(\d+)\s*次/);
    return match ? Number(match[1]) : null;
  }

  function isHardLimitMessage(message) {
    const text = message || "";
    const remainingQuota = parseRemainingQuota(text);
    if (remainingQuota === 0) return true;
    return /上限|今日沟通人数已达|频繁|验证|验证码|登录|失效|安全|风控|异常|稍后|暂时无法|账号/.test(
      text,
    );
  }

  function debugBossResponse(job, response, data) {
    const message = extractBossMessage(data);
    if (
      !config.debug &&
      response.ok &&
      (data?.code === 0 || message === "Success")
    )
      return;
    console.groupCollapsed(
      `[${APP_ID}] 投递接口响应 ${response.status} ${data?.code ?? ""} ${formatJob(job)}`,
    );
    console.log("message:", message);
    console.log("chatRemindDialog:", getChatRemindDialog(data));
    console.log("raw:", data);
    console.groupEnd();
  }

  function formatJob(job) {
    const title = normalizeText(job?.jobName) || "未知职位";
    const company = normalizeText(job?.brandName) || "未知公司";
    const salary = normalizeText(job?.salaryDesc);
    return `${title} - ${company}${salary ? ` - ${salary}` : ""}`;
  }

  async function goNextPageOrScroll() {
    const scrollContainer = SELECTORS.scrollContainers
      .map((selector) => document.querySelector(selector))
      .find(Boolean);
    if (scrollContainer) {
      const before = scrollContainer.scrollTop + scrollContainer.clientHeight;
      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior: "smooth",
      });
      await sleep(1000);
      const after = scrollContainer.scrollTop + scrollContainer.clientHeight;
      if (after > before + 20) {
        log("debug", "已滚动职位列表加载更多");
        return true;
      }
    }

    const pageBefore = window.scrollY + window.innerHeight;
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "smooth",
    });
    await sleep(1000);
    const pageAfter = window.scrollY + window.innerHeight;
    if (pageAfter > pageBefore + 20) {
      log("debug", "已滚动页面加载更多");
      return true;
    }

    const nextIcon = document.querySelector(SELECTORS.nextIcon);
    const nextButton =
      nextIcon?.closest("button, a, li, .btn, .page-next") ||
      nextIcon?.parentElement;
    if (
      nextButton &&
      !/disabled|disable/.test(nextButton.className || "") &&
      nextButton.getAttribute("aria-disabled") !== "true"
    ) {
      nextButton.click();
      log("debug", "已点击下一页");
      return true;
    }

    return false;
  }

  function registerMenuCommands() {
    try {
      if (typeof GM_registerMenuCommand !== "function") return;
      GM_registerMenuCommand("显示/隐藏 Boss 自动投递面板", () => {
        if (!cachedPanel) mountPanel();
        state.collapsed = !state.collapsed;
        renderPanel();
      });
      GM_registerMenuCommand("停止 Boss 自动投递", stopApply);
    } catch (error) {
      console.warn(`[${APP_ID}] register menu failed`, error);
    }
  }

  function installRouteWatcher() {
    const rerender = () =>
      window.setTimeout(() => {
        if (isBossJobPage()) mountPanel();
      }, 500);

    const rawPushState = history.pushState;
    history.pushState = function patchedPushState(...args) {
      const result = rawPushState.apply(this, args);
      rerender();
      return result;
    };

    const rawReplaceState = history.replaceState;
    history.replaceState = function patchedReplaceState(...args) {
      const result = rawReplaceState.apply(this, args);
      rerender();
      return result;
    };

    window.addEventListener("popstate", rerender);
  }

  function bootstrap() {
    if (!isBossJobPage()) return;
    mountPanel();
    registerMenuCommands();
    installRouteWatcher();
    log("success", "脚本已加载。");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
