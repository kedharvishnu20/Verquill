// Loads content/injector.js into a jsdom page so its step handlers can be
// exercised against a real DOM.
//
// injector.js is a classic content script, not a module: it has no exports, it
// builds a shadow host at load, and it ends with a dynamic import of the
// overlay engine. So it is evaluated in the page context with `chrome` stubbed
// and a small epilogue that publishes the handlers under test.
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const SOURCE = new URL("../../content/injector.js", import.meta.url);

/** Functions the harness exposes to tests. Extend as more come under test. */
const EXPOSED = [
  "_executeStep",
  "_stepClick",
  "_stepUploadActivity",
  "_stepExtract",
  "_stepIfElse",
  "_queryScoped",
  "_activateSelectorPicker",
  "_stepFill",
  "_honeypotReason",
  "_stepSelect",
  "_stepKeyboard",
  "_stepScroll",
  "_stepWait",
  "_stepPaginate",
  "_stepHover",
  "_buildScopedSelector",
  "_buildSelector",
  "_buildNthPath",
  "_buildBulkSelector",
];

/**
 * jsdom has no layout engine: every getBoundingClientRect is 0x0, and
 * scrollIntoView / elementsFromPoint are absent. injector's click path treats a
 * zero-sized element as non-interactable and would refuse to click anything, so
 * give the page enough geometry to behave like a rendered one.
 *
 * Elements are laid out as a simple vertical stack: each gets a 100x20 box, and
 * elementsFromPoint returns nothing so _resolveTopmostAtCenter falls back to the
 * element it was given.
 */
function stubLayout(window) {
  const { Element, HTMLElement, document } = window;

  Element.prototype.scrollIntoView = function () {};
  Element.prototype.getBoundingClientRect = function () {
    const index = [...document.querySelectorAll("*")].indexOf(this);
    const top = Math.max(0, index) * 24;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      width: 100,
      height: 20,
      right: 100,
      bottom: top + 20,
      toJSON() {
        return this;
      },
    };
  };
  if (!HTMLElement.prototype.focus.__stubbed) {
    HTMLElement.prototype.focus = function () {};
    HTMLElement.prototype.focus.__stubbed = true;
  }
  document.elementsFromPoint = () => [];
}

/**
 * The drag-and-drop constructors jsdom does not implement.
 *
 * jsdom has `File` but neither `DataTransfer` nor `DragEvent`, so the drop
 * path throws `DataTransfer is not defined` before it does anything — which
 * says nothing about whether the code is right.
 *
 * These are as small as the code under test needs and no smaller: `types`
 * reporting "Files" matters, because a real dropzone checks it before
 * accepting, and `defaultPrevented` matters, because that is the signal the
 * step reads to decide whether the page took the files. What they cannot show
 * is whether a real browser delivers the sequence the same way — that is what
 * the end-to-end check in a real Chromium is for.
 */
function stubDragAndDrop(window) {
  if (!window.DataTransfer) {
    window.DataTransfer = class DataTransfer {
      constructor() {
        this._files = [];
        this.dropEffect = "none";
        this.effectAllowed = "all";
        this.items = {
          add: (file) => {
            this._files.push(file);
            return file;
          },
        };
      }
      get files() {
        return this._files;
      }
      get types() {
        return this._files.length ? ["Files"] : [];
      }
    };
  }
  if (!window.DragEvent) {
    window.DragEvent = class DragEvent extends window.MouseEvent {
      constructor(type, init = {}) {
        super(type, init);
        this.dataTransfer = init.dataTransfer ?? null;
      }
    };
  }
  // `input.files = dt.files` is the whole mechanism of the file-input mode.
  // jsdom's setter type-checks for a real FileList, which the DataTransfer
  // above cannot produce — so the assignment throws for a reason that has
  // nothing to do with the code. Replaced rather than conditionally patched:
  // jsdom does define a setter, it just refuses our stand-in.
  const original = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "files",
  );
  Object.defineProperty(window.HTMLInputElement.prototype, "files", {
    configurable: true,
    get() {
      return "_vqFiles" in this ? this._vqFiles : original?.get?.call(this);
    },
    set(value) {
      Object.defineProperty(this, "_vqFiles", {
        value,
        configurable: true,
        writable: true,
      });
    },
  });
}

/**
 * Build a page and load injector.js into it.
 *
 * @param {string} html - body markup for the page under test
 * @returns {Promise<{ window: Window, document: Document, api: Record<string, Function>, close: () => void }>}
 */
export async function loadInjector(html = "") {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://example.test/page",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;

  // Minimal extension surface. The harness never exercises messaging; these
  // exist so module-scope setup does not throw on load.
  window.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: { addListener() {} },
      sendMessage: () => Promise.resolve(),
      lastError: null,
    },
  };

  stubLayout(window);
  stubDragAndDrop(window);

  let source = await readFile(SOURCE, "utf8");

  // Drop the trailing overlay-engine bootstrap: it is a dynamic import of an ES
  // module, which is not resolvable inside a classic-script evaluation.
  source = source.replace(
    /import\(chrome\.runtime\.getURL\("content\/overlay-engine\.js"\)\)[\s\S]*?\}\);\s*$/,
    "",
  );

  // injector.js is wrapped in an IIFE so a second evaluation cannot collide with
  // its own top-level bindings, which means the export has to go *inside* that
  // function — appended to the file it would see none of these names.
  const close = source.lastIndexOf("})();");
  assert.ok(close !== -1, "injector.js is no longer wrapped in an IIFE");
  source =
    source.slice(0, close) +
    `\n;globalThis.__vqTestApi = { ${EXPOSED.join(", ")} };\n` +
    source.slice(close);

  const context = dom.getInternalVMContext();
  vm.runInContext(source, context, { filename: "injector.js" });

  return {
    window,
    document: window.document,
    api: window.__vqTestApi,
    close: () => window.close(),
  };
}
