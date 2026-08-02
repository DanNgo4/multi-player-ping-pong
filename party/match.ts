import {
  getServerByName,
  Server,
  type Connection,
  type ConnectionContext,
} from "partyserver";
import {
  MAX_LAG_TICKS,
  MAX_RACKET_SPEED,
  PLAYER_Z,
  RACKET_MAX_X,
  RACKET_MAX_Y,
  RACKET_REACH_Z,
  RENDER_LAG_TICKS,
  TICK_HZ,
} from "../lib/game/constants";
import {
  addSeat,
  allReady,
  beginCountdown,
  clamp,
  removeSeat,
  resetScores,
  sideCount,
  step,
  suspendPlay,
} from "../lib/game/engine";
import {
  createInitialState,
  type Ball,
  type GameState,
  type PlayerIndex,
  type Seat,
} from "../lib/game/types";
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

interface MatchStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
}

/** Everything a hibernated room needs to pick the match back up on wake. */
interface SavedSession {
  state: GameState;
  playerNames: [string, string | null][];
  watcherNames: [string, string][];
  creator: string | null;
  creatorSet: boolean;
  chatHistory: ChatEntry[];
}

export class MatchServer extends Server<Env> {
  /**
   * Hibernate between messages while idle: rooms sitting on a waiting or
   * game-over screen with tabs open would otherwise stay pinned in memory
   * around the clock and burn the Durable Objects duration quota. During
   * countdown/play the 30 Hz tick interval keeps the room awake anyway.
   */
  static override options = { hibernate: true };
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
  /** Last broadcast payloads, so identical ticks aren't resent (idle rooms). */
  lastStateJson = "";
  lastMetaJson = "";
  /** Recent ball positions (index 0 = one tick ago) for lag-compensated hits. */
  ballTrail: Ball[] = [];

  /**
   * The base class holds env, but its type lives in the `cloudflare:workers`
   * ambient module, which we deliberately do not load globally (it conflicts
   * with the DOM lib used by app code). Runtime property is real.
   */
  private get bindings(): Env {
    return (this as unknown as { env: Env }).env;
  }

  private get store(): MatchStorage {
    return (this as unknown as { ctx: { storage: MatchStorage } }).ctx.storage;
  }

  override async onStart(): Promise<void> {
    // Waking from hibernation: connections survived, memory didn't.
    const saved = (await this.store.get("session")) as SavedSession | undefined;
    if (!saved) return;
    this.state = saved.state;
    // A session stored before rackets had any depth comes back without one,
    // and an undefined z would sail straight through the engine's hit-depth
    // test (every comparison against NaN is false) — turning that seat into a
    // racket that reaches the whole table. Put those players on their base
    // plane, which is where they were standing when the room went to sleep.
    for (const seat of this.state.seats) {
      if (!Number.isFinite(seat.racket.z)) seat.racket.z = PLAYER_Z[seat.side];
    }
    this.playerNames = new Map(saved.playerNames);
    this.watcherNames = new Map(saved.watcherNames);
    this.creator = saved.creator;
    this.creatorSet = saved.creatorSet;
    this.chatHistory = saved.chatHistory;
  }

  /** Persists the session so an idle (hibernated) room survives eviction. */
  private saveSession(): void {
    const session: SavedSession = {
      state: this.state,
      playerNames: [...this.playerNames.entries()],
      watcherNames: [...this.watcherNames.entries()],
      creator: this.creator,
      creatorSet: this.creatorSet,
      chatHistory: this.chatHistory,
    };
    void this.store.put("session", session).catch(() => {});
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
    // The tick loop only runs while the match needs simulating; idle rooms
    // stay quiet so they can hibernate.
    if (this.state.status === "countdown" || this.state.status === "playing") {
      this.ensureLoop();
    }
    this.broadcastState();
    this.saveSession();
    void this.updateLobby();
  }

  override onMessage(conn: Connection, raw: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof raw !== "string") return;
    const msg = parseClientMessage(raw);
    if (!msg) return;
    if (msg.type === "ping") {
      const pong: ServerMessage = { type: "pong", t: msg.t };
      conn.send(JSON.stringify(pong));
      // The reported round-trip sets this player's lag compensation window,
      // capped so a dishonest client can't buy more than MAX_LAG_TICKS.
      if (msg.rtt !== undefined) {
        const pingSeat = this.state.seats.find((s) => s.id === conn.id);
        if (pingSeat) {
          const oneWaySec = Math.max(0, msg.rtt) / 2 / 1000;
          pingSeat.lagTicks = Math.min(Math.round(oneWaySec * TICK_HZ), MAX_LAG_TICKS);
        }
      }
      return;
    }
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
      // Forward reach runs from the player's own base plane toward the net and
      // no further: side 0 reaches up the z axis, side 1 down it. A client too
      // old to send z (or one sending nonsense) plays from its base plane.
      const base = PLAYER_Z[seat.side];
      const front = seat.side === 0 ? base + RACKET_REACH_Z : base - RACKET_REACH_Z;
      const wantsZ = typeof msg.z === "number" && Number.isFinite(msg.z) ? msg.z : base;
      const next = {
        x: clamp(msg.x, -RACKET_MAX_X, RACKET_MAX_X),
        y: clamp(msg.y, 0, RACKET_MAX_Y),
        z: clamp(wantsZ, Math.min(base, front), Math.max(base, front)),
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
      // Only the in-plane axes feed racket velocity, so only they are tracked.
      this.lastRacketInput.set(conn.id, { x: next.x, y: next.y, t: now });
      seat.racket = next;
    } else if (msg.type === "ready" && this.state.status === "waiting") {
      seat.ready = !seat.ready;
      if (allReady(this.state)) {
        beginCountdown(this.state);
        this.ensureLoop();
      }
      this.broadcastState();
      this.saveSession();
      void this.updateLobby();
    } else if (msg.type === "restart" && this.state.status === "gameover") {
      // A rematch starts only once every seated player has pressed it.
      seat.ready = true;
      if (allReady(this.state)) {
        resetScores(this.state);
        beginCountdown(this.state);
        this.ensureLoop();
      }
      this.broadcastState();
      this.saveSession();
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
    this.saveSession();
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
    this.saveSession();
    void this.updateLobby();
  }

  private seatPlayer(id: string, side: PlayerIndex, name: string | null): Seat | null {
    const seat = addSeat(this.state, side, id);
    if (!seat) return null;
    this.playerNames.set(id, name);
    // No auto-start: play begins when every seated player presses ready.
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
    this.saveSession();
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
      this.lastStateJson = "";
      this.lastMetaJson = "";
      void this.store.delete("session").catch(() => {});
      void this.updateLobby(true);
    } else {
      this.broadcastState();
      this.saveSession();
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
    // The trail only tracks a ball in flight; stale positions from a previous
    // rally must never satisfy a compensated hit check.
    if (this.state.live) {
      this.ballTrail.unshift({ ...this.state.ball });
      // Deep enough for the worst allowed ping plus the fixed client render
      // delay every player's hit checks look back through.
      if (this.ballTrail.length > MAX_LAG_TICKS + RENDER_LAG_TICKS) this.ballTrail.pop();
    } else if (this.ballTrail.length > 0) {
      this.ballTrail = [];
    }
    step(this.state, 1 / TICK_HZ, Math.random, this.ballTrail);
    this.broadcastState();
    const after = `${this.state.scores[0]}:${this.state.scores[1]}:${this.state.status}`;
    if (before !== after) void this.updateLobby();
    if (!wasOver && this.state.status === "gameover") void this.reportResult();
    // Simulation over (suspended or game over): stop ticking and persist so
    // the room can hibernate until the next message wakes it.
    if (this.state.status !== "countdown" && this.state.status !== "playing") {
      if (this.loop) {
        clearInterval(this.loop);
        this.loop = null;
      }
      this.saveSession();
    }
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
    // A joiner missed all past meta broadcasts, so hand it the current one.
    conn.send(JSON.stringify(this.metaMsg()));
  }

  private metaMsg(): ServerMessage {
    const { players, spectators } = this.counts();
    return {
      type: "meta",
      players,
      spectators,
      seats: this.state.seats.map((s) => ({
        side: s.side,
        name: this.playerNames.get(s.id) ?? null,
      })),
      watchers: this.watchers(),
      creator: this.creator,
    };
  }

  /**
   * Presence (meta) goes out only when it changes; snapshots go out only when
   * the simulation actually moved. Idle rooms send nothing at all.
   */
  private broadcastState(): void {
    const meta = JSON.stringify(this.metaMsg());
    if (meta !== this.lastMetaJson) {
      this.lastMetaJson = meta;
      this.broadcast(meta);
    }
    const stateMsg: ServerMessage = { type: "state", state: this.state };
    const state = JSON.stringify(stateMsg);
    if (state !== this.lastStateJson) {
      this.lastStateJson = state;
      this.broadcast(state);
    }
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
