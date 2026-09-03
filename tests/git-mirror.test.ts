import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exportDatabaseToFiles, importFilesIntoDatabase, mirroredTables, rowShard, rowSlug } from "../lib/git-mirror";
import { containsSecrets, mergeSharedSettings, redactSharedSettings } from "../lib/shared-settings";

function temporaryDirectory() {
  return mkdtempSync(path.join(tmpdir(), "control-center-mirror-"));
}

function seededDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE content_items (
      category TEXT NOT NULL,
      external_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      archived_at TEXT,
      archive_reason TEXT,
      PRIMARY KEY (category, external_id)
    );
    CREATE TABLE workspace_state (
      state_key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE collector_snapshots (
      collector TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      checked_at TEXT NOT NULL
    );
  `);
  database.prepare("INSERT INTO content_items VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "industry", "abc123", JSON.stringify({ id: "abc123", title: "A launch" }), "2026-02-11T08:00:00.000Z", "2026-02-12T08:00:00.000Z", null, null,
  );
  database.prepare("INSERT INTO workspace_state VALUES (?, ?, ?)").run("tasks", "[]", "2026-02-11T08:00:00.000Z");
  database.prepare("INSERT INTO collector_snapshots VALUES (?, ?, ?, ?)").run("industry", "scope", "{}", "2026-02-11T08:00:00.000Z");
  return database;
}

test("caches are never mirrored and every mirrored table is addressable by primary key", () => {
  const tables = mirroredTables(seededDatabase()).map((table) => table.name);
  assert.deepEqual(tables, ["content_items", "workspace_state"]);
});

test("a row round-trips through committed files into an empty database", () => {
  const root = temporaryDirectory();
  const source = seededDatabase();
  const exported = exportDatabaseToFiles(source, root);
  assert.equal(exported.written, 2);
  assert.equal(exported.removed, 0);
  assert.ok(exported.files.includes("data/content_items/2026-02/8342a655cb35918b731c0904a5af0f3a.json"));

  const restored = seededDatabase();
  restored.exec("DELETE FROM content_items; DELETE FROM workspace_state;");
  const imported = importFilesIntoDatabase(restored, root);
  assert.equal(imported.imported, 2);
  assert.equal(imported.skipped, 0);
  const row = restored.prepare("SELECT * FROM content_items").get() as unknown as Record<string, unknown>;
  assert.equal(row.external_id, "abc123");
  assert.equal(row.archived_at, null);
  assert.equal(JSON.parse(String(row.payload_json)).title, "A launch");
});

test("an unchanged database writes nothing, and a deleted row deletes its file", () => {
  const root = temporaryDirectory();
  const database = seededDatabase();
  exportDatabaseToFiles(database, root);
  assert.equal(exportDatabaseToFiles(database, root).written, 0);

  database.exec("DELETE FROM content_items");
  const second = exportDatabaseToFiles(database, root);
  assert.equal(second.removed, 1);
  assert.equal(readdirSync(path.join(root, "data")).includes("content_items"), false);
});

test("read state travels with the row rather than being recollected", () => {
  const root = temporaryDirectory();
  const database = seededDatabase();
  database.prepare("UPDATE content_items SET archived_at = ?, archive_reason = ?").run("2026-02-13T09:00:00.000Z", "user");
  exportDatabaseToFiles(database, root);

  const other = seededDatabase();
  importFilesIntoDatabase(other, root);
  const row = other.prepare("SELECT archived_at, archive_reason FROM content_items").get() as unknown as Record<string, unknown>;
  assert.equal(row.archived_at, "2026-02-13T09:00:00.000Z");
  assert.equal(row.archive_reason, "user");
});

test("files from an unknown table are left alone instead of being dropped", () => {
  const root = temporaryDirectory();
  const database = seededDatabase();
  exportDatabaseToFiles(database, root);
  const future = path.join(root, "data", "future_table", "2026-03");
  mkdirSync(future, { recursive: true });
  writeFileSync(path.join(future, "row.json"), '{"id":"1"}\n');

  const result = importFilesIntoDatabase(database, root);
  assert.equal(result.skipped, 1);
  assert.equal(readFileSync(path.join(future, "row.json"), "utf8"), '{"id":"1"}\n');
});

test("shards come from stable columns and fall back to undated", () => {
  assert.equal(rowShard({ published_at: "2026-01-04T00:00:00.000Z" }, ["published_at", "first_seen_at"]), "2026-01");
  assert.equal(rowShard({ published_at: null, first_seen_at: "2026-05-04T00:00:00.000Z" }, ["published_at", "first_seen_at"]), "2026-05");
  assert.equal(rowShard({ published_at: "not a date" }, ["published_at"]), "undated");
});

test("a single safe key stays readable and anything else is hashed", () => {
  assert.equal(rowSlug(["tasks"]), "tasks");
  assert.equal(rowSlug(["../escape"]).length, 32);
  assert.notEqual(rowSlug(["a", "b"]), rowSlug(["a~b"]));
});

test("credentials are stripped before anything is committed and survive a merge", () => {
  const local = {
    general: { workspaceName: "Mine" },
    industry: { keywords: ["ai"], sources: ["one"] },
    newsletters: { googleClientId: "id", googleClientSecret: "secret", refreshToken: "refresh", accessToken: "access", accessTokenExpiresAt: 12, connectedEmail: "me@example.com", gmailQuery: "q" },
    ai: { provider: "anthropic", model: "", apiKeys: { anthropic: "sk-live" } },
  };
  const shared = redactSharedSettings(local);
  assert.equal(containsSecrets(shared), false);
  assert.equal(JSON.stringify(shared).includes("sk-live"), false);
  assert.equal(JSON.stringify(shared).includes("refresh"), false);
  assert.equal(shared.general !== undefined, true);

  const incoming = { ...shared, industry: { keywords: ["robotics"], sources: ["two"] } } as Record<string, unknown>;
  const merged = mergeSharedSettings(local, incoming);
  assert.deepEqual(merged.industry.keywords, ["robotics"]);
  assert.equal(merged.ai.apiKeys.anthropic, "sk-live");
  assert.equal(merged.newsletters.refreshToken, "refresh");
});

test("a shared file carrying a credential cannot overwrite the local one", () => {
  const local = { ai: { apiKeys: { anthropic: "sk-mine" } } };
  const merged = mergeSharedSettings(local, { ai: { apiKeys: { anthropic: "sk-theirs" } } });
  assert.equal(merged.ai.apiKeys.anthropic, "sk-mine");
});
