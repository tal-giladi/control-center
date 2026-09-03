import { getDatabase, setContentArchived, type ContentCategory } from "@/lib/server/database";
import { updateCollectorSnapshotArchive } from "@/lib/collector-cache";
import { requestGitSync } from "@/lib/server/git-data";

export const runtime = "nodejs";

const categories = new Set<ContentCategory>(["industry", "mentions", "newsletters"]);

export async function PATCH(request: Request) {
  const database = getDatabase();
  let transactionOpen = false;
  try {
    const body = await request.json() as { category?: ContentCategory; id?: string; archived?: boolean };
    if (!body.category || !categories.has(body.category) || !body.id || typeof body.archived !== "boolean") {
      return Response.json({ error: "Category, item ID, and archived state are required." }, { status: 400 });
    }
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const updated = setContentArchived(
      database,
      body.category,
      body.id,
      body.archived,
      now,
    );
    if (!updated) {
      database.exec("ROLLBACK");
      transactionOpen = false;
      return Response.json({ error: "Saved item was not found." }, { status: 404 });
    }
    updateCollectorSnapshotArchive(
      database,
      body.category,
      body.id,
      body.archived,
      now,
    );
    database.exec("COMMIT");
    transactionOpen = false;
    requestGitSync(database);
    return Response.json({ ok: true });
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original archive error.
      }
    }
    return Response.json({ error: error instanceof Error ? error.message : "Could not update the archive." }, { status: 400 });
  }
}
