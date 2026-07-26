import { describe, expect, it } from "vitest";
import {
  BALL_RADIUS,
  COUNTDOWN_SECONDS,
  MISS_MARGIN,
  NET_Z,
  PLAYER_Z,
  SERVE_DELAY,
  SHOT_SPEED_Z,
  TABLE_LENGTH,
  WIN_SCORE,
} from "./constants";
import { beginCountdown, step } from "./engine";
import { createInitialState, type GameState } from "./types";

const TICK = 1 / 30;

function liveState(): GameState {
  const state = createInitialState();
  state.status = "playing";
  state.live = true;
  state.lastHitter = 0;
  return state;
}

describe("createInitialState", () => {
  it("starts waiting with a held ball and level scores", () => {
    const state = createInitialState();
    expect(state.status).toBe("waiting");
    expect(state.scores).toEqual([0, 0]);
    expect(state.live).toBe(false);
    expect(state.winner).toBeNull();
  });
});

describe("countdown and serve", () => {
  it("moves to playing after the countdown, then auto-serves", () => {
    const state = createInitialState();
    beginCountdown(state);
    for (let t = 0; t < COUNTDOWN_SECONDS + 0.2; t += TICK) step(state, TICK);
    expect(state.status).toBe("playing");
    expect(state.live).toBe(false);
    for (let t = 0; t < SERVE_DELAY + 0.2; t += TICK) step(state, TICK);
    expect(state.live).toBe(true);
    expect(state.ball.vz).toBe(SHOT_SPEED_Z);
    expect(state.lastHitter).toBe(0);
  });

  it("holds the ball on the server's racket before the serve", () => {
    const state = createInitialState();
    state.status = "playing";
    state.live = false;
    state.serveTimer = 10;
    state.rackets[0].x = 55;
    step(state, TICK);
    expect(state.ball.x).toBe(55);
    expect(state.ball.z).toBe(0);
  });
});

describe("flight", () => {
  it("applies gravity", () => {
    const state = liveState();
    state.ball.y = 100;
    state.ball.z = NET_Z;
    state.ball.vz = 100;
    const vyBefore = state.ball.vy;
    step(state, TICK);
    expect(state.ball.vy).toBeLessThan(vyBefore);
  });

  it("bounces off the table with damping", () => {
    const state = liveState();
    state.ball.z = NET_Z + 60;
    state.ball.y = BALL_RADIUS + 1;
    state.ball.vy = -300;
    state.ball.vz = 100;
    step(state, TICK);
    expect(state.ball.vy).toBeGreaterThan(0);
    expect(state.ball.vy).toBeLessThan(300);
  });

  it("marks the shot as bounced when it lands on the receiver's side", () => {
    const state = liveState();
    state.lastHitter = 0;
    state.ball.z = NET_Z + 120;
    state.ball.y = BALL_RADIUS + 1;
    state.ball.vy = -300;
    state.ball.vz = 100;
    step(state, TICK);
    expect(state.bouncedSinceHit).toBe(true);
  });
});

describe("racket hits", () => {
  it("returns the ball when the racket covers it", () => {
    const state = liveState();
    state.lastHitter = 1;
    state.ball.x = 20;
    state.ball.y = 50;
    state.ball.z = PLAYER_Z[0] + 20;
    state.ball.vz = -SHOT_SPEED_Z;
    state.rackets[0] = { x: 25, y: 55 };
    step(state, TICK);
    expect(state.ball.vz).toBe(SHOT_SPEED_Z);
    expect(state.lastHitter).toBe(0);
    expect(state.bouncedSinceHit).toBe(false);
  });

  it("misses when the racket is far from the ball", () => {
    const state = liveState();
    state.lastHitter = 1;
    state.ball.x = 0;
    state.ball.y = 50;
    state.ball.z = PLAYER_Z[0] + 20;
    state.ball.vz = -SHOT_SPEED_Z;
    state.rackets[0] = { x: 150, y: 55 };
    step(state, TICK);
    expect(state.ball.vz).toBe(-SHOT_SPEED_Z);
  });
});

describe("scoring", () => {
  it("awards the hitter when a bounced shot flies past the receiver", () => {
    const state = liveState();
    state.lastHitter = 0;
    state.bouncedSinceHit = true;
    state.ball.z = PLAYER_Z[1] + MISS_MARGIN + 1;
    state.ball.y = 60;
    state.ball.vz = SHOT_SPEED_Z;
    step(state, TICK);
    expect(state.scores).toEqual([1, 0]);
    expect(state.live).toBe(false);
    expect(state.server).toBe(1);
  });

  it("awards the receiver when a shot dies in the net", () => {
    const state = liveState();
    state.lastHitter = 0;
    state.bouncedSinceHit = false;
    state.ball.z = NET_Z - 10;
    state.ball.y = 20;
    state.ball.vy = 0;
    state.ball.vz = SHOT_SPEED_Z;
    step(state, TICK);
    expect(state.scores).toEqual([0, 1]);
  });

  it("awards the receiver when a shot flies long without bouncing", () => {
    const state = liveState();
    state.lastHitter = 0;
    state.bouncedSinceHit = false;
    state.ball.z = PLAYER_Z[1] + MISS_MARGIN + 1;
    state.ball.y = 60;
    state.ball.vz = SHOT_SPEED_Z;
    step(state, TICK);
    expect(state.scores).toEqual([0, 1]);
  });

  it("ends the game at the win score", () => {
    const state = liveState();
    state.scores = [WIN_SCORE - 1, 0];
    state.lastHitter = 0;
    state.bouncedSinceHit = true;
    state.ball.z = PLAYER_Z[1] + MISS_MARGIN + 1;
    state.ball.y = 60;
    state.ball.vz = SHOT_SPEED_Z;
    step(state, TICK);
    expect(state.status).toBe("gameover");
    expect(state.winner).toBe(0);
    expect(state.live).toBe(false);
  });
});

describe("full rally simulation", () => {
  it("a served ball reaches the receiver's hit plane at a playable height", () => {
    const state = createInitialState();
    state.status = "playing";
    state.serveTimer = 0.01;
    // Receiver tracks the ball perfectly so nothing dies en route.
    for (let t = 0; t < 3; t += TICK) {
      state.rackets[1].x = state.ball.x;
      state.rackets[1].y = Math.max(20, state.ball.y);
      step(state, TICK, () => 0.5);
      if (state.lastHitter === 1) break;
    }
    expect(state.lastHitter).toBe(1);
    expect(state.scores).toEqual([0, 0]);
    expect(state.ball.vz).toBe(-SHOT_SPEED_Z);
    expect(state.ball.z).toBeLessThan(TABLE_LENGTH + MISS_MARGIN);
  });
});
