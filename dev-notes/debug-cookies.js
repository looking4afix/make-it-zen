"use strict";

/*
 * Temporary diagnostics for the "signed in on first look, signed out after a click"
 * investigation (see session-investigation.md). NOT part of the release build:
 * dev-notes/ is excluded from the AMO zip.
 *
 * To use it, add "dev-notes/debug-cookies.js" AFTER "background.js" in the manifest's
 * background.scripts, reload the add-on, and read the logs in the background console.
 * Remove the line again afterwards.
 *
 * It logs, for sub-frame requests to the watched hosts, cookie NAMES only (never values),
 * the Sec-Fetch-* headers that say how the browser classified the request, and the
 * Set-Cookie names with their SameSite / Partitioned attributes.
 *
 * Change the watched hosts from the console: zenDbg.hosts = ["youtube.com", "google.com"]
 */
(() => {
  const zenDbg = (window.zenDbg = { hosts: ["youtube.com", "google.com"], seq: 0 });
  const watched = (u) => {
    try {
      const h = new URL(u).hostname;
      return zenDbg.hosts.some((w) => h === w || h.endsWith("." + w));
    } catch (_) {
      return false;
    }
  };
  const get = (headers, name) => {
    const h = (headers || []).find((x) => x.name.toLowerCase() === name);
    return h ? String(h.value || "") : "";
  };
  const short = (u) => String(u).replace(/^https:\/\//, "").slice(0, 90);
  const out = (...a) => console.log("[zen-cookies]", ...a);

  const cookieNames = (value) =>
    value
      .split(/;\s*/)
      .map((c) => c.split("=")[0])
      .filter(Boolean);

  browser.webRequest.onBeforeSendHeaders.addListener(
    (d) => {
      if (!watched(d.url)) return;
      const n = ++zenDbg.seq;
      const names = cookieNames(get(d.requestHeaders, "cookie"));
      out(
        `#${n} REQ`, short(d.url),
        `tab=${d.tabId} frame=${d.frameId} parent=${d.parentFrameId}`,
        `site=${get(d.requestHeaders, "sec-fetch-site") || "?"}`,
        `dest=${get(d.requestHeaders, "sec-fetch-dest") || "?"}`,
        `mode=${get(d.requestHeaders, "sec-fetch-mode") || "?"}`,
        `cookies(${names.length})=${names.join(",")}`
      );
    },
    { urls: ["<all_urls>"], types: ["sub_frame"] },
    ["requestHeaders"]
  );

  browser.webRequest.onHeadersReceived.addListener(
    (d) => {
      if (!watched(d.url)) return;
      const set = (d.responseHeaders || [])
        .filter((h) => h.name.toLowerCase() === "set-cookie")
        .map((h) => {
          const v = String(h.value || "");
          const name = v.split("=")[0];
          const same = (v.match(/samesite=(\w+)/i) || [])[1] || "-";
          const part = /;\s*partitioned/i.test(v) ? "P" : "";
          return `${name}[${same}${part ? "," + part : ""}]`;
        });
      out(`RES`, d.statusCode, short(d.url), `tab=${d.tabId} frame=${d.frameId}`, `set-cookie=${set.join(",") || "none"}`);
    },
    { urls: ["<all_urls>"], types: ["sub_frame"] },
    ["responseHeaders"]
  );

  out("ready; watching", zenDbg.hosts.join(", "));
})();
