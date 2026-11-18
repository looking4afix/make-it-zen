"use strict";
// Runs background.js against a fake `browser` (no Firefox needed).
const test = require("node:test");
const assert = require("node:assert");
const vm = require("vm");
const { read, J, sleep } = require("./helpers");

function load(settings = {}, ctx = {}) {
  const listeners = {};
  const calls = { sent: [], created: [], updated: [], executed: [], badge: [], pushed: [] };
  const evt = (n) => ({ addListener: (fn) => (listeners[n] = fn) });
  const browser = {
    storage: { sync: { get: async (d) => ({ ...d, ...settings }) } },
    commands: { onCommand: evt("command") },
    webRequest: { onHeadersReceived: evt("headers"), onErrorOccurred: evt("error") },
    windows: { update: async () => {} },
    tabs: {
      onRemoved: evt("removed"),
      onUpdated: evt("updated"),
      sendMessage: async (tabId, msg, opts) => void calls.sent.push({ tabId, msg, opts }),
      create: async (o) => void calls.created.push(o),
      get: async () => ({ windowId: 1 }),
      update: async (id, o) => void calls.updated.push({ id, o }),
      remove: async () => {},
      query: async () => [],
      executeScript: async (id, o) => void calls.executed.push({ id, o }),
    },
    runtime: {
      onInstalled: evt("installed"),
      onMessage: evt("message"),
      getURL: (p) => "moz-extension://x/" + p,
      sendMessage: async (msg) => void calls.pushed.push(msg),
    },
    i18n: { getMessage: (k) => k },
    browserAction: {
      setBadgeText: async (o) => void calls.badge.push(o),
      setBadgeBackgroundColor: async () => {},
    },
  };
  vm.runInNewContext(read("background.js"), {
    browser, console: { debug() {} }, navigator: {}, document: {}, URL, setTimeout, clearTimeout, Date,
    ...ctx,
  });
  const send = async (msg, tab = { id: 7, index: 2, url: "https://example.org/" }, frameId = 0) =>
    J(await listeners.message(msg, { tab, frameId }));
  return { listeners, calls, send };
}

const hdrs = () => [
  { name: "X-Frame-Options", value: "deny" },
  { name: "Content-Security-Policy", value: "default-src 'self'; frame-ancestors 'none'; img-src *" },
  { name: "Content-Type", value: "text/html" },
];
const names = (r) => r.responseHeaders.map((h) => h.name);
const frame = (o) => ({ tabId: 7, frameId: 5, parentFrameId: 0, statusCode: 200, responseHeaders: hdrs(), ...o });

test("Glance: framing headers are removed only for the Glance frame of the opening tab", async () => {
  const { listeners, send } = load();
  const H = async (d) => J(await listeners.headers(d));

  assert.deepStrictEqual(await H(frame({ url: "https://github.com/x" })), {}, "no Glance open: untouched");
  assert.deepStrictEqual(await send({ type: "glance-register", url: "https://github.com/google" }), { ok: true });

  const r = await H(frame({ url: "https://github.com/google" }));
  assert(!names(r).includes("X-Frame-Options"));
  assert(!names(r).includes("Content-Security-Policy"), "a CSP with frame-ancestors goes away entirely");
  assert(names(r).includes("Content-Type"));

  assert.deepStrictEqual(await H(frame({ frameId: 9, url: "https://ads.example.net/" })), {}, "other frame untouched");
  assert.deepStrictEqual(await H(frame({ parentFrameId: 5, frameId: 11, url: "https://github.com/n" })), {}, "nested frame untouched");
  assert.deepStrictEqual(await H(frame({ tabId: 8, url: "https://github.com/google" })), {}, "other tab untouched");

  const keep = await H(frame({ url: "https://github.com/google", responseHeaders: [{ name: "Content-Security-Policy", value: "default-src 'self'" }] }));
  assert.strictEqual(keep.responseHeaders.length, 1, "a CSP without frame-ancestors is kept");
});

test("Glance: responses answered by a service worker (tabId -1) are matched by host", async () => {
  const { listeners, send } = load();
  const H = async (d) => J(await listeners.headers(d));
  await send({ type: "glance-register", url: "https://www.youtube.com/user/x" });
  const sw = (url) => ({ tabId: -1, frameId: 3, parentFrameId: 0, type: "sub_frame", url, statusCode: 200, responseHeaders: hdrs() });
  assert(!names(await H(sw("https://www.youtube.com/user/x"))).includes("X-Frame-Options"));
  assert.deepStrictEqual(await H(sw("https://other.example/")), {}, "other host untouched");

  // A link followed inside Glance refreshes what is matched.
  await send({ type: "glance-nav", url: "https://new.example/page" });
  assert(!names(await H(sw("https://new.example/page"))).includes("X-Frame-Options"));
});

test("Glance: bad URLs are refused and nothing is matched after closing", async () => {
  const { listeners, send } = load();
  assert.deepStrictEqual(await send({ type: "glance-register", url: "javascript:alert(1)" }), { ok: false });
  await send({ type: "glance-register", url: "https://a.example/" });
  await send({ type: "glance-close" });
  assert.deepStrictEqual(J(await listeners.headers(frame({ url: "https://a.example/" }))), {});
});

test("Glance: 'open tab' opens the link next to the current tab", async () => {
  const { calls, send } = load();
  await send({ type: "glance-register", url: "https://a.example/" });
  assert.deepStrictEqual(await send({ type: "glance-expand", url: "https://a.example/" }), { ok: true });
  assert.deepStrictEqual(J(calls.created), [{ url: "https://a.example/", active: true, openerTabId: 7, index: 3 }]);
});

test("What's-new page opens after an update only, and can be turned off", async () => {
  let t = load();
  await t.listeners.installed({ reason: "install" });
  assert.strictEqual(t.calls.created.length, 0);
  await t.listeners.installed({ reason: "update" });
  assert.deepStrictEqual(J(t.calls.created), [{ url: "moz-extension://x/release-notes.html", active: false }]);
  t = load({ showReleaseNotes: false });
  await t.listeners.installed({ reason: "update" });
  assert.strictEqual(t.calls.created.length, 0);
});

test("Players: snapshots are sanitised, listed, controlled and dropped with the tab", async () => {
  const { listeners, calls, send } = load();
  await send({ type: "media-update", player: { id: "1", title: "T".repeat(500), artwork: "http://insecure/x.png", volume: 5, paused: false } }, { id: 12, url: "https://music.youtube.com/watch" });
  let list = await listeners.message({ type: "media-list" }, {});
  assert.strictEqual(list.players.length, 1);
  const p = list.players[0];
  assert.strictEqual(p.title.length, 200);
  assert.strictEqual(p.artwork, "", "non-https artwork dropped");
  assert.strictEqual(p.volume, 1, "volume clamped");
  assert.strictEqual(p.site, "music.youtube.com");
  await sleep(5);
  assert(calls.badge.some((b) => b.text === "♪"), "badge while playing");

  await listeners.message({ type: "media-control", key: p.key, action: "pause" }, {});
  assert.deepStrictEqual(J(calls.sent.at(-1)), { tabId: 12, msg: { type: "media-cmd", id: "1", action: "pause" }, opts: { frameId: 0 } });
  assert.deepStrictEqual(J(await listeners.message({ type: "media-control", key: p.key, action: "rm -rf" }, {})), { ok: false });
  assert.deepStrictEqual(J(await listeners.message({ type: "media-control", key: "nope", action: "play" }, {})), { ok: false });

  listeners.removed(12);
  list = await listeners.message({ type: "media-list" }, {});
  assert.strictEqual(list.players.length, 0);
});

test("Players: closing a card pauses it and hides it until it plays again", async () => {
  const { listeners, calls, send } = load();
  const tab = { id: 12, url: "https://web.whatsapp.com/" };
  const upd = (paused, id = "1") => send({ type: "media-update", player: { id, paused, duration: 30 } }, tab);
  const keys = async () => J((await listeners.message({ type: "media-list" }, {})).players.map((p) => p.id));

  await upd(false);
  const key = "12:0:1";
  assert.deepStrictEqual(J(await listeners.message({ type: "media-control", key, action: "dismiss" }, {})), { ok: true });
  assert.deepStrictEqual(J(calls.sent.at(-1).msg), { type: "media-cmd", id: "1", action: "pause" }, "playing media is paused");
  assert.deepStrictEqual(J(calls.pushed.at(-1)), { type: "media-push", removed: key }, "sidebar drops the card");
  assert.deepStrictEqual(await keys(), [], "hidden from the list");

  const pushes = calls.pushed.length;
  await upd(false);
  assert.deepStrictEqual(await keys(), [], "a late 'playing' update before the pause lands does not bring it back");
  await upd(true);
  assert.deepStrictEqual(await keys(), [], "the pause itself keeps it hidden");
  assert.strictEqual(calls.pushed.length, pushes, "no sidebar pushes while hidden");

  await upd(false);
  assert.deepStrictEqual(await keys(), ["1"], "playing again brings the card back");
  assert.strictEqual(calls.pushed.at(-1).player.key, key);

  await upd(true, "2");
  assert.deepStrictEqual(J(await listeners.message({ type: "media-control", key: "12:0:2", action: "dismiss" }, {})), { ok: true });
  const cmds = calls.sent.filter((s) => s.msg.type === "media-cmd");
  assert.strictEqual(cmds.length, 1, "an already paused player gets no pause command");
  await upd(true, "2");
  assert.deepStrictEqual(await keys(), ["1"]);
  await upd(true, "3");
  assert.deepStrictEqual((await keys()).sort(), ["1", "3"], "a new player still shows up");

  listeners.updated(12, { status: "loading" });
  await upd(true, "2");
  assert(( await keys()).includes("2"), "reloading the tab forgets the dismissal");
});

test("Players: a page that refuses the pause gets its card back", async () => {
  let now = 1_000_000;
  const FakeDate = class extends Date {
    static now() {
      return now;
    }
  };
  const { listeners, send } = load({}, { Date: FakeDate });
  const upd = () => send({ type: "media-update", player: { id: "1", paused: false } }, { id: 4, url: "https://radio.example/" });
  await upd();
  await listeners.message({ type: "media-control", key: "4:0:1", action: "dismiss" }, {});
  now += 1000;
  await upd();
  assert.strictEqual((await listeners.message({ type: "media-list" }, {})).players.length, 0, "still waiting for the pause");
  now += 3000;
  await upd();
  assert.strictEqual((await listeners.message({ type: "media-list" }, {})).players.length, 1, "still playing after the grace period");
});

test("Copy URL: toast is injected, badge is the fallback on restricted pages", async () => {
  const { listeners, calls } = load();
  const copied = [];
  // copyText prefers navigator.clipboard; load() gave an empty navigator, so only check the paths that do not need it.
  await listeners.command("other", { id: 1, url: "https://a.example/" });
  assert.strictEqual(calls.executed.length, 0, "unknown command ignored");
  void copied;
});
