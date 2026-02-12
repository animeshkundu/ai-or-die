# Copilot Agent Testing with Playwright MCP

This document covers Tier 2 (Copilot Agent Exploratory Testing) of the project's testing hierarchy. For the full three-tier hierarchy and how the tiers work together, see `docs/agent-instructions/02-testing-and-validation.md`.

## The Idea

Traditional E2E tests verify known scenarios. They catch regressions, but they only test what you thought to test. Copilot coding agents with Playwright MCP fill a different gap: they act as human-like exploratory testers, discovering issues nobody anticipated.

This is the difference between "does the button work?" and "can a real person actually use this on a phone?" One is a test script. The other is a product tester.

We used 8 Copilot agents in parallel to audit the mobile UX of this app. They found 40+ issues, including a Critical z-index bug (install button blocking bottom navigation) that was missed by every human planning session. After expert validation, 6 findings were false positives and the rest were actionable. The whole process took ~50 minutes wall-clock time.

## When to Use This Pattern

Use Copilot agent testing when you need fresh eyes on the product. Specific use cases:

- **Exploratory UX testing**: "Does this app actually work on a phone?" -- not scripted checks, but real-user-style browsing
- **Mobile and responsive audits**: Test across viewports (phone, tablet, landscape) with agents acting as users on each device class
- **Accessibility audits**: WCAG compliance checks, touch target measurement, contrast ratios, screen reader support
- **Visual regression and polish**: Screenshot every screen, compare spacing, check dark/light themes, find orphaned text
- **PWA behavior**: Offline resilience, service worker lifecycle, install prompts, network edge cases
- **Post-feature sanity checks**: After a large feature lands, run agents as "new users" to find rough edges

Do NOT use this for:

- **Regression testing**: That is what deterministic E2E tests are for. Copilot agent runs are too expensive and too slow for every commit.
- **Unit-level logic verification**: Agents test from the browser. Internal logic needs unit tests.
- **Performance benchmarking**: Playwright emulation does not reflect real device performance.

Think of it as a "bug bash" -- run periodically (per feature, per release, per major UI change), not on every push.

## How It Works

1. You create GitHub issues with broad exploratory mandates
2. Each issue is assigned to a Copilot coding agent
3. The agent starts a dev server, opens Playwright MCP, and browses the app
4. The agent interacts with the UI, takes screenshots, measures elements, reads code
5. The agent produces a structured markdown report as a PR
6. Expert reviewers validate the findings against the actual codebase
7. An adversarial reviewer challenges assumptions and identifies gaps
8. The lead synthesizes validated findings into a prioritized fix list

## Setup Requirements

### 1. Playwright MCP Server

Configure the Playwright MCP server in your GitHub repository settings:

**Settings > Copilot > Coding agent > MCP configuration**

Use this JSON configuration:

```json
{
  "mcpServers": {
    "playwright": {
      "type": "local",
      "command": "npx",
      "args": ["@playwright/mcp@latest"],
      "tools": ["*"]
    }
  }
}
```

This gives the Copilot agent access to a full Playwright browser instance. The agent can navigate pages, click elements, type text, take screenshots, measure dimensions, and evaluate JavaScript -- all through MCP tool calls.

### 2. App Must Be Self-Startable

The agent runs on a fresh GitHub Codespace or runner. Your app must start from the repo with minimal setup:

```bash
npm install
npm run dev  # Must start a server the agent can browse to
```

The dev server URL must be deterministic (e.g., `http://localhost:7777`). If your app requires environment variables, database setup, or external services, document every step in the issue body.

### 3. Setup Instructions in Issue Body

This is critical. Copilot agents start working immediately when assigned. They read the issue body first. If your setup instructions are in a comment or a linked document, the agent may miss them entirely.

The first section of every issue body must be setup instructions. See the template at the end of this document.

## Issue Design Principles

The quality of agent output is directly proportional to the quality of the issue prompt. Follow these principles:

### Give Broad Mandates, Not Narrow Scripts

The whole point of this pattern is exploratory discovery. If you script every step, you get a test -- not a tester.

**Good**: "You are a QA engineer testing a terminal web app on a phone. Navigate every screen, try every interaction, and report what breaks."

**Bad**: "Click the settings button. Verify the modal opens. Verify the font size slider works. Close the modal."

The first prompt produces a 16KB audit report with 7 categorized findings and screenshots. The second produces a pass/fail on 3 checkboxes.

### Frame Personas

Give the agent a role that shapes its testing perspective:

| Persona | Focus |
|---------|-------|
| QA engineer on iPhone SE | General usability, layout, interaction flow |
| Accessibility specialist | WCAG compliance, ARIA, contrast, touch targets |
| UI designer reviewing visual polish | Spacing, alignment, theme consistency, loading/empty/error states |
| Reliability engineer | PWA behavior, offline, network changes, reconnection |
| Power user with 10 sessions open | Multi-session management, tab overflow, switching speed |

Different personas find different issues. The accessibility specialist found missing `aria-label` attributes. The phone QA engineer found the install button z-index overlap. The reliability engineer found missing network change handlers.

### Specify Viewports, Let the Agent Decide What to Test

Tell the agent which device viewports to use, but let them choose what to test at each. Example:

```
Use Playwright MCP at iPhone SE (375x667) and iPhone 14 (390x844) viewports.
```

Do not micromanage the test plan. The agent will explore based on its persona and what it discovers while browsing.

### Request Structured Deliverables

Tell the agent exactly what to produce and where to put it:

```
Produce a detailed report at `docs/audits/mobile-phone-ux-audit.md` with:
- Every issue found, categorized as Critical / Important / Suggestion
- Steps to reproduce each issue
- Screenshots or viewport dimensions where the issue occurs
- Recommendations for fixing each issue
```

Without this, agents produce unstructured commentary. With it, they produce reports that can be directly fed into a prioritized fix list.

### Include Key File References

Agents are coding agents -- they can read your source code. Point them to the files that matter:

```
### Key Files
- `src/public/app.js` — Main controller, resize logic, mobile detection
- `src/public/components/mobile.css` — Mobile breakpoints (768px, 480px)
- `src/public/components/tabs.css` — Session tab pills on mobile
```

This lets the agent trace UI issues back to specific code, producing findings like "install button at `buttons.css:248-263` has z-index 300, which overlaps bottom nav at z-index 200."

## Parallelization Strategy

### All Issues Must Be Independent

Each issue targets a different focus area with no shared state. Agents run in parallel, each browsing the app independently. No agent depends on another agent's output.

Our 8-agent breakdown:

| # | Focus | Persona | Viewports |
|---|-------|---------|-----------|
| 1 | Phone UX | QA engineer | iPhone SE, iPhone 14 |
| 2 | Input and keyboard | QA engineer | iPhone SE, Pixel 7 |
| 3 | Tablet UX | QA engineer | iPad Air, iPad Mini, Galaxy Tab |
| 4 | Responsive stress | Stress tester | 14 viewports (320px to 1920px) |
| 5 | PWA and network | Reliability engineer | iPhone 14, Pixel 7 |
| 6 | Session management | Power user | iPhone SE, iPhone 14 |
| 7 | Visual polish | UI designer | iPhone SE, iPhone 14, iPad Air |
| 8 | Accessibility | Accessibility specialist | iPhone 14, Pixel 7 |

8 agents = 8x coverage in 1x wall-clock time. The total run took ~50 minutes (the Copilot agent timeout).

### Scope Each Issue for Completion Within 50 Minutes

Copilot coding agents have a ~50-minute timeout. If the mandate is too broad, the agent may not finish. If it is too narrow, you waste a slot.

A good scope is: one persona, 2-3 viewports, one focus area, one deliverable report. This reliably completes within the timeout.

### Label Issues for Tracking

Use labels to identify Copilot agent runs and distinguish between model runs:

- `copilot` -- generic Copilot agent assignment
- `copilot-5.3` -- GPT-5.3-Codex run (useful for comparing model quality)

## Model Selection

### Available Models

When assigning an issue to the Copilot coding agent through the GitHub web UI, you can select which model the agent uses. As of February 2026:

- **Auto** -- GitHub selects the model. Works well for exploratory testing.
- **GPT-5.3-Codex** -- 1x cost. Fast, capable, good for structured exploratory work.
- **Claude Opus 4.6** -- 3x cost. Stronger reasoning, more thorough reports, better at edge case discovery.

### How to Select

Model selection is only available through the GitHub web UI when assigning the agent. There is no API or CLI flag for model selection.

To assign via the web UI: open the issue, click "Assignees," select "Copilot," and choose the model in the dropdown.

To assign programmatically (without model selection): use the GraphQL `replaceActorsForAssignable` mutation with actor ID `BOT_kgDOC9w8XQ`. This uses the default (Auto) model.

### Model Comparison

We ran the same 8 issues with both GPT-5.3-Codex and Claude Opus 4.6 (issues #35-42 and #51-58). Both produced useful findings. The choice depends on budget and thoroughness requirements.

## Expert and Adversarial Validation

Raw Copilot agent findings need human (or senior-agent) validation. Out of 40+ findings across 8 reports, we identified 6 false positives. This is a ~15% false-positive rate, which is acceptable for exploratory testing but means you cannot ship fixes based on raw agent reports alone.

### Why False Positives Happen

Playwright emulation is not a real device. Known gaps:

- **`pointer: coarse` may not trigger**: Touch target CSS overrides (`@media (pointer: coarse)`) may not activate in Playwright's emulation, causing the agent to measure desktop-sized targets and report them as undersized when they would be correct on a real phone.
- **`visualViewport` events do not fire**: Keyboard detection logic that relies on `visualViewport.resize` will not work in emulation. The agent may report "keyboard does not trigger layout change" when the code is correct.
- **CSS transitions may be missed**: Playwright snapshots the DOM at a point in time. If a menu opens via CSS transition, the agent may snapshot before the transition completes and report "menu does not open."
- **Hidden elements measure as 0x0**: Elements that are intentionally hidden (e.g., voice button when STT is unavailable) have zero dimensions. The agent may flag these as bugs.

### The Two-Layer Approach

**Layer 1: Discovery (Copilot agents)**
Broad, parallel, exploratory. Finds the unknowns. Produces raw findings with screenshots and code references.

**Layer 2: Validation (expert + adversarial reviewers)**
Each finding is validated by reviewers who:
- Check the actual codebase (not just the screenshot)
- Test whether `pointer: coarse` or other media queries change the behavior
- Verify whether "broken" elements are intentionally hidden
- Cross-reference findings across multiple agent reports (3 agents flagging the same issue = high confidence)
- Challenge assumptions: "Is this really a bug, or is it Playwright emulation diverging from real device behavior?"

The adversarial reviewer specifically looks for:
- Findings that assume Playwright emulation matches real device behavior
- Recommendations that would break existing functionality
- WCAG interpretations that conflict with practical accessibility (e.g., `maximum-scale=1.0` violates WCAG 1.4.4 zoom)
- Missing findings -- what did all 8 agents fail to test?

### Validation Process

1. Collect all reports from all agents
2. Assign 3 expert reviewers to validate findings against the codebase
3. Assign 1 adversarial reviewer to challenge assumptions and identify gaps
4. Reviewers classify each finding as Confirmed, False Positive, or Needs Real Device Testing
5. Lead synthesizes validated findings into a prioritized fix list with severity tiers

The result is a high-confidence finding list with false positives removed and new issues (from the adversarial reviewer) added.

## Comparison with Traditional E2E Tests

| Dimension | Copilot Agent Testing | Traditional E2E Tests |
|-----------|----------------------|----------------------|
| **Purpose** | Discover unknown issues | Prevent known regressions |
| **Coverage** | Exploratory, unpredictable | Deterministic, reproducible |
| **Output** | Human-readable audit reports | Pass/fail test results |
| **Cost per run** | High (agent compute + MCP) | Low (CI runner minutes) |
| **Run frequency** | Per feature / per release | Every commit / every PR |
| **Finds** | Unknown-unknowns, UX issues, usability problems | Regressions in known behavior |
| **Misses** | May report false positives from emulation gaps | Only catches what was anticipated |
| **Setup** | GitHub issue + Playwright MCP config | Test code in repo + CI pipeline |

These are complementary, not competing. The ideal workflow:

1. **Copilot agents discover issues** during feature development or before a release
2. **Findings become fix tasks** after expert validation
3. **Fixes include E2E regression tests** that prevent the issue from recurring
4. **E2E tests run on every commit** going forward

The agents are the "bug bash." The E2E tests are the "regression suite." Use both.

## Limitations and Gotchas

### Playwright Emulation Is Not a Real Device

This is the single biggest source of false positives. Playwright emulates mobile viewports by resizing the browser window and setting user agent strings. It does NOT:

- Fire `visualViewport` resize events (keyboard detection breaks)
- Emulate real touch physics (scroll momentum, rubber-banding)
- Activate `pointer: coarse` media queries reliably
- Render real keyboard overlays (no virtual keyboard appears)
- Simulate split keyboards, floating keyboards, or external keyboards
- Match real device pixel density for sub-pixel rendering

Any finding that depends on real device behavior must be flagged for manual device testing during validation.

### 50-Minute Timeout

Copilot agents have an approximately 50-minute execution window. Design issues accordingly:

- One persona, 2-3 viewports, one focus area per issue
- Include setup instructions at the top so the agent does not waste time figuring out how to start the app
- Avoid mandates that require testing every viewport at every screen -- scope to the most important combinations

### Model Selection Is Web-UI Only

There is no CLI or API parameter to specify which model the Copilot agent uses. You must assign through the GitHub web UI to select the model. Programmatic assignment via GraphQL uses the default model.

### Setup Instructions Must Be in the Issue Body

Copilot agents read the issue body when they start. They do not reliably read comments added after the issue is created. All setup steps, context, and requirements must be in the body. See the template below.

### Agent Reports Need Validation

Never ship fixes based solely on agent reports. The ~15% false-positive rate means approximately 1 in 7 findings is wrong. Always run the expert + adversarial validation layer before acting on findings.

### Agents May Modify Code

Copilot coding agents are designed to write code. If you want audit-only behavior, explicitly state in the issue: "This is an audit task. Do not modify any source code. Only produce the report." Even with this instruction, agents sometimes create branches and PRs with suggested fixes alongside their reports. Review PRs carefully.

## Issue Template

Copy and adapt this template for future Copilot agent audit runs.

````markdown
## Setup Instructions (READ FIRST)

Before testing with Playwright MCP, you must start the app:

### 1. Install dependencies
```bash
npm install
```

### 2. Start the development server
```bash
npm run dev
```
This starts the server on **http://localhost:7777** with extra logging enabled.

### 3. Use Playwright MCP to browse the app
Navigate to `http://localhost:7777` in the Playwright browser. The app is a terminal emulator with:
- A **session tabs bar** at the top
- A **terminal** (xterm.js) in the center
- A **bottom navigation** bar on mobile viewports (Voice, Files, More, Settings)
- An **extra keys bar** that appears when virtual keyboard is open on mobile

### 4. Testing at specific viewports
Use Playwright viewport configuration. Example:
```javascript
await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14
```

### 5. Key interactions
- **Create sessions**: Click "+" in tab bar
- **Settings**: Gear icon (desktop) or Settings in bottom nav (mobile)
- **File browser**: Folder icon (desktop) or Files in bottom nav (mobile)
- **Terminal**: Click/tap to focus, then type
- **Context menu**: Right-click (desktop) or long-press (mobile)
- **Mobile menu**: Hamburger icon or "More" in bottom nav

### 6. Requirements
Node.js 22+. Dev server runs without auth by default.

---

## Task

You are a [PERSONA] testing a terminal web app on [DEVICE CLASS]. Use Playwright MCP to open the app at [VIEWPORT 1] and [VIEWPORT 2] viewports. Interact with the app as a real [USER TYPE] would.

### What to Test

- [Broad mandate 1 — what to explore]
- [Broad mandate 2 — what to look for]
- [Broad mandate 3 — specific concerns for this focus area]
- [Broad mandate 4 — edge cases relevant to this persona]

### Key Files

- `src/public/app.js` — Main controller, resize logic, mobile detection
- `src/public/components/mobile.css` — Mobile breakpoints (768px, 480px)
- [Additional files relevant to this focus area]

### Deliverable

Produce a detailed report at `docs/audits/[REPORT-NAME].md` with:
- Every issue found, categorized as Critical / Important / Suggestion
- Steps to reproduce each issue
- Screenshots or viewport dimensions where the issue occurs
- Recommendations for fixing each issue, with specific file and line references
````

### Template Variables

| Variable | Example |
|----------|---------|
| `[PERSONA]` | QA engineer, accessibility specialist, UI designer, reliability engineer |
| `[DEVICE CLASS]` | phone, tablet, across all breakpoints |
| `[VIEWPORT 1]` | iPhone SE (375x667), iPad Air (820x1180) |
| `[VIEWPORT 2]` | iPhone 14 (390x844), Pixel 7 (412x915) |
| `[USER TYPE]` | mobile user, tablet user, power user with many sessions |
| `[REPORT-NAME]` | mobile-phone-ux-audit, accessibility-audit, pwa-resilience-audit |

### Creating an 8-Agent Audit Run

For a full audit, create 8 issues with these focus areas:

1. **Phone UX** -- QA engineer, iPhone SE + iPhone 14
2. **Input and keyboard** -- QA engineer, iPhone SE + Pixel 7
3. **Tablet UX** -- QA engineer, iPad Air + iPad Mini + Galaxy Tab
4. **Responsive stress** -- Stress tester, 14 viewports from 320px to 1920px
5. **PWA and network** -- Reliability engineer, iPhone 14 + Pixel 7
6. **Session management** -- Power user, iPhone SE + iPhone 14
7. **Visual polish** -- UI designer, iPhone SE + iPhone 14 + iPad Air
8. **Accessibility** -- Accessibility specialist, iPhone 14 + Pixel 7

Label all issues with `copilot`. Assign all to the Copilot agent. They run in parallel and complete in ~50 minutes.

## Synthesizing Results

After all agents complete:

1. Collect all reports from `docs/audits/`
2. Run the expert + adversarial validation layer (see above)
3. Remove false positives with documented rationale
4. Cross-reference: findings reported by 3+ agents are high-confidence
5. Produce a synthesized summary at `docs/audits/SUMMARY.md` with:
   - Prioritized fix list (P0 Critical, P1 High, P2 Polish, P3 Deferred)
   - False positives identified and why they were rejected
   - Expert consensus on contested findings
   - Corrections to original plans based on new discoveries
6. Create implementation tasks from the P0 and P1 findings
7. Write E2E regression tests for each fix

The summary becomes the source of truth. Individual agent reports are raw data -- useful for traceability but not for decision-making.

## Real Results from Our First Run

8 agents, ~50 minutes, 40+ raw findings:

- **P0 Critical**: 9 issues (install button overlap, viewport meta, keyboard detection, context menu, terminal sizing, network handling, clipboard permissions, touch targets, text-size-adjust)
- **P1 High**: 9 issues (auto-hide UI on keyboard, keyboard dismiss, extra keys expansion, orientation handling, font sizing, modal overflow, overlay blocking, breakpoint tuning, aria-labels)
- **P2 Polish**: 10 issues (swipe navigation, pinch-to-zoom, haptic feedback, settings layout, pull-to-refresh, dark mode, CSS cleanup, visual prominence, modifier timeout, mobile E2E tests)
- **P3 Deferred**: 8 items (VirtualKeyboard API, iOS text selection, Android composition, customizable keys, edge-swipe drawer, scrollback optimization, screen reader output, service worker versioning)
- **False positives removed**: 6 (mode switcher timing, tab ellipsis, auth storage, service worker, mobile menu transition, voice button dimensions)

The single most valuable finding -- install button blocking bottom navigation (P0-1) -- was discovered by 3 independent agents (PRs #45, #46, #49) and confirmed by 2 expert reviewers. No human planning session had identified this issue. It would have shipped to production without this audit.
