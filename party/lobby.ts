import { Server, type Connection } from "partyserver";
import type { LobbyServerMessage, LobbyUpdate, MatchInfo } from "../lib/protocol";
import type { Env } from "./env";

export class LobbyServer extends Server<Env> {
  matches = new Map<string, MatchInfo>();

  override onConnect(conn: Connection): void {
    conn.send(this.snapshot());
  }

  override async onRequest(req: Request): Promise<Response> {
    if (req.method === "POST") {
      const update = (await req.json()) as LobbyUpdate;
      if (update.gone) {
        this.matches.delete(update.id);
      } else {
        this.matches.set(update.id, {
          id: update.id,
          players: update.players,
          spectators: update.spectators,
          scores: update.scores,
          status: update.status,
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
    const msg: LobbyServerMessage = { type: "matches", matches: [...this.matches.values()] };
    return JSON.stringify(msg);
  }
}
