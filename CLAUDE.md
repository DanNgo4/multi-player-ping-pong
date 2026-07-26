# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Realtime multiplayer table tennis in a pseudo-3D behind-the-racket view (styled after GameSnacks Table Tennis). A match starts 1v1; up to 4 players total (2 per side) — later joiners pick a side mid-match and the score carries on. Any number of live spectators can watch, chat, and grab a free seat. Mouse or touch controls: the pointer moves the racket in the player's hit plane; off-centre contact steers the return and a fast swipe brushes spin onto the ball. Frontend is a Next.js App Router app deployed to Vercel. Match state lives on a partyserver (Durable Objects) room, because Vercel serverless functions cannot hold WebSocket connections.

Conventions here are adapted from the Fundwise platform repo (`D:\N\2. Work\2. Fundwise\Apps\platform`), which is the reference for tooling patterns but has no realtime layer and does not deploy to Vercel, so the realtime and hosting decisions below are new to this project.

## Commands

Single npm package at the repo root (no monorepo).

```
npm run dev          # concurrently: next dev (:3000) + wrangler dev (:1999)
npm run build        # next build
npm run typecheck    # tsc --noEmit
npm run lint         # eslint . --max-warnings 0
npm test             # vitest run
npm run test:e2e     # playwright test (auto-starts dev servers via webServer config)
```

Single test file: `npm test -- lib/game/physics.test.ts`
Single test by name: `npm test -- -t "ball bounces off paddle"`
One e2e spec: `npx playwright test test/e2e/smoke.spec.ts` (first-time: `npx playwright install chromium`)

Deploy: `vercel --prod` for the Next.js app, `npm run deploy:party` (wrangler) for the room server, which runs as Cloudflare Durable Objects at `multi-player-ping-pong.danngo-au.workers.dev`. The room-server host is provided to the client via `NEXT_PUBLIC_PARTYKIT_HOST` (set in Vercel project env). Note: the room server uses `partyserver` (Cloudflare's PartyKit successor), NOT hosted PartyKit — `partykit deploy` is dead, its shared partykit.dev zone hit Cloudflare's custom-domain cap. The client still uses `partysocket`; URL scheme `/parties/:party/:room` is unchanged.

Before every push, run locally: `npm run typecheck && npm run lint && npm test`.

## Architecture

### Why two runtimes

Vercel hosts the UI (lobby, match page, spectate page) and any request/response API routes. It cannot terminate long-lived WebSockets, so every realtime concern — match rooms, physics, presence, spectator broadcast — runs on PartyKit. The Next.js app never simulates authoritative game state; it only renders snapshots and sends inputs.

### Match room model (`party/match.ts`)

- One room per match; room id = match id.
- **Server-authoritative physics.** The room runs the simulation tick (30 Hz) and broadcasts state snapshots every tick. Clients send only racket-position messages (`{type:"racket", x, y}`, ~30/s); the server decides hits, bounces, and points. The client draws its own racket from local pointer state for responsiveness and interpolates the ball/other rackets between the two latest snapshots; the server snapshot always wins.
- **Seats, not fixed slots:** `GameState.seats` is a dynamic list (max 2 per side, 4 total), seat id = connection id. The first two `play`-intent connections auto-seat on sides 0 and 1; everyone else is a spectator who may send `{type:"join", side}` to grab a free seat mid-match — the score is kept (also how a side that emptied resumes: play suspends via `suspendPlay`, score intact). `{type:"restart"}` after gameover = rematch: `resetScores` keeps seats.
- **World coordinates (`lib/game`):** x lateral (0 at centre), y up (0 at table surface), z along the table (side 0 at z=0, side 1 at z=TABLE_LENGTH). Each client renders a perspective projection from behind its own side; side 1's view is mirrored. Spectators default to side 0's end and can switch ends. Rackets carry floating name labels.
- **Spin:** the server derives racket velocity from input deltas (`seat.vel`, decays at `RACKET_VEL_DECAY`); contact brushes it onto the ball (`spinSide`/`spinTop`). Side spin curves flight (Magnus, travel-direction relative), topspin dips flight and kicks forward off the bounce, backspin floats/deadens. All constants in `lib/game/constants.ts`.
- **Point rules (arcade):** a dead ball (floor, past a racket plane) scores for the hitting side if the shot had already bounced on the receiving side (`bouncedSinceHit`), otherwise for the receivers (fault). Win at 11 with a two-point margin (deuce from 10-10). The serve swaps sides each point and rotates between teammates within a side (`GameState.serveTurns`). The net is physical: a ball well under the tape rebounds (`netTouched`, point resolves when it lands), a tape clip dribbles over and play continues.
- **Names & chat:** display name persists in `localStorage` (`pingpong.name`, see `lib/name-storage.ts`) and travels as a `?name=` query param on connect; the server sanitizes it. The first connection's name makes the room title (`matchTitle` → "X's match"). Players and spectators share a chat (`{type:"chat"}`, rate-limited 500ms, 140 chars); the room keeps the last 50 lines and replays them in `welcome`.
- Spectators are never allowed to send game input — the server enforces this by seat ownership, not client claim.
- A separate lobby room (`party/lobby.ts`) tracks live matches (title, per-side player counts, names, score) so the home page can list joinable and watchable games in real time.

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
