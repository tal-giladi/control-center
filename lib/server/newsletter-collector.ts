import "server-only";

import { createHash } from "node:crypto";
import { collectionScope } from "@/lib/collection-scope";
import {
  buildNewsletterTopics,
  canonicalizeNewsletterUrl,
  gmailMessageText,
  likelyNewsletterRedirect,
  isNewsletterHousekeepingSubject,
  newsletterMentionId,
  newsletterPublisher,
  newsletterSenderLabel,
  maskNewsletterIdentifiers,
  prepareNewsletterForAi,
  validateNewsletterAiStories,
  type GmailMessagePart,
  type NewsletterMentionRecord,
  type ExtractedNewsletterLink,
} from "@/lib/newsletter-intelligence";
import {
  knownNewsletterIssueIds,
  assignNewsletterTopicIdentities,
  listNewsletterMentions,
  newsletterStoreStats,
  pruneNewsletterEvidence,
  saveNewsletterIssue,
} from "@/lib/newsletter-store";
import type { NewsletterFeedResponse, NewsletterTopic } from "@/lib/types";
import { getGmailAccessToken, gmailJson } from "@/lib/server/gmail";
import { getDatabase, syncContentItems } from "@/lib/server/database";
import { resolvePublicRedirect } from "@/lib/server/safe-fetch";
import { consolidateNewsletterTopicsWithAi, extractNewsletterStoriesWithAi, prioritizeSavedNewsletterTopicsWithAi } from "@/lib/server/newsletter-ai";
import { configuredAiReady } from "@/lib/server/settings";
import type { readSettings } from "@/lib/server/settings";
import { isLocalAiProvider } from "@/lib/ai-providers";
import { newsletterPriority, sortFeedStories } from "@/lib/feed-priority";

const MAX_MESSAGES = 500;
const MAX_NEW_ISSUES_PER_PASS = 16;
const MAX_REDIRECTS_PER_PASS = 1_000;
const EVIDENCE_RETENTION_DAYS = 180;
const NEWSLETTER_ACTIVE_HOURS = 36;
const NEWSLETTER_PROCESSOR_VERSION = 3;

type Settings = Awaited<ReturnType<typeof readSettings>>;
type GmailList = { messages?: Array<{ id: string }>; nextPageToken?: string };
type GmailMessage = {
  id: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailMessagePart & {
    headers?: Array<{ name: string; value: string }>;
  };
};

type ParsedIssue = {
  message: GmailMessage;
  sender: string;
  subject: string;
  receivedAt: string;
  gmailUrl: string;
  html: string;
  text: string;
  links: ExtractedNewsletterLink[];
};

declare global {
  var controlCenterNewsletterJobs: Map<string, Promise<NewsletterFeedResponse>> | undefined;
}

export function newsletterAiConfigured(settings: Settings) {
  return configuredAiReady(settings);
}

async function settleWithConcurrency<T, R>(
  values: T[],
  limit: number,
  operation: (value: T) => Promise<R>,
) {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        try {
          results[index] = {
            status: "fulfilled",
            value: await operation(values[index]),
          };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}

export function newsletterWindowDays(query: string) {
  const match = query.match(/newer_than:(\d+)d/i);
  return Math.max(1, Math.min(365, Number(match?.[1]) || 30));
}

export function newsletterCollectionScope(settings: Settings) {
  return collectionScope("newsletter-topics-v3", [
    settings.newsletters.connectedEmail.toLowerCase(),
    settings.newsletters.gmailQuery,
    settings.ai.provider,
    settings.ai.model,
    settings.industry.description,
    ...settings.industry.keywords.map((term) => `topic:${term}`),
    ...settings.industry.excludedTerms.map((term) => `exclude:${term}`),
    ...(isLocalAiProvider(settings.ai.provider) ? [settings.ai.localBaseUrls[settings.ai.provider]] : []),
  ]);
}

async function listMessageIds(token: string, query: string) {
  const messageIds: string[] = [];
  let pageToken = "";
  while (messageIds.length < MAX_MESSAGES) {
    const list = await gmailJson<GmailList>(
      `/messages?maxResults=100&q=${encodeURIComponent(query)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      token,
    );
    messageIds.push(...(list.messages || []).map(({ id }) => id));
    pageToken = list.nextPageToken || "";
    if (!pageToken) break;
  }
  return [...new Set(messageIds)].slice(0, MAX_MESSAGES);
}

function parseIssue(message: GmailMessage, mailbox: string): ParsedIssue {
  const headers = new Map(
    (message.payload?.headers || []).map((header) => [
      header.name.toLowerCase(),
      header.value,
    ]),
  );
  const { html, text } = gmailMessageText(message.payload);
  const sender = newsletterSenderLabel(headers.get("from") || "Unknown newsletter");
  const subject = headers.get("subject") || "Untitled newsletter";
  const receivedAt = new Date(Number(message.internalDate || Date.now())).toISOString();
  const gmailUrl = `https://mail.google.com/mail/u/${encodeURIComponent(mailbox)}/#all/${message.id}`;
  return {
    message,
    sender,
    subject,
    receivedAt,
    gmailUrl,
    html,
    text,
    links: [],
  };
}

async function resolveTrackedLinks(issues: ParsedIssue[]) {
  const candidates = [...new Set(
    issues.flatMap((issue) => issue.links.map(({ url }) => url))
      .filter(likelyNewsletterRedirect),
  )].slice(0, MAX_REDIRECTS_PER_PASS);
  const results = await settleWithConcurrency(candidates, 16, (url) =>
    resolvePublicRedirect(url, { timeoutMs: 8_000 }));
  const resolved = new Map<string, string>();
  let failed = 0;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      resolved.set(
        candidates[index],
        canonicalizeNewsletterUrl(result.value) || candidates[index],
      );
    } else failed += 1;
  });
  return { resolved, failed, attempted: candidates.length };
}

function mentionsForIssue(
  issue: ParsedIssue,
  mailbox: string,
  resolved: Map<string, string>,
  firstSeenAt: string,
) {
  const issueKey = `${mailbox}:${issue.message.id}`;
  return [...new Map(issue.links.map((link) => {
    const canonicalUrl = canonicalizeNewsletterUrl(
      resolved.get(link.url) || link.url,
    );
    if (!canonicalUrl) return ["", null] as const;
    const mention: NewsletterMentionRecord = {
      id: newsletterMentionId(issueKey, canonicalUrl, link.title),
      issueId: issue.message.id,
      canonicalUrl,
      url: link.url,
      title: link.title,
      context: link.context,
      publisher: newsletterPublisher(canonicalUrl),
      newsletterSender: issue.sender,
      newsletterSubject: issue.subject,
      receivedAt: issue.receivedAt,
      gmailUrl: issue.gmailUrl,
      firstSeenAt,
      importanceScore: link.importanceScore,
      importanceReason: link.importanceReason,
      curationMode: link.curationMode,
    };
    return [`${canonicalUrl}\u0000${mention.title.toLowerCase()}`, mention] as const;
  }).filter(([key]) => key)).values()]
    .filter((mention): mention is NewsletterMentionRecord => Boolean(mention));
}

function topicLists(
  topics: NewsletterTopic[],
  settings: Settings,
) {
  const since = new Date(
    Date.now() - NEWSLETTER_ACTIVE_HOURS * 3_600_000,
  ).toISOString();
  const saved = syncContentItems<NewsletterTopic>("newsletters", topics, {
    freshSince: since,
    activeScopes: [newsletterCollectionScope(settings)],
    currentSweepOnly: true,
  });
  return {
    active: sortFeedStories(saved.active.filter((item) => item.kind === "newsletter-topic").map(newsletterPriority)),
    archived: sortFeedStories(saved.archived.filter((item) =>
      item.kind === "newsletter-topic" &&
      item.workflow?.archiveReason === "user").map(newsletterPriority)),
    history: sortFeedStories(saved.archived.filter((item) =>
      item.kind === "newsletter-topic" &&
      item.collectionScope === newsletterCollectionScope(settings) &&
      item.workflow?.archiveReason === "expired").map(newsletterPriority)),
  };
}

// Extraction -- turning an email body into stories -- is the one part of the
// newsletter pipeline that needs judgement. These two halves let an external
// curator supply it instead of a configured AI provider: the first hands out the
// same evidence the model would receive, the second applies the answer through
// exactly the same validation and storage path.
async function pendingNewsletterMessageIds(settings: Settings, token: string) {
  const messageIds = await listMessageIds(token, settings.newsletters.gmailQuery);
  const known = knownNewsletterIssueIds(
    getDatabase(),
    settings.newsletters.connectedEmail,
    messageIds,
    NEWSLETTER_PROCESSOR_VERSION,
    newsletterCollectionScope(settings),
  );
  return messageIds.filter((id) => !known.has(id));
}

export async function prepareNewsletterExtractionBatch(settings: Settings, limit = MAX_NEW_ISSUES_PER_PASS) {
  const mailbox = settings.newsletters.connectedEmail;
  const token = await getGmailAccessToken();
  const pendingIds = await pendingNewsletterMessageIds(settings, token);
  const batch = pendingIds.slice(0, Math.max(1, Math.min(MAX_NEW_ISSUES_PER_PASS, limit)));
  const database = getDatabase();
  const scope = newsletterCollectionScope(settings);
  const results = await settleWithConcurrency(batch, 4, async (id) => {
    const message = await gmailJson<GmailMessage>(`/messages/${id}?format=full`, token);
    const issue = parseIssue(message, mailbox);
    const prepared = prepareNewsletterForAi(issue);
    // Housekeeping mail and issues with no readable body or links carry no news.
    // They are recorded as processed with no mentions -- exactly what the AI path
    // does with them -- so they stop occupying a slot in every later batch.
    if (isNewsletterHousekeepingSubject(issue.subject) || !prepared.bodyText || !prepared.links.length) {
      saveNewsletterIssue(database, {
        messageId: issue.message.id,
        mailbox,
        sender: issue.sender,
        subject: issue.subject,
        receivedAt: issue.receivedAt,
        gmailUrl: issue.gmailUrl,
        bodyHash: createHash("sha256").update(`${issue.html} ${issue.text}`).digest("hex"),
        processedAt: new Date().toISOString(),
        processorVersion: NEWSLETTER_PROCESSOR_VERSION,
        processorScope: scope,
      }, []);
      return null;
    }
    return {
      messageId: issue.message.id,
      // Addresses and subscriber-specific URLs are masked before the evidence
      // leaves the app, exactly as they are for a provider.
      sender: maskNewsletterIdentifiers(issue.sender),
      subject: maskNewsletterIdentifiers(issue.subject),
      receivedAt: issue.receivedAt,
      bodyText: prepared.bodyText,
      links: prepared.links.map(({ id, title }) => ({ id, title })),
    };
  });
  return {
    mailbox,
    issues: results.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : [])),
    pendingCount: pendingIds.length,
    unreadable: results.filter((result) => result.status === "rejected").length,
  };
}

export async function applyExternalNewsletterStories(
  settings: Settings,
  storiesByMessageId: ReadonlyMap<string, unknown>,
) {
  const mailbox = settings.newsletters.connectedEmail;
  const scope = newsletterCollectionScope(settings);
  const database = getDatabase();
  const checkedAt = new Date().toISOString();
  const token = await getGmailAccessToken();
  // The message is read again rather than held in the database between the two
  // calls: raw newsletter bodies are deliberately never stored.
  const results = await settleWithConcurrency([...storiesByMessageId.keys()], 4, async (id) => {
    const message = await gmailJson<GmailMessage>(`/messages/${id}?format=full`, token);
    const issue = parseIssue(message, mailbox);
    const prepared = prepareNewsletterForAi(issue);
    issue.links = validateNewsletterAiStories(storiesByMessageId.get(id), prepared.links);
    return issue;
  });
  const parsedIssues = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const redirectResult = await resolveTrackedLinks(parsedIssues);
  for (const issue of parsedIssues) {
    saveNewsletterIssue(database, {
      messageId: issue.message.id,
      mailbox,
      sender: issue.sender,
      subject: issue.subject,
      receivedAt: issue.receivedAt,
      gmailUrl: issue.gmailUrl,
      bodyHash: createHash("sha256").update(`${issue.html} ${issue.text}`).digest("hex"),
      processedAt: checkedAt,
      processorVersion: NEWSLETTER_PROCESSOR_VERSION,
      processorScope: scope,
    }, mentionsForIssue(issue, mailbox, redirectResult.resolved, checkedAt));
  }
  return {
    issues: parsedIssues.length,
    stories: parsedIssues.reduce((total, issue) => total + issue.links.length, 0),
    failed: results.filter((result) => result.status === "rejected").length,
  };
}

export async function collectNewsletterIntelligence(
  settings: Settings,
): Promise<NewsletterFeedResponse> {
  const scope = newsletterCollectionScope(settings);
  const jobs = globalThis.controlCenterNewsletterJobs ??= new Map();
  const existing = jobs.get(scope);
  if (existing) return existing;
  const job = runNewsletterCollection(settings);
  jobs.set(scope, job);
  try { return await job; } finally { jobs.delete(scope); }
}

async function runNewsletterCollection(settings: Settings): Promise<NewsletterFeedResponse> {
  const checkedAt = new Date().toISOString();
  const mailbox = settings.newsletters.connectedEmail;
  const scope = newsletterCollectionScope(settings);
  const database = getDatabase();
  const token = await getGmailAccessToken();
  const messageIds = await listMessageIds(token, settings.newsletters.gmailQuery);
  const known = knownNewsletterIssueIds(
    database,
    mailbox,
    messageIds,
    NEWSLETTER_PROCESSOR_VERSION,
    scope,
  );
  const pendingIds = messageIds.filter((id) => !known.has(id));
  const currentIds = pendingIds.slice(0, MAX_NEW_ISSUES_PER_PASS);
  const messageResults = await settleWithConcurrency(currentIds, 4, async (id) => {
    const message = await gmailJson<GmailMessage>(`/messages/${id}?format=full`, token);
    const issue = parseIssue(message, mailbox);
    issue.links = await extractNewsletterStoriesWithAi(settings, issue);
    return issue;
  });
  const parsedIssues = messageResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []);
  const redirectResult = await resolveTrackedLinks(parsedIssues);

  for (const issue of parsedIssues) {
    const mentions = mentionsForIssue(
      issue,
      mailbox,
      redirectResult.resolved,
      checkedAt,
    );
    saveNewsletterIssue(database, {
      messageId: issue.message.id,
      mailbox,
      sender: issue.sender,
      subject: issue.subject,
      receivedAt: issue.receivedAt,
      gmailUrl: issue.gmailUrl,
      bodyHash: createHash("sha256").update(`${issue.html}\u0000${issue.text}`).digest("hex"),
      processedAt: checkedAt,
      processorVersion: NEWSLETTER_PROCESSOR_VERSION,
      processorScope: scope,
    }, mentions);
  }

  pruneNewsletterEvidence(database, {
    before: new Date(Date.parse(checkedAt) - EVIDENCE_RETENTION_DAYS * 86_400_000).toISOString(),
  });
  const since = new Date(
    Date.parse(checkedAt) - newsletterWindowDays(settings.newsletters.gmailQuery) * 86_400_000,
  ).toISOString();
  const mentions = listNewsletterMentions(database, {
    mailbox,
    since,
    processorVersion: NEWSLETTER_PROCESSOR_VERSION,
    processorScope: scope,
  }).filter((mention) => !isNewsletterHousekeepingSubject(mention.newsletterSubject));
  let topics = assignNewsletterTopicIdentities(database, mailbox, buildNewsletterTopics(mentions, scope));
  const topicErrors: string[] = [];
  if (parsedIssues.length && topics.length > 1) {
    try {
      topics = assignNewsletterTopicIdentities(
        database,
        mailbox,
        await consolidateNewsletterTopicsWithAi(settings, topics),
        checkedAt,
        false,
      );
    } catch {
      topicErrors.push("Cross-newsletter AI consolidation was unavailable; exact-link and headline deduplication remain active. A later refresh will retry.");
    }
  }
  if (topics.some((topic) => topic.importanceBaseScore === undefined)) {
    const archived = database.prepare(
      "SELECT external_id FROM content_items WHERE category = 'newsletters' AND archived_at IS NOT NULL",
    ).all() as unknown as Array<{ external_id: string }>;
    try {
      topics = await prioritizeSavedNewsletterTopicsWithAi(settings, topics, new Set(archived.map((row) => row.external_id)));
    } catch {
      topicErrors.push("AI priority ranking was unavailable; saved stories are ordered by independent newsletter coverage and recency instead.");
    }
  }
  const lists = topicLists(topics, settings);
  const stats = newsletterStoreStats(database, {
    mailbox,
    since,
    processorVersion: NEWSLETTER_PROCESSOR_VERSION,
    processorScope: scope,
  });
  const failedMessages = messageResults.filter((result) => result.status === "rejected").length;
  const errors = [
    ...(failedMessages
      ? [`${failedMessages} new Gmail issue${failedMessages === 1 ? " was" : "s were"} deferred because the message could not be read or analyzed. Check Gmail access and the selected AI provider/model.`]
      : []),
    ...(redirectResult.failed
      ? [`${redirectResult.failed} tracked source link${redirectResult.failed === 1 ? " could" : "s could"} not be resolved; the original newsletter links were retained.`]
      : []),
    ...topicErrors,
  ];
  return {
    configured: true,
    connected: true,
    aiConfigured: true,
    aiProvider: settings.ai.provider === "none" ? undefined : settings.ai.provider,
    curationMode: lists.active.some((topic) => topic.curationMode && topic.curationMode !== "local")
      ? settings.ai.provider === "none" ? "local" : settings.ai.provider : "local",
    checkedAt,
    items: lists.active,
    archivedItems: lists.archived,
    archiveCount: lists.archived.length,
    historyItems: lists.history,
    historyCount: lists.history.length,
    freshnessHours: NEWSLETTER_ACTIVE_HOURS,
    errors,
    ...stats,
    newIssueCount: parsedIssues.length,
    pendingIssueCount: pendingIds.length - parsedIssues.length,
  };
}

export function readSavedNewsletterIntelligence(
  settings: Settings,
  connected: boolean,
): NewsletterFeedResponse {
  const checkedAt = new Date().toISOString();
  const scope = newsletterCollectionScope(settings);
  const since = new Date(
    Date.parse(checkedAt) - newsletterWindowDays(settings.newsletters.gmailQuery) * 86_400_000,
  ).toISOString();
  const database = getDatabase();
  const mentions = settings.newsletters.connectedEmail
    ? listNewsletterMentions(database, {
        mailbox: settings.newsletters.connectedEmail,
        since,
        processorVersion: NEWSLETTER_PROCESSOR_VERSION,
        processorScope: scope,
      }).filter((mention) => !isNewsletterHousekeepingSubject(mention.newsletterSubject))
    : [];
  const topics = assignNewsletterTopicIdentities(
    database,
    settings.newsletters.connectedEmail,
    buildNewsletterTopics(mentions, scope),
  );
  const lists = topicLists(topics, settings);
  const stats = settings.newsletters.connectedEmail
    ? newsletterStoreStats(database, {
        mailbox: settings.newsletters.connectedEmail,
        since,
        processorVersion: NEWSLETTER_PROCESSOR_VERSION,
        processorScope: scope,
      })
    : { issueCount: 0, newsletterCount: 0, mentionCount: 0 };
  const hasSavedLibrary = lists.active.length + lists.archived.length + lists.history.length > 0;
  return {
    configured: hasSavedLibrary,
    connected,
    aiConfigured: newsletterAiConfigured(settings),
    aiProvider: settings.ai.provider === "none" ? undefined : settings.ai.provider,
    curationMode: lists.active.some((topic) => topic.curationMode && topic.curationMode !== "local")
      ? settings.ai.provider === "none" ? "local" : settings.ai.provider : "local",
    checkedAt,
    items: lists.active,
    archivedItems: lists.archived,
    archiveCount: lists.archived.length,
    historyItems: lists.history,
    historyCount: lists.history.length,
    freshnessHours: NEWSLETTER_ACTIVE_HOURS,
    errors: hasSavedLibrary && !connected
      ? ["Gmail is disconnected. Saved newsletter intelligence remains available locally."]
      : [],
    ...stats,
    newIssueCount: 0,
  };
}
