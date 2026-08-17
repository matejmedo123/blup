# Recommendations

BLUP's "AI" is two layers with different jobs, and the important one needs no API
key.

1. **The ranker** (`recommend_events`) — deterministic SQL that scores every
   candidate event against the user. This is what actually orders the feed.
2. **The explainer** (`ai-recommendations`) — adds a one-line natural reason. An
   LLM writes it for premium users; a template writes it for everyone else.

Layer 2 failing never affects layer 1. Turn the LLM off and discovery is
unchanged, only the sentence gets simpler.

---

## The scoring model

```
score = 0.30 × interest_match
      + 0.22 × distance_score
      + 0.16 × social_relevance
      + 0.14 × past_behaviour
      + 0.10 × popularity
      + 0.08 × time_relevance
```

Every component is normalised to 0…1, so the final score is directly comparable
and the weights mean what they look like.

| Component | Computed from | Full score when |
|---|---|---|
| `interest_match` | user interests vs event `category` and `tags` | 3+ interests match |
| `distance_score` | linear decay across the search radius | the event is at the user's position |
| `social_relevance` | followed users attending (+0.34 if the user follows the host) | 3+ followed people are going |
| `past_behaviour` | category affinity from 180 days of signals, normalised around 0.5 | strong positive history in that category |
| `popularity` | `attendees + 0.5 × saves + 0.05 × views` | ≥ 50 weighted |
| `time_relevance` | 1.0 within 24 h, then linear decay over 14 days | starting within a day |

**No location?** `distance_score` is 0.5 (neutral) rather than 0 — a user without
GPS still gets a sensible feed instead of an empty one.

**No interests or no history?** Those components sit near their neutral values
and popularity plus time carry the ranking. A brand-new account gets the
reasonable "what's on soon and busy nearby" feed, not an empty one.

**Swiped left?** The event is excluded outright:

```sql
and not exists (
  select 1 from user_event_signals s
  where s.user_id = p_user_id and s.event_id = e.id and s.signal = 'swipe_left'
)
```

Also excluded: the user's own events, anything unpublished, anything more than
two hours in the past, and anything outside the radius.

---

## Signals

Every meaningful interaction is appended to `user_event_signals` by
`record_signal()`. Recording is fire-and-forget: a failed signal never breaks the
user's action.

| Signal | Weight in the affinity sum |
|---|---|
| `ticket_purchase`, `attended` | +3.0 |
| `rsvp_going` | +2.0 |
| `save` | +1.5 |
| `swipe_right`, `rsvp_interested`, `like`, `comment`, `share` | +1.0 |
| `open_detail` | +0.4 |
| `impression` | ×0.2 multiplier |
| `swipe_left` | −1.5 |

These are summed per event category over the last 180 days and normalised
against the strongest signal, which is what makes `past_behaviour` adaptive
without any training step. `test_03` asserts that recording two purchase/attend
signals in a category measurably raises the score of another event in that same
category.

Signals are per-user rows behind RLS: only the user (and an admin) can read
them.

---

## People matching

`recommend_people()` powers both "People like you" in Explore and "BLUP Connect"
on an event.

```
score = 0.45 × min(1, shared_interests / 4)
      + 0.25 × min(1, mutual_events / 3)
      + 0.20 × min(1, mutual_follows / 5)
      + 0.10 × proximity
```

It returns the actual shared interest *names*, so the UI can say
"4 shared interests · both going" rather than a bare percentage. People already
followed are excluded, as is anyone with `anonymous_mode` on (a premium privacy
feature) or a suspended account. Crucially, someone with nothing in common is
returned at all only when scoped to a specific event — the matcher does not
invent connections, and `test_03` asserts exactly that.

---

## The LLM layer

`supabase/functions/ai-recommendations/index.ts`:

1. Calls `recommend_events` for the ranking.
2. Generates a local template explanation for every event
   (`explainLocally()` in `_shared/ai.ts`).
3. **If** the user is premium **and** `AI_API_KEY` is set, asks the model to
   rewrite the top 10 as one-line reasons, constrained to the supplied signals.
4. Logs the call — tokens, latency, or the error — to `ai_requests`.
5. Persists the run and every score to `ai_recommendation_runs/items`.

If step 3 throws, the template explanations are already in place and the response
is unchanged apart from `explanations_by`. If the whole function is unreachable,
the app falls back to calling `recommend_events` directly
(`getAIRecommendations` in `mobile/src/api/ai.ts`).

The provider is behind an interface with Anthropic and OpenAI implementations;
adding another is one entry in the `providers` map. Model and provider are
environment variables, so swapping them is a config change, not a code change.

The prompt forbids inventing facts and only receives the signals the ranker
already computed — the model never sees the database.

---

## Explainability (`/debug/ai`)

Every recommendation carries its arithmetic in `score_breakdown`:

```json
{
  "engine": "sql_ranker_v1",
  "final_score": 0.4693,
  "components": {
    "interest_match": 1.0, "distance_score": 0.9967, "social_relevance": 0.0,
    "past_behaviour": 0.5, "popularity": 0.0, "time_relevance": 1.0
  },
  "weights": { "interest_match": 0.30, "distance_score": 0.22, ... },
  "facts": {
    "interest_hits": 2, "friends_going": 0, "follows_creator": false,
    "distance_m": 1001, "category_affinity": 0.0
  }
}
```

The debug screen renders each component as a bar with
`value × weight = contribution`, sorted by contribution, plus the raw facts and
the final sum. It also lists recent stored runs, so you can audit what a user was
actually served earlier rather than re-deriving it now.

It is available in development builds, or in release when
`EXPO_PUBLIC_DEBUG_AI=true`.

---

## Tuning it

The weights live in one place — the `final` CTE of `recommend_events` in
`supabase/migrations/…000900_discovery_and_ranking.sql`. Change them in a **new**
migration, then run `npm run db:verify`: `test_03` asserts the ordering
properties (interest beats unrelated category; near-and-soon beats far-and-later;
social proof raises a score) rather than exact numbers, so it will catch a change
that breaks the intent while allowing deliberate re-tuning.

## Where this goes next

The current model is content-based plus social proof. The pieces for more are
already in place: `user_event_signals` is a clean interaction matrix for
collaborative filtering, `ai_recommendation_runs/items` gives served-vs-clicked
data for offline evaluation, and the `engine` field on every run means two
rankers can be compared side by side. Adding an embedding-based semantic match
would slot in as a seventh component without touching anything above the RPC.
