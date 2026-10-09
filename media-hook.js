"use strict";

/*
 * Zenify media hook. Runs in the page's own JavaScript world (manifest "world": "MAIN")
 * so it can see <audio>/<video> elements that are never attached to the DOM
 * (Spotify, for example) and read navigator.mediaSession. It talks to
 * media-bridge.js through DOM events that carry JSON strings.
 */
(() => {
  const FLAG = Symbol.for("zenify.media");
  if (window[FLAG]) return;
  window[FLAG] = true;

  const UP = "zenify-media-up";
  const DOWN = "zenify-media-down";
  const EVENTS = [
    "play", "playing", "pause", "ended", "emptied", "seeked",
    "volumechange", "ratechange", "durationchange", "loadedmetadata", "timeupdate",
  ];
  const HEARTBEAT = 5000;

  // Previous/next cannot be triggered through the page's media session, so the
  // site's own buttons are clicked. Top frame only.
  const SITES = [
    { host: /(^|\.)music\.youtube\.com$/, prev: "ytmusic-player-bar .previous-button", next: "ytmusic-player-bar .next-button" },
    { host: /(^|\.)youtube\.com$/, prev: ".ytp-prev-button", next: ".ytp-next-button" },
    { host: /(^|\.)spotify\.com$/, prev: '[data-testid="control-button-skip-back"]', next: '[data-testid="control-button-skip-forward"]' },
  ];

  const infoOf = new WeakMap();
  const byId = new Map();
  let nextId = 1;
  let lastPlayed = null;

  const post = (obj) => {
    try {
      window.dispatchEvent(new CustomEvent(UP, { detail: JSON.stringify(obj) }));
    } catch (_) {
      // ignore
    }
  };

  function navButton(dir) {
    if (window !== window.top) return null;
    const site = SITES.find((s) => s.host.test(location.hostname));
    return site ? document.querySelector(site[dir]) : null;
  }
  const usable = (b) =>
    !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true" && b.getClientRects().length > 0;

  function snapshot(el, info) {
    const md = lastPlayed === el && navigator.mediaSession ? navigator.mediaSession.metadata : null;
    let artwork = "";
    if (md && md.artwork && md.artwork.length) artwork = md.artwork[md.artwork.length - 1].src || "";
    return {
      id: info.id,
      title: (md && md.title) || document.title || location.hostname,
      artist: md ? md.artist || md.album || "" : "",
      artwork,
      paused: el.paused,
      currentTime: el.currentTime,
      duration: el.duration,
      rate: el.playbackRate,
      volume: el.volume,
      muted: el.muted,
      isVideo: el.localName === "video",
      hasPrev: usable(navButton("prev")),
      hasNext: usable(navButton("next")),
    };
  }

  function flush(el) {
    const info = infoOf.get(el);
    if (!info) return;
    info.timer = null;
    info.sent = Date.now();

    // Only media that has actually been audible counts (muted autoplay loops don't).
    if (!info.eligible && !el.paused && !el.muted && el.volume > 0 && el.mozHasAudio !== false) {
      info.eligible = true;
    }
    if (!info.eligible) return;

    if (el.ended || (!el.currentSrc && !el.srcObject)) {
      if (info.announced) {
        info.announced = false;
        post({ id: info.id, removed: true });
      }
      return;
    }
    info.announced = true;
    post(snapshot(el, info));
  }

  // State changes are flushed in a microtask, not a timer: tabs in the background
  // throttle setTimeout to about once a second, which made pause/seek updates late.
  function schedule(el, delay = 0) {
    const info = infoOf.get(el);
    if (!info || info.timer) return;
    if (delay > 0) {
      info.timer = setTimeout(() => flush(el), delay);
    } else {
      info.timer = true;
      Promise.resolve().then(() => flush(el));
    }
  }

  function onEvent(el, type) {
    const info = infoOf.get(el);
    if (!info) return;
    if (type === "play" || type === "playing") lastPlayed = el;
    if (type === "timeupdate") {
      if (!el.paused && Date.now() - info.sent >= HEARTBEAT) schedule(el, 0);
      return;
    }
    schedule(el);
    if (type === "loadedmetadata" || type === "emptied") setTimeout(() => schedule(el, 0), 1500);
  }

  function track(el) {
    if (!(el instanceof HTMLMediaElement) || infoOf.has(el)) return;
    const info = { id: String(nextId++), eligible: false, announced: false, timer: null, sent: 0 };
    infoOf.set(el, info);
    byId.set(info.id, typeof WeakRef === "function" ? new WeakRef(el) : { deref: () => el });
    for (const type of EVENTS) el.addEventListener(type, () => onEvent(el, type));
    onEvent(el, "track");
  }

  // Elements created by script and never inserted: caught when play() is called.
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    try {
      track(this);
    } catch (_) {
      // ignore
    }
    return origPlay.apply(this, args);
  };

  // Elements in the page that start on their own (autoplay).
  for (const type of ["play", "playing"]) {
    window.addEventListener(
      type,
      (e) => {
        if (e.target instanceof HTMLMediaElement) track(e.target);
      },
      true
    );
  }

  const scan = () => document.querySelectorAll("audio, video").forEach(track);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan, { once: true });
  else scan();

  window.addEventListener(DOWN, (e) => {
    let m;
    try {
      m = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    if (!m || typeof m !== "object") return;

    if (m.cmd === "resync") {
      for (const ref of byId.values()) {
        const el = ref.deref();
        if (el) schedule(el, 0);
      }
      return;
    }

    const ref = byId.get(String(m.id));
    const el = ref && ref.deref();
    if (!el) return;
    const value = Number(m.value);

    switch (m.cmd) {
      case "play":
        el.play().catch(() => {});
        break;
      case "pause":
        el.pause();
        break;
      case "seek":
        if (Number.isFinite(value)) el.currentTime = Math.max(0, value);
        break;
      case "volume":
        if (Number.isFinite(value)) {
          el.volume = Math.min(1, Math.max(0, value));
          if (el.volume > 0) el.muted = false;
        }
        break;
      case "mute":
        el.muted = !el.muted;
        break;
      case "prev":
      case "next": {
        const b = navButton(m.cmd);
        if (usable(b)) b.click();
        break;
      }
      default:
    }
  });
})();
