// === stream-writer.js ===
/**
 * @module stream-writer
 * @description Chunked write utility for large exports (10k+ rows, no OOM).
 *   All exporters use this module to write rows in chunks rather than
 *   building a full in-memory string.
 *
 *   Design decision: We use the File System Access API (showSaveFilePicker)
 *   when available, falling back to a Blob download. This allows true streaming
 *   writes for very large exports without holding all data in RAM.
 *
 * @dependencies logger
 */

import { logger } from "../utils/logger.js";

const MODULE = "stream-writer";
const CHUNK_SIZE = 1000; // rows per chunk

/**
 * @typedef {Object} WriterContext
 * @property {function(string): void}  write  - Write a string chunk
 * @property {function(): Promise<void>} close - Close/finalize the writer
 * @property {string}                  filename
 */

/**
 * Create a writer context. Uses File System Access API if available.
 * @param {string} filename
 * @param {string} mimeType
 * @returns {Promise<WriterContext>}
 */
export async function createWriter(filename, mimeType) {
  if (typeof showSaveFilePicker === "function") {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: filename,
        types: [{ accept: { [mimeType]: [`.${filename.split(".").pop()}`] } }],
      });
      const writable = await handle.createWritable();
      const encoder = new TextEncoder();
      return {
        filename,
        write: async (chunk) => {
          await writable.write(encoder.encode(chunk));
        },
        close: async () => {
          await writable.close();
        },
      };
    } catch (err) {
      if (err.name !== "AbortError") {
        logger.warn(MODULE, "fsa-fail-fallback", { error: err.message });
      }
    }
  }

  // Fallback: in-memory accumulate + Blob download
  const parts = [];
  return {
    filename,
    write: async (chunk) => {
      parts.push(chunk);
    },
    close: async () => {
      const blob = new Blob(parts, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 2000);
    },
  };
}

// === END stream-writer.js ===
