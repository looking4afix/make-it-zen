# Glance: signed-in state is inconsistent inside the iframe

Status: cause narrowed down. Not blocking the 0.8.0 review.

**Result of experiment 1 (2026-10-20):** turning Enhanced Tracking Protection off for the top-level
page makes the preview signed in, so it is state partitioning (hypothesis A).

**Decision:** only the Storage Access API route is pursued (`document.requestStorageAccess()`
from the Glance frame on the first click inside it, then reload the frame). Copying cookies between
partitions is rejected for good: it would defeat the browser's protection and open clickjacking.
Implemented in 0.8.1 as the setting `sessionAccess` (default on); results of testing go below.

### Test log for the 0.8.1 storage-access build
Tested 2026-10-20 (YouTube channel opened in Glance from a mozilla.org page, signed in on youtube.com):
- `requestStorageAccess()` works from the content script of the Glance frame, on the first `pointerdown`.
- Firefox granted it without a prompt (the user had interacted with youtube.com as a top-level site).
- After the grant and a reload of the frame, `hasStorageAccess()` is true and the page is signed in.
- A click on a link right after the grant opens the video signed in (likes, comments and history work).
- The grant does not carry over to the next Glance: each new frame document starts with
  `hasStorageAccess() === false` and has to ask again, so the first non-link click always costs one reload.
- Not done (decided to ship as is): reload only if cookies changed; loading veil during the reload.
  Revisit if it turns out to bother people.

## What was observed (Firefox 157, Windows, Total Cookie Protection on)

1. Glance on a YouTube channel (opened from a page on another site, e.g. firefox.com):
   - First open: shows the signed-out page ("Fazer login").
   - Close Glance and open it again: the header shows the user's avatar and the
     subscribed state, but the left menu still says "Faça login para curtir vídeos...".
2. Clicking "Premium" inside the Glance (a navigation inside the frame) shows a fully
   signed-out page.
3. The same link in a normal tab is signed in.

So the session is not simply "always missing": it appears partially, and is lost again on
navigations. That is what needs explaining.

## Hypotheses

A. **State partitioning (Total Cookie Protection).** Cookies in the iframe live in a jar
   keyed by the top-level site (firefox.com + youtube.com), separate from the one in a normal
   YouTube tab. Anything signed-in in that jar was created in the iframe itself
   (`accounts.youtube.com/RotateCookiesPage` showed up in the first log).
B. **SameSite.** Lax/Strict cookies are not sent on cross-site subframe requests, so the
   document request is signed-out while JS calls made from the page (SameSite=None)
   are signed-in. This would explain the "avatar yes, menu no" mix.
C. **Who started the navigation.** Navigations started by the extension
   (`frame.src = url` retry, see glance.js `maybeBlockedNav`) may be classified differently
   (Sec-Fetch-Site, triggering principal) from clicks made by the user in the frame.
D. **Service worker path.** The first load is answered by the site's service worker (tabId -1,
   see `glanceWantsBackground` in background.js); later loads may take the network path.

## Experiments, in order

Each one answers a question; stop when the cause is clear.

1. **Turn off Enhanced Tracking Protection for the top-level page** (shield icon in the
   address bar, on the page the Glance opens over), open Glance, check the session on
   first open and after clicking "Premium".
   - Signed in everywhere now → hypothesis A (partitioning). Nothing the extension can
     do cleanly; document it.
   - Still the same → A is not the main cause.
2. **Cookie diagnostics** (this folder, `debug-cookies.js`):
   1. In `manifest.json`, `background.scripts` becomes
      `["background.js", "dev-notes/debug-cookies.js"]`. Reload the add-on.
   2. Open the background console (about:debugging → Inspect) and filter on `zen-cookies`.
   3. Reproduce: Glance on a YouTube channel (first open), close, open again, click Premium.
   4. Compare the `REQ` lines of the signed-in and the signed-out loads:
      - `cookies(N)=...` — are the login cookies (SID, SAPISID, __Secure-*PSID, LOGIN_INFO)
        sent on the document request? Names only are logged, never values.
      - `site=` / `dest=` / `mode=` — how Firefox classified the request.
      - `RES set-cookie=NAME[SameSite,P]` — what the site sets and whether it is partitioned.
   5. Remove the line from the manifest afterwards.
   Reading the result:
   - Login cookies missing on the signed-out document request, present on the signed-in
     one → partition/SameSite; compare which load differs (extension-started vs user click).
   - Same cookies in both but different pages → the difference is on the site side
     (e.g. service-worker cache); look at the `tab=-1` lines.
3. **Clean profile** (about:profiles) with only Make it Zen: rules out other extensions
   (a second add-on that touches cookies or headers).
4. **Reload the frame instead of reopening Glance**: if a reload of the iframe alone fixes
   the first-open case, an automatic single reload could be considered. Only if A is ruled
   out and the cause is a timing/cookie-rotation issue; do not add it blindly.

## Ideas that were considered and rejected for now

- Copying cookies between partitions with the `cookies` API: sensitive, needs the
  `cookies` permission and is invasive for a store review. Not doing this.
- Hiding the problem with a "Sign in" banner: no.

## When there is a solution (version 0.8.1)

- [ ] Fix, if any, in `glance.js` / `background.js`.
- [ ] README "Known limitations": replace the line about third-party cookie protection with
      what was actually found.
- [ ] Remove `gecko_android` from `manifest.json` (the sidebar, Alt+click and the keyboard
      shortcuts do not exist on Android, so the "Available on Firefox for Android" badge on
      the AMO page is misleading). Also search the README for Android mentions.
- [ ] Bump `version` in `manifest.json` and `package.json`, run the three test suites and
      `npm run lint`, `npm run build`, upload to AMO, tag `v0.8.1`.
- [ ] Optional: store screenshots can be changed in the Developer Hub without a new version.
