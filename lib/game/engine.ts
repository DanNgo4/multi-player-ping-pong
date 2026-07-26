import {
  BALL_MAX_SPEED,
  BALL_RADIUS,
  BALL_SPEED,
  BALL_SPEED_INCREMENT,
  COUNTDOWN_SECONDS,
  COURT_HEIGHT,
  COURT_WIDTH,
  MAX_BOUNCE_ANGLE,
  PADDLE_HEIGHT,
  PADDLE_MARGIN,
  PADDLE_SPEED,
  PADDLE_WIDTH,
  WIN_SCORE,
} from "./constants";
import type { GameState, PlayerIndex } from "./types";

/** Injectable randomness source so the engine stays deterministic under test. */
export type Rand = () => number;

const halfAngle = MAX_BOUNCE_ANGLE / 2;

/** Places the ball at centre court moving toward the given player. */
export function serve(state: GameState, toward: PlayerIndex, rand: Rand = () => 0.5): void {
  const angle = (rand() * 2 - 1) * halfAngle;
  const dir = toward === 0 ? -1 : 1;
  state.ball.x = COURT_WIDTH / 2;
  state.ball.y = COURT_HEIGHT / 2;
  state.ball.vx = Math.cos(angle) * BALL_SPEED * dir;
  state.ball.vy = Math.sin(angle) * BALL_SPEED;
}

export function beginCountdown(state: GameState): void {
  state.status = "countdown";
  state.countdown = COUNTDOWN_SECONDS;
}

/** Advances the match by dt seconds. Mutates and returns the same state object. */
export function step(state: GameState, dt: number, rand: Rand = () => 0.5): GameState {
  movePaddles(state, dt);

  if (state.status === "countdown") {
    state.countdown -= dt;
    if (state.countdown <= 0) {
      state.countdown = 0;
      state.status = "playing";
      if (state.ball.vx === 0 && state.ball.vy === 0) {
        serve(state, rand() < 0.5 ? 0 : 1, rand);
      }
    }
    return state;
  }

  if (state.status !== "playing") return state;

  const ball = state.ball;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  if (ball.y - BALL_RADIUS < 0) {
    ball.y = BALL_RADIUS;
    ball.vy = Math.abs(ball.vy);
  } else if (ball.y + BALL_RADIUS > COURT_HEIGHT) {
    ball.y = COURT_HEIGHT - BALL_RADIUS;
    ball.vy = -Math.abs(ball.vy);
  }

  const leftFace = PADDLE_MARGIN + PADDLE_WIDTH;
  const rightFace = COURT_WIDTH - PADDLE_MARGIN - PADDLE_WIDTH;
  if (
    ball.vx < 0 &&
    ball.x - BALL_RADIUS <= leftFace &&
    ball.x + BALL_RADIUS >= PADDLE_MARGIN &&
    overlapsPaddle(state, 0)
  ) {
    bounceOffPaddle(state, 0);
  } else if (
    ball.vx > 0 &&
    ball.x + BALL_RADIUS >= rightFace &&
    ball.x - BALL_RADIUS <= COURT_WIDTH - PADDLE_MARGIN &&
    overlapsPaddle(state, 1)
  ) {
    bounceOffPaddle(state, 1);
  }

  if (ball.x + BALL_RADIUS < 0) {
    score(state, 1, rand);
  } else if (ball.x - BALL_RADIUS > COURT_WIDTH) {
    score(state, 0, rand);
  }

  return state;
}

function movePaddles(state: GameState, dt: number): void {
  for (const paddle of state.paddles) {
    paddle.y += paddle.dir * PADDLE_SPEED * dt;
    paddle.y = clamp(paddle.y, 0, COURT_HEIGHT - PADDLE_HEIGHT);
  }
}

function overlapsPaddle(state: GameState, i: PlayerIndex): boolean {
  const paddle = state.paddles[i];
  return (
    state.ball.y + BALL_RADIUS >= paddle.y &&
    state.ball.y - BALL_RADIUS <= paddle.y + PADDLE_HEIGHT
  );
}

function bounceOffPaddle(state: GameState, i: PlayerIndex): void {
  const paddle = state.paddles[i];
  const offset = clamp(
    (state.ball.y - (paddle.y + PADDLE_HEIGHT / 2)) / (PADDLE_HEIGHT / 2),
    -1,
    1,
  );
  const angle = offset * MAX_BOUNCE_ANGLE;
  const speed = Math.min(
    Math.hypot(state.ball.vx, state.ball.vy) + BALL_SPEED_INCREMENT,
    BALL_MAX_SPEED,
  );
  const dir = i === 0 ? 1 : -1;
  state.ball.vx = Math.cos(angle) * speed * dir;
  state.ball.vy = Math.sin(angle) * speed;
  state.ball.x =
    i === 0
      ? PADDLE_MARGIN + PADDLE_WIDTH + BALL_RADIUS
      : COURT_WIDTH - PADDLE_MARGIN - PADDLE_WIDTH - BALL_RADIUS;
}

function score(state: GameState, winner: PlayerIndex, rand: Rand): void {
  state.scores[winner] += 1;
  if (state.scores[winner] >= WIN_SCORE) {
    state.status = "gameover";
    state.winner = winner;
    state.ball.x = COURT_WIDTH / 2;
    state.ball.y = COURT_HEIGHT / 2;
    state.ball.vx = 0;
    state.ball.vy = 0;
  } else {
    serve(state, winner === 0 ? 1 : 0, rand);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
