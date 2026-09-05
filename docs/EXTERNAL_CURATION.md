# External curation

The Industry tab can be ranked by something other than a configured AI provider.
The collector publishes the same candidate pool the model would have received,
an external curator — an agent, a script, a person — posts back the same shape of
answer, and the tab renders it exactly as if a provider had produced it.

This is not a second pipeline. Collection, canonicalisation, deduplication, the
keyword scorer, event grouping, source diversity and the archive all run
unchanged; only the semantic pick-and-explain step moves outside the app.

## The loop

```
GET  /api/curation?category=industry     → the pool the model would have been given
POST /api/curation                       → the picks, applied to the tab
DELETE /api/curation                     → drop the picks, back to built-in ranking
```

### GET

Returns the pool published by the last collection run:

```json
{
  "category": "industry",
  "generatedAt": "2026-09-03T20:12:47.915Z",
  "limit": 30,
  "niche": "AI industry news: model releases, agent tooling, funding...",
  "keywords": ["artificial intelligence", "agents"],
  "excludedTerms": ["crypto"],
  "instructions": ["...the same rules the model is given..."],
  "candidates": [
    {
      "id": "91c15871fb81a709a48b861c",
      "title": "OpenAI launches new Astra model amid growing scrutiny...",
      "summary": "...",
      "source": "Reuters",
      "url": "https://...",
      "publishedAt": "2026-09-03T17:41:00.000Z",
      "localScore": 74,
      "localReasons": ["Matches agents and OpenAI", "Published in the last 6 hours"],
      "corroboratingSources": ["Reuters", "CNBC"]
    }
  ],
  "currentSelectionCount": 0,
  "currentCurator": ""
}
```

At most 120 candidates, the same bound the model gets. `404` means no collection
has run yet — open or refresh the Industry tab first.

### POST

```json
{
  "curator": "claude-code",
  "selections": [
    { "id": "91c15871fb81a709a48b861c", "score": 96, "reason": "OpenAI ships its most capable model, with regulators already scrutinising agent safety." }
  ]
}
```

The answer goes through the same validation as the model's own: an id outside the
current pool is dropped, so is a missing reason, a non-numeric score, or a repeat
of an id already seen — and anything scoring under 55 is discarded. The response
reports how many of the submitted picks survived:

```json
{ "accepted": 14, "submitted": 14, "curator": "claude-code", "note": "Reload the Industry tab to see the new ranking." }
```

Posting a new set **replaces** the previous one: dropping an item means it should
stop being surfaced. The Industry snapshot is invalidated, so the next read of
the tab re-ranks rather than serving the cached list.

## How the picks are applied

`reason` becomes the item's `importanceReason` in the UI, `score` its
`importanceScore`. The picks are then merged with the local top set and passed
through the same diversity pass a provider's answer would get, so one source
cannot take over the page and near-duplicate events still collapse. The tab
reports `curationMode: "external"` and labels itself *external assisted*.

Precedence: external picks win over a configured AI provider. Nothing is sent to
any provider while they are in force, whatever Settings says.

Picks expire six hours after they are posted. They are answers to one specific
pool, and collection keeps moving; once they age out the tab falls back to the
built-in ranking rather than surfacing stale choices. The picks themselves are
mirrored to the data repository, so they follow the dashboard between machines;
the candidate pool is not, because every run republishes it.

## Driving it from Claude Code

A scheduled task that does the whole loop:

```bash
curl -s http://localhost:3000/api/curation > /tmp/pool.json
# read /tmp/pool.json, choose the consequential, non-duplicative stories
curl -s -X POST -H "Content-Type: application/json" \
  --data-binary @/tmp/picks.json http://localhost:3000/api/curation
```

The value over a provider key is judgement the keyword scorer cannot reach: it
lets through a story about "armed agents at voting sites" because *agents* is a
tracked keyword, and it cannot tell that thirty stories about one model launch
should be one entry with the best source chosen. That is the job.

## Newsletters

Newsletters work the same way but the job is different: the provider there does
not rank, it *extracts* — turning an email body into news stories. Without it the
tab has no fallback at all and stays empty, which is why the same endpoint covers
it.

```
GET  /api/curation?category=newsletters&limit=8   → pending issues with their evidence
POST /api/curation?category=newsletters           → the stories found in them
```

The GET returns each pending Gmail issue as the model would see it: sender and
subject with addresses masked, the flattened body text, and the numbered link
labels (`L1`, `L2`, …) whose real URLs are deliberately withheld.

```json
{
  "issues": [
    {
      "messageId": "1a06cbe3a9d866fa",
      "sender": "The Code",
      "subject": "Tech CEO almost got AI scammed",
      "receivedAt": "2026-09-04T06:12:00.000Z",
      "bodyText": "...",
      "links": [{ "id": "L4", "title": "GPT-6 Astra" }]
    }
  ],
  "pendingCount": 10
}
```

POST one entry per issue. An issue with nothing newsworthy in it takes an empty
list — that is a real answer, and it marks the issue processed so it stops coming
back:

```json
{
  "issues": [
    {
      "messageId": "1a06cbe3a9d866fa",
      "stories": [
        {
          "title": "OpenAI ships GPT-6 Astra with design and coding gains",
          "summary": "OpenAI released GPT-6 Astra, reported beating Sol and Fable on coding accuracy and API cost...",
          "linkIds": ["L4", "L5"],
          "score": 88,
          "reason": "The frontier model release that resets coding and design workflows.",
          "sponsored": false
        }
      ]
    },
    { "messageId": "1a07065a8807dfc4", "stories": [] }
  ]
}
```

Stories go through `validateNewsletterAiStories`, the same gate the model's reply
passes: a title under 12 characters, a summary under 20, a score under 55, a
missing `sponsored: false`, or a link id not in that issue all drop the story. A
story keeps up to four link ids; each becomes one mention, and cross-newsletter
grouping then folds repeat coverage into a single topic.

Bodies are **not** stored between the two calls. The POST re-reads the messages
from Gmail and re-derives the link ids, so the app keeps its property of never
persisting raw newsletter content — the ids in your answer must come from the GET
you are replying to, and a new GET renumbers them.

## Scope

Industry and Newsletters. Mentions still uses the configured provider or its
built-in ranking.
