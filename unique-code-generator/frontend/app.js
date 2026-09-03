"use strict";

/* ============================================================
   Constants & shared helpers
   ============================================================ */

const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || "";
const CHUNK_SIZE = 500; // codes per network request, for progress + to avoid huge single requests
const DB_NAME = "unique-code-generator";
const DB_STORE = "history";

const PRESETS = {
  numbers: "0123456789",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lower: "abcdefghijklmnopqrstuvwxyz",
  upperNumbers: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  lowerNumbers: "abcdefghijklmnopqrstuvwxyz0123456789",
  upperLowerNumbers:
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
};

const CONFUSING = new Set(["O", "0", "I", "1", "L", "l", "o"]);

function $(id) { return document.getElementById(id); }

/* ============================================================
   Client-side charset / pattern helpers (mirrors worker logic
   for the PREVIEW ONLY — the server re-validates everything and
   is the sole source of truth for actual generation).
   ============================================================ */

function resolveCharsetClient({ preset, custom, excludeConfusing }) {
  let raw = "";
  if (preset && preset !== "custom" && PRESETS[preset]) raw += PRESETS[preset];
  if (custom) raw += custom;
  if (!raw) return { ok: false, error: "Please select at least one character." };

  const seen = new Set();
  let deduped = "";
  for (const ch of raw) {
    if (!seen.has(ch)) { seen.add(ch); deduped += ch; }
  }
  if (excludeConfusing) {
    deduped = [...deduped].filter((ch) => !CONFUSING.has(ch)).join("");
  }
  if (!deduped) return { ok: false, error: "Please select at least one character." };
  return { ok: true, charset: deduped };
}

function buildTemplateClient({ prefix, postfix, pattern, length }) {
  const tokens = [];
  for (const ch of prefix || "") tokens.push({ literal: ch });

  if (pattern) {
    if (!pattern.includes("#")) {
      return { ok: false, error: "Please enter a valid pattern containing at least one # placeholder." };
    }
    for (const ch of pattern) tokens.push(ch === "#" ? { random: true } : { literal: ch });
  } else {
    const len = Number(length);
    if (!Number.isInteger(len) || len < 1) {
      return { ok: false, error: "Please enter a valid code length." };
    }
    for (let i = 0; i < len; i++) tokens.push({ random: true });
  }

  for (const ch of postfix || "") tokens.push({ literal: ch });

  const randomPositions = tokens.filter((t) => t.random).length;
  if (randomPositions === 0) {
    return { ok: false, error: "Please enter a valid pattern containing at least one # placeholder." };
  }
  return { ok: true, tokens, randomPositions };
}

function randomIndexInsecurePreviewOnly(max) {
  // Preview-only convenience randomness. Never used for anything reserved —
  // actual codes always come from the worker's crypto.getRandomValues path.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

function renderPreviewCode(tokens, charset) {
  let out = "";
  for (const t of tokens) {
    out += t.random ? charset[randomIndexInsecurePreviewOnly(charset.length)] : t.literal;
  }
  return out;
}

function computeCapacity(charsetSize, randomPositions) {
  let capacity = 1n;
  const base = BigInt(charsetSize);
  const cap = 10n ** 15n;
  for (let i = 0; i < randomPositions; i++) {
    capacity *= base;
    if (capacity > cap) return { value: cap, uncapped: true };
  }
  return { value: capacity, uncapped: false };
}

/* ============================================================
   State + settings reading
   ============================================================ */

function readSettings() {
  return {
    quantity: $("quantity").value,
    length: $("length").value,
    prefix: $("prefix").value,
    postfix: $("postfix").value,
    pattern: $("pattern").value.trim(),
    charsetPreset: $("charset-preset").value,
    customCharset: $("custom-charset").value,
    excludeConfusing: $("exclude-confusing").checked,
  };
}

function setSettingsError(message) {
  const el = $("settings-error");
  if (!message) {
    el.hidden = true;
    el.textContent = "";
  } else {
    el.hidden = false;
    el.textContent = message;
  }
}

/* ============================================================
   Preview + capacity note
   ============================================================ */

function updatePreview() {
  const settings = readSettings();
  const charsetResult = resolveCharsetClient({
    preset: settings.charsetPreset,
    custom: settings.customCharset,
    excludeConfusing: settings.excludeConfusing,
  });

  const templateResult = buildTemplateClient(settings);

  const capacityNote = $("capacity-note");

  if (!charsetResult.ok) {
    setSettingsError(charsetResult.error);
    $("preview-code").textContent = "—";
    capacityNote.textContent = "";
    return;
  }
  if (!templateResult.ok) {
    setSettingsError(templateResult.error);
    $("preview-code").textContent = "—";
    capacityNote.textContent = "";
    return;
  }

  setSettingsError(null);
  $("preview-code").textContent = renderPreviewCode(templateResult.tokens, charsetResult.charset);

  const { value: capacity, uncapped } = computeCapacity(
    charsetResult.charset.length,
    templateResult.randomPositions
  );
  capacityNote.textContent = uncapped
    ? `Combination space: 10\u00B9\u2075+ possible codes for this configuration.`
    : `Combination space: ${capacity.toLocaleString()} possible codes for this configuration.`;
}

function updateGenerateButtonLabel() {
  const qty = Number($("quantity").value);
  const btn = $("generate-btn");
  if (!Number.isInteger(qty) || qty < 1) {
    btn.textContent = "Generate Codes";
    return;
  }
  const label = qty === 1 ? "Generate 1 Code" : `Generate ${qty.toLocaleString()} Codes`;
  btn.textContent = label;
}

function onSettingsChanged() {
  updateGenerateButtonLabel();
  updatePreview();
  $("custom-charset-field").hidden = $("charset-preset").value !== "custom";
}

/* ============================================================
   Online / offline handling
   ============================================================ */

function updateOnlineStatus() {
  const banner = $("offline-banner");
  const online = navigator.onLine;
  banner.hidden = online;
  $("generate-btn").disabled = !online;
}

/* ============================================================
   IndexedDB local history (cache only — never authoritative)
   ============================================================ */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        const store = db.createObjectStore(DB_STORE, { keyPath: "code" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveCodesToHistory(codes, requestId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const createdAt = new Date().toISOString();
    for (const code of codes) {
      store.put({ code, requestId, createdAt });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadAllHistory() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const index = store.index("createdAt");
    const items = [];
    const cursorReq = index.openCursor(null, "prev"); // newest first
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        items.push(cursor.value);
        cursor.continue();
      } else {
        resolve(items);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

async function clearAllHistory() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ============================================================
   Toast
   ============================================================ */

let toastTimer = null;
function showToast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("toast--visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("toast--visible"), 2200);
}

/* ============================================================
   Clipboard / export helpers
   ============================================================ */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older/unsupported contexts.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    document.body.removeChild(ta);
    return ok;
  }
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function toCsv(codes) {
  const header = "code\n";
  const rows = codes.map((c) => `"${c.replace(/"/g, '""')}"`).join("\n");
  return header + rows;
}

/* ============================================================
   Generic code-list rendering (shared by results + history)
   ============================================================ */

function renderCodeList(listEl, codes, { emptyEl } = {}) {
  listEl.innerHTML = "";
  if (emptyEl) emptyEl.hidden = codes.length > 0;

  for (const code of codes) {
    const li = document.createElement("li");
    li.className = "code-list__item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "code-list__checkbox";
    checkbox.value = code;

    const span = document.createElement("span");
    span.className = "code-list__code";
    span.textContent = code;

    const copyBtn = document.createElement("button");
    copyBtn.className = "code-list__copy";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(code);
      showToast(ok ? "Copied" : "Copy failed");
    });

    li.appendChild(checkbox);
    li.appendChild(span);
    li.appendChild(copyBtn);
    listEl.appendChild(li);
  }
}

function getCheckedCodes(listEl) {
  return [...listEl.querySelectorAll(".code-list__checkbox:checked")].map((cb) => cb.value);
}

function getAllCodes(listEl) {
  return [...listEl.querySelectorAll(".code-list__checkbox")].map((cb) => cb.value);
}

/* ============================================================
   Results state
   ============================================================ */

let lastResults = [];

function showResults(codes) {
  lastResults = codes;
  $("results-section").hidden = codes.length === 0;
  $("results-count").textContent = `${codes.length.toLocaleString()} code${codes.length === 1 ? "" : "s"}`;
  renderCodeList($("results-list"), codes);
  $("select-all-results").checked = false;
}

/* ============================================================
   History rendering
   ============================================================ */

let allHistoryItems = [];

async function refreshHistory() {
  allHistoryItems = await loadAllHistory();
  applyHistoryFilter();
}

function applyHistoryFilter() {
  const query = $("history-search").value.trim().toLowerCase();
  const filtered = query
    ? allHistoryItems.filter((item) => item.code.toLowerCase().includes(query))
    : allHistoryItems;
  renderCodeList(
    $("history-list"),
    filtered.map((i) => i.code),
    { emptyEl: $("history-empty") }
  );
  $("select-all-history").checked = false;
}

/* ============================================================
   Generation flow
   ============================================================ */

function setProgress(current, total) {
  const wrap = $("progress");
  wrap.hidden = false;
  $("progress-fill").style.width = `${Math.min(100, (current / total) * 100)}%`;
  $("progress-label").textContent = `Generating unique codes…  ${current.toLocaleString()} / ${total.toLocaleString()}`;
}

function hideProgress() {
  $("progress").hidden = true;
}

async function requestChunk(payload) {
  const res = await fetch(`${API_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("Unable to generate codes right now. Please try again.");
  }

  if (!res.ok && res.status !== 206) {
    throw new Error(data.error || "Unable to generate codes right now. Please try again.");
  }

  return data; // may include { codes, error } together on 206 partial
}

async function handleGenerateClick() {
  if (!navigator.onLine) {
    setSettingsError("You're offline. Connect to the internet to generate globally unique codes.");
    return;
  }

  const settings = readSettings();

  const charsetResult = resolveCharsetClient({
    preset: settings.charsetPreset,
    custom: settings.customCharset,
    excludeConfusing: settings.excludeConfusing,
  });
  if (!charsetResult.ok) { setSettingsError(charsetResult.error); return; }

  const templateResult = buildTemplateClient(settings);
  if (!templateResult.ok) { setSettingsError(templateResult.error); return; }

  const qty = Number(settings.quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    setSettingsError("Please enter a valid number of codes.");
    return;
  }

  setSettingsError(null);
  const btn = $("generate-btn");
  btn.disabled = true;
  showResults([]);

  const collected = [];
  let partialError = null;

  try {
    let remaining = qty;
    setProgress(0, qty);

    while (remaining > 0) {
      const chunkQty = Math.min(CHUNK_SIZE, remaining);

      const payload = {
        quantity: chunkQty,
        length: settings.length,
        prefix: settings.prefix,
        postfix: settings.postfix,
        pattern: settings.pattern,
        charsetPreset: settings.charsetPreset,
        customCharset: settings.customCharset,
        excludeConfusing: settings.excludeConfusing,
      };

      const data = await requestChunk(payload);

      if (Array.isArray(data.codes) && data.codes.length) {
        collected.push(...data.codes);
        await saveCodesToHistory(data.codes, data.requestId);
        setProgress(collected.length, qty);
      }

      if (data.error) {
        partialError = data.error;
        break; // stop chunking further if the server signalled it can't keep up
      }

      remaining = qty - collected.length;
      if (!data.codes || data.codes.length === 0) break; // safety: avoid infinite loop
    }
  } catch (err) {
    partialError = err.message || "Unable to generate codes right now. Please try again.";
  }

  hideProgress();
  btn.disabled = false;

  if (collected.length) {
    showResults(collected);
    await refreshHistory();
    showToast(`Reserved ${collected.length.toLocaleString()} code${collected.length === 1 ? "" : "s"}`);
  }

  if (partialError) {
    setSettingsError(partialError);
  }
}

/* ============================================================
   Wiring
   ============================================================ */

function wireSettingsInputs() {
  [
    "quantity", "length", "prefix", "postfix", "pattern",
    "charset-preset", "custom-charset", "exclude-confusing",
  ].forEach((id) => {
    const el = $(id);
    el.addEventListener("input", onSettingsChanged);
    el.addEventListener("change", onSettingsChanged);
  });
}

function wireResultsToolbar() {
  $("select-all-results").addEventListener("change", (e) => {
    document.querySelectorAll("#results-list .code-list__checkbox").forEach((cb) => {
      cb.checked = e.target.checked;
    });
  });

  $("copy-selected-btn").addEventListener("click", async () => {
    const codes = getCheckedCodes($("results-list"));
    if (!codes.length) return showToast("No codes selected");
    await copyText(codes.join("\n"));
    showToast(`Copied ${codes.length} code${codes.length === 1 ? "" : "s"}`);
  });

  $("copy-all-btn").addEventListener("click", async () => {
    if (!lastResults.length) return;
    await copyText(lastResults.join("\n"));
    showToast(`Copied ${lastResults.length} code${lastResults.length === 1 ? "" : "s"}`);
  });

  $("download-txt-btn").addEventListener("click", () => {
    if (!lastResults.length) return;
    downloadFile("codes.txt", lastResults.join("\n"), "text/plain");
  });

  $("download-csv-btn").addEventListener("click", () => {
    if (!lastResults.length) return;
    downloadFile("codes.csv", toCsv(lastResults), "text/csv");
  });
}

function wireHistoryToolbar() {
  $("history-search").addEventListener("input", applyHistoryFilter);

  $("select-all-history").addEventListener("change", (e) => {
    document.querySelectorAll("#history-list .code-list__checkbox").forEach((cb) => {
      cb.checked = e.target.checked;
    });
  });

  $("copy-selected-history-btn").addEventListener("click", async () => {
    const codes = getCheckedCodes($("history-list"));
    if (!codes.length) return showToast("No codes selected");
    await copyText(codes.join("\n"));
    showToast(`Copied ${codes.length} code${codes.length === 1 ? "" : "s"}`);
  });

  $("export-history-csv-btn").addEventListener("click", () => {
    const codes = getAllCodes($("history-list"));
    if (!codes.length) return showToast("No history to export");
    downloadFile("history.csv", toCsv(codes), "text/csv");
  });

  $("clear-history-btn").addEventListener("click", async () => {
    const confirmed = confirm(
      "Clearing local history does not release previously generated codes. Those codes remain globally reserved. Clear local history anyway?"
    );
    if (!confirmed) return;
    await clearAllHistory();
    await refreshHistory();
    showToast("Local history cleared");
  });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {
        /* offline-first still works for cached shell even if this fails */
      });
    });
  }
}

function init() {
  wireSettingsInputs();
  wireResultsToolbar();
  wireHistoryToolbar();

  $("generate-btn").addEventListener("click", handleGenerateClick);

  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);
  updateOnlineStatus();

  onSettingsChanged();
  refreshHistory();
  registerServiceWorker();
}

document.addEventListener("DOMContentLoaded", init);
