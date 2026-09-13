// === tests/helpers/python.mjs ===
/**
 * Find a Python 3 interpreter, or report honestly that there is none.
 *
 * Several tests compile or run the Python that `script-gen/python-emitter.js`
 * emits — the only way to know the generated script is valid rather than
 * merely well-shaped. Python is therefore an optional test dependency, and the
 * suite has to behave correctly both with and without it.
 *
 * It did neither. Four call sites ran `execFileSync("python3", …)` with no
 * check at all, so a machine without it failed the run rather than skipping.
 * The one file that did guard used `execFileSync("sh", ["-c", "command -v
 * python3"])` — which needs a POSIX shell, so on the Windows machines it was
 * meant to protect the guard failed before the thing it was guarding could.
 * That is how an outside audit came to report these as broken code.
 *
 * Both problems are the same problem: five copies of a decision that should
 * exist once. This is that one copy.
 *
 * `python3` first, then `python`, because Windows installs the launcher under
 * the bare name. The version string is checked rather than the exit code
 * alone: the Microsoft Store ships a `python` stub that exists, resolves, and
 * does nothing useful, and a stub that "works" would turn a skip into a
 * confusing failure inside the test body.
 */
import { execFileSync } from "node:child_process";

/** @type {string|null|undefined} Resolved once — the answer cannot change mid-run. */
let _cached;

/**
 * @returns {string|null} the interpreter to spawn, or null if there is none
 */
export function pythonBin() {
  if (_cached !== undefined) return _cached;

  for (const candidate of ["python3", "python"]) {
    try {
      const out = execFileSync(candidate, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      // "Python 3.12.1". Python 2 is not what these emitters target, and the
      // Store stub prints nothing at all.
      if (/^Python 3\./.test(out.trim())) {
        _cached = candidate;
        return _cached;
      }
    } catch {
      /* not on this machine, or not runnable; try the next name */
    }
  }

  _cached = null;
  return _cached;
}

/**
 * Skip the current test when there is no interpreter.
 *
 * Returns the binary name when there is one, so a caller reads as:
 *
 *   const python = skipWithoutPython(t);
 *   if (!python) return;
 *
 * The explicit `return` is the caller's, deliberately: `t.skip()` marks the
 * test skipped but does not stop the function body, and a helper that looked
 * like it did would leave the spawn running underneath a green "skipped".
 *
 * @param {import("node:test").TestContext} t
 * @returns {string|null}
 */
export function skipWithoutPython(t) {
  const bin = pythonBin();
  if (!bin) {
    t.skip("no Python 3 on this machine — the emitted script was not compiled");
  }
  return bin;
}

// === END tests/helpers/python.mjs ===
