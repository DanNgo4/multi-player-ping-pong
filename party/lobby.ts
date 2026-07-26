import type * as Party from "partykit/server";
import type { LobbyServerMessage, LobbyUpdate, MatchInfo } from "../lib/protocol";

export default class LobbyServer implements Party.Server {
  matches = new Map<string, MatchInfo>();

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection): void {
    conn.send(this.snapshot());
  }

  async onRequest(req: Party.Request): Promise<Response> {
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
      this.room.broadcast(this.snapshot());
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
