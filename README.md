# Ping Pong Live

Realtime multiplayer ping pong: two players per match, any number of live spectators.

- **Frontend:** Next.js App Router, deployed to Vercel.
- **Realtime:** PartyKit room server with server-authoritative physics (30 Hz tick). Clients send paddle input only; everyone in the room, players and spectators alike, receives the same state broadcast.

## Develop

```
npm install
npm run dev     # Next.js on :3000 + PartyKit on :1999
```

Open http://localhost:3000, create a match, then join the same room from a second tab. Move your racket with the mouse to return the ball. Watch a match live from `/watch/<room>`.

## Test

```
npm run typecheck
npm run lint
npm test            # vitest unit tests (game engine)
npm run test:e2e    # Playwright smoke (starts dev servers itself)
```

## Deploy

```
vercel                  # Next.js app
npm run deploy:party    # PartyKit room server
```

Set `NEXT_PUBLIC_PARTYKIT_HOST` on Vercel to the deployed PartyKit host.
