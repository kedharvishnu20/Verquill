// === sidepanel/overlay-panel.js ===
/**
 * @module overlay-panel
 * @description Renders the overlay preferences UI into the new Config view's accordion section.
 */
"use strict";

// Shared with the builder rather than reimplemented: talking to a page needs
// the same ensure-then-send dance and the same explanation when Chrome refuses
// the page, and a second copy of that is a second thing to keep correct.
import { _ensureContentReady, notify } from "./pipeline-builder.js";

const SK_PREFS = "vq_overlay_prefs";
const SK_PALETTE = "vq_zone_palette";

const DEFAULT_PREFS = {
  enabled: true,
  showInPreviewMode: true,
  showDuringRun: true,
  opacity: 0.28,
  showLabels: true,
  showMatchCount: true,
  pulseAnimation: true,
  autoFadeCompleted: true,
  fadeDelayMs: 2000,
  customPalette: null,
};

const DEFAULT_PALETTE = [
  "#3B82F6",
  "#10B981",
  "#F59E0B",
  "#8B5CF6",
  "#EF4444",
  "#06B6D4",
  "#EC4899",
  "#84CC16",
];

const PALETTE_NAMES = [
  "NAVIGATE",
  "EXTRACT",
  "FORM_FILL",
  "CLICK",
  "Error",
  "SCROLL",
  "WAIT",
  "PAGINATE",
];

let _prefs = { ...DEFAULT_PREFS };
let _palette = [...DEFAULT_PALETTE];

async function _loadPrefs() {
  const { [SK_PREFS]: p, [SK_PALETTE]: pal } = await chrome.storage.local.get([
    SK_PREFS,
    SK_PALETTE,
  ]);
  if (p) _prefs = { ...DEFAULT_PREFS, ...p };
  if (pal) _palette = pal;
  _renderPanel();
}

async function _savePrefs() {
  await chrome.storage.local.set({
    [SK_PREFS]: _prefs,
    [SK_PALETTE]: _palette,
  });
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: "overlay:reloadPrefs",
        payload: { prefs: _prefs },
      });
    }
  } catch {
    // Deliberately silent, unlike the preview button below. This fires on every
    // preference change, and a tab with no content script is the normal case
    // rather than a fault — the preferences are already saved to storage, and
    // this message only asks a page that happens to be listening to repaint
    // now. Warning here would mean a toast every time a checkbox moved.
  }
}

function _renderPanel() {
  const container = document.getElementById("overlay-panel-root");
  if (!container) return;

  container.innerHTML = `
    <!-- Master Toggle -->
    <div class="toggle-wrap" style="padding-bottom: 8px; border-bottom: 1px solid var(--bg-border); margin-bottom: 12px;">
      <input type="checkbox" id="ov-master" ${_prefs.enabled ? "checked" : ""}>
      <div class="toggle-switch"></div>
      <span style="font-weight: 600;">Master Overlay Feature</span>
    </div>

    <div class="flex gap-2 justify-between">
       <div class="toggle-wrap">
          <input type="checkbox" id="ov-show-preview" ${_prefs.showInPreviewMode ? "checked" : ""}>
          <div class="toggle-switch"></div>
          <span>Show on hover</span>
       </div>
       <div class="toggle-wrap">
          <input type="checkbox" id="ov-show-run" ${_prefs.showDuringRun ? "checked" : ""}>
          <div class="toggle-switch"></div>
          <span>Show on run</span>
       </div>
    </div>

    <label style="margin-top: 12px;" id="ov-opacity-label">Opacity: ${Math.round(_prefs.opacity * 100)}%</label>
    <input type="range" id="ov-opacity" min="5" max="80" step="1" value="${Math.round(_prefs.opacity * 100)}" style="width:100%; margin-bottom: 12px; accent-color: var(--accent);">

    <div class="grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        <div class="toggle-wrap">
            <input type="checkbox" id="ov-show-labels" ${_prefs.showLabels ? "checked" : ""}>
            <div class="toggle-switch"></div>
            <span>Labels</span>
        </div>
        <div class="toggle-wrap">
            <input type="checkbox" id="ov-pulse" ${_prefs.pulseAnimation ? "checked" : ""}>
            <div class="toggle-switch"></div>
            <span>Pulse FX</span>
        </div>
        <div class="toggle-wrap" style="grid-column: span 2;">
            <input type="checkbox" id="ov-auto-fade" ${_prefs.autoFadeCompleted ? "checked" : ""}>
            <div class="toggle-switch"></div>
            <span>Auto-fade (${_prefs.fadeDelayMs}ms)</span>
        </div>
    </div>

    <!-- Palette -->
    <label style="margin-top:16px;">Color Palette</label>
    <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:8px;margin-bottom:8px;">
        ${_palette
          .map(
            (color, i) => `
          <input type="color" id="ov-color-${i}" value="${color}" title="${PALETTE_NAMES[i] || "Zone " + i}"
          style="width:100%;height:24px;border:none;padding:0;cursor:pointer;border-radius:4px;background:none;">
        `,
          )
          .join("")}
    </div>
    
    <div class="flex justify-between gap-2 mt-4">
        <button class="btn" id="ov-reset-palette">↺ Reset</button>
        <button class="btn btn-primary" id="ov-preview-now" style="flex: 1;">👁 Preview All Matches</button>
    </div>
  `;

  _bindEvents();
}

function _bindEvents() {
  document
    .getElementById("ov-master")
    ?.addEventListener("change", async (e) => {
      _prefs.enabled = e.target.checked;
      await _savePrefs();
    });

  const cbMap = {
    "ov-show-preview": "showInPreviewMode",
    "ov-show-run": "showDuringRun",
    "ov-show-labels": "showLabels",
    "ov-pulse": "pulseAnimation",
    "ov-auto-fade": "autoFadeCompleted",
  };

  for (const [id, key] of Object.entries(cbMap)) {
    document.getElementById(id)?.addEventListener("change", async (e) => {
      _prefs[key] = e.target.checked;
      await _savePrefs();
    });
  }

  const opSlider = document.getElementById("ov-opacity");
  const opLabel = document.getElementById("ov-opacity-label");
  opSlider?.addEventListener("input", (e) => {
    const val = parseInt(e.target.value, 10);
    _prefs.opacity = val / 100;
    if (opLabel) opLabel.textContent = `Opacity: ${val}%`;
  });
  opSlider?.addEventListener("change", _savePrefs);

  _palette.forEach((_, i) => {
    document
      .getElementById(`ov-color-${i}`)
      ?.addEventListener("change", async (e) => {
        _palette[i] = e.target.value;
        _prefs.customPalette = [..._palette];
        await _savePrefs();
      });
  });

  document
    .getElementById("ov-reset-palette")
    ?.addEventListener("click", async () => {
      _palette = [...DEFAULT_PALETTE];
      _prefs.customPalette = null;
      await _savePrefs();
      _renderPanel();
    });

  document
    .getElementById("ov-preview-now")
    ?.addEventListener("click", async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id) {
        notify("warn-log", "No active tab to preview the overlay on.");
        return;
      }

      // Content scripts are injected on demand (C-09), so a tab that has never
      // had a pipeline run against it has nothing listening. Sending anyway
      // rejected with "Could not establish connection. Receiving end does not
      // exist." — uncaught, so it reached the console as a stack trace and the
      // button simply did nothing. Same ensure-then-send the selector picker
      // uses; _ensureContentReady already explains the pages Chrome refuses.
      if (!(await _ensureContentReady(tab.id))) return;

      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "overlay:setMode",
          payload: { action: "previewAll" },
        });
      } catch (err) {
        // Injection can succeed and the send still fail: the page navigated in
        // between, or it tore the script down. Worth saying, because the user
        // pressed a button and is owed an answer either way.
        notify(
          "error-log",
          `Could not show the overlay preview: ${err?.message || "the page stopped responding"}`,
        );
      }
    });
}

// Init when module loads
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _loadPrefs);
} else {
  _loadPrefs();
}
