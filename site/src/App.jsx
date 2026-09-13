import { useState, useEffect } from "react";
import {
  fetchPipelines,
  pushPipeline,
  publishToGlobal,
  removePipeline,
  fetchGlobalPipelines,
} from "./github-api";
// The same module the extension's import gate uses. There used to be a second
// copy in site/src/analyzer.js that nothing imported, so the publish path ran
// no check at all — and the copies had already begun to drift. One definition
// (G-01), and the site and the panel now refuse the same things.
import {
  analyzePipeline,
  findPublishBlockers,
  VERDICT,
} from "../../utils/pipeline-capabilities.js";
import "./index.css";

const REPO_OWNER = "kedharvishnu20";
const REPO_NAME = "Verquill_Market_place";

/**
 * Strip the fields that are this page's business, not the pipeline's.
 *
 * This used to claim to remove credentials and did not. It set `step.cookies`
 * and `step.headers` — neither of which exists anywhere in the product. A
 * SET_HEADERS step keeps its data at `step.config.headers`, and a SESSION step
 * carries no cookies at all (they live encrypted inside the extension and
 * never enter the pipeline JSON). So the function wrote two properties nobody
 * reads and published the real `Authorization:` header verbatim.
 *
 * Silently blanking it now would be the other failure: the author would
 * publish a pipeline that quietly no longer works, and would not know their
 * token had ever been at risk. Credentials are refused at the gate instead —
 * see `findPublishBlockers` — and this function goes back to doing the one
 * honest thing its name can cover.
 */
function stripLocalFields(pipeline) {
  const copy = JSON.parse(JSON.stringify(pipeline));
  delete copy.source;
  delete copy._displayId;
  return copy;
}

export default function App() {
  const [route, setRoute] = useState("registry");
  const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [sortBy, setSortBy] = useState("name");
  const [pat, setPat] = useState("");
  const [repoUrl, setRepoUrl] = useState(
    `https://github.com/${REPO_OWNER}/${REPO_NAME}.git`,
  );
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [reviewModal, setReviewModal] = useState(false);
  const [reviewJson, setReviewJson] = useState("");
  const [reviewJsonErr, setReviewJsonErr] = useState(null);
  const [pushModal, setPushModal] = useState(null);
  const [pushName, setPushName] = useState("");
  const [pushUrl, setPushUrl] = useState("");
  const [sourceStatus, setSourceStatus] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash.replace(/^#\//, "") || "registry";
      setRoute(hash.split("/")[0]);
    };
    window.addEventListener("hashchange", handleHash);
    handleHash();
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  useEffect(() => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      // The repository URL is a preference and persists. The token does not:
      // it lives in session storage, which Chrome clears when the browser
      // closes. The extension already holds every other API key that way, on
      // the stated view that a scraping tool keeping a credential on disk
      // forever is a worse trade than retyping it — and a token with
      // Contents: Read & Write on your repositories is the last one that
      // should have been the exception.
      chrome.storage.local.get(["vq_github_repo"], (res) => {
        if (res.vq_github_repo) setRepoUrl(res.vq_github_repo);
        if (chrome.storage.session) {
          chrome.storage.session.get(["vq_github_pat"], (s) => {
            if (s?.vq_github_pat) setPat(s.vq_github_pat);
            setSettingsLoaded(true);
          });
        } else {
          setSettingsLoaded(true);
        }
      });
      // Anything left in local by a previous version is swept rather than
      // read. Moving where new tokens go would otherwise leave the old one on
      // disk indefinitely, which is most of the exposure this fix is about.
      chrome.storage.local.remove("vq_github_pat");
    } else {
      setSettingsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (settingsLoaded) loadData(pat, repoUrl);
  }, [settingsLoaded]);

  const loadData = async (effectivePat = pat, effectiveRepo = repoUrl) => {
    setLoading(true);
    const all = [];
    const status = { local: 0, github: null, global: null };

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        const stored = await chrome.storage.local.get(null);
        Object.keys(stored)
          .filter((k) => k.startsWith("vq_active_pipeline"))
          .forEach((k) => {
            const p = stored[k];
            if (p && typeof p === "object" && Array.isArray(p.steps)) {
              if (!p.id) p.id = k;
              if (!p.name) p.name = "Untitled Pipeline";
              const short = p.id.replace(/^(local_)?vq_active_pipeline_?/, "");
              p._displayId = short ? `#${short.slice(-6)}` : "#local";
              p.source = "local";
              if (!all.find((x) => x.id === p.id)) all.push(p);
            }
          });
        status.local = all.length;
      } catch (_) {}
    }

    // Public repo — reading needs no PAT (the token is only required to push).
    if (effectiveRepo) {
      try {
        const github = await fetchPipelines(effectiveRepo, effectivePat);
        github.forEach((p) => {
          p.source = "github";
          p._displayId = p.id;
          if (!all.find((x) => x.id === p.id && x.source === "github"))
            all.push(p);
        });
        status.github = github.length;
      } catch (e) {
        status.github = `error: ${e.message}`;
        console.warn("GitHub fetch failed:", e.message);
      }
    }

    try {
      const global = await fetchGlobalPipelines(
        REPO_OWNER,
        REPO_NAME,
        effectivePat,
      );
      let added = 0;
      global.forEach((p) => {
        p.source = "global";
        p._displayId = p.id;
        if (!all.find((x) => x.id === p.id && x.source === "global")) {
          all.push(p);
          added++;
        }
      });
      status.global = added;
    } catch (e) {
      status.global = `error: ${e.message}`;
    }

    setPipelines(all);
    setSourceStatus(status);
    setLoading(false);
  };

  const saveSettings = () => {
    setSavingSettings(true);
    const done = () => {
      setSavingSettings(false);
      loadData(pat, repoUrl);
    };
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ vq_github_repo: repoUrl }, () => {
        if (chrome.storage.session) {
          chrome.storage.session.set({ vq_github_pat: pat }, done);
        } else {
          // No session storage means no safe place to keep it. It stays in
          // this page's memory for as long as the tab is open and is not
          // written anywhere — quietly falling back to local would put the
          // token back on disk while the interface said it had been saved
          // securely.
          done();
        }
      });
    } else {
      setTimeout(done, 400);
    }
  };

  const handleLoad = (p) => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const copy = stripLocalFields(p);
      chrome.storage.local.set({ vq_marketplace_load: copy }, () =>
        showToast("Pipeline loaded into sidepanel."),
      );
    } else {
      showToast("Load only works inside the Chrome Extension.", "err");
    }
  };

  const openPushModal = (p) => {
    if (!repoUrl || !pat)
      return showToast("Configure GitHub in Sync Settings first.", "err");
    setPushName(p.name || "");
    setPushUrl(p.website || p.url || "");
    setPushModal({ pipeline: p });
  };

  const confirmPush = async () => {
    if (!pushModal) return;
    const name = pushName.trim();
    if (!name) return showToast("Pipeline name is required.", "err");
    const edited = { ...pushModal.pipeline, name, website: pushUrl.trim() };
    setPushModal(null);
    await handlePushToGitHub(edited);
  };

  const handlePushToGitHub = async (p) => {
    if (!repoUrl || !pat)
      return showToast("Configure GitHub in Sync Settings first.", "err");
    try {
      const copy = stripLocalFields(p);
      await pushPipeline(repoUrl, pat, copy);
      showToast(`"${copy.name}" pushed to GitHub.`);
      loadData(pat, repoUrl);
    } catch (e) {
      showToast("Push failed: " + e.message, "err");
    }
  };

  const handleSaveLocally = (p) => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const copy = stripLocalFields(p);
      const key = `vq_active_pipeline_saved_${copy.id || Date.now()}`;
      chrome.storage.local.set({ [key]: copy }, () => {
        showToast("Saved locally.");
        loadData(pat, repoUrl);
      });
    } else {
      showToast("Only works inside the Chrome Extension.", "err");
    }
  };

  const handleRemove = async (p) => {
    if (!window.confirm(`Remove "${p.name}" from your GitHub library?`)) return;
    if (!repoUrl || !pat)
      return showToast("Configure GitHub in Sync Settings first.", "err");
    try {
      await removePipeline(repoUrl, pat, p);
      showToast(`"${p.name}" removed.`);
      loadData(pat, repoUrl);
    } catch (e) {
      showToast("Remove failed: " + e.message, "err");
    }
  };

  const openPublishModal = (p) => {
    if (!pat)
      return showToast("Configure GitHub in Sync Settings first.", "err");
    setReviewJson(JSON.stringify(stripLocalFields(p), null, 2));
    setReviewJsonErr(null);
    setReviewModal(true);
  };

  const confirmPublish = async () => {
    let parsed;
    try {
      parsed = JSON.parse(reviewJson);
      setReviewJsonErr(null);
    } catch (e) {
      setReviewJsonErr("Invalid JSON: " + e.message);
      return;
    }

    // The JSON in the box is editable, so both checks run on what is about to
    // be sent rather than on what was offered a moment ago.

    // Credentials first, because this one is irreversible: a token in a public
    // commit is leaked the instant it lands, and deleting the file afterwards
    // does not unpublish it. Named, never quoted — a warning about a secret
    // must not repeat the secret.
    const leaks = findPublishBlockers(parsed);
    if (leaks.length) {
      const where = leaks
        .map((l) => `${l.stepType} (${l.headers.join(", ")})`)
        .join("; ");
      setReviewJsonErr(
        `Not published: this would put a credential in a public repository — ` +
          `${where}. Remove the header value here, then publish. Anything ` +
          `already committed has to be rotated, not just deleted.`,
      );
      return;
    }

    // Then what the pipeline can do to whoever installs it. The registry's
    // whole promise is that this ran; until now it never did.
    const analysis = analyzePipeline(parsed);
    if (analysis.verdict === VERDICT.BLOCKED) {
      setReviewJsonErr(`Not published: ${analysis.blockedReason}`);
      return;
    }

    try {
      setReviewModal(false);
      showToast("Publishing...");
      await publishToGlobal(REPO_OWNER, REPO_NAME, pat, parsed);
      // Says what happened. This used to report a pull request, while
      // publishToGlobal commits straight to global/ — telling someone a human
      // reviewed their submission when nobody did is worse than saying
      // nothing. A real review gate is the Phase 3 fix; the wording is honest
      // in the meantime.
      showToast("Published to the community registry.");
    } catch (e) {
      showToast("Publish failed: " + e.message, "err");
    }
  };

  const sourceOrder = { local: 0, github: 1, global: 2 };
  const display = pipelines
    .filter((p) => {
      if (sourceFilter !== "all" && p.source !== sourceFilter) return false;
      if (!q) return true;
      const s = q.toLowerCase();
      return (
        (p.name || "").toLowerCase().includes(s) ||
        (p.id || "").toLowerCase().includes(s) ||
        (p.author || "").toLowerCase().includes(s) ||
        (p.description || p.desc || "").toLowerCase().includes(s)
      );
    })
    .sort((a, b) => {
      if (sortBy === "source")
        return (sourceOrder[a.source] ?? 9) - (sourceOrder[b.source] ?? 9);
      if (sortBy === "steps")
        return (b.steps?.length || 0) - (a.steps?.length || 0);
      return (a.name || "").localeCompare(b.name || "");
    });

  const SOURCE_LABEL = { local: "LOCAL", github: "GITHUB", global: "GLOBAL" };

  return (
    <>
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 2000,
            fontFamily: "var(--mono)",
            fontSize: "12px",
            padding: "10px 16px",
            background: toast.type === "err" ? "#ef5350" : "var(--panel)",
            color: toast.type === "err" ? "#fff" : "var(--ink)",
            border: "1px solid var(--line)",
            letterSpacing: "0.06em",
            boxShadow: "var(--shadow-fly)",
          }}
        >
          {toast.msg}
        </div>
      )}

      {pushModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1100,
            background: "rgba(0,0,0,0.9)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 460,
              background: "var(--panel)",
              border: "1px solid var(--line)",
              boxShadow: "var(--shadow-fly)",
            }}
          >
            <div
              style={{
                padding: "16px 24px",
                borderBottom: "1px solid var(--line)",
                fontFamily: "var(--mono)",
                fontSize: "11px",
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "var(--amber)",
              }}
            >
              Push to GitHub · Pipeline Details
            </div>
            <div
              style={{
                padding: "20px 24px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <label
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "11px",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--dim)",
                }}
              >
                Pipeline Name
              </label>
              <input
                className="field"
                value={pushName}
                onChange={(e) => setPushName(e.target.value)}
                placeholder="e.g. Amazon Product Extractor"
                style={{ width: "100%" }}
                autoFocus
              />
              <label
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "11px",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--dim)",
                  marginTop: 8,
                }}
              >
                Website Link
              </label>
              <input
                className="field"
                value={pushUrl}
                onChange={(e) => setPushUrl(e.target.value)}
                placeholder="https://example.com"
                style={{ width: "100%" }}
              />
            </div>
            <div
              style={{
                padding: "14px 24px",
                borderTop: "1px solid var(--line)",
                display: "flex",
                justifyContent: "flex-end",
                gap: 12,
              }}
            >
              <button className="btn" onClick={() => setPushModal(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={confirmPush}>
                Push
              </button>
            </div>
          </div>
        </div>
      )}

      {reviewModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.9)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "16px 24px",
              borderBottom: "1px solid var(--line)",
              background: "var(--panel)",
              display: "flex",
              alignItems: "center",
              gap: 16,
            }}
          >
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: "11px",
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "var(--amber)",
                flex: 1,
              }}
            >
              Review Pipeline · Confirm Before Publishing
            </span>
            <button className="btn" onClick={() => setReviewModal(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={confirmPublish}>
              Confirm Publish
            </button>
          </div>
          <div
            style={{
              padding: "10px 24px",
              background: "rgba(239,83,80,0.08)",
              borderBottom: "1px solid rgba(239,83,80,0.25)",
              fontFamily: "var(--mono)",
              fontSize: "11px",
              color: "#ef5350",
              letterSpacing: "0.04em",
            }}
          >
            Caution · We tried our best to strip credentials. Verify the JSON
            below and remove anything sensitive before confirming.
          </div>
          {reviewJsonErr && (
            <div
              style={{
                padding: "6px 24px",
                background: "rgba(239,83,80,0.15)",
                fontFamily: "var(--mono)",
                fontSize: "11px",
                color: "#ef5350",
              }}
            >
              {reviewJsonErr}
            </div>
          )}
          <textarea
            value={reviewJson}
            onChange={(e) => {
              setReviewJson(e.target.value);
              setReviewJsonErr(null);
            }}
            spellCheck={false}
            style={{
              flex: 1,
              width: "100%",
              resize: "none",
              fontFamily: "var(--mono)",
              fontSize: "13px",
              lineHeight: 1.65,
              background: "var(--void)",
              color: "var(--ink)",
              border: "none",
              outline: "none",
              padding: "20px 24px",
              tabSize: 2,
            }}
          />
          <div
            style={{
              padding: "14px 24px",
              borderTop: "1px solid var(--line)",
              background: "var(--panel)",
              display: "flex",
              justifyContent: "flex-end",
              gap: 12,
            }}
          >
            <button className="btn" onClick={() => setReviewModal(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={confirmPublish}>
              Confirm Publish
            </button>
          </div>
        </div>
      )}

      <header className="masthead">
        <div className="masthead-in">
          <a className="wordmark" href="#/registry">
            <b>VERQUILL</b>
            <span>Registry</span>
          </a>
          <nav className="mainnav" id="nav">
            <a href="#/registry" className={route === "registry" ? "on" : ""}>
              Marketplace
            </a>
            <a href="#/settings" className={route === "settings" ? "on" : ""}>
              Sync Settings
            </a>
          </nav>
        </div>
      </header>

      <main>
        {route === "registry" ? (
          <>
            <div className="head">
              <div className="eyebrow">Marketplace</div>
              <h1>
                Manage your <em>pipelines</em>.
              </h1>
              <p className="lede">
                All pipelines across local storage, your GitHub library, and the
                global community.
              </p>
            </div>

            <div className="toolbar" style={{ marginTop: 18 }}>
              <input
                className="field"
                id="q"
                placeholder="Search name, author, or id"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <div className="chipset">
                {[
                  ["all", "All"],
                  ["local", "Local"],
                  ["github", "My GitHub"],
                  ["global", "Global"],
                ].map(([val, label]) => (
                  <button
                    key={val}
                    className={`chip ${sourceFilter === val ? "on" : ""}`}
                    onClick={() => setSourceFilter(val)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <select
                className="btn"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                style={{ cursor: "pointer" }}
              >
                <option value="name">Sort: Name</option>
                <option value="source">Sort: Source</option>
                <option value="steps">Sort: Steps</option>
              </select>
              <button className="btn" onClick={() => loadData(pat, repoUrl)}>
                Refresh
              </button>
            </div>

            {sourceStatus && (
              <div
                style={{
                  marginTop: 10,
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  letterSpacing: "0.10em",
                  textTransform: "uppercase",
                  color: "var(--dim)",
                  display: "flex",
                  gap: 16,
                  flexWrap: "wrap",
                }}
              >
                <span>Local: {sourceStatus.local}</span>
                <span
                  style={{
                    color:
                      typeof sourceStatus.github === "string"
                        ? "#ef5350"
                        : "var(--dim)",
                  }}
                >
                  GitHub:{" "}
                  {sourceStatus.github === null ? "-" : sourceStatus.github}
                </span>
                <span
                  style={{
                    color:
                      typeof sourceStatus.global === "string"
                        ? "#ef5350"
                        : "var(--dim)",
                  }}
                >
                  Global:{" "}
                  {sourceStatus.global === null ? "-" : sourceStatus.global}
                </span>
              </div>
            )}

            <div className="rows-head">
              <div>Source</div>
              <div>Pipeline</div>
              <div></div>
              <div>Actions</div>
            </div>
            <div className="rows">
              {loading ? (
                <div className="empty">Loading...</div>
              ) : display.length === 0 ? (
                <div
                  className="empty"
                  style={{ textAlign: "center", padding: "48px 0" }}
                >
                  <div style={{ marginBottom: 10 }}>No pipelines found.</div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--muted)",
                      maxWidth: 360,
                      margin: "0 auto",
                      lineHeight: 1.7,
                    }}
                  >
                    {sourceFilter === "local"
                      ? "Build a pipeline in the Verquill sidepanel — it will appear here automatically."
                      : sourceFilter === "github"
                        ? "Configure your GitHub token in Sync Settings to load your personal repository."
                        : sourceFilter === "global"
                          ? "The global community registry is empty or unreachable."
                          : "Build a pipeline in the sidepanel, or configure GitHub sync to see your library here."}
                  </div>
                </div>
              ) : (
                display.map((p) => (
                  <div key={`${p.source}::${p.id}`} className="row">
                    <div className="partno">
                      <div
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: "9px",
                          letterSpacing: "0.18em",
                          textTransform: "uppercase",
                          color: "var(--dim)",
                          marginBottom: 4,
                        }}
                      >
                        {SOURCE_LABEL[p.source] || p.source}
                      </div>
                      <div
                        style={{
                          fontSize: 10,
                          color: "var(--muted)",
                          wordBreak: "break-all",
                        }}
                      >
                        {p._displayId || p.id}
                      </div>
                    </div>
                    <div>
                      <div className="row-name">
                        {p.name || "Untitled Pipeline"}
                      </div>
                      {(p.description || p.desc) && (
                        <div className="row-meta">
                          {p.description || p.desc}
                        </div>
                      )}
                      {p.author && (
                        <div className="row-meta" style={{ marginTop: 3 }}>
                          by {p.author}
                        </div>
                      )}
                      {p.steps?.length > 0 && (
                        <div className="row-meta" style={{ marginTop: 3 }}>
                          {p.steps.length} step{p.steps.length !== 1 ? "s" : ""}
                        </div>
                      )}
                    </div>
                    <div />
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                        justifyContent: "flex-end",
                      }}
                    >
                      {p.source === "local" && (
                        <>
                          <button
                            className="btn btn-primary"
                            onClick={() => handleLoad(p)}
                          >
                            Load
                          </button>
                          <button
                            className="btn"
                            onClick={() => openPushModal(p)}
                          >
                            Push to GitHub
                          </button>
                          <button
                            className="btn"
                            onClick={() => openPublishModal(p)}
                          >
                            Publish
                          </button>
                        </>
                      )}
                      {p.source === "github" && (
                        <>
                          <button
                            className="btn btn-primary"
                            onClick={() => handleLoad(p)}
                          >
                            Run Now
                          </button>
                          <button
                            className="btn"
                            onClick={() => openPublishModal(p)}
                          >
                            Publish
                          </button>
                          <button
                            className="btn"
                            onClick={() => handleRemove(p)}
                          >
                            Remove
                          </button>
                        </>
                      )}
                      {p.source === "global" && (
                        <>
                          <button
                            className="btn btn-primary"
                            onClick={() => handleLoad(p)}
                          >
                            Run Now
                          </button>
                          <button
                            className="btn"
                            onClick={() => openPushModal(p)}
                          >
                            Save to GitHub
                          </button>
                          <button
                            className="btn"
                            onClick={() => handleSaveLocally(p)}
                          >
                            Save Locally
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        ) : route === "settings" ? (
          <div style={{ padding: "40px 0", maxWidth: 440 }}>
            <div className="eyebrow" style={{ marginBottom: 20 }}>
              Sync Settings
            </div>
            <h2 style={{ fontSize: 20, marginBottom: 8 }}>
              GitHub Configuration
            </h2>
            <p className="prose" style={{ marginBottom: 24 }}>
              Connect your personal GitHub repository to push and pull your
              pipelines. Requires a Fine-Grained PAT with{" "}
              <strong>Contents: Read &amp; Write</strong> and{" "}
              <strong>Pull Requests: Read &amp; Write</strong>.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "11px",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--dim)",
                }}
              >
                Personal Access Token
              </label>
              <input
                type="password"
                className="field"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder="github_pat_xxxxxxxxxxxxxxxx"
                style={{ width: "100%" }}
              />
              <label
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "11px",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--dim)",
                  marginTop: 8,
                }}
              >
                Repository URL
              </label>
              <input
                type="text"
                className="field"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/username/repo.git"
                style={{ width: "100%" }}
              />
              <button
                className="btn btn-primary"
                onClick={saveSettings}
                disabled={savingSettings}
                style={{ marginTop: 16, alignSelf: "flex-start" }}
              >
                {savingSettings ? "Saving..." : "Save & Sync"}
              </button>
            </div>
          </div>
        ) : (
          <div className="empty">Not found.</div>
        )}
      </main>

      <footer>
        <span>Verquill Registry · pipelines are reviewed, not trusted</span>
        <span>MIT · no account · no tracking</span>
      </footer>
    </>
  );
}
