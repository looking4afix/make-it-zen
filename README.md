# Make it Zen

Zen-inspired touches for Firefox.

**[Install it from Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/make-it-zen/)**

- **Copy tab URL** (default `Ctrl+Shift+C`): copies the active tab's URL and shows a small pill at the top of the page. On pages where extensions can't inject (about:, addons.mozilla.org, PDF viewer), a ✓ badge flashes on the toolbar icon instead.
- **Glance**: `Alt+click` a link to preview it in a rounded overlay with a URL header. `Esc`, the ✕ button or a click outside closes it; "Open tab" opens it in a normal tab.
- **Blocked sites**: if the preview can't be shown (a network error, a site that still refuses framing, or the current page's own CSP forbidding the link), a card explains what happened and offers "Open in new tab" or "Cancel". Nothing opens on its own.

- **Back shortcut**: `Alt+Left` (`Cmd+[` on macOS) closes the Glance preview, or closes a tab opened from another tab (while it is still on its first page) and returns to the opener. Map your mouse Back button to `Alt+Left` in the mouse software (Logi Options+, etc.) to use it from the mouse. Works while the page has focus, not from the address bar.

- **Make it Zen sidebar**: open the Make it Zen button in Firefox's sidebar to see every tab that is playing audio or video: title, artist/channel, artwork with the site's favicon, play/pause, timeline, volume/mute, and a click to jump to the tab. The ✕ on a card pauses that media and hides the card until it plays again; "Close paused" in the list header does the same for every paused card. Finished WhatsApp Web voice messages disappear from the list. Long titles scroll in a loop only while they don't fit. In a narrow sidebar the volume slider moves into a small popup above the speaker button. The panel takes its colours from the current Firefox theme (light/dark from the system when the theme defines none). The Players list and a Settings block (pinned to the bottom) are both collapsible. Previous/next work on YouTube, YouTube Music and Spotify Web (they click the site's own buttons). A ♪ badge on the toolbar icon shows while something plays. Muted autoplay videos are ignored.

Settings (sidebar bottom block, or the toolbar icon): enable/disable each feature, Glance modifier key, panel size, sharing your sign-in with Glance previews (experimental), and the what's-new page shown after updates (`release-notes.html`).

Running a local copy, tests and logs? See: [DEBUGGING.md](DEBUGGING.md).

## Known limitations

- Make it Zen is a Manifest V2 extension on purpose: Firefox lets MV2 extensions edit response headers (blocking `webRequest`), which Glance needs, and MV3 extensions cannot do that reliably.
- Glance uses an iframe. To let pages render, Make it Zen removes `X-Frame-Options` and any `Content-Security-Policy` header that carries `frame-ancestors` (Firefox merges rewritten CSPs with the original, so the header has to go entirely), only for the Glance frame of the tab that opened it (and, for sites with a service worker, for that frame's requests to the same host while Glance is open). Other CSP headers are left alone.
- Firefox keeps a site's cookies apart when it is shown inside another site (Total Cookie Protection), so a Glance preview can look signed out. With *Share my sign-in with Glance previews* on, the first click inside a preview asks Firefox for storage access (the Storage Access API) and, if it is granted, the sign-in is available from then on. A link you click opens signed in; a click anywhere else reloads the preview once. This repeats every time Glance opens, because the access belongs to the page that asked for it. Turning off Enhanced Tracking Protection for the page you are on also works but is a much bigger change.
- Firefox does not deliver the mouse Back/Forward buttons (X1/X2) to pages or extensions ([bug 1720538](https://bugzilla.mozilla.org/show_bug.cgi?id=1720538)), so the extension can only react to the keyboard shortcut. A history-marker approach was tried and dropped: Firefox skips entries without user interaction and sites such as YouTube reload on `popstate`.
- The player lives in the sidebar: extensions cannot draw over the tab strip like Zen's media controller. Previous/next are site-specific selectors and can break when a site changes; everything else works on any `<audio>`/`<video>`.
- A true Zen-style Glance (a real browser tab as overlay) needs browser-level code and can't be done from an extension.

## Get it

Make it Zen is published on **[Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/make-it-zen/)**, and Firefox keeps it up to date. It is an independent project, not affiliated with Zen Browser or Mozilla.

- **Ideas and questions:** [Discussions](https://github.com/looking4afix/make-it-zen/discussions)
- **Something broken?** [Report a bug](https://github.com/looking4afix/make-it-zen/issues/new?template=bug_report.yml)

## License

CC0 1.0 Universal (public domain dedication). See `LICENSE`.
