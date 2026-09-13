// === text-exporters.js ===
/**
 * @module exporters/text-exporters
 * @description Write result rows to a file the user chooses.
 *
 *   Formatting lives in row-formatters.js; this module only handles delivery.
 *   It used to carry its own CSV, TSV, XML and Markdown implementations, which
 *   were the fourth copy in the repository and disagreed with the others —
 *   headers came from Object.keys(rows[0]), so a column missing from the first
 *   row was dropped.
 *
 *   Used by the side panel's partial-run download. The EXPORT *step* is handled
 *   by _doExport in the service worker, which downloads directly — a worker
 *   cannot show the File System Access API's save dialog. The panel can, so it
 *   comes through here (audit F-01, which listed this module and stream-writer
 *   as dead).
 *
 * @dependencies row-formatters, stream-writer
 */

import { formatRows, formatMeta, defaultFilename } from "./row-formatters.js";
import { createWriter } from "./stream-writer.js";

/**
 * Write rows to a file in the given format.
 *
 * @param {object[]} rows
 * @param {import('./row-formatters.js').RowFormat} format
 * @param {string} [filename] - defaults to export.<ext>
 * @returns {Promise<void>}
 */
export async function exportRows(rows, format, filename) {
  if (!Array.isArray(rows) || rows.length === 0) return;

  const { mime } = formatMeta(format);
  const writer = await createWriter(filename ?? defaultFilename(format), mime);

  await writer.write(formatRows(rows, format));
  await writer.close();
}

// === END text-exporters.js ===
