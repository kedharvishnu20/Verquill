// github-api.js
//
// Storage layout in the Verquill_Market_place repo:
//   pipelines/<slug>.json      — one file per personal ("My GitHub") pipeline
//   global/<slug>.json         — one file per published (community) pipeline
//   registry.json              — LEGACY personal array (still read, migrated away on save)
//   global/registry.json       — LEGACY global array (still read, migrated away on publish)
//
// Each per-pipeline file contains a single pipeline object, named after the
// pipeline so the repo is browsable by name instead of one opaque registry.json.

const PERSONAL_DIR = "pipelines";
const GLOBAL_DIR = "global";
const LEGACY_PERSONAL = "registry.json";
const LEGACY_GLOBAL = "global/registry.json";

function getRepoInfo(repoUrl) {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) throw new Error("Invalid GitHub URL");
  return { owner: match[1], repo: match[2] };
}

function slugify(name, fallback = "pipeline") {
  const clean = (v) =>
    String(v || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const s = clean(name).slice(0, 60);
  if (s) return s;
  const f = clean(fallback).slice(0, 60);
  return f || "pipeline";
}

function ghHeaders(pat, extra = {}) {
  const h = { Accept: "application/vnd.github.v3+json", ...extra };
  if (pat) h["Authorization"] = `token ${pat}`;
  return h;
}

function decodeContent(b64) {
  return JSON.parse(
    decodeURIComponent(escape(atob(String(b64).replace(/\s/g, "")))),
  );
}

function encodeContent(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2))));
}

const api = (owner, repo, path) =>
  `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

// Returns { sha, json } or null on 404.
async function getFile(owner, repo, path, pat) {
  const res = await fetch(api(owner, repo, path), {
    headers: ghHeaders(pat),
  });
  if (res.status === 404) return null;
  if (!res.ok)
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  const d = await res.json();
  return { sha: d.sha, json: decodeContent(d.content) };
}

// Lists *.json files in a directory (excluding the legacy registry.json). [] on 404.
async function listJsonFiles(owner, repo, dir, pat) {
  const res = await fetch(api(owner, repo, dir), {
    headers: ghHeaders(pat),
  });
  if (res.status === 404) return [];
  if (!res.ok)
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  const items = await res.json();
  if (!Array.isArray(items)) return [];

  // The contents API returns at most 1000 entries for a directory and gives no
  // indication that it stopped. A registry that quietly lost everything past
  // the thousandth pipeline would look like it was working. Reaching the cap is
  // reported rather than truncated silently; moving to the Git Trees API is the
  // real fix and belongs with the prebuilt index.
  if (items.length >= 1000) {
    throw new Error(
      `${dir} has reached the 1000-entry limit of the GitHub contents API. ` +
        `Some pipelines are not being listed.`,
    );
  }

  return items.filter(
    (i) =>
      i.type === "file" &&
      i.name.toLowerCase().endsWith(".json") &&
      i.name.toLowerCase() !== "registry.json",
  );
}

async function deleteFile(owner, repo, path, sha, pat, message) {
  const res = await fetch(api(owner, repo, path), {
    method: "DELETE",
    headers: ghHeaders(pat, { "Content-Type": "application/json" }),
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok && res.status !== 404) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.message || "Delete failed");
  }
}

// Drop a pipeline id from the legacy array file so it does not show twice.
// Deletes the legacy file entirely once it is empty.
async function removeFromLegacy(owner, repo, legacyPath, pat, id) {
  const got = await getFile(owner, repo, legacyPath, pat).catch(() => null);
  if (!got || !Array.isArray(got.json)) return;
  const next = got.json.filter((p) => p && p.id !== id);
  if (next.length === got.json.length) return;
  if (next.length === 0) {
    await deleteFile(
      owner,
      repo,
      legacyPath,
      got.sha,
      pat,
      "Remove empty legacy registry.json",
    ).catch(() => {});
    return;
  }
  await fetch(api(owner, repo, legacyPath), {
    method: "PUT",
    headers: ghHeaders(pat, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      message: `Migrate ${id} out of legacy registry`,
      content: encodeContent(next),
      sha: got.sha,
    }),
  });
}

// Read every pipeline from a per-file directory plus its legacy array file.
async function readDir(owner, repo, dir, legacyPath, pat) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (p && p.id && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  };

  const files = await listJsonFiles(owner, repo, dir, pat).catch(() => []);

  // One request per pipeline, previously awaited one at a time: a hundred
  // pipelines meant a hundred and one serial round trips before the page could
  // show anything. Batched instead — in order, so the listing stays stable, and
  // bounded, because firing several hundred at once is how an unauthenticated
  // visitor burns the whole rate limit in a single page load.
  const BATCH = 8;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = await Promise.all(
      files
        .slice(i, i + BATCH)
        .map((f) =>
          getFile(owner, repo, `${dir}/${f.name}`, pat).catch(() => null),
        ),
    );
    batch.forEach((got) => {
      if (got && got.json && !Array.isArray(got.json)) push(got.json);
    });
  }
  const legacy = await getFile(owner, repo, legacyPath, pat).catch(() => null);
  if (legacy && Array.isArray(legacy.json)) legacy.json.forEach(push);
  return out;
}

// Write one pipeline as <dir>/<slug>.json. The new file is written FIRST; only
// after that succeeds do we clean up (delete an older file that held the same id
// under a different name, and drop the id from the legacy array). Doing the
// destructive work first would lose data whenever the write failed.
async function upsertPipelineFile(
  owner,
  repo,
  dir,
  legacyPath,
  pat,
  pipeline,
  message,
) {
  let slug = slugify(pipeline.name, pipeline.id);
  let targetPath = `${dir}/${slug}.json`;

  // Snapshot the directory up front (read-only) for post-write cleanup.
  const existing = await listJsonFiles(owner, repo, dir, pat).catch(() => []);

  // Avoid overwriting a different pipeline that already owns this filename.
  if (existing.some((f) => `${dir}/${f.name}` === targetPath)) {
    const got = await getFile(owner, repo, targetPath, pat).catch(() => null);
    if (got && got.json && got.json.id && got.json.id !== pipeline.id) {
      const suffix =
        String(pipeline.id || Date.now())
          .replace(/[^a-z0-9]+/gi, "")
          .slice(-6)
          .toLowerCase() || "1";
      slug = `${slug}-${suffix}`;
      targetPath = `${dir}/${slug}.json`;
    }
  }

  // 1) Write the new named file.
  let sha;
  const cur = await getFile(owner, repo, targetPath, pat).catch(() => null);
  if (cur) sha = cur.sha;
  const body = { message, content: encodeContent(pipeline) };
  if (sha) body.sha = sha;
  const res = await fetch(api(owner, repo, targetPath), {
    method: "PUT",
    headers: ghHeaders(pat, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.message || "Write failed");
  }
  const result = await res.json();

  // 2) Cleanup only after the write succeeded (non-fatal on error).
  for (const f of existing) {
    if (`${dir}/${f.name}` === targetPath) continue;
    const got = await getFile(owner, repo, `${dir}/${f.name}`, pat).catch(
      () => null,
    );
    if (got && got.json && got.json.id === pipeline.id) {
      await deleteFile(
        owner,
        repo,
        `${dir}/${f.name}`,
        f.sha,
        pat,
        `Rename pipeline file for ${pipeline.name}`,
      ).catch(() => {});
    }
  }
  await removeFromLegacy(owner, repo, legacyPath, pat, pipeline.id).catch(
    () => {},
  );

  return { path: targetPath, result };
}

// ---- Personal ("My GitHub") library -----------------------------------------

export async function fetchPipelines(repoUrl, pat) {
  if (!repoUrl) return [];
  const { owner, repo } = getRepoInfo(repoUrl);
  return readDir(owner, repo, PERSONAL_DIR, LEGACY_PERSONAL, pat);
}

export async function pushPipeline(repoUrl, pat, pipeline) {
  if (!repoUrl || !pat) throw new Error("Repo URL and PAT required to push");
  const { owner, repo } = getRepoInfo(repoUrl);
  return upsertPipelineFile(
    owner,
    repo,
    PERSONAL_DIR,
    LEGACY_PERSONAL,
    pat,
    pipeline,
    `Save pipeline: ${pipeline.name}`,
  );
}

export async function removePipeline(repoUrl, pat, pipeline) {
  if (!repoUrl || !pat) throw new Error("Repo URL and PAT required to remove");
  const { owner, repo } = getRepoInfo(repoUrl);
  const files = await listJsonFiles(owner, repo, PERSONAL_DIR, pat).catch(
    () => [],
  );
  for (const f of files) {
    const got = await getFile(
      owner,
      repo,
      `${PERSONAL_DIR}/${f.name}`,
      pat,
    ).catch(() => null);
    if (got && got.json && got.json.id === pipeline.id) {
      await deleteFile(
        owner,
        repo,
        `${PERSONAL_DIR}/${f.name}`,
        f.sha,
        pat,
        `Remove pipeline: ${pipeline.name}`,
      );
    }
  }
  await removeFromLegacy(owner, repo, LEGACY_PERSONAL, pat, pipeline.id).catch(
    () => {},
  );
}

// ---- Global (community) registry --------------------------------------------

export async function fetchGlobalPipelines(owner, repo, pat) {
  return readDir(owner, repo, GLOBAL_DIR, LEGACY_GLOBAL, pat);
}

/**
 * Publish directly to global/<slug>.json in the same repo.
 * No fork needed — the user owns this repo.
 */
export async function publishToGlobal(repoOwner, repoName, pat, pipeline) {
  const userRes = await fetch("https://api.github.com/user", {
    headers: ghHeaders(pat),
  });
  if (!userRes.ok)
    throw new Error("Could not verify GitHub identity. Check your PAT.");
  const user = await userRes.json();
  pipeline.author = user.login;
  return upsertPipelineFile(
    repoOwner,
    repoName,
    GLOBAL_DIR,
    LEGACY_GLOBAL,
    pat,
    pipeline,
    `Publish pipeline: ${pipeline.name} by @${user.login}`,
  );
}
