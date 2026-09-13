// === page-sniffer.js ===
/**
 * @module page-sniffer
 * @description Injected into the "MAIN" world (same context as the website).
 *   Hooks window.fetch and XMLHttpRequest to silently capture background APIs.
 *   Transmits captured data (url, method, request/response bodies) to the
 *   isolated content script (injector.js) via window.postMessage.
 */

(function () {
  if (window.__vqSnifferReady) return;
  window.__vqSnifferReady = true;

  // Extremely basic filter: only log JSON-looking content or basic API urls.
  // Avoids filling memory with massive JPGs or CSS.
  function _shouldLog(url, contentType) {
    if (!url) return false;
    const strUrl = String(url).toLowerCase();
    if (
      strUrl.includes(".png") ||
      strUrl.includes(".jpg") ||
      strUrl.includes(".css") ||
      strUrl.includes(".woff")
    )
      return false;
    if (
      contentType &&
      (contentType.includes("image") ||
        contentType.includes("font") ||
        contentType.includes("css"))
    )
      return false;
    return true;
  }

  function _sendPayload(method, url, status, reqBody, resBody, type) {
    try {
      window.postMessage(
        {
          type: "VQ_NETWORK_SNIFF",
          payload: {
            method: String(method || "GET").toUpperCase(),
            url: String(url || ""),
            status: Number(status || 0),
            reqBody: reqBody ? String(reqBody).substring(0, 50000) : "", // Cap at 50KB string
            resBody: resBody ? String(resBody).substring(0, 500000) : "", // Cap at 500KB string
            apiType: type,
          },
        },
        "*",
      );
    } catch {
      // Ignore cloning errors
    }
  }

  // Hook Fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const startObj = args[0];
    const initObj = args[1];

    let url = "";
    if (typeof startObj === "string") url = startObj;
    else if (startObj instanceof URL) url = startObj.href;
    else if (startObj instanceof Request) url = startObj.url;

    let reqBody = "";
    let method = "GET";
    if (initObj) {
      if (initObj.method) method = initObj.method;
      if (initObj.body && typeof initObj.body === "string")
        reqBody = initObj.body;
    } else if (startObj instanceof Request) {
      method = startObj.method;
    }

    try {
      const response = await originalFetch.apply(this, args);
      const ct = response.headers.get("content-type") || "";

      if (_shouldLog(url, ct)) {
        // Clone so we don't break the original page reading it!
        const clone = response.clone();
        clone
          .text()
          .then((resText) => {
            _sendPayload(
              method,
              url,
              response.status,
              reqBody,
              resText,
              "fetch",
            );
          })
          .catch(() => {});
      }
      return response;
    } catch (err) {
      throw err;
    }
  };

  // Hook XHR
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._vqMethod = method;
    this._vqUrl = url;
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this._vqReqBody = typeof body === "string" ? body : "";

    this.addEventListener("load", function () {
      const ct = this.getResponseHeader("content-type") || "";
      if (_shouldLog(this._vqUrl, ct)) {
        let resBody = "";
        try {
          if (this.responseType === "" || this.responseType === "text") {
            resBody = this.responseText;
          }
        } catch {}
        _sendPayload(
          this._vqMethod,
          this._vqUrl,
          this.status,
          this._vqReqBody,
          resBody,
          "xhr",
        );
      }
    });

    return originalXhrSend.apply(this, arguments);
  };
})();
