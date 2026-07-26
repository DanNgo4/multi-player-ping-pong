import type * as Party from "partykit/server";
import { TICK_HZ } from "../lib/game/constants";
import { beginCountdown, step } from "../lib/game/engine";
import { createInitialState, type GameState, type PlayerIndex } from "../lib/game/types";
import {
  parseClientMessage,
  type LobbyUpdate,
  type Role,
  type ServerMessage,
} from "../lib/protocol";

const LOBBY_ROOM = "index";

export default class MatchServer implements Party.Server {
  state: GameState = createInitialState();
  players = new Map<string, PlayerIndex>();
  loop: ReturnType<typeof setInterval> | null = null;

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext): void {
    const wantsWatch = new URL(ctx.request.url).searchParams.get("intent") === "watch";
    let role: Role = "spectator";
    let playerIndex: PlayerIndex | null = null;
    if (!wantsWatch) {
      const taken = new Set(this.players.values());
      if (!taken.has(0)) playerIndex = 0;
      else if (!taken.has(1)) playerIndex = 1;
      if (playerIndex !== null) {
        this.players.set(conn.id, playerIndex);
        role = "player";
      }
    }
    this.send(conn, { type: "welcome", role, playerIndex, state: this.state });
    if (this.players.size === 2 && this.state.status === "waiting") {
      beginCountdown(this.state);
    }
    this.ensureLoop();
    this.broadcastState();
    void this.updateLobby();
  }

  onMessage(raw: string, conn: Party.Connection): void {
    const msg = parseClientMessage(raw);
    const playerIndex = this.players.get(conn.id);
    // Input is enforced by server-side role: spectators are simply not in the map.
    if (!msg || playerIndex === undefined) return;
    if (msg.type === "input") {
      this.state.paddles[playerIndex].dir = msg.dir;
    } else if (msg.type === "restart" && this.state.status === "gameover") {
      this.state = createInitialState();
      if (this.players.size === 2) beginCountdown(this.state);
      this.broadcastState();
      void this.updateLobby();
    }
  }

  onClose(conn: Party.Connection): void {
    const wasPlayer = this.players.delete(conn.id);
    if (wasPlayer && this.state.status !== "gameover") {
      // A player left mid-match: reset and wait for a new opponent.
      this.state = createInitialState();
    }
    if ([...this.room.getConnections()].length === 0) {
      if (this.loop) {
        clearInterval(this.loop);
        this.loop = null;
      }
      void this.updateLobby(true);
    } else {
      this.broadcastState();
      void this.updateLobby();
    }
  }

  private ensureLoop(): void {
    if (this.loop) return;
    this.loop = setInterval(() => this.tick(), 1000 / TICK_HZ);
  }

  private tick(): void {
    const before = `${this.state.scores[0]}:${this.state.scores[1]}:${this.state.status}`;
    step(this.state, 1 / TICK_HZ, Math.random);
    this.broadcastState();
    const after = `${this.state.scores[0]}:${this.state.scores[1]}:${this.state.status}`;
    if (before !== after) void this.updateLobby();
  }

  private counts(): { players: number; spectators: number } {
    const total = [...this.room.getConnections()].length;
    return { players: this.players.size, spectators: total - this.players.size };
  }

  private broadcastState(): void {
    const { players, spectators } = this.counts();
    const msg: ServerMessage = { type: "state", state: this.state, players, spectators };
    this.room.broadcast(JSON.stringify(msg));
  }

  private send(conn: Party.Connection, msg: ServerMessage): void {
    conn.send(JSON.stringify(msg));
  }

  private async updateLobby(gone = false): Promise<void> {
    const { players, spectators } = this.counts();
    const update: LobbyUpdate = {
      id: this.room.id,
      players,
      spectators,
      scores: this.state.scores,
      status: this.state.status,
      ...(gone ? { gone: true } : {}),
    };
    try {
      await this.room.context.parties.lobby
        ?.get(LOBBY_ROOM)
        .fetch({ method: "POST", body: JSON.stringify(update) });
    } catch {
      // The lobby listing is best-effort; never let it break a live match.
    }
  }
}
