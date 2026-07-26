import {
  getServerByName,
  Server,
  type Connection,
  type ConnectionContext,
} from "partyserver";
import { RACKET_MAX_X, RACKET_MAX_Y, TICK_HZ } from "../lib/game/constants";
import { beginCountdown, clamp, step } from "../lib/game/engine";
import { createInitialState, type GameState, type PlayerIndex } from "../lib/game/types";
import {
  parseClientMessage,
  type LobbyUpdate,
  type Role,
  type ServerMessage,
} from "../lib/protocol";
import type { Env } from "./env";

const LOBBY_ROOM = "index";

export class MatchServer extends Server<Env> {
  state: GameState = createInitialState();
  players = new Map<string, PlayerIndex>();
  loop: ReturnType<typeof setInterval> | null = null;

  /**
   * The base class holds env, but its type lives in the `cloudflare:workers`
   * ambient module, which we deliberately do not load globally (it conflicts
   * with the DOM lib used by app code). Runtime property is real.
   */
  private get bindings(): Env {
    return (this as unknown as { env: Env }).env;
  }

  override onConnect(conn: Connection, ctx: ConnectionContext): void {
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

  override onMessage(conn: Connection, raw: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof raw !== "string") return;
    const msg = parseClientMessage(raw);
    const playerIndex = this.players.get(conn.id);
    // Input is enforced by server-side role: spectators are simply not in the map.
    if (!msg || playerIndex === undefined) return;
    if (msg.type === "racket") {
      this.state.rackets[playerIndex] = {
        x: clamp(msg.x, -RACKET_MAX_X, RACKET_MAX_X),
        y: clamp(msg.y, 0, RACKET_MAX_Y),
      };
    } else if (msg.type === "restart" && this.state.status === "gameover") {
      this.state = createInitialState();
      if (this.players.size === 2) beginCountdown(this.state);
      this.broadcastState();
      void this.updateLobby();
    }
  }

  override onClose(conn: Connection): void {
    const wasPlayer = this.players.delete(conn.id);
    if (wasPlayer && this.state.status !== "gameover") {
      // A player left mid-match: reset and wait for a new opponent.
      this.state = createInitialState();
    }
    if ([...this.getConnections()].length === 0) {
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
    const total = [...this.getConnections()].length;
    return { players: this.players.size, spectators: total - this.players.size };
  }

  private broadcastState(): void {
    const { players, spectators } = this.counts();
    const msg: ServerMessage = { type: "state", state: this.state, players, spectators };
    this.broadcast(JSON.stringify(msg));
  }

  private send(conn: Connection, msg: ServerMessage): void {
    conn.send(JSON.stringify(msg));
  }

  private async updateLobby(gone = false): Promise<void> {
    const { players, spectators } = this.counts();
    const update: LobbyUpdate = {
      id: this.name,
      players,
      spectators,
      scores: this.state.scores,
      status: this.state.status,
      ...(gone ? { gone: true } : {}),
    };
    try {
      const lobby = await getServerByName(
        this.bindings.lobby as Parameters<typeof getServerByName>[0],
        LOBBY_ROOM,
      );
      await lobby.fetch("https://lobby.internal/", {
        method: "POST",
        body: JSON.stringify(update),
      });
    } catch {
      // The lobby listing is best-effort; never let it break a live match.
    }
  }
}
