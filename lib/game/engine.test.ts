import { describe, expect, it } from "vitest";
import {
  BALL_RADIUS,
  COUNTDOWN_SECONDS,
  FLOOR_Y,
  HIT_HEIGHT,
  HOLD_BALL_WINDOW,
  MAX_SPIN,
  MISS_MARGIN,
  NET_HEIGHT,
  NET_Z,
  PLAYER_Z,
  POWER_BOOST,
  RACKET_VEL_DECAY,
  RENDER_LAG_TICKS,
  SERVE_DELAY,
  SHOT_SPEED_Z,
  SPIN_AIR_DECAY,
  SPIN_CARRY,
  SPIN_FACTOR,
  TABLE_LENGTH,
  TABLE_WIDTH,
  WIN_SCORE,
} from "./constants";
import {
  addSeat,
  allReady,
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

describe("ready check", () => {
  it("is ready only when both sides are manned and all players pressed", () => {
    const state = seatedState();
    expect(allReady(state)).toBe(false);
    state.seats[0]!.ready = true;
    expect(allReady(state)).toBe(false);
    state.seats[1]!.ready = true;
    expect(allReady(state)).toBe(true);
    removeSeat(state, "b");
    expect(allReady(state)).toBe(false);
  });

  it("clears ready flags on a score reset so a rematch needs new consent", () => {
    const state = seatedState();
    state.seats.forEach((s) => (s.ready = true));
    resetScores(state);
    expect(state.seats.every((s) => !s.ready)).toBe(true);
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

  it("serves flat and spinless when the racket is still", () => {
    const state = seatedState();
    state.status = "playing";
    state.live = false;
    state.serveTimer = 0.01;
    step(state, TICK);
    expect(state.live).toBe(true);
    expect(state.ball.vz).toBe(SHOT_SPEED_Z);
    expect(state.ball.spinTop).toBe(0);
    expect(state.ball.spinSide).toBe(0);
  });

  // Steps the match forward after a serve and reports whether the serve
  // bounced on the receiving side before any point was scored.
  const serveLandsIn = (state: GameState): boolean => {
    for (let t = 0; t < 3; t += TICK) {
      step(state, TICK);
      if (state.bouncedSinceHit) return true;
      if (state.scores[0] !== 0 || state.scores[1] !== 0) return false;
    }
    return false;
  };

  it("styles the serve with spin from a moving racket, still landing in", () => {
    const state = seatedState();
    state.status = "playing";
    state.live = false;
    state.serveTimer = 0.01;
    state.seats[0]!.vel = { x: 0, y: 600 };
    step(state, TICK);
    expect(state.live).toBe(true);
    expect(state.ball.vz).toBe(SHOT_SPEED_Z);
    expect(state.ball.spinTop).toBeGreaterThan(0);
    expect(serveLandsIn(state)).toBe(true);
  });

  it("keeps an extreme swipe serve legal by scaling the spin down", () => {
    const state = seatedState();
    state.status = "playing";
    state.live = false;
    state.serveTimer = 0.01;
    state.seats[0]!.vel = { x: 900, y: -900 };
    step(state, TICK);
    expect(state.live).toBe(true);
    // A serve never gains raw power from the swipe; a chopped one gives some up.
    expect(state.ball.vz).toBeLessThan(SHOT_SPEED_Z);
    expect(state.ball.spinTop).toBeLessThan(0);
    expect(serveLandsIn(state)).toBe(true);
  });

  it("delivers a heavy chopped serve at full backspin rather than scaling it away", () => {
    // A backspin serve used to be launched higher (symmetric lift tilt) and
    // then floated by the Magnus term, so its pre-simulated flight always ran
    // past the far baseline and the scale ladder cut the spin down. Pushed
    // flat and slow instead, the same chop is legal at full strength.
    const state = seatedState();
    state.status = "playing";
    state.live = false;
    state.serveTimer = 0.01;
    state.seats[0]!.vel = { x: 0, y: -900 };
    step(state, TICK);
    expect(state.live).toBe(true);
    expect(state.ball.spinTop).toBeCloseTo(-MAX_SPIN, 6);
    expect(state.ball.vz).toBeLessThan(SHOT_SPEED_Z);
    expect(serveLandsIn(state)).toBe(true);
  });

  it("keeps every served spin honest: what serveIsLegal predicts, the ball does", () => {
    // serveIsLegal pre-simulates the flight to pick a spin scale, and that
    // simulation has to decay spin exactly as `step` does. If the two drift,
    // a serve passed as legal flies long (or legal spin gets needlessly
    // scaled away), so sweep the swipe space and check every serve lands in.
    for (const x of [-900, -450, 0, 450, 900]) {
      for (const y of [-900, -450, 0, 450, 900]) {
        const state = seatedState();
        state.status = "playing";
        state.live = false;
        state.serveTimer = 0.01;
        state.seats[0]!.vel = { x, y };
        step(state, TICK);
        expect(state.live).toBe(true);
        expect(serveLandsIn(state)).toBe(true);
      }
    }

    // ...and it must not be over-cautious either. A pre-sim that forgot to
    // decay would over-predict the curve, judge this ordinary swipe illegal
    // and quietly serve it at a lower spin scale instead.
    const state = seatedState();
    state.status = "playing";
    state.live = false;
    state.serveTimer = 0.01;
    state.seats[0]!.vel = { x: 0, y: 600 };
    step(state, TICK);
    const swipeAtContact = 600 * (1 - RACKET_VEL_DECAY * TICK);
    expect(state.ball.spinTop).toBeCloseTo(swipeAtContact * SPIN_FACTOR, 6);
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

  it("ends the point on the second bounce on the receiving side", () => {
    const state = liveState();
    state.lastHitter = 0;
    state.bouncedSinceHit = true;
    state.ball.z = NET_Z + 120;
    state.ball.y = BALL_RADIUS + 1;
    state.ball.vy = -300;
    state.ball.vz = 40;
    step(state, TICK);
    // The receivers never returned the first bounce: the hitter scores.
    expect(state.scores).toEqual([1, 0]);
    expect(state.live).toBe(false);
  });

  it("resolves the point when the ball is too weak to bounce (rolling)", () => {
    const state = liveState();
    state.lastHitter = 0;
    state.ball.z = NET_Z + 120;
    state.ball.y = BALL_RADIUS + 1;
    state.ball.vy = -60;
    state.ball.vz = 40;
    step(state, TICK);
    // Landed on the receiving side, then died rolling: the hitter scores.
    expect(state.scores).toEqual([1, 0]);
    expect(state.live).toBe(false);
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

  it("does not return balls off the handle below the blade", () => {
    const state = liveState();
    state.lastHitter = 1;
    state.ball.x = 0;
    state.ball.y = 50;
    state.ball.z = PLAYER_Z[0] + 20;
    state.ball.vz = -SHOT_SPEED_Z;
    // Blade centre ~50 above the ball: only the handle overlaps it.
    state.seats[0]!.racket = { x: 0, y: 100 };
    step(state, TICK);
    expect(state.ball.vz).toBe(-SHOT_SPEED_Z);
  });

  it("keeps full reach above the blade centre", () => {
    const state = liveState();
    state.lastHitter = 1;
    state.ball.x = 0;
    state.ball.y = 90;
    state.ball.z = PLAYER_Z[0] + 20;
    state.ball.vz = -SHOT_SPEED_Z;
    state.seats[0]!.racket = { x: 0, y: 40 };
    step(state, TICK);
    expect(state.ball.vz).toBe(SHOT_SPEED_Z);
  });

  // Regression: balls crossing fast out by the sidelines used to phase through
  // the blade. The client draws the ball a couple of ticks behind the server,
  // so a racket put exactly where the ball looked was compared against a ball
  // that had already travelled on — harmless head-on, but out at the edges the
  // lateral speed turned that delay into a clean miss.
  describe("edge phasing", () => {
    // Ball crossing the sideline area at speed, racket placed on the ball as
    // the client drew it RENDER_LAG_TICKS ago.
    const edgeSwing = (racketX: number): GameState => {
      const state = liveState();
      state.lastHitter = 1;
      state.ball.y = 50;
      state.ball.vy = 0;
      state.ball.vx = 900;
      state.ball.vz = -SHOT_SPEED_Z;
      state.ball.x = 200;
      state.ball.z = PLAYER_Z[0] - 8;
      state.seats[0]!.racket = { x: racketX, y: 50 };
      // Newest first, 30 units of x and 18 of z per tick. The server ends this
      // tick with the ball at x=230; two ticks back — what the client drew —
      // it was at x=170, a clear 60 wide of that.
      const trail = [0, 1, 2].map((k) => ({
        ...state.ball,
        x: 200 - k * 30,
        z: PLAYER_Z[0] - 8 + k * 18,
      }));
      step(state, TICK, () => 0.5, trail);
      return state;
    };

    it("connects on a ball out at the table edge, where the player saw it", () => {
      const state = edgeSwing(170);
      expect(state.ball.vz).toBe(SHOT_SPEED_Z);
      expect(state.lastHitter).toBe(0);
    });

    it("still misses a ball genuinely out of reach at the edge", () => {
      // Same swing, but the racket is a blade-width too far inside even of
      // where the ball was drawn.
      const state = edgeSwing(90);
      expect(state.ball.vz).toBe(-SHOT_SPEED_Z);
      expect(state.lastHitter).toBe(1);
    });
  });

  it("lag compensation: a lagged seat hits the ball where it saw it", () => {
    const state = liveState();
    state.lastHitter = 1;
    // The ball has already flown past the hit window at the server's clock...
    state.ball.x = 0;
    state.ball.y = 60;
    state.ball.z = PLAYER_Z[0] - 28;
    state.ball.vz = -SHOT_SPEED_Z;
    state.seats[0]!.racket = { x: 0, y: 60 };
    state.seats[0]!.lagTicks = 2;
    // ...but two ticks ago it was right on the racket.
    const past = { ...state.ball, z: PLAYER_Z[0] };
    const trail = [{ ...state.ball, z: PLAYER_Z[0] - 18 }, past];
    step(state, TICK, () => 0.5, trail);
    expect(state.ball.vz).toBe(SHOT_SPEED_Z);
    expect(state.lastHitter).toBe(0);
  });

  it("compensation is bounded: a swing older than the seat's lookback misses", () => {
    // A ball crossing fast sideways, with the racket parked where it was four
    // ticks ago. A seat on a clean connection looks back RENDER_LAG_TICKS and
    // cannot reach that far; measured ping buys the extra reach.
    const lateSwing = (lagTicks: number): number => {
      const state = liveState();
      state.lastHitter = 1;
      state.ball.x = 200;
      state.ball.y = 60;
      state.ball.z = PLAYER_Z[0] + 10;
      state.ball.vx = 600;
      state.ball.vz = -SHOT_SPEED_Z;
      state.seats[0]!.racket = { x: 0, y: 60 };
      state.seats[0]!.lagTicks = lagTicks;
      const trail = [1, 2, 3, 4].map((k) => ({
        ...state.ball,
        x: 200 - k * 50,
        z: PLAYER_Z[0],
      }));
      step(state, TICK, () => 0.5, trail);
      return state.ball.vz;
    };
    expect(RENDER_LAG_TICKS).toBe(2);
    // Two ticks back the ball was still 100 wide of the blade.
    expect(lateSwing(0)).toBe(-SHOT_SPEED_Z);
    // Four ticks back it was right on it.
    expect(lateSwing(2)).toBe(SHOT_SPEED_Z);
  });

  // The spin already on the ball fights the blade, so a return is shaped by
  // what the opponent put on it, not just by the hitter's own swipe.
  describe("receiving spin", () => {
    // Side 0 returns a ball arriving with the given spin, with the racket
    // swiping at the given velocity. Returns the launched ball.
    const returnOf = (spinSide: number, spinTop: number, vel = { x: 0, y: 0 }) => {
      const state = liveState();
      state.lastHitter = 1;
      state.ball.x = 0;
      state.ball.y = 50;
      state.ball.z = PLAYER_Z[0] + 20;
      state.ball.vy = 0;
      state.ball.vz = -SHOT_SPEED_Z;
      state.ball.spinSide = spinSide;
      state.ball.spinTop = spinTop;
      state.seats[0]!.racket = { x: 0, y: 50 };
      state.seats[0]!.vel = { ...vel };
      step(state, TICK, () => 0.5);
      expect(state.lastHitter).toBe(0);
      return { ...state.ball };
    };

    it("kicks the return up off an incoming topspin ball", () => {
      expect(returnOf(0, MAX_SPIN).vy).toBeGreaterThan(returnOf(0, 0).vy);
    });

    it("drops the return of an incoming backspin ball", () => {
      expect(returnOf(0, -MAX_SPIN).vy).toBeLessThan(returnOf(0, 0).vy);
    });

    it("deflects the return the way the incoming side spin was curving", () => {
      const flat = returnOf(0, 0).vx;
      // Arriving at side 0, positive side spin bends the ball toward -x, and
      // the return is pushed along with it — by far more than the contact
      // point alone drifts during the tick.
      expect(flat - returnOf(MAX_SPIN, 0).vx).toBeGreaterThan(40);
      expect(returnOf(-MAX_SPIN, 0).vx - flat).toBeGreaterThan(40);
    });

    it("mirrors the deflection for the player on the far side", () => {
      // Side 1 receives the same spin travelling the other way, so the same
      // side spin must push its return the opposite way.
      const forSide1 = (spinSide: number): number => {
        const state = liveState();
        state.lastHitter = 0;
        state.ball.x = 0;
        state.ball.y = 50;
        state.ball.z = PLAYER_Z[1] - 20;
        state.ball.vy = 0;
        state.ball.vz = SHOT_SPEED_Z;
        state.ball.spinSide = spinSide;
        state.seats[1]!.racket = { x: 0, y: 50 };
        step(state, TICK, () => 0.5);
        expect(state.lastHitter).toBe(1);
        return state.ball.vx;
      };
      expect(forSide1(MAX_SPIN) - forSide1(0)).toBeGreaterThan(40);
    });

    it("lets a deliberate counter-swipe cancel the incoming lift", () => {
      const flat = returnOf(0, 0).vy;
      const uncountered = returnOf(0, MAX_SPIN).vy;
      // Swiping up brushes the hitter's own topspin on, which launches flatter
      // (SPIN_LIFT_TILT) and pays back what the incoming ball added — all but
      // a sliver of it, the ball having shed a little spin on the way in.
      const countered = returnOf(0, MAX_SPIN, { x: 0, y: 630 }).vy;
      expect(uncountered).toBeGreaterThan(flat);
      expect(Math.abs(countered - flat)).toBeLessThan(Math.abs(uncountered - flat) * 0.1);
    });

    it("carries part of the incoming spin back, negating only the topspin", () => {
      // A still bat does not stop the ball rotating. The two axes are stored
      // differently against the direction of travel, so a conserved rotation
      // carries with opposite signs: spinTop has to be negated by hand, while
      // spinSide is already travel-relative and keeps its value.
      // The ball spends one tick in the air before contact, so what the blade
      // meets is already one step of SPIN_AIR_DECAY down from MAX_SPIN.
      const atContact = MAX_SPIN * (1 - SPIN_AIR_DECAY * TICK);
      expect(returnOf(0, MAX_SPIN).spinTop).toBeLessThan(-50);
      expect(returnOf(0, MAX_SPIN).spinTop).toBeCloseTo(-atContact * SPIN_CARRY, 6);
      expect(returnOf(MAX_SPIN, 0).spinSide).toBeGreaterThan(50);
      expect(returnOf(MAX_SPIN, 0).spinSide).toBeCloseTo(atContact * SPIN_CARRY, 6);
      // The hitter's own swipe spin is added on top of that carry.
      const swiped = returnOf(0, MAX_SPIN, { x: 0, y: 630 }).spinTop;
      expect(swiped).toBeGreaterThan(-MAX_SPIN * SPIN_CARRY);
    });

    it("flips which way a blocked side-spin ball bends", () => {
      // The world-frame consequence of carrying spinSide unchanged: the return
      // travels the other way, so the same stored spin now curves it the
      // opposite way. Getting this sign wrong makes a blocked ball keep
      // hooking the way it already was.
      const state = liveState();
      state.lastHitter = 1;
      state.ball.x = 0;
      state.ball.y = 50;
      state.ball.z = PLAYER_Z[0] + 20;
      state.ball.vy = 0;
      state.ball.vz = -SHOT_SPEED_Z;
      // Heading toward side 0, this spin drags the ball toward -x.
      state.ball.spinSide = MAX_SPIN;
      state.seats[0]!.racket = { x: 0, y: 50 };
      step(state, TICK, () => 0.5);
      expect(state.lastHitter).toBe(0);
      expect(state.ball.spinSide).toBeGreaterThan(0);
      // Now heading back, the carried spin must bend it toward +x instead.
      const vxAtLaunch = state.ball.vx;
      step(state, TICK, () => 0.5);
      expect(state.ball.vx).toBeGreaterThan(vxAtLaunch);
    });

    it("keeps a flat return of a maximum-spin ball playable", () => {
      // Heavy spin must perturb a dead-bat return, never win the point outright.
      for (const [spinSide, spinTop] of [
        [0, MAX_SPIN],
        [0, -MAX_SPIN],
        [MAX_SPIN, 0],
        [-MAX_SPIN, 0],
      ]) {
        const state = liveState();
        state.lastHitter = 1;
        state.ball.x = 0;
        state.ball.y = 50;
        state.ball.z = PLAYER_Z[0] + 20;
        state.ball.vy = 0;
        state.ball.vz = -SHOT_SPEED_Z;
        state.ball.spinSide = spinSide!;
        state.ball.spinTop = spinTop!;
        state.seats[0]!.racket = { x: 0, y: 50 };
        step(state, TICK, () => 0.5);
        expect(state.lastHitter).toBe(0);
        // The return must land on the far half rather than fly out or net.
        let landed: { x: number; z: number } | null = null;
        for (let i = 0; i < 120 && landed === null; i++) {
          const before = { ...state.ball };
          step(state, TICK, () => 0.5);
          if (state.bouncedSinceHit) landed = { x: before.x, z: before.z };
          if (state.scores[0] !== 0 || state.scores[1] !== 0) break;
        }
        expect(landed).not.toBeNull();
        expect(landed!.z).toBeGreaterThan(NET_Z);
        expect(landed!.z).toBeLessThan(TABLE_LENGTH);
        expect(Math.abs(landed!.x)).toBeLessThan(TABLE_WIDTH / 2);
      }
    });

    it("bleeds spin off the ball while it flies", () => {
      // Parked high above the table with no z travel, so nothing but air drag
      // touches the rotation — no bounce, no net, no racket.
      const state = liveState();
      state.ball.x = 0;
      state.ball.y = 1200;
      state.ball.z = NET_Z;
      state.ball.vx = 0;
      state.ball.vy = 0;
      state.ball.vz = 0;
      state.ball.spinTop = MAX_SPIN;
      state.ball.spinSide = MAX_SPIN;
      for (let t = 0; t < 1; t += TICK) step(state, TICK);
      // A second in the air is a little under one half-life (~1.15 s).
      expect(state.ball.spinTop).toBeLessThan(MAX_SPIN * 0.6);
      expect(state.ball.spinTop).toBeGreaterThan(MAX_SPIN * 0.4);
      // Both axes drag alike.
      expect(state.ball.spinSide).toBeCloseTo(state.ball.spinTop, 6);
    });

    it("gives a ball that has floated a full crossing less bite than a fresh one", () => {
      // Same spin at launch, but this one flies the length of the table first,
      // staying high so only the air — not a bounce — takes spin off it.
      const state = liveState();
      state.lastHitter = 1;
      state.ball.x = 0;
      state.ball.y = 200;
      state.ball.z = PLAYER_Z[1] - 10;
      state.ball.vx = 0;
      state.ball.vy = 700;
      state.ball.vz = -SHOT_SPEED_Z;
      state.ball.spinTop = MAX_SPIN;
      // Out of reach until it arrives.
      state.seats[0]!.racket = { x: 9999, y: 0 };
      let ticks = 0;
      while (state.ball.z > PLAYER_Z[0] + 20 && ticks < 120) {
        step(state, TICK, () => 0.5);
        ticks += 1;
      }
      const spinOnArrival = state.ball.spinTop;
      expect(state.bouncedSinceHit).toBe(false);
      expect(spinOnArrival).toBeLessThan(MAX_SPIN * 0.65);
      // Put the bat on it and return it.
      state.seats[0]!.racket = { x: state.ball.x, y: state.ball.y };
      step(state, TICK, () => 0.5);
      expect(state.lastHitter).toBe(0);
      // Less spin left means less of a kick off the blade than a fresh ball.
      expect(state.ball.vy).toBeLessThan(returnOf(0, MAX_SPIN).vy);
      // ...but the return still carries the reversed remnant of it.
      expect(state.ball.spinTop).toBeLessThan(0);
    });

    it("leaves the serve untouched by spin left on the previous ball", () => {
      // Serves are held fresh and simulate flight only, so the contact model
      // never reaches them.
      const state = seatedState();
      state.status = "playing";
      state.live = false;
      state.serveTimer = 0.01;
      state.ball.spinSide = MAX_SPIN;
      state.ball.spinTop = -MAX_SPIN;
      step(state, TICK);
      expect(state.live).toBe(true);
      expect(state.ball.vz).toBe(SHOT_SPEED_Z);
      expect(state.ball.spinSide).toBe(0);
      expect(state.ball.spinTop).toBe(0);
    });
  });

  it("keeps the whole probe window usable, not just up to MISS_MARGIN", () => {
    // The probe trails the live ball by the same lookback the hit checks use,
    // so the dead-ball grace has to cover it. If it only covered measured
    // ping, a ball on a clean connection would be killed while its probe was
    // still on the blade — the tail of every player's window.
    const fast = SHOT_SPEED_Z * 1.5;
    const state = liveState();
    state.lastHitter = 1;
    state.bouncedSinceHit = true;
    state.ball.x = 0;
    state.ball.y = 50;
    state.ball.vy = 0;
    state.ball.vz = -fast;
    state.seats[0]!.racket = { x: 0, y: 50 };
    const seen = (x: number, z: number) => ({ ...state.ball, x, y: 50, z });

    // Tick one: already past MISS_MARGIN, and this tick's probe is wide of the
    // blade, so nothing connects. The ball must survive anyway.
    state.ball.z = PLAYER_Z[0] - 38;
    step(state, TICK, () => 0.5, [
      seen(0, PLAYER_Z[0] - 38),
      seen(300, PLAYER_Z[0] - 11),
    ]);
    expect(state.scores).toEqual([0, 0]);

    // Tick two: the probe has caught up to the racket and the return lands.
    step(state, TICK, () => 0.5, [
      seen(0, PLAYER_Z[0] - 65),
      seen(0, PLAYER_Z[0] - 38),
    ]);
    expect(state.lastHitter).toBe(0);
    expect(state.scores).toEqual([0, 0]);
  });

  it("reads the spin off the probed snapshot, not the live ball", () => {
    // Contact is judged against the ball the player saw, so the spin the blade
    // meets has to come from that same snapshot. The live ball has flown on
    // and shed spin to SPIN_AIR_DECAY since.
    const state = liveState();
    state.lastHitter = 1;
    state.ball.x = 0;
    state.ball.y = 50;
    state.ball.z = PLAYER_Z[0] - 20;
    state.ball.vy = 0;
    state.ball.vz = -SHOT_SPEED_Z;
    // The live ball has no spin left at all...
    state.ball.spinTop = 0;
    state.seats[0]!.racket = { x: 0, y: 50 };
    // ...but two ticks ago, where this player struck it, it was loaded.
    const trail = [
      { ...state.ball, z: PLAYER_Z[0] - 20, spinTop: 0 },
      { ...state.ball, z: PLAYER_Z[0], spinTop: MAX_SPIN },
    ];
    step(state, TICK, () => 0.5, trail);
    expect(state.lastHitter).toBe(0);
    // Reading the live ball would have carried nothing back.
    expect(state.ball.spinTop).toBeCloseTo(-MAX_SPIN * SPIN_CARRY, 6);
  });

  it("keeps the ball alive past the plane while a lagged hit could connect", () => {
    const state = liveState();
    state.lastHitter = 1;
    state.bouncedSinceHit = true;
    state.ball.z = PLAYER_Z[0] - MISS_MARGIN - 30;
    state.ball.y = 60;
    state.ball.vz = -SHOT_SPEED_Z;
    state.seats[0]!.lagTicks = 8;
    step(state, TICK);
    expect(state.scores).toEqual([0, 0]);
    state.seats[0]!.lagTicks = 0;
    step(state, TICK);
    expect(state.scores).toEqual([0, 1]);
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

/**
 * How far past a racket plane a ball travelling at SHOT_SPEED_Z has to be
 * before it is unambiguously dead. Beyond MISS_MARGIN a side still keeps the
 * grace window its hit checks look back through, so a fixture that wants a
 * dead ball has to clear both.
 */
const DEAD_PAST_PLANE = MISS_MARGIN + RENDER_LAG_TICKS * TICK * SHOT_SPEED_Z + 1;

describe("scoring", () => {
  it("awards the hitting side when a bounced shot flies past the receivers", () => {
    const state = liveState();
    state.lastHitter = 0;
    state.bouncedSinceHit = true;
    state.ball.z = PLAYER_Z[1] + DEAD_PAST_PLANE;
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
    state.ball.z = PLAYER_Z[1] + DEAD_PAST_PLANE;
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
    state.ball.z = PLAYER_Z[1] + DEAD_PAST_PLANE;
    state.ball.y = 60;
    state.ball.vz = SHOT_SPEED_Z;
    step(state, TICK);
    expect(state.status).toBe("gameover");
    expect(state.winner).toBe(0);
    expect(state.live).toBe(false);
  });

  // Awards a point to `to` by flying the ball dead past the loser's plane.
  const scoreFor = (state: GameState, to: 0 | 1): void => {
    state.status = "playing";
    state.live = true;
    state.lastHitter = to;
    state.bouncedSinceHit = true;
    state.ball.z = to === 0 ? PLAYER_Z[1] + DEAD_PAST_PLANE : PLAYER_Z[0] - DEAD_PAST_PLANE;
    state.ball.y = 60;
    state.ball.vy = 0;
    state.ball.vz = to === 0 ? SHOT_SPEED_Z : -SHOT_SPEED_Z;
    step(state, TICK);
  };

  it("deuce: 11-10 does not end the game, a two-point margin does", () => {
    const state = liveState();
    state.scores = [10, 10];
    scoreFor(state, 0);
    expect(state.scores).toEqual([11, 10]);
    expect(state.status).toBe("playing");
    scoreFor(state, 0);
    expect(state.scores).toEqual([12, 10]);
    expect(state.status).toBe("gameover");
    expect(state.winner).toBe(0);
  });

  it("rotates the serve between teammates on a duo side", () => {
    const state = liveState();
    addSeat(state, 0, "a2");
    const first = state.seats[0]!;
    const second = state.seats.find((s) => s.id === "a2")!;
    first.racket.x = -75;
    second.racket.x = 75;
    // Side 1 scores twice; side 0 serves both times, alternating players.
    scoreFor(state, 1);
    expect(state.server).toBe(0);
    // The dead ball coasts through the first part of the serve delay; it only
    // lands on the serving player's racket once the hold window opens.
    state.serveTimer = HOLD_BALL_WINDOW;
    step(state, TICK);
    const firstServeX = state.ball.x;
    scoreFor(state, 1);
    state.serveTimer = HOLD_BALL_WINDOW;
    step(state, TICK);
    const secondServeX = state.ball.x;
    expect([firstServeX, secondServeX].sort()).toEqual([-75, 75]);
  });
});

describe("dead ball flight", () => {
  /** Scores for side 0 with the ball still travelling, and returns the state. */
  const pointJustEnded = (): GameState => {
    const state = liveState();
    state.seats[0]!.racket.x = -90;
    state.lastHitter = 0;
    state.bouncedSinceHit = true;
    state.ball.x = 40;
    state.ball.y = 70;
    state.ball.z = PLAYER_Z[1] + DEAD_PAST_PLANE;
    state.ball.vx = 20;
    state.ball.vy = -100;
    state.ball.vz = SHOT_SPEED_Z;
    step(state, TICK);
    expect(state.scores).toEqual([1, 0]);
    expect(state.live).toBe(false);
    return state;
  };

  /**
   * Steps up to — but never into — the serve hold window, so callers can assert
   * on the coast itself. The loop guard subtracts a tick because the condition
   * is tested before the step, and one more step would park the ball.
   */
  const coastToHoldWindow = (state: GameState, check?: () => void): void => {
    while (state.serveTimer - TICK > HOLD_BALL_WINDOW) {
      step(state, TICK);
      expect(state.live).toBe(false);
      check?.();
    }
  };

  it("lets the ball fly on after a point instead of snapping it to the server", () => {
    const state = pointJustEnded();
    // The point is over, but the ball is mid-air: it has to finish its arc,
    // not teleport onto the next server's racket the very next tick.
    expect(state.ball.vz).toBeGreaterThan(0);
    const before = { ...state.ball };
    step(state, TICK);
    expect(state.ball.z).toBeGreaterThan(before.z);
    expect(state.ball.y).toBeLessThan(before.y);
    expect(state.ball.x).not.toBe(state.seats[1]!.racket.x);
  });

  it("parks the ball on the server's racket once the hold window opens", () => {
    const state = pointJustEnded();
    const server = state.seats.find((s) => s.side === state.server)!;
    server.racket.x = 62;
    coastToHoldWindow(state);
    expect(state.ball.x).not.toBeCloseTo(62, 6);
    expect(state.coasting).toBe(true);
    // Crossing into the hold window: the serve is visibly held from here on.
    step(state, TICK);
    expect(state.coasting).toBe(false);
    expect(state.ball.x).toBe(62);
    expect(state.ball.z).toBe(TABLE_LENGTH);
    expect(state.ball.vz).toBe(0);
    expect(state.ball.spinTop).toBe(0);
  });

  it("never scores again off the coasting ball", () => {
    const state = pointJustEnded();
    // Aim the dead ball back through the table and both racket planes: every
    // path that could award a point has to be inert while it coasts.
    state.ball.vz = -SHOT_SPEED_Z * 2;
    state.ball.vy = -400;
    while (state.serveTimer > TICK) step(state, TICK);
    expect(state.scores).toEqual([1, 0]);
    expect(state.netTouched).toBe(false);
    expect(state.lastHitter).toBeNull();
  });

  it("settles the coasting ball rather than dropping it forever", () => {
    const state = pointJustEnded();
    state.ball.vy = -600;
    coastToHoldWindow(state, () => {
      expect(state.ball.y).toBeGreaterThanOrEqual(FLOOR_Y);
    });
  });

  it("stops the coasting ball receding before it reaches the camera", () => {
    // The client projects from behind the viewer's own end, dividing by the
    // distance to the camera. A dead ball that kept a full-speed vz for the
    // whole serve delay would swell across the canvas and then turn inside
    // out as it passed the lens, so it has to stop receding and drop.
    for (const dir of [1, -1]) {
      const state = pointJustEnded();
      state.ball.z = dir === 1 ? PLAYER_Z[1] : PLAYER_Z[0];
      state.ball.vz = dir * SHOT_SPEED_Z * 1.5;
      state.ball.vy = 0;
      coastToHoldWindow(state, () => {
        expect(state.ball.z).toBeGreaterThan(PLAYER_Z[0] - MISS_MARGIN * 4);
        expect(state.ball.z).toBeLessThan(PLAYER_Z[1] + MISS_MARGIN * 4);
      });
    }
  });

  it("never pops the coasting ball up through the table top", () => {
    // A ball that has already fallen below the table and drifts back over its
    // footprint must keep going down to the floor: the table is a surface
    // only to a ball arriving on it from above.
    const state = pointJustEnded();
    state.ball.x = TABLE_WIDTH / 2 + 20;
    state.ball.y = FLOOR_Y + 30;
    state.ball.z = NET_Z;
    state.ball.vx = -200;
    state.ball.vy = -10;
    state.ball.vz = 0;
    coastToHoldWindow(state, () => {
      expect(state.ball.y).toBeLessThan(0);
    });
    expect(Math.abs(state.ball.x)).toBeLessThan(TABLE_WIDTH / 2);
  });

  it("leaves a settled ball lying where it stopped until the hold window", () => {
    // Zeroing the velocity on settling must not read as "nothing to coast" —
    // that would teleport the ball into the server's hand the moment it came
    // to rest, and the rest position would never be seen.
    const state = pointJustEnded();
    state.ball.vx = 0;
    state.ball.vy = 0;
    state.ball.vz = 0;
    state.ball.y = FLOOR_Y + BALL_RADIUS;
    const settled = { ...state.ball };
    coastToHoldWindow(state, () => {
      expect(state.coasting).toBe(true);
      expect(state.ball.x).toBe(settled.x);
      expect(state.ball.y).toBe(settled.y);
      expect(state.ball.z).toBe(settled.z);
    });
    step(state, TICK);
    expect(state.coasting).toBe(false);
    expect(state.ball.y).toBe(HIT_HEIGHT);
  });

  it("parks the ball when play is suspended mid-coast", () => {
    // A player dropping out during the coast would otherwise strand the dead
    // ball in mid-air for the whole of the next countdown.
    const state = pointJustEnded();
    step(state, TICK);
    expect(state.coasting).toBe(true);
    suspendPlay(state);
    expect(state.coasting).toBe(false);
    expect(state.ball.y).toBe(HIT_HEIGHT);
    expect(state.ball.z).toBe(TABLE_LENGTH);
    expect(state.ball.vz).toBe(0);
  });

  it("still freezes the ball when the game ends", () => {
    const state = liveState();
    state.scores = [WIN_SCORE - 1, 0];
    state.lastHitter = 0;
    state.bouncedSinceHit = true;
    state.ball.y = 70;
    state.ball.z = PLAYER_Z[1] + DEAD_PAST_PLANE;
    state.ball.vz = SHOT_SPEED_Z;
    step(state, TICK);
    expect(state.status).toBe("gameover");
    const resting = { ...state.ball };
    step(state, TICK);
    expect(state.ball).toEqual(resting);
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

  it("takes pace off a chopped shot but never off a topspin one", () => {
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
      return state.ball.vz;
    };
    // A chop is a slow, floating ball: the harder it is chopped, the less
    // forward speed it keeps. Without this the float alone carried every
    // chopped return past the far baseline.
    expect(hit(-900)).toBeLessThan(hit(-300));
    expect(hit(-300)).toBeLessThan(hit(0));
    // Topspin and flat shots are untouched — a fast upward swipe still drives.
    expect(hit(0)).toBe(SHOT_SPEED_Z);
    expect(hit(900)).toBeGreaterThan(SHOT_SPEED_Z);
  });

  it("never lets a chop outpace a flat push, however fast the swipe", () => {
    const vzOf = (velX: number, velY: number): number => {
      const state = liveState();
      state.lastHitter = 1;
      state.ball.x = 20;
      state.ball.y = 50;
      state.ball.z = PLAYER_Z[0] + 20;
      state.ball.vz = -SHOT_SPEED_Z;
      state.seats[0]!.racket = { x: 25, y: 55 };
      state.seats[0]!.vel = { x: velX, y: velY };
      step(state, TICK);
      return state.ball.vz;
    };
    // Stripping only the downward part of the swipe left a loophole: a chop
    // swung mostly sideways kept the full power boost and left the blade
    // faster than a flat push, which is the opposite of what a chop does.
    for (const velX of [0, 450, 900, -900]) {
      expect(vzOf(velX, -900)).toBeLessThan(SHOT_SPEED_Z);
      // And a chop is always slower than the same swing without it.
      expect(vzOf(velX, -900)).toBeLessThan(vzOf(velX, 0));
    }
  });

  it("brakes the bounce with backspin, harder the heavier the chop", () => {
    const bounceVz = (spinTop: number): number => {
      const state = liveState();
      state.ball.z = NET_Z + 60;
      state.ball.y = BALL_RADIUS + 1;
      state.ball.vy = -300;
      state.ball.vz = 400;
      state.ball.spinTop = spinTop;
      step(state, TICK);
      return state.ball.vz;
    };
    expect(bounceVz(-MAX_SPIN)).toBeLessThan(bounceVz(-200));
    expect(bounceVz(-200)).toBeLessThan(bounceVz(0));
  });

  it("lands a chopped return on the receiving side across the chop range", () => {
    // The player-visible symptom of the old symmetric lift: a chop of any real
    // strength flew long, so backspin only ever lost points. Sweep contact
    // heights against chop strengths and require every return to bounce in.
    /**
     * Plays out one return, reporting whether it bounced on the receiving side
     * and how far up the table it carried — `carryZ` being the z at which it
     * first descends through table height, which measures length alone.
     * (Where a *dead* ball ends up is no use here: one that misses the table
     * sideways keeps going, so it always "reaches" further than one that
     * bounced, whatever its pace.)
     */
    const shot = (
      contactY: number,
      velX: number,
      velY: number,
    ): { landedIn: boolean; carryZ: number } => {
      const state = liveState();
      state.lastHitter = 1;
      state.bouncedSinceHit = true;
      state.ball.x = 0;
      state.ball.y = contactY;
      state.ball.z = PLAYER_Z[0] + 20;
      state.ball.vz = -SHOT_SPEED_Z;
      state.seats[0]!.racket = { x: 0, y: contactY };
      state.seats[0]!.vel = { x: velX, y: velY };
      // Park the receiver out of reach so only the flight is under test.
      state.seats[1]!.racket = { x: 900, y: 900 };
      step(state, TICK);
      if (velY < 0) expect(state.ball.spinTop).toBeLessThan(0);
      let carryZ = NaN;
      for (let t = 0; t < 3; t += TICK) {
        const prevY = state.ball.y;
        step(state, TICK);
        // First descent to table height, whether or not the table is under it.
        if (Number.isNaN(carryZ) && prevY > BALL_RADIUS && state.ball.y <= BALL_RADIUS) {
          carryZ = state.ball.z;
        }
        if (state.bouncedSinceHit && state.ball.z > NET_Z) return { landedIn: true, carryZ };
        if (state.scores[0] !== 0 || state.scores[1] !== 0) {
          return { landedIn: false, carryZ };
        }
      }
      return { landedIn: false, carryZ };
    };

    for (const contactY of [20, 40, 80, 140]) {
      for (const velY of [-100, -300, -500, -700, -900]) {
        // A straight chop has to land from every sane contact height: this is
        // the shot players were told did nothing, and it faulted long instead.
        expect(
          shot(contactY, 0, velY).landedIn,
          `chop y=${contactY} velY=${velY} did not land in`,
        ).toBe(true);

        // Swung sideways as well — the case that used to keep the full power
        // boost. Length is the axis backspin broke, so length is what is
        // asserted: a chop must never carry the ball further up the table than
        // the same swing without it. Whether a violent sideways swipe lands is
        // a question of aim, and a floatier ball curving further off the side
        // is the side spin doing its job, not the chop failing.
        //
        // Carry is sampled once per tick, so the comparison allows one tick of
        // travel at the fastest a shot can leave the blade. The behaviour this
        // guards against overshot by hundreds of units, so the slack is free.
        const slack = SHOT_SPEED_Z * (1 + POWER_BOOST) * TICK;
        for (const velX of [-300, 300, -900, 900]) {
          const flat = shot(contactY, velX, 0);
          const chopped = shot(contactY, velX, velY);
          // A shot that never comes back down inside the simulated window is
          // off the end of the world; there is no length to compare.
          if (Number.isNaN(flat.carryZ) || Number.isNaN(chopped.carryZ)) continue;
          expect(
            chopped.carryZ,
            `chop y=${contactY} velY=${velY} velX=${velX} carried further than flat`,
          ).toBeLessThanOrEqual(flat.carryZ + slack);
        }
      }
    }
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
