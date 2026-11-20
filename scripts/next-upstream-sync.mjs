import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const CURSOR = ".github/scripts/dbx-next-upstream-base";
const OFFICIAL_MAIN = "refs/remotes/upstream/main";
const WORKFLOWS = ".github/workflows";
const NEXT_FEED = "https://github.com/xue-ding-e/DBX-Next/releases/latest/download/latest.json";
const SHA = /^[0-9a-f]{40}$/;
const EMPTY_BLOB = "0".repeat(40);

function git(args, { input, env, allowed = [0] } = {}) {
  const result = spawnSync("git", ["--no-replace-objects", ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  if (result.error) throw result.error;
  if (!allowed.includes(result.status)) {
    throw new Error("git " + args[0] + " failed: " + (result.stderr.trim() || result.stdout.trim()));
  }
  return result;
}

function resolveObject(ref, type) {
  return git(["rev-parse", "--verify", ref + "^{" + type + "}"]).stdout.trim();
}

function isAncestor(ancestor, descendant) {
  return git(["merge-base", "--is-ancestor", ancestor, descendant], { allowed: [0, 1] }).status === 0;
}

function blob(tree, path) {
  return git(["show", tree + ":" + path]).stdout;
}

function editTree(tree, edit) {
  const temporary = mkdtempSync(join(tmpdir(), "dbx-next-sync-"));
  const index = join(temporary, "index");
  const env = { GIT_INDEX_FILE: index };
  try {
    git(["read-tree", tree], { env });
    edit(env);
    return git(["write-tree"], { env }).stdout.trim();
  } finally {
    rmSync(index, { force: true });
    rmdirSync(temporary);
  }
}

function officialSourceTree(commit) {
  // Keep the unmodified official history on upstream-main. Its Actions files
  // never enter the downstream tree or run as part of an integration.
  return editTree(commit, (env) => {
    git(["rm", "-q", "--cached", "-rf", "--ignore-unmatch", "--", WORKFLOWS], { env });
  });
}

function makeCommit(tree, head, base, target) {
  const date = git(["show", "-s", "--format=%ct", target]).stdout.trim() + " +0000";
  const identity = "github-actions[bot]";
  const email = "41898282+github-actions[bot]@users.noreply.github.com";
  const message = [
    "chore(upstream): integrate DBX " + target.slice(0, 12),
    "",
    "Upstream-Repository: https://github.com/t8y2/dbx",
    "Upstream-Base: " + base,
    "Upstream-Commit: " + target,
    "",
  ].join("\n");
  return git(["-c", "commit.gpgSign=false", "commit-tree", tree, "-p", head], {
    input: message,
    env: {
      GIT_AUTHOR_NAME: identity,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: identity,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: date,
    },
  }).stdout.trim();
}

function checkNextFiles(head, tree) {
  const changed = git(["diff-tree", "-r", "--no-renames", "--name-only", "-z", head, tree]).stdout.split("\0");
  for (const path of changed) {
    if (/^\.github\/workflows\//i.test(path) ||
        /^(?:\.github\/scripts\/dbx-next-|scripts\/(?:next-upstream-sync|next-release|verify-next-release))/i.test(path)) {
      if (path !== CURSOR) throw new Error("Integration changed a DBX-Next workflow or release file: " + path);
    }
  }
  const config = "src-tauri/tauri.conf.json";
  const previous = JSON.parse(blob(head, config)).plugins.updater;
  const next = JSON.parse(blob(tree, config)).plugins.updater;
  if (!previous.pubkey || next?.pubkey !== previous.pubkey ||
      !Array.isArray(next.endpoints) || next.endpoints.length !== 1 || next.endpoints[0] !== NEXT_FEED) {
    throw new Error("Integration changed the DBX-Next updater key or feed");
  }
}

export function plan(requestedTarget) {
  const head = resolveObject("HEAD", "commit");
  const official = resolveObject(OFFICIAL_MAIN, "commit");
  if (requestedTarget && !SHA.test(requestedTarget)) throw new Error("--target requires a full upstream commit SHA");
  const target = requestedTarget ? resolveObject(requestedTarget, "commit") : official;
  const base = blob(head, CURSOR).trimEnd();
  if (!SHA.test(base) || !isAncestor(base, official) || !isAncestor(target, official) || !isAncestor(base, target)) {
    throw new Error("The target must advance the recorded upstream base on official main");
  }
  if (base === target) return { status: "current", head, base, target };

  const baseTree = officialSourceTree(base);
  const targetTree = officialSourceTree(target);
  const merge = git(["-c", "merge.conflictStyle=diff3", "merge-tree", "--write-tree", "--no-messages", "-z",
    "--merge-base=" + baseTree, head, targetTree], { allowed: [0, 1] });
  const [mergedTree, ...records] = merge.stdout.split("\0").filter(Boolean);
  const stages = records.map((record) => {
    const entry = /^([0-7]{6}) ([a-f0-9]{40}) ([123])\t([\s\S]+)$/.exec(record);
    if (!entry) throw new Error("Invalid conflict record from git merge-tree");
    return { mode: entry[1], oid: entry[2], stage: entry[3], path: entry[4] };
  });
  const conflicts = [...new Set(stages.map((entry) => entry.path))];
  const tree = editTree(mergedTree, (env) => {
    const cursorBlob = git(["hash-object", "-w", "--stdin"], { input: target + "\n" }).stdout.trim();
    git(["update-index", "--add", "--cacheinfo", "100644," + cursorBlob + "," + CURSOR], { env });
  });
  if (merge.status === 1) return { status: "blocked", head, base, target, tree, conflicts, stages };

  checkNextFiles(head, tree);
  const candidate = makeCommit(tree, head, base, target);
  return { status: "ready", head, base, target, tree, candidate };
}

function stage(result) {
  if (!result.tree || git(["status", "--porcelain", "--untracked-files=all"]).stdout) {
    throw new Error("--stage requires an integration tree and a clean worktree");
  }
  git(["read-tree", "-m", "-u", result.head, result.tree]);
  if (result.stages?.length) {
    const removals = result.conflicts.map((path) => "0 " + EMPTY_BLOB + "\t" + path + "\0");
    const entries = result.stages.map(({ mode, oid, stage, path }) => mode + " " + oid + " " + stage + "\t" + path + "\0");
    git(["update-index", "-z", "--index-info"], { input: removals.concat(entries).join("") });
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      report: { type: "string" },
      stage: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("Fetch upstream/main, then run node scripts/next-upstream-sync.mjs [--target UPSTREAM_SHA] [--report FILE].");
    console.log("Add --stage in a clean integration worktree to resolve conflicts using Git's index and diff3 markers.");
    console.log("Commit the resolved tree with the updated upstream cursor after validation.");
    return;
  }
  const result = plan(values.target);
  if (values.stage) stage(result);
  const json = JSON.stringify(result, null, 2) + "\n";
  if (values.report) writeFileSync(values.report, json);
  if (process.env.GITHUB_OUTPUT) {
    const entries = Object.entries(result).filter(([key]) => ["status", "head", "target", "candidate"].includes(key));
    appendFileSync(process.env.GITHUB_OUTPUT, entries.map(([key, value]) => key + "=" + value + "\n").join(""));
  }
  console.log(json.trimEnd());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
