import { HIT_HEIGHT } from "./constants";

/** Side of the table: 0 plays from z=0, 1 from z=TABLE_LENGTH. */
export type PlayerIndex = 0 | 1;
export type MatchStatus = "waiting" | "countdown" | "playing" | "gameover";

/** A match starts 1v1; later joiners pick a side, up to two seats per side. */
export const MAX_SEATS_PER_SIDE = 2;
export const MAX_PLAYERS = 4;

export interface Ball {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Side spin: curves the flight laterally. Set by racket x-velocity at contact. */
  spinSide: number;
  /** Topspin (positive) dips flight and kicks off the bounce; negative is backspin. */
  spinTop: number;
}

/**
 * Racket position, driven directly by pointer input. x is lateral and y is
 * height, as they always were; z is how far the player has reached forward
 * over their own end of the table, between their base plane (PLAYER_Z) and
 * RACKET_REACH_Z in front of it.
 */
export interface Racket {
  x: number;
  y: number;
  z: number;
}

/**
 * Racket velocity in the hit plane. Only lateral and vertical motion brushes
 * spin onto the ball, so reaching forward has no z term to track here.
 */
export interface RacketVelocity {
  x: number;
  y: number;
}

/** One player's racket. Seats are created when a player joins, removed when they leave. */
export interface Seat {
  /** Stable id for the seat (the owning connection's id on the server). */
  id: string;
  side: PlayerIndex;
  racket: Racket;
  /** Racket velocity (units/s), tracked server-side from input deltas; feeds spin. */
  vel: RacketVelocity;
  /**
   * Lag compensation: how many ticks into the past this player's hit checks
   * look, matching what their screen showed when they reacted. Set from their
   * measured ping; 0 for low-latency players.
   */
  lagTicks: number;
  /** Play starts only when every seated player has pressed ready. */
  ready: boolean;
}

export interface GameState {
  ball: Ball;
  seats: Seat[];
  scores: [number, number];
  status: MatchStatus;
  /** Seconds remaining before play starts; only meaningful while status is "countdown". */
  countdown: number;
  winner: PlayerIndex | null;
  /** Which side serves the next ball. */
  server: PlayerIndex;
  /**
   * How many times each side has served; the serving seat within a side
   * rotates on it, so teammates in a duo take turns serving.
   */
  serveTurns: [number, number];
  /** Seconds until the held ball is served; only meaningful while live is false. */
  serveTimer: number;
  /** True while the ball is in flight. */
  live: boolean;
  /**
   * True while the ball is a dead body finishing its flight: the point is
   * already scored, and it is coasting (or lying where it stopped) until the
   * serve hold parks it on the server's racket. Distinct from `!live` alone,
   * which also covers a ball that never launched — that one is held from the
   * first tick. Clients read it to keep smoothing and trailing the dead ball,
   * and to break interpolation on the one frame it snaps to the racket.
   */
  coasting: boolean;
  lastHitter: PlayerIndex | null;
  /** True once the last shot has bounced on the receiving side of the table. */
  bouncedSinceHit: boolean;
  /** True after the net fully blocked the ball; the point resolves when it lands. */
  netTouched: boolean;
}

export function createInitialState(): GameState {
  return {
    ball: { x: 0, y: HIT_HEIGHT, z: 0, vx: 0, vy: 0, vz: 0, spinSide: 0, spinTop: 0 },
    seats: [],
    scores: [0, 0],
    status: "waiting",
    countdown: 0,
    winner: null,
    server: 0,
    serveTurns: [0, 0],
    serveTimer: 0,
    live: false,
    coasting: false,
    lastHitter: null,
    bouncedSinceHit: false,
    netTouched: false,
  };
}
