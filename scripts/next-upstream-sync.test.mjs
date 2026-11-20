import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { plan } from "./next-upstream-sync.mjs";

const script = fileURLToPath(new URL("./next-upstream-sync.mjs", import.meta.url));
const cursor = ".github/scripts/dbx-next-upstream-base";
const feed = "https://github.com/xue-ding-e/DBX-Next/releases/latest/download/latest.json";
const config = "src-tauri/tauri.conf.json";

test("integrates official changes into linear Next history and stages overlapping edits", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "dbx-sync-test-"));
  const cwd = process.cwd();
  function git(...args) {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  }
  function write(file, contents) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), contents);
  }
  function commit() {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  }
  try {
    git("init", "-q", "-b", "official");
    git("config", "user.name", "DBX test");
    git("config", "user.email", "dbx@example.invalid");
    git("config", "commit.gpgSign", "false");
    git("config", "core.hooksPath", path.join(repo, "unused-hooks"));
    write(config, JSON.stringify({ plugins: { updater: { pubkey: "official", endpoints: ["https://upstream.invalid"] } } }));
    write("overlap", "original\n");
    const base = commit();
    const upstreamWorkflow = ".github/workflows/official.yml";
    write(upstreamWorkflow, "official workflow\n");
    write("new-upstream", "official addition\n");
    const clean = commit();
    write("overlap", "official edit\n");
    const conflict = commit();
    git("update-ref", "refs/remotes/upstream/main", conflict);

    git("switch", "-q", "--orphan", "next");
    write(cursor, base + "\n");
    write(config, JSON.stringify({ plugins: { updater: { pubkey: "next", endpoints: [feed] } } }));
    write("overlap", "Next edit\n");
    write("next-only", "feature\n");
    write(".github/workflows/release-next.yml", "Next workflow\n");
    const head = commit();
    process.chdir(repo);

    const result = plan(clean);
    assert.equal(result.status, "ready");
    assert.equal(git("rev-list", "--parents", "-n", "1", result.candidate), result.candidate + " " + head);
    assert.equal(git("show", result.candidate + ":" + cursor), clean);
    assert.equal(git("show", result.candidate + ":new-upstream"), "official addition");
    assert.equal(git("show", result.candidate + ":next-only"), "feature");
    assert.equal(git("show", result.candidate + ":overlap"), "Next edit");
    assert.equal(git("show", result.candidate + ":.github/workflows/release-next.yml"), "Next workflow");
    assert.equal(git("ls-tree", "-r", result.candidate, "--", upstreamWorkflow), "");
    assert.equal(plan(clean).candidate, result.candidate);
    assert.throws(() => plan(head), /on official main/);
    assert.equal(git("status", "--porcelain"), "");

    git("merge", "--ff-only", result.candidate);
    assert.equal(plan(clean).status, "current");
    assert.throws(() => plan(base), /advance the recorded upstream base/);
    const blocked = JSON.parse(execFileSync(process.execPath, [script, "--stage"], { encoding: "utf8" }));
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blocked.conflicts, ["overlap"]);
    assert.deepEqual(blocked.stages.map((entry) => entry.stage), ["1", "2", "3"]);
    assert.equal(git("show", ":1:overlap"), "original");
    assert.equal(git("show", ":2:overlap"), "Next edit");
    assert.equal(git("show", ":3:overlap"), "official edit");
    assert.equal(git("show", ":" + cursor), conflict);
    assert.equal(git("rev-parse", "HEAD"), result.candidate);
  } finally {
    process.chdir(cwd);
    if (path.dirname(path.resolve(repo)) !== path.resolve(tmpdir()) ||
        !path.basename(repo).startsWith("dbx-sync-test-")) throw new Error("Unexpected fixture path");
    rmSync(repo, { recursive: true, force: true });
  }
});
