import { Server, type Connection } from "partyserver";
import type {
  LobbyPost,
  LobbyServerMessage,
  MatchInfo,
  MatchResult,
} from "../lib/protocol";
import type { Env } from "./env";

/** How many finished games the lobby remembers for history/leaderboard. */
const RESULT_LIMIT = 50;

interface LobbyStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export class LobbyServer extends Server<Env> {
  /**
   * Hibernate between messages: home-page tabs hold sockets open around the
   * clock, and a pinned lobby object burns the Durable Objects duration
   * quota. Sockets survive hibernation; memory is restored in onStart.
   */
  static override options = { hibernate: true };

  matches = new Map<string, MatchInfo>();
  results: MatchResult[] = [];

  /**
   * Like `env` in the match server, `ctx` exists at runtime but its type
   * lives in the `cloudflare:workers` ambient module we don't load globally.
   */
  private get store(): LobbyStorage {
    return (this as unknown as { ctx: { storage: LobbyStorage } }).ctx.storage;
  }

  override async onStart(): Promise<void> {
    // Both survive hibernation and restarts; live rooms also re-POST on
    // every state change, correcting any staleness in the match list.
    const storedResults = await this.store.get("results");
    if (Array.isArray(storedResults)) this.results = storedResults as MatchResult[];
    const storedMatches = await this.store.get("matches");
    if (Array.isArray(storedMatches)) {
      this.matches = new Map(
        (storedMatches as MatchInfo[]).map((m) => [m.id, m]),
      );
    }
  }

  override onConnect(conn: Connection): void {
    conn.send(this.snapshot());
  }

  override async onRequest(req: Request): Promise<Response> {
    if (req.method === "POST") {
      const post = (await req.json()) as LobbyPost;
      if ("result" in post) {
        this.results.unshift(post.result);
        this.results = this.results.slice(0, RESULT_LIMIT);
        await this.store.put("results", this.results);
      } else {
        if (post.gone) {
          this.matches.delete(post.id);
        } else {
          this.matches.set(post.id, {
            id: post.id,
            players: post.players,
            spectators: post.spectators,
            sides: post.sides,
            scores: post.scores,
            status: post.status,
            names: post.names,
            creator: post.creator,
          });
        }
        await this.store.put("matches", [...this.matches.values()]);
      }
      this.broadcast(this.snapshot());
      return new Response("ok");
    }
    return new Response(this.snapshot(), {
      headers: { "content-type": "application/json" },
    });
  }

  private snapshot(): string {
    const msg: LobbyServerMessage = {
      type: "matches",
      matches: [...this.matches.values()],
      results: this.results,
    };
    return JSON.stringify(msg);
  }
}
