"use strict";

/*
 * Zenify media bridge (content-script world). Relays between media-hook.js
 * (page world, DOM events) and the extension (runtime messages).
 */
(() => {
  const UP = "zenify-media-up";
  const DOWN = "zenify-media-down";
  let enabled = true;

  browser.storage.sync
    .get({ mediaEnabled: true })
    .then((s) => {
      enabled = !!s.mediaEnabled;
    })
    .catch(() => {});
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.mediaEnabled) enabled = !!changes.mediaEnabled.newValue;
  });

  const down = (obj) => window.dispatchEvent(new CustomEvent(DOWN, { detail: JSON.stringify(obj) }));

  window.addEventListener(UP, (e) => {
    if (!enabled) return;
    let player;
    try {
      player = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    if (!player || typeof player !== "object") return;
    browser.runtime.sendMessage({ type: "media-update", player }).catch(() => {});
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "media-cmd") down({ cmd: msg.action, id: msg.id, value: msg.value });
    else if (msg.type === "media-resync") down({ cmd: "resync" });
  });

  window.addEventListener("pagehide", () => {
    browser.runtime.sendMessage({ type: "media-clear" }).catch(() => {});
  });
})();
