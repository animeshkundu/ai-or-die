# Usage Analytics Specification

Two classes work together to track, analyze, and predict API usage: `UsageReader` reads raw JSONL log files from the Claude CLI, and `UsageAnalytics` performs session windowing, burn rate analysis, and depletion predictions.

---

## UsageReader

Source: `src/usage-reader.js`

### Overview

Reads usage data from Claude CLI's JSONL log files at `~/.claude/projects/`. Each project directory contains per-conversation JSONL files with one JSON object per line, recording every API request and response.

### Constructor

```js
new UsageReader(sessionDurationHours = 5)
```

- `claudeProjectsPath`: `~/.claude/projects/`
- Cache with a 5-second TTL for `getUsageStats()`.
- `sessionDurationHours`: configurable window size (default 5 hours).

### JSONL File Discovery

`findJsonlFiles(onlyRecent = false)`:
- Recursively scans all project directories under `~/.claude/projects/`.
- Collects all `.jsonl` files.
- When `onlyRecent = true`, filters to files modified within the last 24 hours.

### Entry Parsing

`readJsonlFile(filePath, cutoffTime)`:
- Streams the file line by line via `readline`.
- Parses each line as JSON. Malformed lines are silently ignored.
- Filters by `cutoffTime` (only entries with `timestamp >= cutoffTime`).
- Deduplicates entries within each file using a hash of `message_id:request_id`.
- Extracts only assistant messages with usage data (`entry.type === 'assistant'` or `entry.message.role === 'assistant'`).

### Extracted Entry Fields

```js
{
  timestamp: string,
  model: 'opus' | 'sonnet' | 'haiku' | 'unknown',
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  totalCost: number,
  sessionId: string,
  messageId: string,
  requestId: string
}
```

### Model Normalization

`normalizeModelName(model)`:
- Any model string containing `"opus"` -> `"opus"`
- Any model string containing `"sonnet"` -> `"sonnet"`
- Any model string containing `"haiku"` -> `"haiku"`
- Otherwise -> `"unknown"`

### Pricing

Costs are calculated per-token when `usage.total_cost` is not available:

| Model | Input (per 1M tokens) | Output (per 1M tokens) | Cache Creation | Cache Read |
|-------|----------------------|------------------------|----------------|------------|
| Opus | $15.00 | $75.00 | Same as input | 10% of input |
| Sonnet | $3.00 | $15.00 | Same as input | 10% of input |
| Haiku | $0.25 | $1.25 | Same as input | 10% of input |

When `usage.total_cost` is present:
- If the value is > 1, it is assumed to be in cents and divided by 100.
- Otherwise, used as-is (dollars).

### Session Boundary Detection

`getDailySessionBoundaries()`:

1. Gets all entries for the current calendar day (midnight to 23:59:59).
2. Sorts chronologically.
3. Groups into sessions: a new session starts when an entry falls outside the current session's window (start + `sessionDurationHours`).
4. Each session start is rounded down to the nearest hour.
5. Session end is `startTime + sessionDurationHours` or midnight, whichever is earlier.
6. Returns array of `{ sessionNumber, startTime, endTime, sessionId }`.

`getCurrentSession()`:
- Calls `getDailySessionBoundaries()` and returns the session containing `now`, or `null`.

### Key Methods

#### `getUsageStats(hoursBack = 24)`

Returns aggregated statistics for the given lookback window. Cached for 5 seconds.

**Response:**
```js
{
  requests: number,
  totalTokens: number,      // inputTokens + outputTokens (no cache tokens)
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  cacheTokens: number,       // cacheCreation + cacheRead
  totalCost: number,
  periodHours: number,
  firstEntry: string,
  lastEntry: string,
  models: { [model]: { requests, inputTokens, outputTokens, cost } },
  hourlyRate: number,
  projectedDaily: number,
  tokensPerHour: number,
  costPerHour: number,
  requestPercentage: number,
  tokenPercentage: number
}
```

#### `getCurrentSessionStats()`

Returns statistics for the current active session window.

**Response:**
```js
{
  requests: number,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  cacheTokens: number,
  totalTokens: number,
  totalCost: number,
  models: { ... },
  sessionStartTime: string,   // ISO timestamp
  lastUpdate: string,
  sessionId: string,
  sessionNumber: number,       // 1-indexed within the day
  isExpired: boolean,
  remainingTokens: null
}
```

#### `calculateBurnRate(minutes = 60)`

Calculates token consumption rate over the given time window.

**Response:**
```js
{
  rate: number,        // tokens per minute
  confidence: number,  // 0.0 to 1.0, based on data points (min(count/10, 1))
  dataPoints: number
}
```

#### `detectOverlappingSessions()`

Looks back `2 * sessionDurationHours`, groups entries into sessions by time gaps, and identifies overlapping session windows. Returns the session list (not the overlap pairs, which are stored in `this.overlappingSessions`).

---

## UsageAnalytics

Source: `src/usage-analytics.js`

Extends `EventEmitter`. Provides real-time analytics, burn rate tracking with trend analysis, and depletion predictions.

### Constructor

```js
new UsageAnalytics(options)
```

| Option | Default | Description |
|--------|---------|-------------|
| `sessionDurationHours` | `5` | Session window size |
| `confidenceThreshold` | `0.95` | Minimum confidence for predictions |
| `burnRateWindow` | `60` | Minutes of data for burn rate calculation |
| `updateInterval` | `10000` | Milliseconds between analytics updates |
| `plan` | `'custom'` | Subscription plan type |
| `customCostLimit` | `76.89` | Dollar limit for custom plans |

### Plan Limits

```js
{
  'pro':    { tokens: 19000,  cost: 18.00,  messages: 250,  algorithm: 'fixed' },
  'max5':   { tokens: 88000,  cost: 35.00,  messages: 1000, algorithm: 'fixed' },
  'max20':  { tokens: 220000, cost: 140.00, messages: 2000, algorithm: 'fixed' },
  'custom': { tokens: null,   cost: 76.89,  messages: 1019, algorithm: 'p90'   }
}
```

Legacy aliases `claude-pro`, `claude-max5`, and `claude-max20` are maintained for backwards compatibility with the same values.

### Token Limit Resolution

`getTokenLimit()`:
- For `fixed` algorithm plans: returns `plan.tokens` directly.
- For `p90` algorithm plans: returns the calculated P90 value, or `188,026` as the default fallback.

### P90 Calculation

`calculateP90Limit(historicalSessions)`:
- Requires at least 10 historical sessions.
- Sorts all session token counts ascending.
- Returns the value at the 90th percentile index.
- Emits `p90-calculated` event.

### Burn Rate Analysis

`calculateBurnRate()`:

1. Sorts recent usage data by timestamp.
2. Calculates token consumption rates over multiple time windows: 5, 10, 15, 30, and 60 minutes.
3. Each window's rate is weighted by data density (`min(dataPoints / 10, 1)`).
4. The final burn rate is a weighted average across all windows.
5. Only counts input + output tokens (excludes cache tokens).

`analyzeTrend()`:

Compares the average burn rate from the first half vs. the second half of the history:
- Change > +15%: `'increasing'`
- Change < -15%: `'decreasing'`
- Otherwise: `'stable'`

Requires at least 5 data points. Burn rate history is kept for the last hour.

### Depletion Predictions

`updatePredictions()`:

1. Gets the current session and its token limit.
2. Calculates `remaining = limit - used`.
3. If remaining <= 0: depletion is now, confidence = 1.
4. Otherwise: `minutesToDepletion = remaining / currentBurnRate`.
5. Adjusts for velocity trend:
   - `'increasing'`: pulls depletion 10% sooner.
   - `'decreasing'`: pushes depletion 10% later.

### Confidence Scoring

`calculateConfidence()` combines three factors:

| Factor | Weight | Score Calculation |
|--------|--------|-------------------|
| Data quantity | 0.3 | `min(recentUsage.length / 20, 1)` |
| Rate consistency | 0.4 | `1 - coefficient_of_variation` (requires 4+ history points) |
| Trend stability | 0.3 | `1.0` if stable, `0.7` if trending |

### Session Management

`startSession(sessionId, startTime)`:
- Creates a session object with `startTime`, calculated `endTime`, and zero usage counters.
- Stores in `activeSessions` Map.
- Updates rolling windows.
- Emits `session-started`.

`updateRollingWindows()`:
- Clears existing windows.
- Creates a window for each active session that started within the last `sessionDurationHours`.
- Each window tracks total tokens, cost, and remaining tokens.

`cleanup()`:
- Removes expired sessions (where `endTime < now`) to `sessionHistory`.
- Trims `sessionHistory` to the last 24 hours.

### Events

| Event | Payload | Trigger |
|-------|---------|---------|
| `usage-update` | Usage entry | New data point added |
| `session-started` | Session object | Session tracking started |
| `windows-updated` | Window array | Rolling windows recalculated |
| `burn-rate-updated` | `{ rate, trend, confidence }` | Burn rate recalculated |
| `prediction-updated` | `{ depletionTime, confidence, remaining, burnRate }` | Prediction refreshed |
| `p90-calculated` | `{ limit, sampleSize, confidence }` | P90 limit computed |
| `plan-changed` | Plan type string | User changed plan |

### Comprehensive Analytics Response

`getAnalytics()` returns the full state:

```js
{
  currentSession: {
    id, startTime, endTime, tokens, remaining, percentUsed
  },
  burnRate: {
    current: number,     // tokens per minute
    trend: 'stable' | 'increasing' | 'decreasing',
    history: [{ timestamp, rate }]  // last 10 data points
  },
  predictions: {
    depletionTime: Date | null,
    confidence: number,  // 0.0 to 1.0
    minutesRemaining: number | null
  },
  plan: {
    type: string,
    limits: { tokens, cost, messages, algorithm },
    p90Limit: number | null
  },
  windows: [ ... ],
  activeSessions: [ { id, startTime, endTime, isActive, tokens } ]
}
```

---

## Session Timer (Server Integration)

Source: `src/server.js`, `handleGetUsage()`

The server combines `UsageReader` and `UsageAnalytics` data into a session timer object sent via the `usage_update` WebSocket message:

```js
{
  startTime: string,                // ISO timestamp of session start
  elapsed: number,                   // milliseconds since session start
  remaining: number,                 // milliseconds until session expires
  formatted: "HH:MM:SS",            // elapsed time formatted
  remainingFormatted: "HH:MM",      // remaining time formatted
  hours: number,
  minutes: number,
  seconds: number,
  remainingMs: number,
  sessionDurationHours: number,      // configured window size (e.g. 5)
  sessionNumber: number,             // 1-indexed session within the day
  isExpired: boolean,
  burnRate: number,                  // tokens per minute
  burnRateConfidence: number,
  depletionTime: Date | null,
  depletionConfidence: number
}
```
