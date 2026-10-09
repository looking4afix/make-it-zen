"use strict";

/* ------------------------------------------------------------------ *
 * Settings and logging
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  copyEnabled: true,
  glanceEnabled: true,
  glanceModifier: "alt",
  glanceSize: 85,
  backCloses: true,
  mediaEnabled: true,
};

// Console output is visible in about:debugging -> This Firefox -> Make it Zen -> Inspect.
// Set to false before publishing.
const DEBUG = false;
const log = (...args) => {
  if (DEBUG) console.debug("[zenify]", ...args);
};

const getSettings = () => browser.storage.sync.get(DEFAULTS);

/* ------------------------------------------------------------------ *
 * Copy tab URL (+ toast at the top of the page)
 * ------------------------------------------------------------------ */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Fall through to the legacy path.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
    document.documentElement.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

// Serialized and executed inside the page: must not reference anything outside.
function injectedToast(text, duration) {
  const ID = "zenify-toast-host";
  const old = document.getElementById(ID);
  if (old) old.remove();

  const host = document.createElement("div");
  host.id = ID;
  host.style.cssText =
    "all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    .pill {
      position: fixed; top: 14px; left: 50%;
      transform: translate(-50%, -18px); opacity: 0;
      display: flex; align-items: center; gap: 8px;
      padding: 9px 16px; border-radius: 999px;
      background: rgba(28, 28, 30, .92); color: #fff;
      font: 500 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .28);
      transition: opacity .18s ease, transform .22s cubic-bezier(.2, .8, .2, 1);
    }
    .pill.in { opacity: 1; transform: translate(-50%, 0); }
    .ck { font-weight: 700; }
    @media (prefers-reduced-motion: reduce) { .pill { transition: none; } }
  `;

  const pill = document.createElement("div");
  pill.className = "pill";
  const ck = document.createElement("span");
  ck.className = "ck";
  ck.textContent = "✓";
  const label = document.createElement("span");
  label.textContent = text;
  pill.append(ck, label);

  root.append(style, pill);
  document.documentElement.appendChild(host);

  requestAnimationFrame(() => requestAnimationFrame(() => pill.classList.add("in")));
  setTimeout(() => {
    pill.classList.remove("in");
    setTimeout(() => host.remove(), 260);
  }, duration);
}

async function flashBadge(tabId, text, color) {
  try {
    await browser.action.setBadgeBackgroundColor({ color, tabId });
    await browser.action.setBadgeText({ text, tabId });
    setTimeout(() => browser.action.setBadgeText({ text: null, tabId }).catch(() => {}), 1500);
  } catch (_) {
    // Tab may be gone; nothing to do.
  }
}

browser.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "copy-url") return;
  const settings = await getSettings();
  if (!settings.copyEnabled) return;

  if (!tab) [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  const ok = await copyText(tab.url);
  if (!ok) {
    flashBadge(tab.id, "!", "#c62828");
    return;
  }

  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectedToast,
      args: [browser.i18n.getMessage("toastCopied"), 1600],
    });
  } catch (_) {
    // Restricted page (about:, addons.mozilla.org, PDF viewer, new tab...).
    flashBadge(tab.id, "✓", "#2e7d32");
  }
});

/* ------------------------------------------------------------------ *
 * Glance: per-tab state (kept in storage.session so it survives the
 * background page being suspended)
 *
 *   { open, at, pending, frames: { [frameId]: lastUrl } }
 * ------------------------------------------------------------------ */

const session = browser.storage.session;
const stateKey = (tabId) => `glance:${tabId}`;
const STALE_MS = 60 * 60 * 1000;
const FRESH_MS = 15 * 1000;

const emptyState = () => ({ open: false, at: 0, pending: null, frames: {} });

async function getState(tabId) {
  const k = stateKey(tabId);
  const o = await session.get(k);
  const st = o[k] || emptyState();
  if (st.open && Date.now() - st.at > STALE_MS) return emptyState();
  return st;
}
const setState = (tabId, st) => session.set({ [stateKey(tabId)]: st });
const clearState = (tabId) => session.remove(stateKey(tabId));

const stripHash = (u) => String(u).split("#")[0];
const sameUrl = (a, b) => !!a && !!b && stripHash(a) === stripHash(b);

function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch (_) {
    return "";
  }
}

function isHttpUrl(u) {
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch (_) {
    return false;
  }
}

const sendToTop = (tabId, message) =>
  browser.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => {});

async function onHeadersReceived(details) {
  if (details.tabId < 0) return {};

  const st = await getState(details.tabId);
  if (!st.open) return {};

  const frameKey = String(details.frameId);
  let isGlance = frameKey in st.frames;
  let dirty = false;

  if (!isGlance && st.pending && details.parentFrameId === 0) {
    const exact = sameUrl(details.url, st.pending);
    const sameHostSoon =
      Date.now() - st.at < FRESH_MS && hostOf(details.url) === hostOf(st.pending);
    if (exact || sameHostSoon) {
      isGlance = true;
      st.pending = null;
      dirty = true;
    }
  }

  if (!isGlance) {
    log("sub_frame NOT matched", details.url, "pending:", st.pending, "frames:", Object.keys(st.frames));
    return {};
  }

  if (st.frames[frameKey] !== details.url) {
    st.frames[frameKey] = details.url;
    dirty = true;
    const isRedirect = details.statusCode >= 300 && details.statusCode < 400;
    if (!isRedirect) sendToTop(details.tabId, { type: "glance-url", url: details.url });
  }
  if (dirty) await setState(details.tabId, st);

  const removed = [];
  const responseHeaders = [];
  for (const h of details.responseHeaders || []) {
    const name = h.name.toLowerCase();
    if (name === "x-frame-options") {
      removed.push(name);
      continue;
    }
    if (name === "content-security-policy" || name === "content-security-policy-report-only") {
      // Firefox merges an extension-rewritten CSP with the original one (the stricter
      // result wins), so frame-ancestors can only be lifted by removing the whole header.
      // Policies without frame-ancestors are left alone.
      if (/(^|;)\s*frame-ancestors\b/i.test(h.value || "")) {
        removed.push(`${name}(frame-ancestors)`);
        continue;
      }
    }
    responseHeaders.push(h);
  }
  log("glance frame", details.frameId, details.url, "status", details.statusCode, "removed:", removed);
  return { responseHeaders };
}

browser.webRequest.onHeadersReceived.addListener(
  onHeadersReceived,
  { urls: ["<all_urls>"], types: ["sub_frame"] },
  ["blocking", "responseHeaders"]
);

// A network-level failure of the Glance frame (framing refused, DNS, TLS...).
async function onErrorOccurred(details) {
  if (details.tabId < 0 || details.parentFrameId !== 0) return;
  const err = details.error || "";
  if (/NS_BINDING_ABORTED|NS_ERROR_ABORT/i.test(err)) return;

  const st = await getState(details.tabId);
  if (!st.open) return;

  const known =
    String(details.frameId) in st.frames ||
    sameUrl(details.url, st.pending) ||
    (st.pending && Date.now() - st.at < 2 * FRESH_MS);
  log("sub_frame error", details.url, err, "glance:", !!known);
  if (!known) return;

  sendToTop(details.tabId, {
    type: "glance-blocked",
    url: st.frames[String(details.frameId)] || st.pending || details.url,
  });
}

browser.webRequest.onErrorOccurred.addListener(onErrorOccurred, {
  urls: ["<all_urls>"],
  types: ["sub_frame"],
});

/* ------------------------------------------------------------------ *
 * Media players (shown in the sidebar)
 *
 * Content scripts push snapshots; the map is mirrored to storage.session so
 * it survives the background page being suspended.
 * ------------------------------------------------------------------ */

const players = new Map();
const playersReady = session
  .get("players")
  .then((o) => {
    for (const p of o.players || []) players.set(p.key, p);
  })
  .catch(() => {});

let saveTimer = null;
function savePlayers() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => session.set({ players: [...players.values()] }).catch(() => {}), 300);
}

const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const httpsUrl = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.href : "";
  } catch (_) {
    return "";
  }
};
const iconUrl = (v) => {
  if (typeof v !== "string") return "";
  if (/^data:image\//i.test(v)) return v.length <= 20000 ? v : "";
  return v.length <= 600 ? httpsUrl(v) : "";
};
const playerKey = (tabId, frameId, id) => `${tabId}:${frameId}:${id}`;
const notifySidebar = (msg) => browser.runtime.sendMessage(msg).catch(() => {});

async function updateBadge() {
  const playing = [...players.values()].some((p) => !p.paused);
  try {
    await browser.action.setBadgeText({ text: playing ? "\u266a" : "" });
    if (playing) await browser.action.setBadgeBackgroundColor({ color: "#5b4bdb" });
  } catch (_) {
    // ignore
  }
}

async function mediaUpdate(raw, tab, frameId) {
  await playersReady;
  if (!raw || typeof raw !== "object" || raw.id === undefined) return;
  const id = str(String(raw.id), 16);
  const key = playerKey(tab.id, frameId, id);

  if (raw.removed) {
    if (players.delete(key)) notifySidebar({ type: "media-push", removed: key });
  } else {
    const player = {
      key,
      tabId: tab.id,
      frameId,
      id,
      title: str(raw.title, 200),
      artist: str(raw.artist, 200),
      artwork: httpsUrl(raw.artwork),
      site: hostOf(tab.url),
      favicon: iconUrl(tab.favIconUrl),
      paused: !!raw.paused,
      currentTime: num(raw.currentTime),
      duration: num(raw.duration),
      rate: num(raw.rate) || 1,
      volume: Math.min(1, Math.max(0, num(raw.volume))),
      muted: !!raw.muted,
      isVideo: !!raw.isVideo,
      hasPrev: !!raw.hasPrev,
      hasNext: !!raw.hasNext,
      at: Date.now(),
    };
    players.set(key, player);
    notifySidebar({ type: "media-push", player });
  }
  savePlayers();
  updateBadge();
}

function dropPlayers(tabId, frameId) {
  let changed = false;
  for (const [key, p] of players) {
    if (p.tabId === tabId && (frameId === undefined || p.frameId === frameId)) {
      players.delete(key);
      notifySidebar({ type: "media-push", removed: key });
      changed = true;
    }
  }
  if (changed) {
    savePlayers();
    updateBadge();
  }
}

async function mediaList() {
  await playersReady;
  for (const tabId of new Set([...players.values()].map((p) => p.tabId))) {
    browser.tabs.sendMessage(tabId, { type: "media-resync" }).catch(() => {});
  }
  return { players: [...players.values()] };
}

const MEDIA_ACTIONS = ["play", "pause", "seek", "volume", "mute", "prev", "next", "focus"];

async function mediaControl(msg) {
  await playersReady;
  const p = players.get(msg.key);
  if (!p || !MEDIA_ACTIONS.includes(msg.action)) return { ok: false };
  if (msg.action === "focus") {
    await browser.tabs.update(p.tabId, { active: true });
    try {
      const t = await browser.tabs.get(p.tabId);
      await browser.windows.update(t.windowId, { focused: true });
    } catch (_) {
      // ignore
    }
    return { ok: true };
  }
  await browser.tabs
    .sendMessage(p.tabId, { type: "media-cmd", id: p.id, action: msg.action, value: msg.value }, { frameId: p.frameId })
    .catch(() => {});
  return { ok: true };
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") dropPlayers(tabId);
}, { properties: ["status"] });

browser.tabs.onRemoved.addListener((tabId) => {
  clearState(tabId);
  dropPlayers(tabId);
});

/* ------------------------------------------------------------------ *
 * Messages from the content scripts
 * ------------------------------------------------------------------ */

async function handleMessage(msg, sender) {
  const tab = sender.tab;

  // From the sidebar page (an extension page, so no tab).
  if (!tab) {
    if (msg.type === "debug") {
      log("content", msg.where, ...(msg.args || []));
      return undefined;
    }
    if (msg.type === "media-list") return mediaList();
    if (msg.type === "media-control") return mediaControl(msg);
    return undefined;
  }

  switch (msg.type) {
    case "media-update": {
      await mediaUpdate(msg.player, tab, sender.frameId || 0);
      return undefined;
    }

    case "media-clear": {
      dropPlayers(tab.id, sender.frameId || 0);
      return undefined;
    }

    case "glance-register": {
      if (!isHttpUrl(msg.url)) return { ok: false };
      await setState(tab.id, { open: true, at: Date.now(), pending: msg.url, frames: {} });
      log("glance registered", tab.id, msg.url);
      return { ok: true };
    }

    case "glance-close": {
      await clearState(tab.id);
      return { ok: true };
    }

    case "glance-escape": {
      // Relayed from the (named) Glance frame when it has keyboard/mouse focus.
      await sendToTop(tab.id, { type: "glance-close-request" });
      return { ok: true };
    }

    case "glance-expand": {
      const st = await getState(tab.id);
      const known = Object.values(st.frames);
      const url = known.length ? known[known.length - 1] : msg.url;
      if (!isHttpUrl(url)) return { ok: false };
      await browser.tabs.create({
        url,
        active: true,
        openerTabId: tab.id,
        index: tab.index + 1,
      });
      await clearState(tab.id);
      return { ok: true };
    }

    case "debug": {
      log("content", `tab ${tab.id} opener=${tab.openerTabId}`, msg.where, ...(msg.args || []));
      return undefined;
    }

    case "opener-check": {
      log("opener-check", `tab ${tab.id} openerTabId=${tab.openerTabId}`, tab.url);
      // Only tabs that were opened from another tab (link, window.open...) qualify.
      if (typeof tab.openerTabId !== "number") return { eligible: false };
      try {
        await browser.tabs.get(tab.openerTabId);
        return { eligible: true };
      } catch (_) {
        return { eligible: false };
      }
    }

    case "back-close": {
      // Back pressed on the first page of a tab opened from another one.
      const openerId = tab.openerTabId;
      log("back-close", `tab ${tab.id} openerTabId=${openerId}`);
      if (typeof openerId !== "number") return { ok: false };
      try {
        await browser.tabs.update(openerId, { active: true });
      } catch (_) {
        return { ok: false };
      }
      await browser.tabs.remove(tab.id);
      return { ok: true };
    }

    default:
      return undefined;
  }
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== "string") return undefined;
  return handleMessage(msg, sender);
});
