// === gateway-config.js ===
/**
 * @module gateway-config
 * @description Where the AI gateway's settings live, and the one place that
 *   turns them into a config `utils/ai-gateway.js` will accept.
 *
 *   Three callers need the same four values — the captcha reader, the
 *   AUTO_EXTRACT layer, and the settings panel's own save/test handlers — and
 *   before this they each spelled out the storage key, the `gateway:<provider>`
 *   key-name convention, and the "a local server needs no key" exception. Three
 *   copies of a convention is two chances for the free path to work in one
 *   place and be refused in another.
 *
 *   Deliberately not in `utils/`: it reads `chrome.storage`, and the dependency
 *   rule this codebase follows is background → utils, never the reverse. That
 *   is why `ai-gateway.js` takes a plain config object and never looks anything
 *   up for itself.
 *
 * @dependencies background/api-key-manager.js, utils/ai-gateway.js
 */

import { getApiKey } from "./api-key-manager.js";
import { GATEWAY_PROVIDERS } from "../utils/ai-gateway.js";

/** Where the panel's provider/model/baseUrl choice is stored. */
export const GATEWAY_STORAGE_KEY = "vq_gateway_config_v1";

/**
 * The gateway config to use, or null when nothing is set up.
 *
 * `null` is not a failure. It is the default state of a tool that costs
 * nothing to use: no provider chosen means the free layers answer and the AI
 * layer is simply not consulted. Callers report that as "no model configured",
 * never as an error.
 *
 * @param {{ maxTokens?: number, json?: boolean, timeoutMs?: number }} [over]
 *   merged into the returned config, for callers that need a bigger answer or
 *   a JSON one.
 * @returns {Promise<?import("../utils/ai-gateway.js").GatewayConfig>}
 */
export async function readGatewayConfig(over = {}) {
  const stored = await chrome.storage.local
    .get(GATEWAY_STORAGE_KEY)
    .catch(() => ({}));
  const saved = stored?.[GATEWAY_STORAGE_KEY];
  const provider = saved?.provider;
  if (!provider || !GATEWAY_PROVIDERS[provider]) return null;

  const apiKey = await getApiKey(`gateway:${provider}`).catch(() => null);
  // A local server commonly has no auth at all; every hosted provider needs a
  // key, and asking one without it only produces a 401 the user has to read.
  if (!apiKey && GATEWAY_PROVIDERS[provider].needsApiKey) return null;

  return {
    provider,
    apiKey,
    model: saved.model || "",
    baseUrl: saved.baseUrl || "",
    ...over,
  };
}

/**
 * A sentence naming what is configured, for a run log.
 * @param {?import("../utils/ai-gateway.js").GatewayConfig} config
 * @returns {string}
 */
export function describeGateway(config) {
  if (!config) return "no AI model is configured";
  const label = GATEWAY_PROVIDERS[config.provider]?.label ?? config.provider;
  const model =
    config.model || GATEWAY_PROVIDERS[config.provider]?.defaultModel;
  return `${label}${model ? ` (${model})` : ""}`;
}

// === END gateway-config.js ===
