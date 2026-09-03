export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startLocalCollectorScheduler } = await import("./lib/server/scheduler");
  const { gitDataConfig, restoreFromGit, startGitDataSync } = await import("./lib/server/git-data");

  // The clone is restored before the first request is served, so a fresh machine
  // or container never shows an empty dashboard that then fills in behind the user.
  if (gitDataConfig()) {
    const { getDatabase } = await import("./lib/server/database");
    const database = getDatabase();
    try {
      const restored = await restoreFromGit(database);
      console.log("[git-data] restored from the data repository:", restored);
    } catch (error) {
      // A remote that cannot be reached must not stop the dashboard from opening
      // on the data this machine already has.
      console.error("[git-data] restore failed:", error instanceof Error ? error.message : error);
    }
    startGitDataSync(database);
  }

  startLocalCollectorScheduler();
}
