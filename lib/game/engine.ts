import {
  AIM_FACTOR,
  BALL_RADIUS,
  COUNTDOWN_SECONDS,
  FLOOR_Y,
  GRAVITY,
  HIT_DEPTH,
  HIT_HEIGHT,
  HIT_RADIUS,
  MAX_SIDE_SPEED,
  MISS_MARGIN,
  NET_HEIGHT,
  NET_Z,
  PLAYER_Z,
  SERVE_DELAY,
  SHOT_LIFT,
  SHOT_SPEED_Z,
  TABLE_LENGTH,
  TABLE_RESTITUTION,
  TABLE_WIDTH,
  WIN_SCORE,
} from "./constants";
import type { GameState, PlayerIndex } from "./types";

/** Injectable randomness source so the engine stays deterministic under test. */
export type Rand = () => number;

export function opponent(i: PlayerIndex): PlayerIndex {
  return i === 0 ? 1 : 0;
}

export function beginCountdown(state: GameState): void {
  state.status = "countdown";
  state.countdown = COUNTDOWN_SECONDS;
}

/** Advances the match by dt seconds. Mutates and returns the same state object. */
export function step(state: GameState, dt: number, rand: Rand = () => 0.5): GameState {
  if (state.status === "countdown") {
    state.countdown -= dt;
    if (state.countdown <= 0) {
      state.countdown = 0;
      state.status = "playing";
      prepareServe(state);
    }
    return state;
  }

  if (state.status !== "playing") return state;

  if (!state.live) {
    holdBall(state);
    state.serveTimer -= dt;
    if (state.serveTimer <= 0) launchServe(state, rand);
    return state;
  }

  const ball = state.ball;
  const prevY = ball.y;
  const prevZ = ball.z;

  ball.vy -= GRAVITY * dt;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.z += ball.vz * dt;

  // Net: interpolate height at the moment the ball crosses the net plane.
  if ((prevZ - NET_Z) * (ball.z - NET_Z) < 0) {
    const t = (NET_Z - prevZ) / (ball.z - prevZ);
    const heightAtNet = prevY + (ball.y - prevY) * t;
    if (heightAtNet <= NET_HEIGHT) {
      resolveDead(state);
      return state;
    }
  }

  // Table bounce.
  const overTable =
    ball.z >= 0 && ball.z <= TABLE_LENGTH && Math.abs(ball.x) <= TABLE_WIDTH / 2;
  if (ball.vy < 0 && ball.y <= BALL_RADIUS && overTable) {
    ball.y = BALL_RADIUS;
    ball.vy = -ball.vy * TABLE_RESTITUTION;
    if (state.lastHitter !== null) {
      const side: PlayerIndex = ball.z < NET_Z ? 0 : 1;
      if (side !== state.lastHitter) state.bouncedSinceHit = true;
    }
  }

  // Racket hits.
  for (const i of [0, 1] as const) {
    const plane = PLAYER_Z[i];
    const toward = i === 0 ? ball.vz < 0 : ball.vz > 0;
    if (!toward || Math.abs(ball.z - plane) > HIT_DEPTH) continue;
    const racket = state.rackets[i];
    const dx = ball.x - racket.x;
    const dy = ball.y - racket.y;
    if (dx * dx + dy * dy > HIT_RADIUS * HIT_RADIUS) continue;
    ball.z = plane + (i === 0 ? 10 : -10);
    shoot(state, i, dx, rand);
    state.lastHitter = i;
    state.bouncedSinceHit = false;
  }

  // Dead ball: fell below the table, or flew past a racket plane.
  if (
    ball.y < FLOOR_Y ||
    ball.z < PLAYER_Z[0] - MISS_MARGIN ||
    ball.z > PLAYER_Z[1] + MISS_MARGIN
  ) {
    resolveDead(state);
  }

  return state;
}

function shoot(state: GameState, hitter: PlayerIndex, contactOffsetX: number, rand: Rand): void {
  const dir = hitter === 0 ? 1 : -1;
  state.ball.vz = SHOT_SPEED_Z * dir;
  state.ball.vy = SHOT_LIFT;
  state.ball.vx =
    clamp(contactOffsetX * AIM_FACTOR, -MAX_SIDE_SPEED, MAX_SIDE_SPEED) +
    (rand() * 2 - 1) * 30;
}

/**
 * If the last shot bounced on the receiver's side, the receiver failed to
 * return it and the hitter scores; otherwise the shot itself was a fault
 * (net, long, or wide) and the receiver scores.
 */
function resolveDead(state: GameState): void {
  const faultBy = state.lastHitter ?? state.server;
  const to = state.bouncedSinceHit ? faultBy : opponent(faultBy);
  awardPoint(state, to);
}

function awardPoint(state: GameState, to: PlayerIndex): void {
  state.scores[to] += 1;
  if (state.scores[to] >= WIN_SCORE) {
    state.status = "gameover";
    state.winner = to;
    state.live = false;
    state.ball.vx = 0;
    state.ball.vy = 0;
    state.ball.vz = 0;
    return;
  }
  state.server = opponent(to);
  prepareServe(state);
}

function prepareServe(state: GameState): void {
  state.live = false;
  state.serveTimer = SERVE_DELAY;
  state.lastHitter = null;
  state.bouncedSinceHit = false;
  holdBall(state);
}

/** While waiting to serve, the ball tracks the server's racket. */
function holdBall(state: GameState): void {
  const racket = state.rackets[state.server];
  state.ball.x = racket.x;
  state.ball.y = HIT_HEIGHT;
  state.ball.z = state.server === 0 ? 0 : TABLE_LENGTH;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = 0;
}

function launchServe(state: GameState, rand: Rand): void {
  state.live = true;
  state.lastHitter = state.server;
  state.bouncedSinceHit = false;
  shoot(state, state.server, 0, rand);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
