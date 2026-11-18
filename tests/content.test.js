"use strict";
// Runs glance.js in jsdom with a fake `browser`.
const test = require("node:test");
const assert = require("node:assert");
const { JSDOM } = require("jsdom");
const { read, sleep } = require("./helpers");

const code = read("glance.js");

function makeWindow({ name = "", settings = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><body><a id="l" href="https://github.com/google">link</a></body>`, {
    url: "https://www.google.com/search?q=github",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.name = name;
  const orig = window.Element.prototype.attachShadow; // make the closed shadow root inspectable
  window.Element.prototype.attachShadow = function (init) {
    return orig.call(this, { ...init, mode: "open" });
  };
  const sent = [];
  const onMessage = [];
  window.browser = {
    storage: { sync: { get: async (d) => ({ ...d, ...settings }) }, onChanged: { addListener() {} } },
    i18n: { getMessage: (k) => k },
    runtime: {
      sendMessage: async (msg) => (sent.push(msg), { ok: true, eligible: true }),
      onMessage: { addListener: (fn) => onMessage.push(fn) },
    },
  };
  window.eval(code);
  const deliver = (msg) => onMessage.forEach((fn) => fn(msg));
  return { window, sent, deliver };
}
const shadowOf = (w) => [...w.document.documentElement.children].find((n) => n.shadowRoot)?.shadowRoot;
const click = (w, el, init) =>
  el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0, ...init }));

test("Alt+click opens the overlay; a plain click does not", async () => {
  const { window, sent } = makeWindow();
  await sleep(20);
  click(window, window.document.getElementById("l"));
  assert(!shadowOf(window), "plain click: nothing");
  click(window, window.document.getElementById("l"), { altKey: true });
  await sleep(30);
  const root = shadowOf(window);
  assert(root, "overlay shown");
  assert.strictEqual(root.querySelector(".domain").textContent, "github.com");
  assert(sent.some((m) => m.type === "glance-register" && m.url === "https://github.com/google"));
});

test("Glance frame: first pointerdown asks for storage access once", async () => {
  const mk = (settings) => {
    const { window: parent, sent } = makeWindow({ settings });
    const iframe = parent.document.createElement("iframe");
    parent.document.body.appendChild(iframe);
    const w = iframe.contentWindow;
    w.name = "zenify-glance-z";
    w.browser = parent.browser;
    const calls = { req: 0 };
    w.document.hasStorageAccess = async () => false;
    w.document.requestStorageAccess = async () => void calls.req++;
    w.eval(code);
    w.document.body.innerHTML = '<a id="x" href="https://pt.wikipedia.org/">pt</a><p id="p">text</p>';
    return { w, sent, calls };
  };
  const down = (w, el) => el.dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true, composed: true }));

  let f = mk({});
  await sleep(30);
  down(f.w, f.w.document.getElementById("x")); // a link: asks, but does not reload over the navigation
  await sleep(30);
  assert.strictEqual(f.calls.req, 1);
  assert(f.sent.some((m) => m.type === "debug" && /not reloading/.test(m.args.join(" "))));
  down(f.w, f.w.document.getElementById("p"));
  await sleep(20);
  assert.strictEqual(f.calls.req, 1, "once per document");

  f = mk({});
  await sleep(20);
  down(f.w, f.w.document.getElementById("p"));
  await sleep(30);
  assert(f.sent.some((m) => m.type === "debug" && /granted, reloading/.test(m.args.join(" "))));

  f = mk({ sessionAccess: false });
  await sleep(20);
  down(f.w, f.w.document.getElementById("p"));
  await sleep(20);
  assert.strictEqual(f.calls.req, 0, "setting off: never asks");
});

test("Glance frame: a click on a link is announced to the top frame", async () => {
  const { window: parent, sent } = makeWindow();
  const iframe = parent.document.createElement("iframe");
  parent.document.body.appendChild(iframe);
  const w = iframe.contentWindow;
  w.name = "zenify-glance-y";
  w.browser = parent.browser;
  w.eval(code);
  w.document.body.innerHTML = '<a id="x" href="https://pt.wikipedia.org/">pt</a>';
  click(w, w.document.getElementById("x"));
  assert(sent.some((m) => m.type === "glance-nav" && m.url === "https://pt.wikipedia.org/"));
});

test("Blocked site: explanation and two buttons, nothing opens by itself", async () => {
  const { window, sent, deliver } = makeWindow();
  await sleep(20);
  click(window, window.document.getElementById("l"), { altKey: true });
  await sleep(30);
  deliver({ type: "glance-blocked", url: "https://github.com/google" });
  const root = shadowOf(window);
  const card = root.querySelector(".blocked");
  assert(card, "card shown");
  assert.strictEqual(card.querySelector(".title").textContent, "blockedTitle");
  assert.strictEqual(card.querySelector(".sub").textContent, "blockedText");
  assert.deepStrictEqual([...card.querySelectorAll("button")].map((b) => b.title), ["blockedOpenTab", "blockedCancel"]);
  assert(!card.querySelector(".ring"), "no countdown");
  await sleep(50);
  assert(!sent.some((m) => m.type === "glance-expand"), "does not open on its own");
  click(window, card.querySelector("button.primary"));
  await sleep(10);
  assert(sent.some((m) => m.type === "glance-expand" && m.url === "https://github.com/google"));
});

// media-hook.js runs in the page world and talks through DOM events.
function mediaPage(url) {
  const dom = new JSDOM("<!doctype html><body></body>", { url, runScripts: "outside-only" });
  const { window } = dom;
  const posts = [];
  window.addEventListener("zenify-media-up", (e) => posts.push(JSON.parse(e.detail)));
  window.eval(read("media-hook.js"));
  const audio = window.document.createElement("audio");
  const state = { paused: true, ended: false, currentTime: 0 };
  for (const k of Object.keys(state)) Object.defineProperty(audio, k, { get: () => state[k] });
  Object.defineProperty(audio, "currentSrc", { get: () => "blob:" + url });
  Object.defineProperty(audio, "duration", { get: () => 12 });
  window.document.body.appendChild(audio);
  const fire = (type) => audio.dispatchEvent(new window.Event(type));
  return { posts, state, fire };
}

test("Players: a finished WhatsApp audio is hidden until it plays again", async () => {
  const { posts, state, fire } = mediaPage("https://web.whatsapp.com/");
  state.paused = false;
  fire("play");
  await sleep(5);
  assert.strictEqual(posts.at(-1).paused, false, "announced while playing");
  // WhatsApp ends the audio and rewinds it: `ended` is false again at 0:00.
  state.paused = true;
  fire("ended");
  state.currentTime = 0;
  fire("seeked");
  await sleep(5);
  assert.strictEqual(posts.at(-1).removed, true, "removed when finished");
  const n = posts.length;
  fire("pause");
  await sleep(5);
  assert.strictEqual(posts.length, n, "stays hidden");
  state.paused = false;
  fire("play");
  await sleep(5);
  assert.strictEqual(posts.at(-1).paused, false, "back when it plays again");
});

test("Players: other sites keep a finished-and-rewound player", async () => {
  const { posts, state, fire } = mediaPage("https://example.org/");
  state.paused = false;
  fire("play");
  await sleep(5);
  state.paused = true;
  fire("ended");
  fire("seeked");
  await sleep(5);
  assert.strictEqual(posts.at(-1).paused, true, "still listed, paused");
});
