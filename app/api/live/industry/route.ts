import type { IndustrySourceStatus, LiveFeedResponse, LiveStory } from "@/lib/types";
import { readSettings } from "@/lib/server/settings";
import { parseFeed, readIndustrySnapshots, readSource, writeIndustrySnapshots } from "@/lib/server/rss";
import { isFeedDocument } from "@/lib/feed-discovery";
import { INDUSTRY_FRESHNESS_HOURS } from "@/lib/freshness";
import { getDatabase, syncContentItems } from "@/lib/server/database";
import { safeFetchText } from "@/lib/server/safe-fetch";
import { freshIndustryDiscoveries, sortIndustryItems, splitIndustryLibrary, topicDiscoveryStatus } from "@/lib/industry";
import { collectionScope } from "@/lib/collection-scope";
import { industryCacheScope } from "@/lib/collector-scopes";
import { curateIndustryDiscoveries, selectDiverseIndustryDiscoveries } from "@/lib/industry-curation";
import { listIndustryDiscoveries, pruneIndustryDiscoveries, upsertIndustryDiscoveries } from "@/lib/industry-store";
import { curateIndustryWithAi } from "@/lib/server/industry-ai";
import { readCurationSelections, writeCurationBrief, type CurationCandidate } from "@/lib/curation-store";
import {
  readCollectorSnapshot,
  writeCollectorSnapshot,
} from "@/lib/collector-cache";

export const runtime = "nodejs";

declare global {
  var controlCenterIndustryQueue: Promise<void> | undefined;
}

function topicQueries(keywords: string[]) {
  const cleaned = [...new Set(keywords.map((keyword) => keyword.replaceAll('"', "").trim()).filter(Boolean))].slice(0, 24);
  const queries: string[] = [];
  for (let index = 0; index < cleaned.length; index += 6) {
    const group = cleaned.slice(index, index + 6).map((keyword) => `"${keyword}"`).join(" OR ");
    queries.push(`${group.length ? `(${group}) ` : ""}when:1d`);
  }
  return queries;
}

async function readTopicNews(keywords: string[]) {
  const queries = topicQueries(keywords);
  const results = await Promise.allSettled(queries.map(async (query) => {
    const endpoint = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const response = await safeFetchText(endpoint);
    if (!isFeedDocument(response.text)) throw new Error("Topic provider returned a non-feed response.");
    return { endpoint, items: parseFeed(response.text, "Google News").map((item) => ({ ...item, kind: "topic" as const })) };
  }));
  const items: LiveStory[] = [];
  const errors: string[] = [];
  let endpoint = "https://news.google.com/";
  let successfulQueries = 0;
  results.forEach((result) => {
    if (result.status === "fulfilled") {
      successfulQueries += 1;
      endpoint = result.value.endpoint;
      items.push(...result.value.items);
    } else {
      errors.push(`Topic discovery: ${result.reason instanceof Error ? result.reason.message : "Google News could not be read"}`);
    }
  });
  const uniqueItems = [...new Map(items.map((item) => [item.url || item.id, item])).values()];
  return { items: uniqueItems, errors, endpoint, queryCount: queries.length, successfulQueries };
}

async function collectIndustry() {
  const settings = await readSettings();
  const checkedAt = new Date().toISOString();
  const freshSince = new Date(Date.parse(checkedAt) - INDUSTRY_FRESHNESS_HOURS * 60 * 60 * 1000).toISOString();
  const freshUntil = new Date(Date.parse(checkedAt) + 10 * 60 * 1000).toISOString();
  const sourceScopes = new Map(settings.industry.sources.map((source) => [
    source.id,
    collectionScope("industry-source-v2", [source.id, source.url]),
  ]));
  const topicScope = settings.industry.keywords.length
    ? collectionScope("industry-topics-v2", settings.industry.keywords)
    : "";
  const discoveryScopes = [...sourceScopes.values(), ...(topicScope ? [topicScope] : [])];
  const surfacedScope = collectionScope("industry-curated-v1", [
    settings.industry.description,
    ...settings.industry.keywords.map((keyword) => `topic:${keyword}`),
    ...settings.industry.excludedTerms.map((term) => `exclude:${term}`),
    `limit:${settings.industry.dailyLimit}`,
  ]);
  if (!settings.industry.sources.length && !settings.industry.keywords.length) {
    const saved = syncContentItems<LiveStory>("industry", [], {
      freshSince,
      freshUntil,
      activeScopes: [],
      currentSweepOnly: true,
    });
    const hasSavedLibrary = saved.active.length + saved.archived.length > 0;
    const { archivedItems, historyItems } = splitIndustryLibrary(saved.archived);
    return Response.json({ configured: hasSavedLibrary, checkedAt, items: saved.active, archivedItems, archiveCount: archivedItems.length, historyItems, historyCount: historyItems.length, errors: hasSavedLibrary ? ["Tracking is paused because no Industry sources are configured. Saved history remains available."] : [], sourceStatuses: [], freshnessHours: INDUSTRY_FRESHNESS_HOURS, discoveredCount: 0, surfacedLimit: settings.industry.dailyLimit, curationMode: "local", providerStatuses: [] } satisfies LiveFeedResponse);
  }
  const snapshots = await readIndustrySnapshots();
  const nextSnapshots = { ...snapshots };
  const [sourceResults, topicResult] = await Promise.all([
    Promise.allSettled(settings.industry.sources.map((source) => readSource(source, snapshots[source.id]))),
    settings.industry.keywords.length ? readTopicNews(settings.industry.keywords) : Promise.resolve({ items: [] as LiveStory[], errors: [] as string[], endpoint: "", queryCount: 0, successfulQueries: 0 }),
  ]);
  const siteItems: LiveStory[] = [];
  const errors: string[] = [];
  const sourceStatuses: IndustrySourceStatus[] = [];
  let snapshotsUpdated = false;
  sourceResults.forEach((result, index) => {
    if (result.status === "fulfilled") {
      const scope = sourceScopes.get(settings.industry.sources[index].id)!;
      siteItems.push(...result.value.items.map((item) => ({ ...item, collectionScope: scope })));
      sourceStatuses.push(result.value.status);
      if (result.value.snapshot) {
        nextSnapshots[settings.industry.sources[index].id] = result.value.snapshot;
        snapshotsUpdated = true;
      }
    }
    else errors.push(`${settings.industry.sources[index].name || settings.industry.sources[index].url}: ${result.reason instanceof Error ? result.reason.message : "Failed to read source"}`);
  });
  if (snapshotsUpdated) await writeIndustrySnapshots(nextSnapshots);
  if (settings.industry.keywords.length) {
    const status = topicDiscoveryStatus({
      endpoint: topicResult.endpoint,
      itemCount: topicResult.items.length,
      keywordCount: settings.industry.keywords.length,
      successfulQueries: topicResult.successfulQueries,
    });
    if (status) sourceStatuses.push(status);
  }
  errors.push(...topicResult.errors);
  const topicItems = topicScope
    ? topicResult.items.map((item) => ({ ...item, collectionScope: topicScope }))
    : [];
  const currentItems = freshIndustryDiscoveries(siteItems, topicItems, Date.parse(checkedAt));
  const database = getDatabase();
  upsertIndustryDiscoveries(database, currentItems, checkedAt);
  pruneIndustryDiscoveries(database, { now: checkedAt });
  const rawItems = listIndustryDiscoveries<LiveStory>(database, {
    since: freshSince,
    until: freshUntil,
    collectionScopes: discoveryScopes,
    limit: 10_000,
  }).map((record) => ({
    ...record.item,
    discoveredAt: record.item.discoveredAt || record.firstSeenAt,
  }));
  const local = curateIndustryDiscoveries(rawItems, {
    now: Date.parse(checkedAt),
    limit: settings.industry.dailyLimit,
    topicTerms: settings.industry.keywords,
    excludeTerms: settings.industry.excludedTerms,
  });
  let selected = local.selected;
  let curationMode: NonNullable<LiveFeedResponse["curationMode"]> = "local";
  const providerStatuses: NonNullable<LiveFeedResponse["providerStatuses"]> = [];

  // The pool an external curator works from is the same one the AI provider
  // would receive: everything the local ranking kept or deferred, minus the
  // duplicate coverage it already folded together.
  const pool = [...local.selected, ...local.deferred]
    .filter((candidate) => candidate.deferredReason !== "similar-event")
    .sort((left, right) => right.score - left.score)
    .slice(0, 120);
  writeCurationBrief(database, {
    category: "industry",
    generatedAt: checkedAt,
    limit: settings.industry.dailyLimit,
    niche: settings.industry.description,
    keywords: settings.industry.keywords,
    excludedTerms: settings.industry.excludedTerms,
    candidates: pool.map((candidate): CurationCandidate => ({
      id: candidate.discoveryId,
      title: candidate.item.title,
      summary: (candidate.item.summary || "").slice(0, 600),
      source: candidate.item.source,
      url: candidate.item.url || "",
      publishedAt: candidate.item.publishedAt || candidate.item.discoveredAt || "",
      localScore: candidate.score,
      localReasons: candidate.reasons.slice(0, 4),
      corroboratingSources: candidate.corroboratingSources.slice(0, 6),
    })),
  });

  const external = readCurationSelections(database, "industry", Date.parse(checkedAt));
  const applySelections = (
    selections: readonly { discoveryId: string; score: number; reason: string }[],
  ) => {
    const byId = new Map(pool.map((candidate) => [candidate.discoveryId, candidate]));
    const reranked = selections.flatMap((selection) => {
      const candidate = byId.get(selection.discoveryId);
      return candidate ? [{
        ...candidate,
        score: selection.score,
        reasons: [selection.reason, ...candidate.reasons],
      }] : [];
    });
    const minimumUsefulSet = Math.min(20, settings.industry.dailyLimit, local.selected.length);
    return selectDiverseIndustryDiscoveries(
      [...reranked, ...local.selected],
      { limit: Math.min(settings.industry.dailyLimit, Math.max(reranked.length, minimumUsefulSet)) },
    ).selected;
  };

  // Picks posted to /api/curation stand in for the model entirely, whether or
  // not a provider is configured.
  if (external.selections.length) {
    selected = applySelections(external.selections);
    curationMode = "external";
    providerStatuses.push({
      provider: `${external.curator} curation`,
      state: "live",
      message: `${external.selections.length} external picks; ${selected.length} important updates surfaced from ${rawItems.length} discoveries.`,
    });
  } else if (settings.ai.provider === "none") {
    providerStatuses.push({
      provider: "AI curation",
      state: "disabled",
      message: `Local importance ranking surfaced ${selected.length} of ${rawItems.length} current discoveries.`,
    });
  } else {
    try {
      const ai = await curateIndustryWithAi(settings, pool, {
        niche: settings.industry.description,
        keywords: settings.industry.keywords,
        excludedTerms: settings.industry.excludedTerms,
        limit: settings.industry.dailyLimit,
        now: Date.parse(checkedAt),
      });
      selected = applySelections(ai.selections);
      curationMode = ai.provider;
      providerStatuses.push({
        provider: `${ai.provider} curation`,
        state: "live",
        message: `${ai.selections.length} semantic picks; ${selected.length} important updates surfaced from ${rawItems.length} discoveries.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI curation failed";
      errors.push(`AI curation: ${message} Local ranking was used instead.`);
      providerStatuses.push({
        provider: `${settings.ai.provider} curation`,
        state: "degraded",
        message: `${message} Local ranking surfaced ${selected.length} updates.`,
      });
    }
  }
  const surfacedItems: LiveStory[] = selected.map((candidate) => ({
    ...candidate.item,
    id: `industry:${candidate.discoveryId}`,
    collectionScope: surfacedScope,
    importanceScore: candidate.score,
    importanceReason: candidate.reasons.slice(0, 3).join(" · ") ||
      "Ranked as a timely, relevant industry update.",
  }));
  const saved = syncContentItems<LiveStory>("industry", surfacedItems, {
    freshSince,
    freshUntil,
    activeScopes: [surfacedScope],
    currentSweepOnly: true,
  });
  const { archivedItems, historyItems } = splitIndustryLibrary(saved.archived);
  return Response.json({ configured: true, checkedAt, items: sortIndustryItems(saved.active, "important"), archivedItems, archiveCount: archivedItems.length, historyItems, historyCount: historyItems.length, errors, sourceStatuses, freshnessHours: INDUSTRY_FRESHNESS_HOURS, discoveredCount: rawItems.length, surfacedLimit: settings.industry.dailyLimit, curationMode, providerStatuses } satisfies LiveFeedResponse);
}

export async function GET(request: Request) {
  const settings = await readSettings();
  const scope = industryCacheScope(settings);
  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (!forceRefresh) {
    const cached = readCollectorSnapshot<LiveFeedResponse>(
      getDatabase(),
      "industry",
      scope,
    );
    if (cached) {
      return Response.json(cached.payload, {
        headers: { "X-Control-Center-Cache": "hit" },
      });
    }
  }
  const previous = globalThis.controlCenterIndustryQueue ?? Promise.resolve();
  let release = () => {};
  globalThis.controlCenterIndustryQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const response = await collectIndustry();
    if (response.ok) {
      const payload = await response.clone().json() as LiveFeedResponse;
      const saved = writeCollectorSnapshot(
        getDatabase(),
        "industry",
        scope,
        payload,
        payload.checkedAt,
      );
      return Response.json(saved, {
        headers: { "X-Control-Center-Cache": "refresh" },
      });
    }
    response.headers.set("X-Control-Center-Cache", "refresh");
    return response;
  } finally {
    release();
  }
}
