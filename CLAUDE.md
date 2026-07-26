# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Realtime multiplayer table tennis in a pseudo-3D behind-the-racket view (styled after GameSnacks Table Tennis). Two players per match, plus any number of live spectators watching the match as it happens. Mouse-only controls: the pointer moves the racket in the player's hit plane; hitting with the racket off-centre steers the return. Frontend is a Next.js App Router app deployed to Vercel. Match state lives on a PartyKit room server, because Vercel serverless functions cannot hold WebSocket connections.

Conventions here are adapted from the Fundwise platform repo (`D:\N\2. Work\2. Fundwise\Apps\platform`), which is the reference for tooling patterns but has no realtime layer and does not deploy to Vercel, so the realtime and hosting decisions below are new to this project.

## Commands

Single npm package at the repo root (no monorepo).

```
npm run dev          # concurrently: next dev (:3000) + partykit dev (:1999)
npm run build        # next build
npm run typecheck    # tsc --noEmit
npm run lint         # eslint . --max-warnings 0
npm test             # vitest run
npm run test:e2e     # playwright test (auto-starts dev servers via webServer config)
```

Single test file: `npm test -- lib/game/physics.test.ts`
Single test by name: `npm test -- -t "ball bounces off paddle"`
One e2e spec: `npx playwright test test/e2e/smoke.spec.ts` (first-time: `npx playwright install chromium`)

Deploy: `vercel` for the Next.js app, `npx partykit deploy` for the room server. The PartyKit host URL is provided to the client via `NEXT_PUBLIC_PARTYKIT_HOST`.

Before every push, run locally: `npm run typecheck && npm run lint && npm test`.

## Architecture

### Why two runtimes

Vercel hosts the UI (lobby, match page, spectate page) and any request/response API routes. It cannot terminate long-lived WebSockets, so every realtime concern — match rooms, physics, presence, spectator broadcast — runs on PartyKit. The Next.js app never simulates authoritative game state; it only renders snapshots and sends inputs.

### Match room model (`party/match.ts`)

- One PartyKit room per match; room id = match id.
- **Server-authoritative physics.** The room runs the simulation tick (30 Hz) and broadcasts state snapshots every tick. Clients send only racket-position messages (`{type:"racket", x, y}`, ~30/s); the server decides hits, bounces, and points. The client draws its own racket from local mouse state for responsiveness, but the ball and opponent always come from the server snapshot.
- **World coordinates (`lib/game`):** x lateral (0 at centre), y up (0 at table surface), z along the table (player 0 at z=0, player 1 at z=TABLE_LENGTH). Each client renders a perspective projection from behind its own end; player 1's view is mirrored so both players see themselves at the bottom. Spectators render from player 0's end.
- **Point rules (arcade):** a dead ball (net, floor, past a racket plane) scores for the hitter if the shot had already bounced on the receiver's side (`bouncedSinceHit`), otherwise for the receiver (fault). Win at 11.
- **Roles:** the first two connections claim the `player` slots; every later connection is a `spectator`. Spectators receive the same snapshot broadcast and score/lifecycle events, and are never allowed to send input — the server enforces this by connection role, not client claim.
- A separate lobby room (`party/lobby.ts`) tracks live matches so the home page can list joinable and watchable games in real time.

### Shared protocol and pure engine

- `lib/protocol.ts` — every message type exchanged between client and room server, as discriminated-union TS types. Single source of truth; both `party/` and `app/` import from it. Never define a message shape inline.
- `lib/game/` — pure TypeScript physics and rules (ball movement, paddle collision, scoring, win condition). No React, no PartyKit, no DOM imports — enforced by an ESLint `no-restricted-imports` fence. This is what lets the same code run in the server tick and in client-side prediction, and unit-test without a browser.

### Directory layout

```
app/           Next.js routes: / (lobby), /play/[room], /watch/[room]
party/         PartyKit servers: match.ts, lobby.ts (partykit.json points here)
lib/protocol.ts  client<->server message types
lib/game/      pure game engine + co-located *.test.ts
test/e2e/      Playwright specs
```

## Conventions (adapted from the platform repo)

- **TypeScript:** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`, `isolatedModules`, target ES2022. Contract-like types (the protocol) are never duplicated — import from `lib/protocol.ts`.
- **Lint:** ESLint 9 flat config, `--max-warnings 0` so warnings block. Boundary fences via `no-restricted-imports`: `lib/game/` may not import react/next/partysocket; `app/` may not import from `party/` (only from `lib/`).
- **Tests:** vitest, co-located `*.test.ts` next to source. The game engine is the main unit-test surface — physics edge cases (corner hits, simultaneous score, paddle clamping) live there, not in e2e.
- **E2E:** Playwright, chromium only, `test/e2e/`, `baseURL http://localhost:3000`. `playwright.config.ts` uses `webServer` to start `npm run dev` with `reuseExistingServer: !process.env.CI`. E2E is a local/pre-release gate, not a CI blocker.

## Browser testing (agent-driven)

Mirrors the platform repo's setup:

- `.mcp.json` wires two MCP servers: `playwright` (`npx playwright-mcp`) and `chrome-devtools` (`npx chrome-devtools-mcp`). Install `@playwright/mcp` and `chrome-devtools-mcp` as devDeps so `npx` resolves locally.
- `.claude/settings.json` enables both servers and pre-allows their common tools (navigate, snapshot, screenshot, click, type, console messages, network requests) so browser verification runs without permission prompts.
- `.claude/agents/browser-tester.md` — subagent that verifies UI flows against the **already-running** dev server. It never starts the server; if `:3000` is down it stops and says to run `npm run dev`. It resolves a driver via ToolSearch (playwright MCP first, chrome-devtools fallback), walks `/`, `/play/[room]`, `/watch/[room]`, and reports a fixed PASS/WARN/FAIL verdict per route including console errors and failed network calls.
- Multiplayer flows need two browser contexts (player A + player B) and optionally a third for a spectator. Playwright e2e is the right tool for that (multiple `browser.newContext()` in one spec); the MCP browser agent is for single-client visual verification.

## Orchestrator working pattern

Condensed from the platform repo's standing directive; applies to agent sessions here:

- The main thread orchestrates: plans, writes subagent briefs, sequences, dispatches, reviews, and holds go/no-go. Delegate implementation work to subagents; the main thread may still make one-line edits and run git directly when an agent round-trip costs more than the step.
- Model tiers on every spawn: Opus (or session model) for load-bearing work — game physics, protocol design, room lifecycle; Sonnet for mechanical work — styling, doc updates, lint sweeps. Never Haiku.
- Serial by default; fan out at most 2-3 subagents and only across genuinely independent tasks, never many agents on one task.
- Any repo-mutating agent running concurrently with another gets its own named git worktree (`.claude/worktrees/<issue>-<desc>`, gitignored); read-only agents don't need one.
- **Report-back loop:** every mutating subagent brief ends with "stop before pushing and report the diff + verification evidence". The orchestrator reviews, sends fixes back to the same agent (SendMessage preserves its context), and only then lands the change. Builders never spawn reviewers — the orchestrator dispatches review after the builder reports.
- Never idle-wait: after starting background work, immediately begin the next independent step in the same turn.
