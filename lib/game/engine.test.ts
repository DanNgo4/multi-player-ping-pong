import { describe, expect, it } from "vitest";
import {
  BALL_RADIUS,
  COUNTDOWN_SECONDS,
  MISS_MARGIN,
  NET_HEIGHT,
  NET_Z,
  PLAYER_Z,
  SERVE_DELAY,
  SHOT_SPEED_Z,
  TABLE_LENGTH,
  WIN_SCORE,
} from "./constants";
import {
  addSeat,
  beginCountdown,
  bothSidesManned,
  removeSeat,
  resetScores,
  step,
  suspendPlay,
} from "./engine";
import { createInitialState, type GameState } from "./types";

const TICK = 1 / 30;

/** 1v1 setup: seat "a" on side 0, seat "b" on side 1. */
function seatedState(): GameState {
  const state = createInitialState();
  addSeat(state, 0, "a");
  addSeat(state, 1, "b");
  return state;
}

function liveState(): GameState {
  const state = seatedState();
  state.status = "playing";
  state.live = true;
  state.lastHitter = 0;
  return state;
}

describe("createInitialState", () => {
  it("starts waiting with no seats and level scores", () => {
    const state = createInitialState();
    expect(state.status).toBe("waiting");
    expect(state.scores).toEqual([0, 0]);
    expect(state.seats).toEqual([]);
    expect(state.live).toBe(false);
    expect(state.winner).toBeNull();
  });
});

describe("seats", () => {
  it("allows up to two seats per side and four total", () => {
    const state = createInitialState();
    expect(addSeat(state, 0, "a")).not.toBeNull();
    expect(addSeat(state, 0, "b")).not.toBeNull();
    expect(addSeat(state, 0, "c")).toBeNull();
    expect(addSeat(state, 1, "d")).not.toBeNull();
    expect(addSeat(state, 1, "e")).not.toBeNull();
    expect(state.seats).toHaveLength(4);
    expect(addSeat(state, 1, "f")).toBeNull();
  });

  it("offsets a second seat away from its teammate", () => {
    const state = createInitialState();
    addSeat(state, 0, "a");
    const second = addSeat(state, 0, "b");
    expect(second?.racket.x).not.toBe(state.seats[0]?.racket.x);
  });

  it("removes a seat by id and reports side occupancy", () => {
    const state = seatedState();
    expect(bothSidesManned(state)).toBe(true);
    removeSeat(state, "b");
    expect(bothSidesManned(state)).toBe(false);
    expect(state.seats).toHaveLength(1);
  });
});

describe("countdown and serve", () => {
  it("moves to playing after the countdown, then auto-serves", () => {
    const state = seatedState();
    beginCountdown(state);
    for (let t = 0; t < COUNTDOWN_SECONDS + 0.2; t += TICK) step(state, TICK);
    expect(state.status).toBe("playing");
    expect(state.live).toBe(false);
    for (let t = 0; t < SERVE_DELAY + 0.2; t += TICK) step(state, TICK);
    expect(state.live).toBe(true);
    expect(state.ball.vz).toBe(SHOT_SPEED_Z);
    expect(state.lastHitter).toBe(0);
  });

  it("holds the ball on the serving player's racket before the serve", () => {
    const state = seatedState();
    state.status = "playing";
    state.live = false;
    state.serveTimer = 10;
    state.seats[0]!.racket.x = 55;
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

  it("marks the shot as bounced when it lands on the receiving side", () => {
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
    state.seats[0]!.racket = { x: 25, y: 55 };
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
    state.seats[0]!.racket = { x: 150, y: 55 };
    step(state, TICK);
    expect(state.ball.vz).toBe(-SHOT_SPEED_Z);
  });

  it("lets a teammate cover the return in a two-seat side", () => {
    const state = liveState();
    addSeat(state, 0, "a2");
    state.lastHitter = 1;
    state.ball.x = 80;
    state.ball.y = 50;
    state.ball.z = PLAYER_Z[0] + 20;
    state.ball.vz = -SHOT_SPEED_Z;
    state.seats[0]!.racket = { x: -150, y: 55 };
    const teammate = state.seats.find((s) => s.id === "a2")!;
    teammate.racket = { x: 85, y: 55 };
    step(state, TICK);
    expect(state.ball.vz).toBe(SHOT_SPEED_Z);
    expect(state.lastHitter).toBe(0);
  });
});

describe("scoring", () => {
  it("awards the hitting side when a bounced shot flies past the receivers", () => {
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

  it("rebounds a low ball off the net; receivers score when it lands", () => {
    const state = liveState();
    state.lastHitter = 0;
    state.bouncedSinceHit = false;
    state.ball.z = NET_Z - 10;
    state.ball.y = 20;
    state.ball.vy = 0;
    state.ball.vz = SHOT_SPEED_Z;
    step(state, TICK);
    expect(state.ball.vz).toBeLessThan(0);
    expect(state.netTouched).toBe(true);
    expect(state.scores).toEqual([0, 0]);
    for (let t = 0; t < 3 && state.scores[1] === 0; t += TICK) step(state, TICK);
    expect(state.scores).toEqual([0, 1]);
  });

  it("lets a net-cord clip dribble over and play on", () => {
    const state = liveState();
    state.lastHitter = 0;
    state.ball.z = NET_Z - 10;
    state.ball.y = NET_HEIGHT + 3;
    state.ball.vy = 0;
    state.ball.vz = SHOT_SPEED_Z;
    step(state, TICK);
    expect(state.netTouched).toBe(false);
    expect(state.ball.vz).toBeGreaterThan(0);
    expect(state.ball.vz).toBeLessThan(SHOT_SPEED_Z);
    expect(state.scores).toEqual([0, 0]);
  });

  it("awards the receivers when a shot flies long without bouncing", () => {
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

describe("spin", () => {
  it("brushes spin onto the ball from racket velocity at contact", () => {
    const state = liveState();
    state.lastHitter = 1;
    state.ball.x = 20;
    state.ball.y = 50;
    state.ball.z = PLAYER_Z[0] + 20;
    state.ball.vz = -SHOT_SPEED_Z;
    state.seats[0]!.racket = { x: 25, y: 55 };
    state.seats[0]!.vel = { x: 400, y: 300 };
    step(state, TICK);
    expect(state.lastHitter).toBe(0);
    expect(state.ball.spinSide).toBeGreaterThan(0);
    expect(state.ball.spinTop).toBeGreaterThan(0);
  });

  it("curves the flight sideways with side spin", () => {
    const state = liveState();
    state.ball.y = 100;
    state.ball.z = 100;
    state.ball.vz = SHOT_SPEED_Z;
    state.ball.spinSide = 200;
    const vxBefore = state.ball.vx;
    step(state, TICK);
    expect(state.ball.vx).toBeGreaterThan(vxBefore);
  });

  it("dips faster with topspin than without", () => {
    const flat = liveState();
    flat.ball.y = 100;
    flat.ball.z = 100;
    flat.ball.vz = SHOT_SPEED_Z;
    const spun = liveState();
    spun.ball.y = 100;
    spun.ball.z = 100;
    spun.ball.vz = SHOT_SPEED_Z;
    spun.ball.spinTop = 200;
    step(flat, TICK);
    step(spun, TICK);
    expect(spun.ball.vy).toBeLessThan(flat.ball.vy);
  });

  it("kicks forward off the bounce with topspin and decays the spin", () => {
    const state = liveState();
    state.ball.z = NET_Z + 60;
    state.ball.y = BALL_RADIUS + 1;
    state.ball.vy = -300;
    state.ball.vz = 100;
    state.ball.spinTop = 200;
    step(state, TICK);
    expect(state.ball.vz).toBeGreaterThan(100);
    expect(state.ball.spinTop).toBeLessThan(200);
  });

  it("adds shot power from a fast swipe", () => {
    const state = liveState();
    state.lastHitter = 1;
    state.ball.x = 20;
    state.ball.y = 50;
    state.ball.z = PLAYER_Z[0] + 20;
    state.ball.vz = -SHOT_SPEED_Z;
    state.seats[0]!.racket = { x: 25, y: 55 };
    state.seats[0]!.vel = { x: 0, y: 900 };
    step(state, TICK);
    expect(state.lastHitter).toBe(0);
    expect(state.ball.vz).toBeGreaterThan(SHOT_SPEED_Z);
  });

  it("launches flatter with topspin and floatier with backspin", () => {
    const hit = (velY: number): number => {
      const state = liveState();
      state.lastHitter = 1;
      state.ball.x = 20;
      state.ball.y = 50;
      state.ball.z = PLAYER_Z[0] + 20;
      state.ball.vz = -SHOT_SPEED_Z;
      state.seats[0]!.racket = { x: 25, y: 55 };
      state.seats[0]!.vel = { x: 0, y: velY };
      step(state, TICK);
      return state.ball.vy;
    };
    expect(hit(700)).toBeLessThan(hit(0));
    expect(hit(-700)).toBeGreaterThan(hit(0));
  });

  it("fades tracked racket velocity over time", () => {
    const state = liveState();
    state.ball.y = 200;
    state.ball.z = NET_Z;
    state.ball.vz = 100;
    state.seats[0]!.vel = { x: 400, y: 0 };
    step(state, TICK);
    expect(state.seats[0]!.vel.x).toBeLessThan(400);
    expect(state.seats[0]!.vel.x).toBeGreaterThan(0);
  });
});

describe("mid-match join and leave", () => {
  it("suspends play but keeps the score when a side empties", () => {
    const state = liveState();
    state.scores = [5, 3];
    removeSeat(state, "b");
    suspendPlay(state);
    expect(state.status).toBe("waiting");
    expect(state.scores).toEqual([5, 3]);
    expect(state.live).toBe(false);
  });

  it("resets scores but keeps seats for a rematch", () => {
    const state = liveState();
    state.scores = [11, 4];
    state.status = "gameover";
    state.winner = 0;
    resetScores(state);
    expect(state.scores).toEqual([0, 0]);
    expect(state.winner).toBeNull();
    expect(state.seats).toHaveLength(2);
  });
});

describe("shot viability", () => {
  it("a hard topspin return clears the net and bounces on the receiving side", () => {
    const state = liveState();
    state.lastHitter = 1;
    state.ball.x = 0;
    state.ball.y = 60;
    state.ball.z = PLAYER_Z[0] + 20;
    state.ball.vz = -SHOT_SPEED_Z;
    state.seats[0]!.racket = { x: 0, y: 60 };
    state.seats[0]!.vel = { x: 0, y: 600 };
    for (let t = 0; t < 2 && !state.bouncedSinceHit && state.scores[1] === 0; t += TICK) {
      step(state, TICK, () => 0.5);
    }
    expect(state.scores).toEqual([0, 0]);
    expect(state.bouncedSinceHit).toBe(true);
  });
});

describe("full rally simulation", () => {
  it("a served ball reaches the receiver's hit plane at a playable height", () => {
    const state = seatedState();
    state.status = "playing";
    state.serveTimer = 0.01;
    const receiver = state.seats[1]!;
    // Receiver tracks the ball perfectly so nothing dies en route.
    for (let t = 0; t < 3; t += TICK) {
      receiver.racket.x = state.ball.x;
      receiver.racket.y = Math.max(20, state.ball.y);
      step(state, TICK, () => 0.5);
      if (state.lastHitter === 1) break;
    }
    expect(state.lastHitter).toBe(1);
    expect(state.scores).toEqual([0, 0]);
    expect(state.ball.vz).toBe(-SHOT_SPEED_Z);
    expect(state.ball.z).toBeLessThan(TABLE_LENGTH + MISS_MARGIN);
  });
});
