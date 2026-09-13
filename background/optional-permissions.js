// === optional-permissions.js ===
/**
 * @module optional-permissions
 * @description The two permissions this extension asks for only when asked to.
 *
 *   Everything else it needs is in `permissions` and is granted at install. Two
 *   capabilities are different in kind, because of what they can see:
 *
 *   - **`cookies`** reads and writes cookies the page itself cannot —
 *     `HttpOnly` ones, which is what a session cookie almost always is. That is
 *     the difference between "save my logged-in state" working and quietly not.
 *   - **`declarativeNetRequestWithHostAccess`** rewrites request headers. The
 *     `WithHostAccess` variant is deliberate: it can only act on hosts the user
 *     has already granted, where plain `declarativeNetRequest` is a broader
 *     grant than this needs.
 *
 *   Declared `optional_permissions` rather than required, so installing the
 *   extension asks for neither and Chrome's own consent dialog appears at the
 *   moment a person turns the feature on. They can take either back from
 *   chrome://extensions at any time, and the steps that use them refuse
 *   politely rather than break (C-07 cut four permissions nobody used; adding
 *   two that most runs never need, as required, would undo that).
 *
 * @dependencies none
 */

import { logger } from "../utils/logger.js";

const MODULE = "optional-permissions";

/**
 * What each permission is for, in the words a refusal will use.
 *
 * Kept here rather than at each call site so the answer to "why is this asking"
 * is the same wherever it is asked.
 */
export const OPTIONAL_PERMISSIONS = Object.freeze({
  cookies: {
    label: "Cookies",
    forWhat: "saving and restoring a logged-in session",
    without:
      "only cookies the page itself can read are saved — the session cookie " +
      "is usually HttpOnly and will be missing, so a restored session is " +
      "usually a logged-out one",
  },
  declarativeNetRequestWithHostAccess: {
    label: "Request headers",
    forWhat: "sending a user-agent or language header of your choosing",
    without:
      "the browser's own headers are sent, which SET_HEADERS cannot change",
  },
});

/**
 * Does this build hold the permission right now?
 *
 * Asked every time rather than cached: it can be revoked from
 * chrome://extensions while the extension is running, and a cache would make
 * the next run fail somewhere less explainable than here.
 *
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function hasPermission(name) {
  try {
    return await chrome.permissions.contains({ permissions: [name] });
  } catch (err) {
    logger.warn(MODULE, "contains-failed", { name, error: err.message });
    return false;
  }
}

/**
 * The sentence a step shows when it needs a permission it does not have.
 *
 * One wording, in one place: a refusal has to say what is missing, what it is
 * for, what happens without it, and where to turn it on — otherwise the user is
 * left guessing which of the two features the message is about.
 *
 * @param {string} name
 * @returns {string}
 */
export function permissionRefusal(name) {
  const meta = OPTIONAL_PERMISSIONS[name];
  if (!meta) return `This step needs the "${name}" permission.`;
  return (
    `This step needs the ${meta.label} permission, for ${meta.forWhat}. ` +
    `Turn it on in Settings → Permissions; Chrome will ask you to confirm. ` +
    `Without it, ${meta.without}.`
  );
}

/** Every optional permission and whether it is held, for the settings panel. */
export async function permissionStatus() {
  const out = {};
  for (const name of Object.keys(OPTIONAL_PERMISSIONS)) {
    out[name] = {
      ...OPTIONAL_PERMISSIONS[name],
      granted: await hasPermission(name),
    };
  }
  return out;
}

// === END optional-permissions.js ===
