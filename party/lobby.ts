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

interface ResultStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export class LobbyServer extends Server<Env> {
  matches = new Map<string, MatchInfo>();
  results: MatchResult[] = [];

  /**
   * Like `env` in the match server, `ctx` exists at runtime but its type
   * lives in the `cloudflare:workers` ambient module we don't load globally.
   */
  private get store(): ResultStorage {
    return (this as unknown as { ctx: { storage: ResultStorage } }).ctx.storage;
  }

  override async onStart(): Promise<void> {
    // Results survive lobby restarts; live match listings rebuild themselves.
    const stored = await this.store.get("results");
    if (Array.isArray(stored)) this.results = stored as MatchResult[];
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
      } else if (post.gone) {
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
