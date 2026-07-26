import { COURT_HEIGHT, COURT_WIDTH, PADDLE_HEIGHT } from "./constants";

export type PlayerIndex = 0 | 1;
export type PaddleDir = -1 | 0 | 1;
export type MatchStatus = "waiting" | "countdown" | "playing" | "gameover";

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Paddle {
  y: number;
  dir: PaddleDir;
}

export interface GameState {
  ball: Ball;
  paddles: [Paddle, Paddle];
  scores: [number, number];
  status: MatchStatus;
  /** Seconds remaining before play starts; only meaningful while status is "countdown". */
  countdown: number;
  winner: PlayerIndex | null;
}

export function createInitialState(): GameState {
  const paddleY = (COURT_HEIGHT - PADDLE_HEIGHT) / 2;
  return {
    ball: { x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2, vx: 0, vy: 0 },
    paddles: [
      { y: paddleY, dir: 0 },
      { y: paddleY, dir: 0 },
    ],
    scores: [0, 0],
    status: "waiting",
    countdown: 0,
    winner: null,
  };
}
