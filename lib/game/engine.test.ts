import { describe, expect, it } from "vitest";
import {
  BALL_RADIUS,
  BALL_SPEED,
  COUNTDOWN_SECONDS,
  COURT_HEIGHT,
  COURT_WIDTH,
  PADDLE_HEIGHT,
  PADDLE_MARGIN,
  PADDLE_WIDTH,
  WIN_SCORE,
} from "./constants";
import { beginCountdown, serve, step } from "./engine";
import { createInitialState, type GameState } from "./types";

function playingState(): GameState {
  const state = createInitialState();
  state.status = "playing";
  return state;
}

describe("createInitialState", () => {
  it("starts waiting with a stationary centred ball and level scores", () => {
    const state = createInitialState();
    expect(state.status).toBe("waiting");
    expect(state.scores).toEqual([0, 0]);
    expect(state.ball).toEqual({ x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2, vx: 0, vy: 0 });
    expect(state.winner).toBeNull();
  });
});

describe("countdown", () => {
  it("transitions to playing and serves once the countdown elapses", () => {
    const state = createInitialState();
    beginCountdown(state);
    expect(state.status).toBe("countdown");
    for (let t = 0; t < COUNTDOWN_SECONDS + 0.5; t += 0.1) step(state, 0.1);
    expect(state.status).toBe("playing");
    expect(Math.hypot(state.ball.vx, state.ball.vy)).toBeCloseTo(BALL_SPEED, 5);
  });
});

describe("ball movement", () => {
  it("advances the ball by velocity * dt", () => {
    const state = playingState();
    state.ball.vx = 100;
    state.ball.vy = 50;
    step(state, 0.1);
    expect(state.ball.x).toBeCloseTo(COURT_WIDTH / 2 + 10);
    expect(state.ball.y).toBeCloseTo(COURT_HEIGHT / 2 + 5);
  });

  it("bounces off the top wall", () => {
    const state = playingState();
    state.ball.y = BALL_RADIUS + 1;
    state.ball.vy = -200;
    step(state, 0.05);
    expect(state.ball.vy).toBeGreaterThan(0);
    expect(state.ball.y).toBeGreaterThanOrEqual(BALL_RADIUS);
  });

  it("bounces off the bottom wall", () => {
    const state = playingState();
    state.ball.y = COURT_HEIGHT - BALL_RADIUS - 1;
    state.ball.vy = 200;
    step(state, 0.05);
    expect(state.ball.vy).toBeLessThan(0);
    expect(state.ball.y).toBeLessThanOrEqual(COURT_HEIGHT - BALL_RADIUS);
  });
});

describe("paddle collision", () => {
  it("reflects and speeds up the ball off the left paddle", () => {
    const state = playingState();
    const paddle = state.paddles[0];
    state.ball.x = PADDLE_MARGIN + PADDLE_WIDTH + BALL_RADIUS + 2;
    state.ball.y = paddle.y + PADDLE_HEIGHT / 2;
    state.ball.vx = -BALL_SPEED;
    state.ball.vy = 0;
    step(state, 0.05);
    expect(state.ball.vx).toBeGreaterThan(0);
    expect(Math.hypot(state.ball.vx, state.ball.vy)).toBeGreaterThan(BALL_SPEED);
  });

  it("deflects steeply when hitting near a paddle edge", () => {
    const state = playingState();
    const paddle = state.paddles[1];
    state.ball.x = COURT_WIDTH - PADDLE_MARGIN - PADDLE_WIDTH - BALL_RADIUS - 2;
    state.ball.y = paddle.y + PADDLE_HEIGHT - 4;
    state.ball.vx = BALL_SPEED;
    state.ball.vy = 0;
    step(state, 0.05);
    expect(state.ball.vx).toBeLessThan(0);
    expect(state.ball.vy).toBeGreaterThan(0);
  });

  it("misses when the ball is outside the paddle's vertical range", () => {
    const state = playingState();
    state.paddles[0].y = 0;
    state.ball.x = PADDLE_MARGIN + PADDLE_WIDTH + BALL_RADIUS + 2;
    state.ball.y = COURT_HEIGHT - 30;
    state.ball.vx = -BALL_SPEED;
    step(state, 0.05);
    expect(state.ball.vx).toBeLessThan(0);
  });
});

describe("scoring", () => {
  it("awards the point to player 1 when the ball exits the left edge and serves to the conceder", () => {
    const state = playingState();
    state.ball.x = BALL_RADIUS;
    state.ball.y = COURT_HEIGHT - 30;
    state.paddles[0].y = 0;
    state.ball.vx = -600;
    step(state, 0.1);
    expect(state.scores).toEqual([0, 1]);
    expect(state.ball.x).toBe(COURT_WIDTH / 2);
    expect(state.ball.vx).toBeLessThan(0);
  });

  it("ends the game at the win score", () => {
    const state = playingState();
    state.scores = [WIN_SCORE - 1, 0];
    state.ball.x = COURT_WIDTH - BALL_RADIUS;
    state.ball.y = COURT_HEIGHT - 30;
    state.paddles[1].y = 0;
    state.ball.vx = 600;
    step(state, 0.1);
    expect(state.status).toBe("gameover");
    expect(state.winner).toBe(0);
    expect(state.ball.vx).toBe(0);
    expect(state.ball.vy).toBe(0);
  });
});

describe("paddles", () => {
  it("clamps paddle movement to the court", () => {
    const state = playingState();
    state.paddles[0].dir = -1;
    for (let i = 0; i < 100; i++) step(state, 0.1);
    expect(state.paddles[0].y).toBe(0);
    state.paddles[0].dir = 1;
    for (let i = 0; i < 100; i++) step(state, 0.1);
    expect(state.paddles[0].y).toBe(COURT_HEIGHT - PADDLE_HEIGHT);
  });
});

describe("serve", () => {
  it("is deterministic given a fixed rand", () => {
    const a = createInitialState();
    const b = createInitialState();
    serve(a, 0, () => 0.25);
    serve(b, 0, () => 0.25);
    expect(a.ball).toEqual(b.ball);
    expect(a.ball.vx).toBeLessThan(0);
  });
});
