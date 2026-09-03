import type { SettingsUpdate } from "@/lib/types";
import { disconnectGmail, readSettings, toPublicSettings, updateSettings } from "@/lib/server/settings";
import { getDatabase } from "@/lib/server/database";
import { requestGitSync } from "@/lib/server/git-data";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(toPublicSettings(await readSettings()));
}

export async function PUT(request: Request) {
  try {
    const update = await request.json() as SettingsUpdate;
    const saved = await updateSettings(update);
    // Watched sources, keywords and brief sections travel with the data
    // repository; the credentials in the same file never leave this machine.
    requestGitSync(getDatabase());
    return Response.json(saved);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not save settings." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("connection") !== "gmail") return Response.json({ error: "Unknown connection." }, { status: 400 });
  await disconnectGmail();
  return Response.json({ ok: true });
}
