import { getDatabase } from "@/lib/server/database";
import { gitDataConfig, syncNow } from "@/lib/server/git-data";

export const runtime = "nodejs";

export async function GET() {
  const config = gitDataConfig();
  if (!config) return Response.json({ enabled: false });
  return Response.json({
    enabled: true,
    remote: config.remote,
    branch: config.branch,
    directory: config.directory,
    syncSeconds: config.syncSeconds,
    push: config.push,
  });
}

export async function POST() {
  try {
    return Response.json(await syncNow(getDatabase()));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not sync the data repository." },
      { status: 500 },
    );
  }
}
