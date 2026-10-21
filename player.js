"use strict";

const t = (key) => browser.i18n.getMessage(key) || key;
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);

const NS = "http://www.w3.org/2000/svg";
const ICONS = {
  play: [{ d: "M8 5v14l11-7z" }],
  pause: [{ d: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" }],
  prev: [{ d: "M6 6h2v12H6zM9.5 12L19 18V6z" }],
  next: [{ d: "M16 6h2v12h-2zM14.5 12L5 18V6z" }],
  volume: [{ d: "M4 9v6h4l5 4V5L8 9z" }, { d: "M16.5 8.5a5 5 0 0 1 0 7", line: true }],
  muted: [{ d: "M4 9v6h4l5 4V5L8 9z" }, { d: "M16 9.5l5 5M21 9.5l-5 5", line: true }],
  note: [{ d: "M9 18V5l11-2v13", line: true }, { d: "M9 18a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0z", line: true }, { d: "M20 16a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0z", line: true }],
};

function icon(name) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "currentColor");
  for (const shape of ICONS[name]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", shape.d);
    if (shape.line) {
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", "2");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
    }
    svg.appendChild(p);
  }
  return svg;
}

function setIcon(button, name) {
  if (button.dataset.icon === name) return;
  button.dataset.icon = name;
  button.replaceChildren(icon(name));
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const send = (key, action, value) =>
  browser.runtime.sendMessage({ type: "media-control", key, action, value }).catch(() => {});

/* ---- Ticker: scroll long text in a loop, only when it does not fit ---- */
const TICK_GAP = 36;
const TICK_SPEED = 40; // px per second
const ticks = new Map(); // .tick element -> state

function makeTicker(className) {
  const tick = el("div", "tick " + className);
  const track = el("div", "track");
  const t1 = el("span", "t1");
  const t2 = el("span", "t2");
  t2.setAttribute("aria-hidden", "true");
  track.append(t1, t2);
  tick.appendChild(track);
  const tk = { tick, t1, t2, text: null, width: 0 };
  ticks.set(tick, tk);
  tickObserver.observe(tick);
  return tk;
}

function measureTick(tk) {
  tk.tick.classList.remove("run");
  const w = tk.t1.offsetWidth;
  if (tk.tick.clientWidth > 0 && w > tk.tick.clientWidth + 1) {
    const dist = w + TICK_GAP;
    tk.tick.style.setProperty("--dist", dist + "px");
    tk.tick.style.setProperty("--dur", (dist / TICK_SPEED).toFixed(2) + "s");
    tk.tick.classList.add("run");
  }
}

function setTicker(tk, text) {
  if (tk.text === text) return;
  tk.text = text;
  tk.t1.textContent = text;
  tk.t2.textContent = text;
  tk.tick.title = text;
  measureTick(tk);
}

const tickObserver = new ResizeObserver((entries) => {
  for (const e of entries) {
    const tk = ticks.get(e.target);
    const w = Math.round(e.contentRect.width);
    if (tk && w !== tk.width) {
      tk.width = w;
      measureTick(tk);
    }
  }
});

const cards = new Map(); // key -> { player, node, refs }
const list = document.getElementById("list");
const empty = document.getElementById("empty");

const liveTime = (p) => {
  if (p.paused) return p.currentTime;
  const t = p.currentTime + ((Date.now() - p.at) / 1000) * (p.rate || 1);
  return p.duration ? Math.min(p.duration, t) : t;
};

function button(label, name, onClick, className) {
  const b = el("button", className);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  setIcon(b, name);
  b.addEventListener("click", onClick);
  return b;
}

function buildCard(key) {
  const node = el("section", "card");
  const refs = { dragging: false };

  const top = el("div", "top");
  top.title = t("playerGoToTab");
  top.addEventListener("click", () => send(key, "focus"));
  refs.thumb = el("div", "thumb");
  refs.art = el("div", "art");
  refs.fav = el("img", "fav");
  refs.fav.alt = "";
  refs.fav.hidden = true;
  refs.fav.referrerPolicy = "no-referrer";
  refs.fav.addEventListener("error", () => {
    refs.fav.hidden = true;
    refs.fav.dataset.src = "";
  });
  refs.thumb.append(refs.art, refs.fav);
  refs.meta = el("div", "meta");
  refs.titleTk = makeTicker("title");
  refs.subTk = makeTicker("sub");
  refs.meta.append(refs.titleTk.tick, refs.subTk.tick);
  top.append(refs.thumb, refs.meta);

  const time = el("div", "time");
  refs.time = time;
  refs.cur = el("span");
  refs.seek = el("input");
  refs.seek.type = "range";
  refs.seek.min = "0";
  refs.seek.step = "0.1";
  refs.seek.value = "0";
  refs.seek.setAttribute("aria-label", t("playerSeek"));
  refs.seek.addEventListener("input", () => {
    refs.dragging = true;
    refs.cur.textContent = fmt(Number(refs.seek.value));
  });
  refs.seek.addEventListener("change", () => {
    refs.dragging = false;
    refs.player.currentTime = Number(refs.seek.value);
    refs.player.at = Date.now();
    send(key, "seek", Number(refs.seek.value));
  });
  refs.dur = el("span");
  time.append(refs.cur, refs.seek, refs.dur);

  const controls = el("div", "controls");
  const group = el("div", "group");
  refs.prev = button(t("playerPrev"), "prev", () => send(key, "prev"));
  refs.toggle = button(t("playerPlay"), "play", () => {
      // Optimistic: freeze/resume the timeline right away; the page's own update corrects it.
      const p = refs.player;
      const action = p.paused ? "play" : "pause";
      p.currentTime = liveTime(p);
      p.paused = !p.paused;
      p.at = Date.now();
      paint(cards.get(key));
      send(key, action);
    }, "main");
  refs.next = button(t("playerNext"), "next", () => send(key, "next"));
  group.append(refs.prev, refs.toggle, refs.next);

  const vol = el("div", "group volgroup");
  refs.mute = button(t("playerMute"), "volume", () => send(key, "mute"));
  refs.volume = el("input", "vol");
  refs.volume.type = "range";
  refs.volume.min = "0";
  refs.volume.max = "1";
  refs.volume.step = "0.01";
  refs.volume.setAttribute("aria-label", t("playerVolume"));
  refs.volume.addEventListener("input", () => send(key, "volume", Number(refs.volume.value)));
  // The slider sits in a wrapper so a narrow card can turn it into a popup (player.css).
  const pop = el("span", "volpop");
  pop.append(refs.volume);
  vol.append(refs.mute, pop);

  controls.append(group, vol);
  node.append(top, time, controls);
  return { node, refs };
}

function paintTime(c) {
  const { refs, player: p } = c;
  if (!p.duration) return;
  const now = liveTime(p);
  if (!refs.dragging) {
    refs.seek.value = String(now);
    refs.cur.textContent = fmt(now);
  }
}

function paint(c) {
  const { refs, player: p } = c;
  refs.player = p;
  setTicker(refs.titleTk, p.title || p.site);
  setTicker(refs.subTk, p.artist || p.site);

  if (p.favicon) {
    if (refs.fav.dataset.src !== p.favicon) {
      refs.fav.dataset.src = p.favicon;
      refs.fav.src = p.favicon;
    }
    refs.fav.hidden = false;
  } else {
    refs.fav.hidden = true;
  }

  if (p.artwork && refs.art.dataset.src !== p.artwork) {
    refs.art.dataset.src = p.artwork;
    const img = el("img", "art");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = p.artwork;
    img.addEventListener("error", () => {
      refs.art.dataset.src = "";
      img.replaceWith(placeholder(refs));
    });
    refs.art.replaceWith(img);
    refs.art = img;
  } else if (!p.artwork && refs.art.localName === "img") {
    const ph = placeholder(refs);
    refs.art.replaceWith(ph);
    refs.art = ph;
  } else if (!refs.art.firstChild && refs.art.localName === "div") {
    refs.art.appendChild(icon("note"));
  }

  const live = !p.duration;
  refs.time.hidden = live;
  if (!live) {
    refs.seek.max = String(p.duration);
    refs.dur.textContent = fmt(p.duration);
    paintTime(c);
  }

  setIcon(refs.toggle, p.paused ? "play" : "pause");
  refs.toggle.title = refs.toggle.ariaLabel = p.paused ? t("playerPlay") : t("playerPause");
  refs.prev.disabled = !p.hasPrev;
  refs.next.disabled = !p.hasNext;
  setIcon(refs.mute, p.muted || p.volume === 0 ? "muted" : "volume");
  refs.mute.title = p.muted ? t("playerUnmute") : t("playerMute");
  refs.volume.value = String(p.muted ? 0 : p.volume);
}

function placeholder(refs) {
  const ph = el("div", "art");
  ph.appendChild(icon("note"));
  refs.art = ph;
  return ph;
}

function reorder() {
  const sorted = [...cards.values()].sort(
    (a, b) => Number(a.player.paused) - Number(b.player.paused) || b.player.at - a.player.at
  );
  const current = [...list.children];
  if (sorted.length === current.length && sorted.every((c, i) => c.node === current[i])) return;
  list.replaceChildren(...sorted.map((c) => c.node));
}

const count = document.getElementById("count");
const updateCount = () => {
  count.textContent = cards.size ? String(cards.size) : "";
};

function upsert(player) {
  let c = cards.get(player.key);
  if (!c) {
    c = buildCard(player.key);
    cards.set(player.key, c);
  }
  c.player = player;
  paint(c);
  reorder();
  empty.hidden = cards.size > 0;
  updateCount();
}

function remove(key) {
  const c = cards.get(key);
  if (!c) return;
  c.node.remove();
  cards.delete(key);
  empty.hidden = cards.size > 0;
  updateCount();
}

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "media-push") return;
  if (msg.removed) remove(msg.removed);
  else if (msg.player) upsert(msg.player);
});

setInterval(() => {
  for (const c of cards.values()) if (!c.player.paused) paintTime(c);
}, 500);

browser.runtime
  .sendMessage({ type: "media-list" })
  .then((res) => {
    for (const p of (res && res.players) || []) upsert(p);
    empty.hidden = cards.size > 0;
  })
  .catch(() => {
    empty.hidden = false;
  });

/* ---- Collapsible blocks remember their state ---- */
for (const box of document.querySelectorAll("details.box")) {
  const k = "zenify-open-" + box.id;
  try {
    const v = localStorage.getItem(k);
    if (v !== null) box.open = v === "1";
  } catch (_) {
    // storage unavailable: keep the defaults
  }
  box.addEventListener("toggle", () => {
    try {
      localStorage.setItem(k, box.open ? "1" : "0");
    } catch (_) {
      // ignore
    }
  });
}

/* ---- Firefox theme colours (falls back to light/dark from the system) ---- */
const root = document.documentElement;
const THEME_PROPS = ["--bg", "--text", "--accent", "--on-accent", "color-scheme"];

function parseColor(value) {
  const probe = document.createElement("span");
  probe.style.color = "";
  probe.style.color = value;
  if (!probe.style.color) return null;
  document.body.appendChild(probe);
  const m = getComputedStyle(probe).color.match(/[\d.]+/g);
  probe.remove();
  if (!m || m.length < 3) return null;
  return [Number(m[0]), Number(m[1]), Number(m[2]), m.length > 3 ? Number(m[3]) : 1];
}

function luminance([r, g, b]) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const debug = (...args) =>
  browser.runtime.sendMessage({ type: "debug", where: "sidebar", args: args.map(String) }).catch(() => {});

function applyTheme(theme) {
  for (const p of THEME_PROPS) root.style.removeProperty(p);
  const colors = theme && theme.colors;
  debug(
    "theme:", JSON.stringify(colors || null),
    "properties:", JSON.stringify((theme && theme.properties) || null),
    "prefersDark=" + darkQuery.matches
  );
  if (!colors) return;

  const pick = (...keys) => {
    for (const k of keys) {
      let v = colors[k];
      if (Array.isArray(v)) v = `rgb(${v.slice(0, 3).join(",")})`;
      if (typeof v !== "string" || !v) continue;
      const rgba = parseColor(v);
      if (rgba && rgba[3] >= 0.9) return { css: v, rgba };
    }
    return null;
  };

  const bg = pick("sidebar", "toolbar", "frame", "popup");
  const text = pick("sidebar_text", "toolbar_text", "tab_background_text", "popup_text");
  if (!bg || !text) return;

  const accent = pick("icons_attention", "sidebar_highlight", "tab_line");
  const accentCss = accent ? accent.css : null;
  const onAccent = accent && (luminance(accent.rgba) > 0.5 ? "#15141a" : "#ffffff");

  const setBase = (bgC, textC, isDark) => {
    root.style.setProperty("--bg", bgC.css);
    root.style.setProperty("--text", textC.css);
    root.style.setProperty("--accent", accentCss || textC.css);
    root.style.setProperty("--on-accent", accentCss ? onAccent : bgC.css);
    root.style.setProperty("color-scheme", isDark ? "dark" : "light");
  };

  // Firefox only exposes the colours of a theme's light variant, even when the dark one
  // is in use (seen with the Sun theme). A theme's variants are normally inverses of each
  // other, so when the background disagrees with the appearance, swap background and text:
  // the light variant's dark text colour becomes the dark variant's background.
  const bgIsDark = luminance(bg.rgba) < 0.45;
  if (bgIsDark !== darkQuery.matches) {
    const light = pick("frame", "sidebar", "toolbar", "popup") || bg;
    const swapBg = text;
    const swapText = Math.abs(luminance(swapBg.rgba) - luminance(light.rgba)) > 0.4 ? light : bg;
    const swapIsDark = luminance(swapBg.rgba) < 0.45;
    debug("theme variant mismatch: swapping colours, usable=" + (swapIsDark === darkQuery.matches));
    if (swapIsDark === darkQuery.matches && Math.abs(luminance(swapBg.rgba) - luminance(swapText.rgba)) > 0.4) {
      setBase(swapBg, swapText, swapIsDark);
    } else if (accentCss) {
      root.style.setProperty("--accent", accentCss);
      root.style.setProperty("--on-accent", onAccent);
    }
    return;
  }

  setBase(bg, text, bgIsDark);
}

(async () => {
  if (!browser.theme) return;
  let winId;
  try {
    winId = (await browser.windows.getCurrent()).id;
  } catch (_) {
    // ignore
  }
  const reload = async () => {
    try {
      applyTheme(await browser.theme.getCurrent(winId));
    } catch (_) {
      // ignore
    }
  };
  browser.theme.onUpdated.addListener(({ theme, windowId }) => {
    if (winId === undefined || windowId === undefined || windowId === winId) applyTheme(theme);
  });
  // The appearance can change without a theme update (light/dark switch).
  darkQuery.addEventListener("change", reload);
  window.addEventListener("focus", reload);
  reload();
})();
