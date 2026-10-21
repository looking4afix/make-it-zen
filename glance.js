"use strict";

/*
 * Zenify content script.
 *  - Top frame: Glance (modifier + click on a link opens it in an overlay)
 *    and the blocked-site countdown.
 *  - Glance frame (recognised by its window name): relays Escape so the
 *    overlay can be closed while the previewed page has focus.
 */
(() => {
  const FRAME_PREFIX = "zenify-glance-";
  const COUNTDOWN_SECONDS = 5;
  const isGlanceFrame = () => String(window.name).startsWith(FRAME_PREFIX);
  const t = (key, ...subs) => browser.i18n.getMessage(key, subs) || key;

  // Alt+Left (Cmd+[ on macOS): what the mouse Back button sends when remapped.
  const isBackKey = (e) =>
    !e.shiftKey &&
    ((e.key === "ArrowLeft" && e.altKey && !e.ctrlKey && !e.metaKey) ||
      (e.key === "[" && e.metaKey && !e.altKey && !e.ctrlKey));

  if (window !== window.top) {
    const relay = () => browser.runtime.sendMessage({ type: "glance-escape" }).catch(() => {});

    // Links followed inside the Glance frame are announced to the top frame, which can
    // then tell a navigation refused by the host page's CSP (frame-src) from a normal one.
    if (isGlanceFrame()) {
      window.addEventListener(
        "click",
        (e) => {
          if (e.button !== 0) return;
          const a = e.composedPath().find((n) => n && n.localName === "a" && n.hasAttribute("href"));
          if (!a || typeof a.href !== "string" || !/^https?:/i.test(a.href)) return;
          browser.runtime.sendMessage({ type: "glance-nav", url: a.href }).catch(() => {});
        },
        true
      );
    }

    // Firefox keeps a site's cookies apart when it is framed by another site, so the preview
    // can look signed out. On the first click inside the preview (a click is required), ask
    // Firefox to let the site use its own cookies here; Firefox may show its prompt. If it is
    // granted, the page is fetched again so it comes back signed in (unless the click was on a
    // link: that navigation is already under way and later loads will have the cookies).
    if (isGlanceFrame()) {
      let enabled = true;
      let tried = false;
      const trace = (...args) =>
        browser.runtime
          .sendMessage({ type: "debug", where: "storage-access " + location.hostname, args: args.map(String) })
          .catch(() => {});
      const hasApi = typeof document.requestStorageAccess === "function";
      browser.storage.sync
        .get({ sessionAccess: true })
        .then(async (s) => {
          enabled = !!s.sessionAccess;
          let has = "n/a";
          try {
            if (hasApi) has = String(await document.hasStorageAccess());
          } catch (err) {
            has = "error " + (err && err.name);
          }
          trace("frame ready", "api=" + hasApi, "enabled=" + enabled, "hasAccess=" + has);
        })
        .catch(() => {});
      if (hasApi) {
        window.addEventListener(
          "pointerdown",
          async (e) => {
            const onLink = e.composedPath().some((n) => n && n.localName === "a" && n.hasAttribute("href"));
            trace("pointerdown", "link=" + onLink, "enabled=" + enabled, "alreadyTried=" + tried);
            if (tried || !enabled) return;
            tried = true;
            try {
              if (await document.hasStorageAccess()) {
                trace("already allowed");
                return;
              }
              await document.requestStorageAccess();
              if (onLink) {
                trace("granted (click was a link, not reloading)");
              } else {
                trace("granted, reloading the frame");
                location.reload();
              }
            } catch (err) {
              trace("refused:", err && err.name, err && err.message);
            }
          },
          true
        );
      }
    }

    document.addEventListener("keydown", (e) => {
      if (e.defaultPrevented || !isGlanceFrame()) return;
      if (e.key === "Escape" || isBackKey(e)) {
        if (e.key !== "Escape") e.preventDefault();
        relay();
      }
    });

    return;
  }

  const DEFAULTS = {
    copyEnabled: true,
    glanceEnabled: true,
    glanceModifier: "alt",
    glanceSize: 85,
    backCloses: true,
  };
  const MODS = { alt: "altKey", ctrl: "ctrlKey", shift: "shiftKey", meta: "metaKey" };

  let settings = { ...DEFAULTS };
  let current = null;

  const settingsReady = browser.storage.sync
    .get(DEFAULTS)
    .then((s) => {
      settings = { ...DEFAULTS, ...s };
    })
    .catch(() => {});

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [key, change] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = change.newValue ?? DEFAULTS[key];
    }
  });

  const stripHash = (u) => u.split("#")[0];

  function modifierMatches(e) {
    const want = settings.glanceModifier;
    if (!(want in MODS) || !e[MODS[want]]) return false;
    return Object.entries(MODS).every(([name, prop]) => name === want || !e[prop]);
  }

  function findLink(e) {
    for (const node of e.composedPath()) {
      if (node.nodeType === 1 && node.localName === "a" && node.hasAttribute("href")) {
        const raw = typeof node.href === "string" ? node.href : node.href && node.href.baseVal;
        if (!raw) return null;
        try {
          const url = new URL(raw, document.baseURI);
          return /^https?:$/.test(url.protocol) ? url : null;
        } catch (_) {
          return null;
        }
      }
    }
    return null;
  }

  window.addEventListener(
    "click",
    (e) => {
      if (!settings.glanceEnabled || e.button !== 0 || !modifierMatches(e)) return;
      const url = findLink(e);
      if (!url) return;
      if (url.hash && stripHash(url.href) === stripHash(location.href)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      openGlance(url.href);
    },
    true
  );

  /* ---------------------------------------------------------------- *
   * Back shortcut (Alt+Left, which the mouse Back button can be mapped to):
   *   - Glance open: closes the preview.
   *   - Tab opened from another tab, still on its first page: closes the
   *     tab and returns to the opener (Back would do nothing there anyway).
   * ---------------------------------------------------------------- */

  let openedFromTab = false;
  settingsReady
    .then(() => browser.runtime.sendMessage({ type: "opener-check" }))
    .then((res) => {
      openedFromTab = !!(res && res.eligible);
    })
    .catch(() => {});

  window.addEventListener(
    "keydown",
    (e) => {
      if (!settings.backCloses || !isBackKey(e)) return;
      const glance = !!current;
      const tab = !glance && openedFromTab && history.length === 1;
      if (glance) {
        e.preventDefault();
        e.stopPropagation();
        closeGlance();
      } else if (tab) {
        e.preventDefault();
        e.stopPropagation();
        browser.runtime.sendMessage({ type: "back-close" }).catch(() => {});
      }
    },
    true
  );

  /* ---------------------------------------------------------------- *
   * Overlay UI
   * ---------------------------------------------------------------- */

  /* A link clicked inside the Glance frame and a frame-src violation reported by the host
     page for the same origin, in either order, mean the host page's CSP refused it. */
  const NAV_WINDOW_MS = 3000;
  let navTry = null;
  let lastViolation = null;

  function originOf(u) {
    try {
      return new URL(u).origin;
    } catch (_) {
      return "";
    }
  }

  function maybeBlockedNav() {
    if (!current || !navTry || !lastViolation) return false;
    if (Math.abs(navTry.at - lastViolation.at) > NAV_WINDOW_MS) return false;
    if (!lastViolation.origin || lastViolation.origin !== originOf(navTry.url)) return false;
    const url = navTry.url;
    navTry = null;
    lastViolation = null;
    // Loads started by the extension itself are not held to the host page's CSP (the
    // initial Glance load passes even where a click inside the frame is refused), so
    // retry the same link through the iframe element. If that is refused too, ask.
    current.retry = { url, at: Date.now() };
    current.frame.src = url;
    return true;
  }

  const RING_R = 34;
  const RING_C = 2 * Math.PI * RING_R;

  const CSS = `
    :host { all: initial; }
    .wrap {
      --bg: #1c1b22; --field: rgba(255, 255, 255, .09); --field-hover: rgba(255, 255, 255, .16);
      --text: #fbfbfe; --muted: #a7a7b3; --accent: #8a7bff;
      --shadow: 0 28px 80px rgba(0, 0, 0, .55), 0 0 0 1px rgba(255, 255, 255, .08);
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: light) {
      .wrap {
        --bg: #f9f9fb; --field: rgba(0, 0, 0, .06); --field-hover: rgba(0, 0, 0, .11);
        --text: #15141a; --muted: #5b5b66; --accent: #5b4bdb;
        --shadow: 0 28px 80px rgba(0, 0, 0, .35), 0 0 0 1px rgba(0, 0, 0, .06);
      }
    }
    .backdrop {
      position: fixed; inset: 0; background: rgba(0, 0, 0, .42);
      -webkit-backdrop-filter: blur(5px); backdrop-filter: blur(5px);
      opacity: 0; transition: opacity .18s ease;
    }
    .stage {
      position: fixed; inset: 0; display: flex; align-items: center;
      justify-content: center; pointer-events: none;
    }
    .panel {
      pointer-events: auto; box-sizing: border-box;
      display: flex; flex-direction: column; gap: 8px; padding: 8px;
      width: min(calc(var(--size) * 1vw), calc(100vw - 24px), 1500px);
      height: min(calc(var(--size) * 1vh), calc(100vh - 24px));
      background: var(--bg); color: var(--text);
      border-radius: 22px; box-shadow: var(--shadow);
      opacity: 0; transform: translateY(10px) scale(.96);
      transition: opacity .18s ease, transform .22s cubic-bezier(.2, .8, .2, 1);
    }
    .header { display: flex; align-items: center; gap: 8px; height: 38px; flex: none; }
    .urlpill {
      flex: 1; min-width: 0; height: 38px; box-sizing: border-box;
      display: flex; align-items: center; gap: 10px; padding: 0 16px;
      border-radius: 999px; background: var(--field);
      font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden;
    }
    .urlpill svg { width: 15px; height: 15px; flex: none; color: var(--accent); }
    .domain { font-weight: 650; }
    .path { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
    button {
      all: unset; box-sizing: border-box; cursor: pointer; flex: none;
      height: 38px; min-width: 38px; padding: 0 14px;
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      border-radius: 999px; background: var(--field); color: var(--text);
      font-size: 13px; font-weight: 550;
      transition: background .12s ease, transform .12s ease;
    }
    button:hover { background: var(--field-hover); }
    button:active { transform: scale(.96); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button.icon { width: 38px; padding: 0; }
    button svg { width: 17px; height: 17px; }
    button.primary { background: var(--accent); color: #fff; }
    button.primary:hover { filter: brightness(1.1); background: var(--accent); }
    .view {
      position: relative; flex: 1; min-height: 0;
      border-radius: 15px; overflow: hidden; background: #fff;
    }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
    .blocked {
      position: absolute; inset: 0; z-index: 2; display: grid; place-items: center;
      padding: 24px; box-sizing: border-box; background: var(--bg); text-align: center;
    }
    .card { display: flex; flex-direction: column; align-items: center; gap: 12px; max-width: 380px; }
    .ring { position: relative; width: 84px; height: 84px; }
    .ring svg { width: 84px; height: 84px; display: block; }
    .ring circle { fill: none; stroke-width: 5; }
    .track { stroke: var(--field-hover); }
    .bar {
      stroke: var(--accent); stroke-linecap: round;
      transform: rotate(-90deg); transform-origin: 50% 50%;
      stroke-dasharray: ${RING_C.toFixed(2)}; stroke-dashoffset: 0;
      animation: zring linear forwards;
    }
    @keyframes zring { to { stroke-dashoffset: ${RING_C.toFixed(2)}; } }
    .num { position: absolute; inset: 0; display: grid; place-items: center; font-size: 26px; font-weight: 650; }
    .title { font-size: 16px; font-weight: 650; }
    .sub { color: var(--muted); font-size: 13px; }
    .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 6px; }
    .badge {
      width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center;
      background: var(--field); color: var(--accent);
    }
    .badge svg { width: 30px; height: 30px; }
    .open .backdrop { opacity: 1; }
    .open .panel { opacity: 1; transform: none; }
    .closing .backdrop, .closing .panel { opacity: 0; }
    .closing .panel { transform: translateY(6px) scale(.98); }
    @media (prefers-reduced-motion: reduce) { .backdrop, .panel { transition: none !important; } }
  `;

  const NS = "http://www.w3.org/2000/svg";

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(paths) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (const d of paths) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }

  const ICON_GLOBE = [
    "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z",
    "M3 12h18",
    "M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z",
  ];
  const ICON_OPEN = [
    "M14 4h6v6",
    "M20 4l-9 9",
    "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  ];
  const ICON_CLOSE = ["M6 6l12 12", "M18 6L6 18"];
  const ICON_SHIELD = ["M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6l8-3z", "M12 8v5", "M12 16h.01"];

  function makeButton({ label, paths, text, className, onClick }) {
    const b = el("button", className || "");
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    if (paths) b.appendChild(icon(paths));
    if (text) b.appendChild(el("span", "", text));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function splitUrl(href) {
    try {
      const u = new URL(href);
      return { domain: u.hostname, path: (u.pathname + u.search).replace(/\/$/, "") };
    } catch (_) {
      return { domain: href, path: "" };
    }
  }

  async function openGlance(url) {
    if (current) closeGlance({ notify: false });

    try {
      const res = await browser.runtime.sendMessage({ type: "glance-register", url });
      if (!res || !res.ok) return;
    } catch (_) {
      return;
    }
    if (current) closeGlance({ notify: false });

    const size = Math.max(50, Math.min(98, Number(settings.glanceSize) || 85));

    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });

    const style = el("style");
    style.textContent = CSS;

    const wrap = el("div", "wrap");
    wrap.style.setProperty("--size", String(size));

    const backdrop = el("div", "backdrop");
    backdrop.addEventListener("click", () => closeGlance());

    const stage = el("div", "stage");
    const panel = el("div", "panel");

    // Header: rounded URL field + round buttons.
    const header = el("div", "header");
    const urlpill = el("div", "urlpill");
    const domainEl = el("span", "domain");
    const pathEl = el("span", "path");
    urlpill.append(icon(ICON_GLOBE), domainEl, pathEl);

    const setUrl = (href) => {
      const { domain, path } = splitUrl(href);
      domainEl.textContent = domain;
      pathEl.textContent = path;
      urlpill.title = href;
    };
    setUrl(url);

    header.append(
      urlpill,
      makeButton({
        label: t("glanceExpand"),
        paths: ICON_OPEN,
        text: t("glanceOpenTab"),
        onClick: () => expandGlance(),
      }),
      makeButton({
        label: t("glanceClose"),
        paths: ICON_CLOSE,
        className: "icon",
        onClick: () => closeGlance(),
      })
    );

    const view = el("div", "view");
    const frame = document.createElement("iframe");
    frame.name = FRAME_PREFIX + Math.random().toString(36).slice(2, 10);
    frame.allowFullscreen = true;
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    view.appendChild(frame);

    panel.append(header, view);
    stage.appendChild(panel);
    wrap.append(backdrop, stage);
    root.append(style, wrap);

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeGlance();
      }
    };
    window.addEventListener("keydown", onKey, true);

    // The page's own CSP forbids framing: same card as a blocked site.
    navTry = null;
    lastViolation = null;
    const onCsp = (ev) => {
      if (!/^(frame-src|child-src)/.test(ev.effectiveDirective || "")) return;
      const blocked = ev.blockedURI || "";
      // The retry itself was refused: nothing more to try silently.
      if (
        current &&
        current.retry &&
        Date.now() - current.retry.at < NAV_WINDOW_MS &&
        originOf(blocked) === originOf(current.retry.url)
      ) {
        const refused = current.retry.url;
        current.retry = null;
        showBlocked(refused, { csp: true });
        return;
      }
      // A link followed inside the Glance frame that the host page's CSP refuses.
      lastViolation = { origin: originOf(blocked), at: Date.now() };
      if (maybeBlockedNav()) return;
      // Once the frame has shown a page, violations belong to navigations inside it
      // (announced by the frame itself), not to the first load below.
      if (current && current.sawUrl) return;
      let origin = "";
      try {
        origin = new URL(url).origin;
      } catch (_) {
        // ignore
      }
      if (!blocked || !(url.startsWith(blocked) || blocked === origin)) return;
      showBlocked(url, { csp: true });
    };
    document.addEventListener("securitypolicyviolation", onCsp, true);

    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";

    current = { host, wrap, view, frame, url, onKey, onCsp, prevOverflow, setUrl, timer: null, blocked: false, retry: null, sawUrl: false };
    document.documentElement.appendChild(host);
    frame.src = url;

    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add("open")));
  }

  function closeGlance({ notify = true } = {}) {
    if (!current) return;
    const c = current;
    current = null;

    if (c.timer) clearInterval(c.timer);
    window.removeEventListener("keydown", c.onKey, true);
    document.removeEventListener("securitypolicyviolation", c.onCsp, true);
    document.documentElement.style.overflow = c.prevOverflow;

    c.wrap.classList.remove("open");
    c.wrap.classList.add("closing");
    setTimeout(() => c.host.remove(), 200);

    if (notify) browser.runtime.sendMessage({ type: "glance-close" }).catch(() => {});
  }

  async function expandGlance(urlOverride) {
    if (!current) return;
    const url = urlOverride || current.url;
    try {
      await browser.runtime.sendMessage({ type: "glance-expand", url });
    } catch (_) {
      window.open(url, "_blank", "noopener");
    }
    closeGlance({ notify: false });
  }

  /* ---------------------------------------------------------------- *
   * Blocked site: message + 5 s ring countdown, then a new tab
   * ---------------------------------------------------------------- */

  // The host page's CSP refuses the frame: explain it and let the user choose.
  function showCspCard(c, target) {
    const card = el("div", "blocked");
    card.setAttribute("role", "status");
    const inner = el("div", "card");

    const badge = el("div", "badge");
    badge.appendChild(icon(ICON_SHIELD));

    const title = el("div", "title", t("blockedCspTitle"));
    const sub = el("div", "sub", t("blockedCspText"));

    const actions = el("div", "actions");
    actions.append(
      makeButton({
        label: t("blockedCspOpenTab"),
        paths: ICON_OPEN,
        text: t("blockedCspOpenTab"),
        className: "primary",
        onClick: () => expandGlance(target),
      }),
      makeButton({
        label: t("blockedCancel"),
        text: t("blockedCancel"),
        onClick: () => closeGlance(),
      })
    );

    inner.append(badge, title, sub, actions);
    card.appendChild(inner);
    c.view.appendChild(card);
  }

  function showBlocked(url, opts = {}) {
    const c = current;
    if (!c || c.blocked) return;
    c.blocked = true;
    const target = url || c.url;
    if (opts.csp) {
      showCspCard(c, target);
      return;
    }
    let left = COUNTDOWN_SECONDS;

    const card = el("div", "blocked");
    card.setAttribute("role", "status");
    const inner = el("div", "card");

    const ring = el("div", "ring");
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 84 84");
    const track = document.createElementNS(NS, "circle");
    track.setAttribute("class", "track");
    const bar = document.createElementNS(NS, "circle");
    bar.setAttribute("class", "bar");
    for (const circle of [track, bar]) {
      circle.setAttribute("cx", "42");
      circle.setAttribute("cy", "42");
      circle.setAttribute("r", String(RING_R));
      svg.appendChild(circle);
    }
    bar.style.animationDuration = `${COUNTDOWN_SECONDS}s`;
    const num = el("div", "num", String(left));
    ring.append(svg, num);

    const title = el("div", "title", t("blockedTitle"));
    const sub = el("div", "sub", t("blockedCountdown", String(left)));

    const actions = el("div", "actions");
    actions.append(
      makeButton({
        label: t("blockedOpenNow"),
        text: t("blockedOpenNow"),
        className: "primary",
        onClick: () => {
          if (c.timer) clearInterval(c.timer);
          c.timer = null;
          expandGlance(target);
        },
      }),
      makeButton({
        label: t("blockedCancel"),
        text: t("blockedCancel"),
        onClick: () => closeGlance(),
      })
    );

    inner.append(ring, title, sub, actions);
    card.appendChild(inner);
    c.view.appendChild(card);

    c.timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(c.timer);
        c.timer = null;
        expandGlance(target);
        return;
      }
      num.textContent = String(left);
      sub.textContent = t("blockedCountdown", String(left));
    }, 1000);
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "glance-close-request") closeGlance();
    else if (msg.type === "glance-blocked") showBlocked(msg.url);
    else if (msg.type === "glance-url" && current) {
      current.setUrl(msg.url);
      current.sawUrl = true;
      current.retry = null; // the page we asked for has answered
    }
    else if (msg.type === "glance-nav" && current) {
      current.retry = null; // a fresh click starts a new attempt
      navTry = { url: msg.url, at: Date.now() };
      maybeBlockedNav();
    }
  });
})();
