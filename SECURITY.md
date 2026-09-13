# Verquill — Security

Last updated: 2026-09-13

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. It goes to the maintainers and nobody
else, and it does not create a public issue.

Please do not open a public issue for a security problem first. Not because
disclosure is unwelcome — because a scraping tool's users are running it
against sites they care about, and the gap between a public report and a fix is
a gap somebody else can use.

What helps, in rough order of usefulness:

- What an attacker gets. "Reads any pipeline" and "reads a stored API key" need
  different urgency, and only you know which one you found.
- The smallest thing that reproduces it. A pipeline JSON, a page, a sequence of
  clicks.
- Which surface. The side panel, the service worker, an injected content
  script, the MCP server, or the registry website — they have very different
  trust boundaries, and the section below says what each one is.

You will get a reply. If a report is not a vulnerability, you will be told why
rather than left waiting.

## What this project treats as a vulnerability

An extension that automates a browser can do a great deal by design. The line
is whether the user asked for it.

**In scope.** Anything that lets a page, a pipeline, or a third party do
something the person running Verquill did not ask for:

- A page reading or influencing the extension's state — its storage, its
  pipelines, its run, its keys.
- An imported or published pipeline sending data somewhere the user did not
  declare. This is the one with a dedicated defence; see below.
- A stored API key, proxy credential, or captured session escaping session
  storage, reaching a log, or appearing in an export.
- A step running on an origin outside the run's declared scope.
- Anything that bypasses the ethics gates rather than asking the user to
  override them, which they are allowed to do knowingly.
- The MCP server accepting a request it should not, or binding wider than
  loopback.

**Not in scope**, and each for a reason rather than by convention:

- **That Verquill can scrape a site that does not want to be scraped.** It can.
  It also reads robots.txt, warns, and records the override. Whether to scrape
  is the user's decision and their responsibility; the tool's job is to make
  the decision visible, not to make it for them.
- **That a pipeline you wrote sends your data to your own server.** That is the
  product. The gate exists so a pipeline _someone else_ wrote cannot do it
  without telling you.
- **`<all_urls>` host permission.** A tool that automates whatever tab you are
  on needs it. `docs/STORE_LISTING.md` justifies every permission in the
  manifest; if one is not justified there, that is a finding.
- **Findings from a scanner with no reachable path.** A rule firing on a line is
  a hypothesis. Tell us the path and it is in scope again.

## The trust boundaries, so a report can name one

| Surface          | Trusts             | Does not trust                         |
| ---------------- | ------------------ | -------------------------------------- |
| Service worker   | The side panel     | Pages, content-script replies, imports |
| Side panel       | The service worker | Pipelines it loads or imports          |
| Content scripts  | The service worker | The page they run in, entirely         |
| MCP server       | Loopback clients   | Everything else                        |
| Registry website | Nothing            | Every pipeline it displays             |

The rule the codebase holds to: a content script is in the page's address
space, so anything it returns is page-controlled data. It is never treated as a
command.

## The capability gate

The defence this project actually leans on. `utils/pipeline-capabilities.js`
reads a pipeline and reports what it can do — where it sends data, which
credentials it carries, which origins it touches that were not declared.

It is one module deliberately, because it is enforced in three places and three
copies would drift:

1. **On import**, in the side panel, before a pipeline is loaded.
2. **On publish**, on the registry website, before anything is made public.
3. **At run start**, in the service worker, on every pipeline however it
   arrived — a restored checkpoint and a scheduled run included.

Import and publish deliberately answer different questions and so disagree.
Importing asks "can this hurt me if I run it", where your own token going to a
site you chose is survivable. Publishing asks "is this safe to make public",
where the same header is the entire problem. A test pins that asymmetry so
nobody "fixes" it into one rule.

It fails closed. A destination it cannot resolve — a templated host, say — is
treated as unknown rather than assumed safe.

**A second copy of this module is a vulnerability report in itself.** The
duplicate that used to live in the website had already begun to drift, and the
copy that drifts is the one that stops refusing things.

## What is already true, so you can rule it out

- No telemetry, no analytics, no server of the project's own. See
  [PRIVACY.md](PRIVACY.md).
- API keys live in `chrome.storage.session`, encrypted, and are gone when the
  browser closes.
- The logger redacts by key name, so a credential does not reach a log by being
  passed to something that logs its arguments.
- The panel's CSP is `script-src 'self'` with no `unsafe-inline`, which is what
  bounds the attribute-injection class of bug to attribute injection.
- Imported step ids are constrained to `[A-Za-z0-9_-]{1,64}` at the boundary,
  rather than escaped at each of the 61 places they are used — escaping 61
  sites leaves the 62nd to whoever adds it next.
- The network sniffer is injected only while a run is active and removed after.

## Supported versions

The latest release, and `master`. This is a single-maintainer project; there is
no backport branch and pretending otherwise would be a promise nobody keeps.
