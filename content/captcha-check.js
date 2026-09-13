// === captcha-check.js ===
/**
 * @module captcha-check
 * @description Is a captcha standing between this run and the page?
 *
 *   Not "does this page use a captcha" — that is a different and much less
 *   useful question. reCAPTCHA v3 runs invisibly on an enormous share of the
 *   web and challenges almost nobody; a hidden `.g-recaptcha` inside a login
 *   form nobody is filling in blocks nothing. A tool that stopped for those
 *   would cry wolf on most of the internet, and the warning would be ignored
 *   exactly when it mattered.
 *
 *   So the test is whether something is *rendered and in the way*: a widget or
 *   challenge iframe with a real box on screen, or one of the full-page
 *   interstitials that replace the site outright. Anything weaker is reported
 *   as `present` and never stops the run.
 *
 *   It reports what it saw and stops there. **Whether anything free can be
 *   done about it — the `tier` — is the worker's answer**, assigned by
 *   `tierOf` in utils/captcha-solvers.js, because for a written question that
 *   depends on whether the parser can actually answer it and a classic content
 *   script cannot import the parser. A tier decided here would be a second
 *   opinion about solvability, free to disagree with the module that has to
 *   produce the answer (the G-01 rule, and the same split IF_ELSE and ASSERT
 *   use).
 *
 *   Replaces content/captcha-detector.js, which was an ES module importing the
 *   overlay engine — content scripts cannot import, which is why it was in no
 *   manifest entry and never ran a line (A-06). This is a classic script with
 *   no dependencies, injected on demand, and it shares the isolated world the
 *   same way structure-detector.js does.
 *
 * @dependencies none
 */

"use strict";

(() => {
  /** A box big enough to be a control a person is meant to use. */
  const MIN_BOX = 40;

  function _visible(el, minBox = MIN_BOX) {
    if (!el || !el.isConnected) return false;
    const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    if (style) {
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") {
        return false;
      }
      if (Number(style.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= minBox && r.height >= minBox;
  }

  function _sitekeyFrom(el) {
    if (!el) return null;
    return (
      el.getAttribute?.("data-sitekey") ??
      el.src?.match(/[?&]k=([^&]+)/)?.[1] ??
      null
    );
  }

  /** A short, human description of where it is. */
  function _describe(el) {
    if (!el) return "";
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList?.length ? `.${[...el.classList][0]}` : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  }

  /**
   * The widgets, in the order a person would notice them.
   * Each entry: [type, selectors that mean "rendered challenge"].
   */
  const WIDGETS = [
    [
      "recaptcha",
      [
        ".g-recaptcha[data-sitekey]",
        'iframe[src*="recaptcha"][src*="anchor"]',
        'iframe[src*="recaptcha"][src*="bframe"]',
      ],
    ],
    [
      "hcaptcha",
      [
        ".h-captcha[data-sitekey]",
        ".hcaptcha[data-sitekey]",
        'iframe[src*="hcaptcha.com"]',
      ],
    ],
    [
      "turnstile",
      [
        ".cf-turnstile[data-sitekey]",
        'iframe[src*="challenges.cloudflare.com"]',
      ],
    ],
    [
      "image",
      [
        'img[src*="captcha" i]',
        'img[alt*="captcha" i]',
        'input[name*="captcha" i]',
        'input[id*="captcha" i]',
      ],
    ],
  ];

  /**
   * Full-page interstitials, which replace the site rather than sitting in it.
   * These are blocking whether or not anything inside them has a usable box —
   * the page the run wanted is simply not there.
   */
  function _interstitial() {
    const title = (document.title || "").toLowerCase();
    const cf =
      document.getElementById("challenge-running") ||
      document.getElementById("cf-challenge-running") ||
      document.querySelector("#challenge-form, .cf-browser-verification");
    if (cf) return { type: "cloudflare", where: _describe(cf) };
    const ak = document.querySelector(
      '#sec-cpt-if, #sec-cpt-form, [href*="/_sec/cp_challenge"]',
    );
    if (ak) return { type: "akamai", where: _describe(ak) };
    if (
      /^(just a moment|attention required|checking your browser|access denied)/.test(
        title,
      )
    ) {
      return { type: "cloudflare", where: `page title: ${document.title}` };
    }
    if (document.querySelector('form[action*="/errors/validateCaptcha"]')) {
      return { type: "image", where: "amazon validateCaptcha form" };
    }
    return null;
  }

  /**
   * Does this text look like a challenge somebody wrote by hand?
   *
   * A shape test, and only that. Whether the question can actually be answered
   * is decided once, in utils/captcha-solvers.js, by the worker — a second
   * parser here would be a second definition of the same thing, free to drift
   * from the first (G-01). This exists so that a page asking an arithmetic
   * question is described as one, instead of being filed under "image captcha"
   * because its answer box happens to be named `captcha_field`.
   */
  const WRITTEN_SHAPE =
    /\b\d{1,4}\s*(?:[+\-−–*×\/÷]|plus|minus|times|divided by)\s*\d{1,4}\b|\b(?:sum|total) of\b|\bhow many (?:letters|characters)\b|\b(?:first|second|third|fourth|fifth|last) word\b|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:plus|minus|times)\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

  /** A typed answer box is an ordinary input, far shorter than MIN_BOX. */
  const MIN_INPUT_HEIGHT = 10;

  /**
   * The text a person reads before typing into this box: its label, and the
   * nearest ancestor carrying wording of its own.
   */
  function _promptFor(input) {
    const parts = [];
    if (input.id) {
      const label = document.querySelector(
        `label[for="${CSS.escape(input.id)}"]`,
      );
      if (label) parts.push(label.textContent || "");
    }
    const wrapper = input.closest("label, p, div, td, li, fieldset, form");
    if (wrapper) parts.push(wrapper.textContent || "");
    parts.push(input.getAttribute("aria-label") || "");
    parts.push(input.getAttribute("placeholder") || "");
    parts.push(input.getAttribute("title") || "");

    // Joined without repeating itself. A label and the wrapper around it both
    // contain the question, so the naive join handed the solver "What is 3 +
    // 4? What is 3 + 4?" — two arithmetic expressions in one string, which its
    // "two readings is not certainty" rule correctly refuses to answer. The
    // question was solvable; the way it was quoted was not.
    const out = [];
    for (const raw of parts) {
      const part = String(raw).replace(/\s+/g, " ").trim();
      if (!part) continue;
      if (out.some((have) => have.includes(part) || part.includes(have))) {
        // Keep the longer of the two: the wrapper often carries the question
        // plus context the label alone leaves out.
        const i = out.findIndex(
          (have) => have.includes(part) || part.includes(have),
        );
        if (part.length > out[i].length) out[i] = part;
        continue;
      }
      out.push(part);
    }
    return out.join(" ").trim();
  }

  /** A selector the worker can hand straight back to FILL. */
  function _selectorFor(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const name = el.getAttribute("name");
    if (name) return `input[name="${CSS.escape(name)}"]`;
    return "";
  }

  /**
   * A written challenge: a question in the markup and a box to type into.
   *
   * Looked for before the widget list, because `input[name*="captcha"]` sits in
   * there as an image-captcha tell and would otherwise claim the answer box of
   * every arithmetic question on the web.
   */
  function _written() {
    const inputs = document.querySelectorAll(
      'input[type="text"], input[type="number"], input[type="tel"], input:not([type])',
    );
    for (const input of inputs) {
      if (!_visible(input, MIN_INPUT_HEIGHT)) continue;
      const selector = _selectorFor(input);
      if (!selector) continue;
      const prompt = _promptFor(input);
      if (!prompt || prompt.length > 300) continue;
      if (!WRITTEN_SHAPE.test(prompt)) continue;
      return {
        type: "question",
        where: _describe(input),
        question: prompt,
        answerSelector: selector,
      };
    }
    return null;
  }

  /**
   * @returns {{blocking: boolean, present: boolean, type: string|null,
   *   tier: string|null, sitekey: string|null, where: string, reason: string,
   *   question: string, answerSelector: string}}
   */
  function checkCaptcha() {
    const none = {
      blocking: false,
      present: false,
      type: null,
      // Assigned by the worker (utils/captcha-solvers.js `tierOf`), the only
      // place that can answer it: whether a written question is solvable
      // depends on whether the parser can actually answer it, and a classic
      // content script cannot import that parser.
      tier: null,
      sitekey: null,
      where: "",
      reason: "",
      question: "",
      answerSelector: "",
    };

    const wall = _interstitial();
    if (wall) {
      return {
        ...none,
        blocking: true,
        present: true,
        type: wall.type,
        where: wall.where,
        reason:
          wall.type === "cloudflare" || wall.type === "akamai"
            ? "the site replaced the page with a bot-management interstitial, " +
              "which has no answer to type"
            : "the site replaced the page with a challenge",
      };
    }

    const written = _written();
    if (written) {
      return {
        ...none,
        blocking: true,
        present: true,
        type: written.type,
        where: written.where,
        reason:
          "the page asks a written question before it will accept the form",
        question: written.question,
        answerSelector: written.answerSelector,
      };
    }

    let present = null;
    for (const [type, selectors] of WIDGETS) {
      for (const sel of selectors) {
        let els;
        try {
          els = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (const el of els) {
          if (_visible(el)) {
            return {
              ...none,
              blocking: true,
              present: true,
              type,
              sitekey: _sitekeyFrom(el),
              where: _describe(el),
              reason: "a challenge is rendered on the page",
            };
          }
          // Remember the first one seen, so "present but not in the way" can
          // still be reported without stopping anything.
          present ??= { type, sitekey: _sitekeyFrom(el), where: _describe(el) };
        }
      }
    }

    if (present) {
      return {
        ...none,
        blocking: false,
        present: true,
        type: present.type,
        sitekey: present.sitekey,
        where: present.where,
        reason: "a captcha is on the page but is not currently in the way",
      };
    }
    return none;
  }

  /**
   * Hand the worker the captcha image itself, plus the box to type into.
   *
   * Drawn off the rendered `<img>` rather than fetched from its URL. A captcha
   * endpoint issues a *new* challenge on every request, so re-fetching the
   * src would return an image the page is no longer asking about — the answer
   * would be right about the wrong picture, which is a failed attempt against
   * a site that usually allows three.
   *
   * A cross-origin image taints the canvas and `toDataURL` throws. That is
   * reported rather than worked around: there is no way to read those pixels
   * from here, and saying so lets the caller pause instead of guessing.
   *
   * @returns {{dataUrl: string, mediaType: string, answerSelector: string,
   *   width: number, height: number}|{error: string}|null}
   */
  function grabImage() {
    let img = null;
    for (const sel of ['img[src*="captcha" i]', 'img[alt*="captcha" i]']) {
      for (const el of document.querySelectorAll(sel)) {
        if (_visible(el, 20)) {
          img = el;
          break;
        }
      }
      if (img) break;
    }
    if (!img) return null;

    let answerSelector = "";
    for (const sel of [
      'input[name*="captcha" i]',
      'input[id*="captcha" i]',
      'input[name*="vcode" i]',
      'input[name*="code" i]',
    ]) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.type === "hidden") continue;
        if (!_visible(el, MIN_INPUT_HEIGHT)) continue;
        answerSelector = _selectorFor(el);
        if (answerSelector) break;
      }
      if (answerSelector) break;
    }
    if (!answerSelector) return { error: "no answer box beside the image" };

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return { error: "the image has not loaded" };

    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      return {
        dataUrl: canvas.toDataURL("image/png"),
        mediaType: "image/png",
        answerSelector,
        width,
        height,
      };
    } catch {
      return {
        error:
          "the captcha image is served from another origin, so its pixels " +
          "cannot be read from the page",
      };
    }
  }

  // The isolated world is shared with injector.js, the same way
  // structure-detector.js hands over its entry point.
  globalThis.__vqCheckCaptcha = checkCaptcha;
  globalThis.__vqGrabCaptchaImage = grabImage;
})();

// === END captcha-check.js ===
