# Debugging Make it Zen

For regular use, install Make it Zen from **[Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/make-it-zen/)**. This page is for running a local copy to test changes or track down a bug.

## Use a clean Firefox profile

Other extensions can change the same things Make it Zen does (response headers, shortcuts, media elements), so test in a profile with no other extensions:

- **Easiest:** `web-ext run` (below) starts Firefox with a new temporary profile each time.
- **By hand:** open `about:profiles` → *Create a New Profile*, then *Launch profile in new browser*.

If the AMO version is installed in the profile you test in, the local copy replaces it until Firefox restarts (both use the same add-on ID).

## Load the local copy

- `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → pick `manifest.json`. After editing files, press *Reload* on the add-on's card and reload the tabs you test in (content scripts are only injected on page load).
- Or, with Node.js: `npm install`, then `npm run run`. It opens a clean temporary profile and reloads the add-on when files change.

If `Ctrl+Shift+C` doesn't fire, DevTools may be taking it: `about:addons` → gear → *Manage Extension Shortcuts*.

## Tests and lint

```
npm install
npm test
npm run lint
```

`npm test` needs no Firefox: `background.js` runs in a Node `vm` and the content scripts in jsdom, each with a fake `browser` object. `npm run lint` runs Mozilla's add-ons linter, the same validator AMO runs on upload. `web-ext` and `jsdom` are dev dependencies only: they never go into the zip.

## Logs

Logging is off in release builds. Set `DEBUG = true` in `background.js` (and set it back before committing), reload the add-on, then open `about:debugging` → This Firefox → Make it Zen → *Inspect* → Console. Lines start with `[zenify]`; every message from a page or the sidebar appears as `message <type> tab <id>`.

### Glance

- `glance registered …` — Alt+click opened a preview.
- `glance frame … removed: [...]` — headers were stripped for the preview (`glance (service worker) frame …` for sites such as YouTube that answer through a service worker).
- `sub_frame NOT matched …` — a frame loaded while Glance was open but wasn't recognised as the preview (shows what was expected).
- `sub_frame error … <ERROR>` — the preview failed (framing refused, DNS, TLS…); this is what shows the "can't be previewed" card.
- `content tab N storage-access <host> …` — the Storage Access request made by the preview (sign-in sharing).
- `glance-expand opening …` / `glance-expand refused …` — the "Open tab" button.
- `back-close tab N openerTabId=…` — Alt+Left closed a tab opened from another one.

For sign-in problems, `dev-notes/debug-cookies.js` logs cookie names (never values) and the `Sec-Fetch-*` headers of preview requests: add it after `background.js` in `background.scripts` in `manifest.json`, and remove it again afterwards. Background: `dev-notes/session-investigation.md`.

### Players sidebar

- `message media-update tab N` — a page reported a player change; `message media-control tab undefined` is a button pressed in the sidebar (the sidebar has no tab).
- `extension page sidebar theme: {...} properties: {...} prefersDark=…` — the Firefox theme colours the sidebar received; `theme variant mismatch: swapping colours, usable=…` means the theme only exposed its light variant while Firefox is dark (or the reverse) and the sidebar swapped background and text. Useful when the sidebar colours look wrong with a theme.
- A player that never shows up was probably never audible: muted autoplay loops are ignored on purpose. On `web.whatsapp.com` a voice message that has finished is hidden until it plays again (WhatsApp rewinds it to 0:00).
- The players themselves are read in the page (`media-hook.js` runs in the page's own world): to check what a site exposes, open that tab's DevTools and inspect its `<audio>`/`<video>` elements.
- To inspect the sidebar page, open `about:debugging` → Make it Zen → *Inspect* and choose `player.html` in the frame picker (the iframe icon in the toolbox).

### Copy URL

No logs: on pages where extensions can't inject (about:, addons.mozilla.org, the PDF viewer) a ✓ badge on the toolbar icon replaces the toast, and a red `!` badge means the clipboard write failed.

## Build

`npm run build` writes the zip to `dist/`. Check that `manifest.json` is at the root of the zip and that development files (tests, notes, screenshots, package files) are not in it.
