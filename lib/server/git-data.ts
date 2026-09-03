import "server-only";

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { exportDatabaseToFiles, importFilesIntoDatabase } from "@/lib/git-mirror";
import { SHARED_SETTINGS_FILE, mergeSharedSettings, redactSharedSettings } from "@/lib/shared-settings";
import { dataDirectory, readSettings, writeSettings } from "@/lib/server/settings";

const run = promisify(execFile);

export type GitDataConfig = {
  remote: string;
  branch: string;
  directory: string;
  syncSeconds: number;
  push: boolean;
  authorName: string;
  authorEmail: string;
};

export type GitSyncResult = {
  status: "disabled" | "unchanged" | "committed";
  written?: number;
  removed?: number;
  pushed?: boolean;
  message?: string;
};

declare global {
  var controlCenterGitTimer: NodeJS.Timeout | undefined;
  var controlCenterGitRunning: Promise<GitSyncResult> | undefined;
  var controlCenterGitDebounce: NodeJS.Timeout | undefined;
}

const REQUEST_DEBOUNCE_MS = 5_000;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt((value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function gitDataConfig(): GitDataConfig | null {
  const remote = process.env.CONTROL_CENTER_GIT_REMOTE?.trim();
  // With no remote configured the app behaves exactly like upstream: SQLite in
  // the data directory and nothing else.
  if (!remote) return null;
  const configured = process.env.CONTROL_CENTER_GIT_DIR?.trim();
  if (configured && !path.isAbsolute(configured))
    throw new Error("CONTROL_CENTER_GIT_DIR must be an absolute path.");
  return {
    remote,
    branch: process.env.CONTROL_CENTER_GIT_BRANCH?.trim() || "main",
    directory: configured || path.join(dataDirectory(), "git-store"),
    syncSeconds: positiveInteger(process.env.CONTROL_CENTER_GIT_SYNC_SECONDS, 120),
    push: process.env.CONTROL_CENTER_GIT_PUSH?.trim() !== "0",
    authorName: process.env.CONTROL_CENTER_GIT_AUTHOR_NAME?.trim() || "Control Center",
    authorEmail: process.env.CONTROL_CENTER_GIT_AUTHOR_EMAIL?.trim() || "control-center@localhost",
  };
}

// The token reaches git through an askpass helper instead of the remote URL, so
// it never lands in .git/config, in a commit, or in the process arguments.
function gitEnvironment() {
  const askpass = process.env.GIT_ASKPASS?.trim();
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    ...(askpass ? { GIT_ASKPASS: askpass } : {}),
  };
}

async function git(config: GitDataConfig, args: string[]) {
  const { stdout } = await run("git", args, {
    cwd: config.directory,
    env: gitEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

async function gitOutsideRepository(args: string[]) {
  const { stdout } = await run("git", args, { env: gitEnvironment(), maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

async function isRepository(directory: string) {
  if (!existsSync(path.join(directory, ".git"))) return false;
  try {
    await run("git", ["rev-parse", "--git-dir"], { cwd: directory, env: gitEnvironment(), windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function ensureRepository(config: GitDataConfig) {
  mkdirSync(path.dirname(config.directory), { recursive: true });
  if (!(await isRepository(config.directory))) {
    mkdirSync(config.directory, { recursive: true });
    await gitOutsideRepository(["clone", "--branch", config.branch, config.remote, config.directory])
      .catch(async () => {
        // A repository created empty has no branch to clone yet.
        await gitOutsideRepository(["init", "--initial-branch", config.branch, config.directory]);
        await git(config, ["remote", "add", "origin", config.remote]);
      });
  }
  await git(config, ["config", "user.name", config.authorName]);
  await git(config, ["config", "user.email", config.authorEmail]);
  await git(config, ["remote", "set-url", "origin", config.remote]).catch(async () => {
    await git(config, ["remote", "add", "origin", config.remote]);
  });
  return config.directory;
}

async function headCommit(config: GitDataConfig) {
  try {
    return await git(config, ["rev-parse", "HEAD"]);
  } catch {
    return "";
  }
}

// Any local file state is discarded: the database is the merge point, so the
// remote is taken verbatim and re-exported from the database afterwards.
// Returns true only when the remote actually moved, because re-importing an
// unchanged clone would replay the committed settings over a newer local edit.
export async function pullLatest(config: GitDataConfig) {
  const before = await headCommit(config);
  try {
    await git(config, ["fetch", "--prune", "origin", config.branch]);
  } catch {
    return false;
  }
  try {
    await git(config, ["checkout", "-B", config.branch, `origin/${config.branch}`]);
  } catch {
    return false;
  }
  return (await headCommit(config)) !== before;
}

async function readSharedSettingsFile(config: GitDataConfig) {
  const file = path.join(config.directory, SHARED_SETTINGS_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function writeSharedSettingsFile(config: GitDataConfig, settings: Record<string, unknown>) {
  const file = path.join(config.directory, SHARED_SETTINGS_FILE);
  const contents = `${JSON.stringify(redactSharedSettings(settings), null, 2)}\n`;
  if (existsSync(file) && readFileSync(file, "utf8") === contents) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return true;
}

export async function importFromGit(config: GitDataConfig, database: DatabaseSync) {
  const shared = await readSharedSettingsFile(config);
  if (shared) await writeSettings(mergeSharedSettings(await readSettings(), shared));
  return importFilesIntoDatabase(database, config.directory);
}

async function hasPendingChanges(config: GitDataConfig) {
  return Boolean(await git(config, ["status", "--porcelain"]));
}

// A commit made while the remote was unreachable -- no token yet, no network --
// must not sit here forever just because nothing has changed since.
async function unpushedCommits(config: GitDataConfig) {
  try {
    const count = await git(config, ["rev-list", "--count", `origin/${config.branch}..HEAD`]);
    return Number.parseInt(count, 10) || 0;
  } catch {
    // No remote-tracking ref yet: everything committed here is unpushed.
    try {
      return Number.parseInt(await git(config, ["rev-list", "--count", "HEAD"]), 10) || 0;
    } catch {
      return 0;
    }
  }
}

async function push(config: GitDataConfig): Promise<Pick<GitSyncResult, "pushed" | "message">> {
  if (!config.push) return { pushed: false };
  try {
    await git(config, ["push", "origin", `HEAD:${config.branch}`]);
    return { pushed: true };
  } catch (error) {
    return { pushed: false, message: error instanceof Error ? error.message : "Push failed." };
  }
}

async function commitAndPush(config: GitDataConfig, message: string): Promise<GitSyncResult> {
  await git(config, ["add", "--all"]);
  if (!(await hasPendingChanges(config))) {
    if (!(await unpushedCommits(config))) return { status: "unchanged" };
    return { status: "committed", ...(await push(config)) };
  }
  await git(config, ["commit", "--message", message]);
  return { status: "committed", ...(await push(config)) };
}

export async function syncNow(database: DatabaseSync): Promise<GitSyncResult> {
  const config = gitDataConfig();
  if (!config) return { status: "disabled" };
  if (globalThis.controlCenterGitRunning) return globalThis.controlCenterGitRunning;

  const work = (async (): Promise<GitSyncResult> => {
    await ensureRepository(config);
    // Take whatever another machine pushed first, fold it into the database, and
    // only then write the database back out. The export is a full reconciliation,
    // so exporting over an unread remote change would delete that change.
    if (await pullLatest(config)) await importFromGit(config, database);

    const exported = exportDatabaseToFiles(database, config.directory);
    writeSharedSettingsFile(config, await readSettings() as unknown as Record<string, unknown>);
    const result = await commitAndPush(
      config,
      `Sync ${exported.written} updated, ${exported.removed} removed at ${new Date().toISOString()}`,
    );
    return { ...result, written: exported.written, removed: exported.removed };
  })();

  globalThis.controlCenterGitRunning = work;
  try {
    return await work;
  } finally {
    globalThis.controlCenterGitRunning = undefined;
  }
}

// Boot always imports, whether or not the remote moved: this machine's database
// may be empty, or a container rebuild away from whatever the clone holds.
export async function restoreFromGit(database: DatabaseSync) {
  const config = gitDataConfig();
  if (!config) return { status: "disabled" as const };
  await ensureRepository(config);
  await pullLatest(config);
  const imported = await importFromGit(config, database);
  return { status: "restored" as const, ...imported };
}

// Marking an item read or editing a task should reach the repository in seconds,
// not on the next interval, but a burst of clicks must still produce one commit.
export function requestGitSync(database: DatabaseSync) {
  if (!gitDataConfig()) return;
  if (globalThis.controlCenterGitDebounce) clearTimeout(globalThis.controlCenterGitDebounce);
  globalThis.controlCenterGitDebounce = setTimeout(() => {
    globalThis.controlCenterGitDebounce = undefined;
    void syncNow(database).catch((error) => {
      console.error("[git-data] sync failed:", error instanceof Error ? error.message : error);
    });
  }, REQUEST_DEBOUNCE_MS);
  globalThis.controlCenterGitDebounce.unref();
}

export function startGitDataSync(database: DatabaseSync) {
  const config = gitDataConfig();
  if (!config || globalThis.controlCenterGitTimer) return;
  globalThis.controlCenterGitTimer = setInterval(() => {
    void syncNow(database).catch((error) => {
      console.error("[git-data] sync failed:", error instanceof Error ? error.message : error);
    });
  }, config.syncSeconds * 1_000);
  globalThis.controlCenterGitTimer.unref();
}
