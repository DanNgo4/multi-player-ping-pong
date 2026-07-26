import {
  getServerByName,
  Server,
  type Connection,
  type ConnectionContext,
} from "partyserver";
import { MAX_RACKET_SPEED, RACKET_MAX_X, RACKET_MAX_Y, TICK_HZ } from "../lib/game/constants";
import {
  addSeat,
  beginCountdown,
  bothSidesManned,
  clamp,
  removeSeat,
  resetScores,
  sideCount,
  step,
  suspendPlay,
} from "../lib/game/engine";
import { createInitialState, type GameState, type PlayerIndex, type Seat } from "../lib/game/types";
import {
  matchTitle,
  parseClientMessage,
  sanitizeChat,
  sanitizeName,
  type ChatEntry,
  type LobbyPost,
  type LobbyUpdate,
  type MatchResult,
  type SeatNames,
  type ServerMessage,
} from "../lib/protocol";
import type { Env } from "./env";

const LOBBY_ROOM = "index";
const CHAT_HISTORY_LIMIT = 50;

export class MatchServer extends Server<Env> {
  state: GameState = createInitialState();
  /** Display name per seated player, keyed by connection id (=== seat id). */
  playerNames = new Map<string, string | null>();
  watcherNames = new Map<string, string>();
  /** Whoever opened the room; gives the match its title for its lifetime. */
  creator: string | null = null;
  creatorSet = false;
  loop: ReturnType<typeof setInterval> | null = null;
  /** Last racket input per player connection, for deriving racket velocity (spin). */
  lastRacketInput = new Map<string, { x: number; y: number; t: number }>();
  lastChatAt = new Map<string, number>();
  /** Rolling chat log replayed to joiners in their welcome message. */
  chatHistory: ChatEntry[] = [];

  /**
   * The base class holds env, but its type lives in the `cloudflare:workers`
   * ambient module, which we deliberately do not load globally (it conflicts
   * with the DOM lib used by app code). Runtime property is real.
   */
  private get bindings(): Env {
    return (this as unknown as { env: Env }).env;
  }

  override onConnect(conn: Connection, ctx: ConnectionContext): void {
    const params = new URL(ctx.request.url).searchParams;
    const wantsWatch = params.get("intent") === "watch";
    const name = sanitizeName(params.get("name"));
    if (!this.creatorSet) {
      this.creatorSet = true;
      this.creator = name;
    }
    let seat: Seat | null = null;
    if (!wantsWatch) {
      // Auto-seat only while the basic 1v1 isn't filled; further players pick
      // a side themselves (join message) and the score carries on.
      const side: PlayerIndex | null =
        sideCount(this.state, 0) === 0 ? 0 : sideCount(this.state, 1) === 0 ? 1 : null;
      if (side !== null) seat = this.seatPlayer(conn.id, side, name);
    }
    if (!seat) this.watcherNames.set(conn.id, name ?? "Guest");
    this.sendWelcome(conn, seat);
    this.ensureLoop();
    this.broadcastState();
    void this.updateLobby();
  }

  override onMessage(conn: Connection, raw: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof raw !== "string") return;
    const msg = parseClientMessage(raw);
    if (!msg) return;
    if (msg.type === "chat") {
      this.handleChat(conn, msg.text);
      return;
    }
    if (msg.type === "join") {
      this.handleJoin(conn, msg.side);
      return;
    }
    if (msg.type === "spectate") {
      this.handleSpectate(conn);
      return;
    }
    const seat = this.state.seats.find((s) => s.id === conn.id);
    // Game input is enforced by server-side role: spectators hold no seat.
    if (!seat) return;
    if (msg.type === "racket") {
      const next = {
        x: clamp(msg.x, -RACKET_MAX_X, RACKET_MAX_X),
        y: clamp(msg.y, 0, RACKET_MAX_Y),
      };
      const now = Date.now();
      const prev = this.lastRacketInput.get(conn.id);
      if (prev) {
        // Racket velocity feeds spin; derived server-side so clients can't fake it.
        const dt = Math.max((now - prev.t) / 1000, 1 / TICK_HZ);
        seat.vel = {
          x: clamp((next.x - prev.x) / dt, -MAX_RACKET_SPEED, MAX_RACKET_SPEED),
          y: clamp((next.y - prev.y) / dt, -MAX_RACKET_SPEED, MAX_RACKET_SPEED),
        };
      }
      this.lastRacketInput.set(conn.id, { ...next, t: now });
      seat.racket = next;
    } else if (msg.type === "restart" && this.state.status === "gameover") {
      resetScores(this.state);
      if (bothSidesManned(this.state)) beginCountdown(this.state);
      this.broadcastState();
      void this.updateLobby();
    }
  }

  /** A spectator grabs a free seat mid-match; the score stays as it is. */
  private handleJoin(conn: Connection, side: PlayerIndex): void {
    if (this.state.seats.some((s) => s.id === conn.id)) return;
    const name = this.watcherNames.get(conn.id) ?? null;
    const seat = this.seatPlayer(conn.id, side, sanitizeName(name));
    if (!seat) return;
    this.watcherNames.delete(conn.id);
    this.sendWelcome(conn, seat);
    this.broadcastState();
    void this.updateLobby();
  }

  /** A player steps down to watch. Refused mid-game in a 1v1 — it would kill the match. */
  private handleSpectate(conn: Connection): void {
    const seat = this.state.seats.find((s) => s.id === conn.id);
    if (!seat) return;
    const midGame = this.state.status === "playing" || this.state.status === "countdown";
    if (midGame && this.state.seats.length <= 2) return;
    removeSeat(this.state, conn.id);
    const name = this.playerNames.get(conn.id) ?? null;
    this.playerNames.delete(conn.id);
    this.lastRacketInput.delete(conn.id);
    this.watcherNames.set(conn.id, name ?? "Guest");
    if (midGame && sideCount(this.state, seat.side) === 0) {
      suspendPlay(this.state);
    }
    this.sendWelcome(conn, null);
    this.broadcastState();
    void this.updateLobby();
  }

  private seatPlayer(id: string, side: PlayerIndex, name: string | null): Seat | null {
    const seat = addSeat(this.state, side, id);
    if (!seat) return null;
    this.playerNames.set(id, name);
    if (this.state.status === "waiting" && bothSidesManned(this.state)) {
      beginCountdown(this.state);
    }
    return seat;
  }

  private handleChat(conn: Connection, raw: string): void {
    const text = sanitizeChat(raw);
    if (!text) return;
    const now = Date.now();
    if (now - (this.lastChatAt.get(conn.id) ?? 0) < 500) return;
    this.lastChatAt.set(conn.id, now);
    const seatIndex = this.state.seats.findIndex((s) => s.id === conn.id);
    const from =
      seatIndex !== -1
        ? (this.playerNames.get(conn.id) ?? `Player ${seatIndex + 1}`)
        : (this.watcherNames.get(conn.id) ?? "Guest");
    this.chatHistory.push({ from, text });
    if (this.chatHistory.length > CHAT_HISTORY_LIMIT) {
      this.chatHistory = this.chatHistory.slice(-CHAT_HISTORY_LIMIT);
    }
    const msg: ServerMessage = { type: "chat", from, text };
    this.broadcast(JSON.stringify(msg));
  }

  override onClose(conn: Connection): void {
    const seat = removeSeat(this.state, conn.id);
    this.playerNames.delete(conn.id);
    this.watcherNames.delete(conn.id);
    this.lastRacketInput.delete(conn.id);
    this.lastChatAt.delete(conn.id);
    if (
      seat &&
      sideCount(this.state, seat.side) === 0 &&
      (this.state.status === "playing" || this.state.status === "countdown")
    ) {
      // A side emptied mid-match: pause, keep the score for the next joiner.
      suspendPlay(this.state);
    }
    if ([...this.getConnections()].length === 0) {
      if (this.loop) {
        clearInterval(this.loop);
        this.loop = null;
      }
      // Empty room resets entirely; the next visitor starts a fresh match.
      this.state = createInitialState();
      this.creator = null;
      this.creatorSet = false;
      this.playerNames.clear();
      this.watcherNames.clear();
      this.chatHistory = [];
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
    const wasOver = this.state.status === "gameover";
    step(this.state, 1 / TICK_HZ, Math.random);
    this.broadcastState();
    const after = `${this.state.scores[0]}:${this.state.scores[1]}:${this.state.status}`;
    if (before !== after) void this.updateLobby();
    if (!wasOver && this.state.status === "gameover") void this.reportResult();
  }

  /** Records a finished game with the lobby for the history list/leaderboard. */
  private async reportResult(): Promise<void> {
    if (this.state.winner === null) return;
    const names: [string[], string[]] = [[], []];
    for (const s of this.state.seats) {
      names[s.side].push(this.playerNames.get(s.id) ?? "Guest");
    }
    const result: MatchResult = {
      id: this.name,
      title: matchTitle(this.creator, this.name),
      names,
      scores: [...this.state.scores],
      winner: this.state.winner,
      endedAt: Date.now(),
    };
    await this.postLobby({ result });
  }

  private counts(): { players: number; spectators: number } {
    const total = [...this.getConnections()].length;
    const players = this.state.seats.length;
    return { players, spectators: Math.max(0, total - players) };
  }

  private seatNames(): SeatNames {
    return this.state.seats.map((s) => this.playerNames.get(s.id) ?? null);
  }

  private watchers(): string[] {
    return [...this.watcherNames.values()];
  }

  private sendWelcome(conn: Connection, seat: Seat | null): void {
    const msg: ServerMessage = {
      type: "welcome",
      role: seat ? "player" : "spectator",
      seatId: seat ? seat.id : null,
      side: seat ? seat.side : null,
      state: this.state,
      names: this.seatNames(),
      watchers: this.watchers(),
      creator: this.creator,
      chat: this.chatHistory,
    };
    conn.send(JSON.stringify(msg));
  }

  private broadcastState(): void {
    const { players, spectators } = this.counts();
    const msg: ServerMessage = {
      type: "state",
      state: this.state,
      players,
      spectators,
      names: this.seatNames(),
      watchers: this.watchers(),
      creator: this.creator,
    };
    this.broadcast(JSON.stringify(msg));
  }

  private async updateLobby(gone = false): Promise<void> {
    const { players, spectators } = this.counts();
    const update: LobbyUpdate = {
      id: this.name,
      players,
      spectators,
      sides: [sideCount(this.state, 0), sideCount(this.state, 1)],
      scores: this.state.scores,
      status: this.state.status,
      names: this.seatNames(),
      creator: this.creator,
      ...(gone ? { gone: true } : {}),
    };
    await this.postLobby(update);
  }

  private async postLobby(post: LobbyPost): Promise<void> {
    try {
      const lobby = await getServerByName(
        this.bindings.lobby as Parameters<typeof getServerByName>[0],
        LOBBY_ROOM,
      );
      await lobby.fetch("https://lobby.internal/", {
        method: "POST",
        body: JSON.stringify(post),
      });
    } catch {
      // The lobby listing is best-effort; never let it break a live match.
    }
  }
}
