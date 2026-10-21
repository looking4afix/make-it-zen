"use strict";

const DEFAULTS = {
  copyEnabled: true,
  glanceEnabled: true,
  glanceModifier: "alt",
  glanceSize: 85,
  backCloses: true,
  mediaEnabled: true,
  sessionAccess: true,
  showReleaseNotes: true,
};

const $ = (id) => document.getElementById(id);

for (const el of document.querySelectorAll("[data-i18n]")) {
  el.textContent = browser.i18n.getMessage(el.dataset.i18n);
}

async function load() {
  const s = await browser.storage.sync.get(DEFAULTS);
  $("copyEnabled").checked = !!s.copyEnabled;
  $("glanceEnabled").checked = !!s.glanceEnabled;
  $("backCloses").checked = !!s.backCloses;
  $("mediaEnabled").checked = !!s.mediaEnabled;
  $("sessionAccess").checked = !!s.sessionAccess;
  $("showReleaseNotes").checked = !!s.showReleaseNotes;
  $("glanceModifier").value = s.glanceModifier;
  $("glanceSize").value = s.glanceSize;
  $("sizeOut").textContent = `${s.glanceSize}%`;
}

function save() {
  const size = Number($("glanceSize").value);
  $("sizeOut").textContent = `${size}%`;
  return browser.storage.sync.set({
    copyEnabled: $("copyEnabled").checked,
    glanceEnabled: $("glanceEnabled").checked,
    glanceModifier: $("glanceModifier").value,
    glanceSize: size,
    backCloses: $("backCloses").checked,
    mediaEnabled: $("mediaEnabled").checked,
    sessionAccess: $("sessionAccess").checked,
    showReleaseNotes: $("showReleaseNotes").checked,
  });
}

for (const id of ["copyEnabled", "glanceEnabled", "glanceModifier", "glanceSize", "backCloses", "mediaEnabled", "sessionAccess", "showReleaseNotes"]) {
  $(id).addEventListener("input", save);
  $(id).addEventListener("change", save);
}

load();
