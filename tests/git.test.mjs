import assert from "node:assert/strict";
import * as G from "../mods/tabbed-changes/git.js";
assert.deepEqual(G.parseBranch("## main...origin/main [ahead 1, behind 2]"), { name: "main", upstream: "origin/main", ahead: 1, behind: 2 });
assert.equal(G.parseBranch("## HEAD (no branch)").detached, true);
const st = G.parseStatus("## a\0MM x.js\0 M y.js\0?? z.js\0UU c.js\0A  n.js\0", { "x.js": { add: 1, del: 0 } }, { "y.js": { add: 2, del: 3 } });
assert.equal(st.staged.length, 2); assert.equal(st.changes.length, 3); assert.equal(st.conflicts.length, 1);
assert.equal(st.changes.find((f) => f.path === "y.js").del, 3);
const rows = G.diffRows(["@@ -3,2 +3,3 @@", " a", "-b", "+B", "+C"]);
assert.deepEqual(rows.map((r) => [r.kind, r.old, r.next]), [["@"], [" ", 3, 3], ["-", 4, undefined], ["+", undefined, 4], ["+", undefined, 5]].map(([k, o, n]) => [k, o, n]));
const pairs = G.pairRows(rows);
assert.equal(pairs.length, 4); assert.equal(pairs[2].l.text, "b"); assert.equal(pairs[2].r.text, "B"); assert.equal(pairs[3].l, null);
const patch = "diff --git a/src/a.js b/src/a.js\nindex 1..2 100644\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n-x\n+y\n+z\ndiff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
const files = G.splitPatch(patch);
assert.deepEqual(files.map((f) => [f.path, f.add, f.del, f.binary]), [["src/a.js", 2, 1, false], ["img.png", 0, 0, true]]);
const quotedName = String.raw`quo\"te\\and\303\274\tline\n.txt`;
const [quoted] = G.splitPatch(`diff --git "a/${quotedName}" "b/${quotedName}"\n--- "a/${quotedName}"\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n`);
assert.equal(quoted.path, 'quo"te\\andü\tline\n.txt');
assert.equal(quoted.deleted, true);
assert.equal(quoted.del, 1);
assert.deepEqual(G.editorArgv("/opt/homebrew/bin/nvim", "/r/f.ts", 12), ["/opt/homebrew/bin/nvim", "+12", "/r/f.ts"]);
assert.deepEqual(G.editorArgv("code", "/r/f.ts", 12), ["code", "/r/f.ts"]);
console.log("git.js ok");
import { tokenize } from "../mods/tabbed-changes/highlight.js";
const k = (s, e) => tokenize(s, e).filter((t) => t.kind).map((t) => `${t.kind}:${t.text}`);
assert.deepEqual(k("const a = foo(1, 'x'); // hi", "ts").filter((x) => !x.startsWith("punct")), ["keyword:const", "function:foo", "number:1", "string:'x'", "comment:// hi"]);
assert.equal(tokenize("  return <Foo bar={x} />", "tsx").map((t) => t.text).join(""), "  return <Foo bar={x} />");
assert.ok(k("x = 1  # c", "py").includes("comment:# c"));
console.log("highlight ok");
const lm = G.lineMarks("@@ -1,0 +2,2 @@\n+a\n+b\n@@ -5 +7 @@\n-x\n+y\n@@ -9,2 +10,0 @@\n-p\n-q\n");
assert.deepEqual(lm.marks, { 2: "add", 3: "add", 7: "mod" }); assert.deepEqual([...lm.deletedBefore], [11]);
console.log("lineMarks ok");
import { changeKind } from "../mods/tabbed-changes/change-kind.js";
assert.equal(changeKind({ status: "A" }), "added"); assert.equal(changeKind({ status: "U" }), "added"); assert.equal(changeKind({ fresh: true, add: 3, del: 0 }), "added");
assert.equal(changeKind({ status: "D" }), "deleted"); assert.equal(changeKind({ status: "!" }), "conflict"); assert.equal(changeKind({ add: 0, del: 4 }), "deleted");
assert.equal(changeKind({ status: "R" }), "renamed"); assert.equal(changeKind({ status: "C" }), "renamed");
assert.equal(changeKind({ status: "M" }), "modified"); assert.equal(changeKind({ add: 2, del: 1 }), "modified"); assert.equal(changeKind({}), "modified"); assert.equal(changeKind(), "modified");
assert.equal(changeKind({ status: "M", add: 0, del: 4 }), "modified", "a status letter beats the counts");
console.log("change kind ok");

// --- fast untracked listing (status --untracked-files=normal + files of the untracked directories only) ---
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as GU from "../mods/tabbed-changes/git.js";
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), "untracked-")));
  const run = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]); run(["config", "user.email", "t@example.com"]); run(["config", "user.name", "t"]);
  const put = (p, text = "x\n") => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), text); };
  put(".gitignore", "ignored/\n*.log\n"); put("tracked.txt"); run(["add", "-A"]); run(["commit", "-qm", "init"]);
  put("top.txt"); put("newdir/a.txt"); put("newdir/sub/deep/b.txt"); put("my dir/with space.txt"); put("ünï/ç.txt"); put("ignored/x.txt"); put("newdir/skip.log");
  mkdirSync(join(root, "emptydir"), { recursive: true });
  mkdirSync(join(root, "nested")); run(["init", "-q", "-b", "main"], join(root, "nested")); put("nested/file.txt");
  const git = async (args) => run([...GU.READ, ...args]);
  const reference = run([...GU.READ, "ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
  const fast = (await GU.listUntracked(git)).sort();
  assert.deepEqual(fast, reference, "the fast listing equals ls-files --others");
  assert.ok(fast.includes("newdir/sub/deep/b.txt") && fast.includes("my dir/with space.txt") && fast.includes("ünï/ç.txt") && fast.includes("top.txt"));
  assert.ok(!fast.some((p) => p.startsWith("ignored/") || p.endsWith(".log")), "ignored files stay out");
  // nothing untracked -> nothing, and no ls-files call is needed
  const clean = realpathSync(mkdtempSync(join(tmpdir(), "clean-"))); run(["init", "-q", "-b", "main"], clean); writeFileSync(join(clean, "a"), "x"); run(["add", "-A"], clean);
  let calls = 0; assert.deepEqual(await GU.listUntracked(async (args) => { calls++; return run([...GU.READ, ...args], clean); }), []); assert.equal(calls, 1);
}
// the panel's status: directories in, files out
{
  const parsed = GU.parseStatus("## main\0?? a/\0 M tracked.txt\0?? b.txt\0?? nested/\0");
  assert.deepEqual(parsed.changes.map((f) => f.path), ["a/", "tracked.txt", "b.txt", "nested/"]);
  const dirs = parsed.changes.filter((f) => f.status === "U" && GU.UNTRACKED_DIR(f.path)).map((f) => f.path);
  assert.deepEqual(dirs, ["a/", "nested/"]);
  const byDir = GU.untrackedInDirs(dirs, "a/1.txt\0a/sub/2.txt\0nested/\0");
  assert.deepEqual(byDir.get("a/"), ["a/1.txt", "a/sub/2.txt"]);
  GU.expandUntracked(parsed, byDir);
  assert.deepEqual(parsed.changes.map((f) => f.path), ["a/1.txt", "a/sub/2.txt", "tracked.txt", "b.txt", "nested/"], "files replace the directory; a directory with nothing listed (nested repo) stays");
  assert.ok(parsed.changes.filter((f) => f.status === "U").every((f) => f.fresh === true && f.group === "changes"));
  const capped = GU.expandUntracked(GU.parseStatus("## m\0?? big/\0"), new Map([["big/", Array.from({ length: 50 }, (_, i) => `big/${i}`)]]), 10);
  assert.equal(capped.changes.length, 10); assert.equal(capped.limited, true, "expansion respects the list limit");
}
console.log("fast untracked listing ok");
