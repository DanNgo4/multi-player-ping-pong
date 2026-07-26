import { HIT_HEIGHT } from "./constants";

export type PlayerIndex = 0 | 1;
export type MatchStatus = "waiting" | "countdown" | "playing" | "gameover";

export interface Ball {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** Racket position in its player's hit plane; driven directly by mouse input. */
export interface Racket {
  x: number;
  y: number;
}

export interface GameState {
  ball: Ball;
  rackets: [Racket, Racket];
  scores: [number, number];
  status: MatchStatus;
  /** Seconds remaining before play starts; only meaningful while status is "countdown". */
  countdown: number;
  winner: PlayerIndex | null;
  /** Who serves the next ball. */
  server: PlayerIndex;
  /** Seconds until the held ball is served; only meaningful while live is false. */
  serveTimer: number;
  /** True while the ball is in flight. */
  live: boolean;
  lastHitter: PlayerIndex | null;
  /** True once the last shot has bounced on the receiver's side of the table. */
  bouncedSinceHit: boolean;
}

export function createInitialState(): GameState {
  return {
    ball: { x: 0, y: HIT_HEIGHT, z: 0, vx: 0, vy: 0, vz: 0 },
    rackets: [
      { x: 0, y: HIT_HEIGHT },
      { x: 0, y: HIT_HEIGHT },
    ],
    scores: [0, 0],
    status: "waiting",
    countdown: 0,
    winner: null,
    server: 0,
    serveTimer: 0,
    live: false,
    lastHitter: null,
    bouncedSinceHit: false,
  };
}
