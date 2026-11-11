// Commit history for the current HEAD: pagination, per-commit file lists, and immutable patches.
// Pure helpers over an injected `git(args)` (same convention as branches.js/comparison.js: resolves
// to stdout or throws an Error), so this is testable against a real temporary repository with no
// Herdr imports. Merge commits are always compared to their first parent (the merge's "what changed
// on this branch" view, not the combined diff across every parent); root commits are compared to the
// empty tree via `git diff-tree --root`, which is a no-op for ordinary single-parent commits so one
// command path covers both.
import { diffFlags } from "./review-model.js";
import { parseNumstat } from "./git.js";

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_LIMIT = 1000;

function checkSha(sha) {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new Error("Invalid commit.");
}

// `T` (typechange, e.g. file <-> symlink) reads as a modification; `--no-renames` keeps everything
// else to the plain A/M/D letters the file-tree UI already understands (see git.js's own `letter`).
const letter = (c) => (c === "T" ? "M" : c === "C" ? "A" : c);

// `git diff --name-status -z --no-renames` -> { path: status }. Alternating NUL-terminated tokens.
function parseNameStatus(stdout) {
  const parts = stdout.split("\0").filter(Boolean);
  const out = {};
  for (let i = 0; i + 1 < parts.length; i += 2) out[parts[i + 1]] = parts[i];
  return out;
}

async function parentShas(git, sha) {
  const line = (await git(["rev-list", "--parents", "-n", "1", sha])).trim();
  const [, ...parents] = line.split(/\s+/).filter(Boolean);
  return parents;
}

// Current HEAD's commit log, newest first. An empty/unborn repository (no HEAD commit yet) is an
// empty history, not an error; any other failure (bad root, detached and missing ref, etc.) propagates.
export async function listCommits(git, { limit = 50, skip = 0 } = {}) {
  const take = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(Number(limit) || 50)));
  const from = Math.max(0, Math.trunc(Number(skip) || 0));
  try {
    await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch (error) {
    if (error.code === 1 || error.status === 1) return { commits: [], hasMore: false };
    throw error;
  }
  const format = ["%H", "%h", "%s", "%an", "%aI", "%P"].join("%x00");
  const out = await git(["log", "-z", `--skip=${from}`, "-n", String(take + 1), `--format=${format}`, "HEAD"]);
  const fields = out.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 6 !== 0) throw new Error("Git returned malformed history records.");
  const commits = [];
  for (let i = 0; i < fields.length && commits.length < take; i += 6) {
    const [sha, short, subject, author, date, parents] = fields.slice(i, i + 6);
    checkSha(sha);
    commits.push({ sha, short, subject, author, date, parents: parents ? parents.trim().split(/\s+/) : [] });
  }
  return { commits, hasMore: fields.length / 6 > take };
}

// Changed files for one commit, excluding anything in the working tree or index.
export async function commitFiles(git, sha) {
  checkSha(sha);
  const parents = await parentShas(git, sha);
  const merge = parents.length >= 2;
  const numstatOut = merge
    ? await git(["diff", "--no-renames", "--numstat", "-z", parents[0], sha])
    : await git(["diff-tree", "-r", "--no-commit-id", "--root", "--no-renames", "--numstat", "-z", sha]);
  const statusOut = merge
    ? await git(["diff", "--no-renames", "--name-status", "-z", parents[0], sha])
    : await git(["diff-tree", "-r", "--no-commit-id", "--root", "--no-renames", "--name-status", "-z", sha]);
  const stats = parseNumstat(numstatOut);
  const statuses = parseNameStatus(statusOut);
  return Object.keys(statuses).map((path) => {
    const stat = stats[path] ?? { add: 0, del: 0, binary: false };
    return { path, status: letter(statuses[path]), add: stat.add, del: stat.del, binary: stat.binary };
  });
}

// The raw unified patch for one commit (or one file within it): an exact, immutable diff between
// commit objects. Never touches the working tree or index, so it cannot show uncommitted work.
export async function commitPatch(git, sha, { path, context = 3, ignoreWhitespace = false } = {}) {
  checkSha(sha);
  const parents = await parentShas(git, sha);
  const flags = diffFlags({ context, ignoreWhitespace });
  const scope = path ? ["--", path] : [];
  if (parents.length >= 2) {
    return await git(["diff", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", ...flags, parents[0], sha, ...scope]);
  }
  return await git(["diff-tree", "-p", "--no-commit-id", "--root", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", ...flags, sha, ...scope]);
}
