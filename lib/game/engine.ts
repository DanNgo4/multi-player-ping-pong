import {
  AIM_FACTOR,
  BALL_RADIUS,
  COUNTDOWN_SECONDS,
  FLOOR_Y,
  GRAVITY,
  HIT_DEPTH,
  HIT_HEIGHT,
  HIT_RADIUS,
  HIT_RADIUS_BELOW,
  MAGNUS_SIDE,
  MAGNUS_TOP,
  MAX_RACKET_SPEED,
  MAX_SIDE_SPEED,
  MAX_SPIN,
  MIN_BOUNCE_VY,
  MISS_MARGIN,
  NET_CORD_DAMP,
  NET_HEIGHT,
  NET_RESTITUTION,
  NET_Z,
  PLAYER_Z,
  POWER_BOOST,
  RACKET_VEL_DECAY,
  SERVE_DELAY,
  SHOT_LIFT,
  SHOT_SPEED_Z,
  SPIN_BOUNCE_KICK,
  SPIN_DECAY_ON_BOUNCE,
  SPIN_FACTOR,
  SPIN_LIFT_TILT,
  TABLE_LENGTH,
  TABLE_RESTITUTION,
  TABLE_WIDTH,
  TICK_HZ,
  WIN_SCORE,
} from "./constants";
import {
  MAX_PLAYERS,
  MAX_SEATS_PER_SIDE,
  type Ball,
  type GameState,
  type PlayerIndex,
  type Seat,
} from "./types";

/** Injectable randomness source so the engine stays deterministic under test. */
export type Rand = () => number;

export function opponent(i: PlayerIndex): PlayerIndex {
  return i === 0 ? 1 : 0;
}

export function sideCount(state: GameState, side: PlayerIndex): number {
  return state.seats.filter((s) => s.side === side).length;
}

export function bothSidesManned(state: GameState): boolean {
  return sideCount(state, 0) > 0 && sideCount(state, 1) > 0;
}

/** Play may start: both sides manned and every seated player pressed ready. */
export function allReady(state: GameState): boolean {
  return bothSidesManned(state) && state.seats.every((s) => s.ready);
}

/** Adds a seat for a joining player; returns it, or null when the side/match is full. */
export function addSeat(state: GameState, side: PlayerIndex, id: string): Seat | null {
  if (state.seats.length >= MAX_PLAYERS) return null;
  const teammates = state.seats.filter((s) => s.side === side);
  if (teammates.length >= MAX_SEATS_PER_SIDE) return null;
  // Start away from an existing teammate so rackets don't stack.
  const first = teammates[0];
  const x = first === undefined ? 0 : first.racket.x <= 0 ? TABLE_WIDTH / 4 : -TABLE_WIDTH / 4;
  const seat: Seat = {
    id,
    side,
    racket: { x, y: HIT_HEIGHT },
    vel: { x: 0, y: 0 },
    lagTicks: 0,
    ready: false,
  };
  state.seats.push(seat);
  return seat;
}

export function removeSeat(state: GameState, id: string): Seat | null {
  const index = state.seats.findIndex((s) => s.id === id);
  if (index === -1) return null;
  const [seat] = state.seats.splice(index, 1);
  return seat ?? null;
}

export function beginCountdown(state: GameState): void {
  state.status = "countdown";
  state.countdown = COUNTDOWN_SECONDS;
}

/** Halts play (a side emptied out) but keeps the score for whoever joins next. */
export function suspendPlay(state: GameState): void {
  state.status = "waiting";
  state.live = false;
  state.countdown = 0;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = 0;
  state.ball.spinSide = 0;
  state.ball.spinTop = 0;
  state.lastHitter = null;
  state.bouncedSinceHit = false;
  state.netTouched = false;
}

/** Fresh game on the same table: scores reset, seats kept. */
export function resetScores(state: GameState): void {
  state.scores = [0, 0];
  state.winner = null;
  state.server = 0;
  state.serveTurns = [0, 0];
  for (const seat of state.seats) seat.ready = false;
  suspendPlay(state);
}

/**
 * Advances the match by dt seconds. Mutates and returns the same state object.
 *
 * `ballTrail` is the recent history of ball positions (index 0 = one tick
 * ago), used for lag compensation: a seat with lagTicks > 0 gets its hit
 * checks run against the ball where it was when that player's screen showed
 * it, so high-ping players hit what they actually saw.
 */
export function step(
  state: GameState,
  dt: number,
  rand: Rand = () => 0.5,
  ballTrail: readonly Ball[] = [],
): GameState {
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

  // Tracked racket velocity fades between input messages, so a racket that
  // stopped moving a while ago imparts no spin.
  const velDecay = Math.max(0, 1 - RACKET_VEL_DECAY * dt);
  for (const seat of state.seats) {
    seat.vel.x *= velDecay;
    seat.vel.y *= velDecay;
  }

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
  // Magnus effect: side spin curves the flight (relative to travel direction),
  // topspin adds dip beyond gravity; backspin (negative) floats the ball.
  const travel = Math.sign(ball.vz) || 1;
  ball.vx += ball.spinSide * MAGNUS_SIDE * travel * dt;
  // Backspin float is halved so a chopped ball hangs but never soars upward.
  ball.vy -= ball.spinTop * MAGNUS_TOP * (ball.spinTop > 0 ? 1 : 0.5) * dt;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.z += ball.vz * dt;

  // Net: interpolate height at the moment the ball crosses the net plane.
  if ((prevZ - NET_Z) * (ball.z - NET_Z) < 0) {
    const t = (NET_Z - prevZ) / (ball.z - prevZ);
    const heightAtNet = prevY + (ball.y - prevY) * t;
    if (heightAtNet <= NET_HEIGHT - BALL_RADIUS) {
      // Blocked: the ball rebounds and drops; the point resolves when it lands.
      ball.z = NET_Z + (prevZ < NET_Z ? -1 : 1) * (BALL_RADIUS + 1);
      ball.y = Math.max(heightAtNet, BALL_RADIUS);
      ball.vz = -ball.vz * NET_RESTITUTION;
      ball.vx *= 0.5;
      ball.vy = Math.min(ball.vy, 0);
      ball.spinSide = 0;
      ball.spinTop = 0;
      state.netTouched = true;
    } else if (heightAtNet <= NET_HEIGHT + BALL_RADIUS) {
      // Net cord: clips the tape and dribbles over — play continues.
      ball.vz *= NET_CORD_DAMP;
      ball.vx *= 0.7;
      ball.vy = Math.max(ball.vy * 0.3, 100);
      ball.spinSide *= 0.3;
      ball.spinTop *= 0.3;
    }
  }

  // Table bounce.
  const overTable =
    ball.z >= 0 && ball.z <= TABLE_LENGTH && Math.abs(ball.x) <= TABLE_WIDTH / 2;
  if (ball.vy < 0 && ball.y <= BALL_RADIUS && overTable) {
    if (state.netTouched) {
      // A net-blocked ball is dead the moment it lands.
      resolveDead(state);
      return state;
    }
    ball.y = BALL_RADIUS;
    ball.vy = -ball.vy * TABLE_RESTITUTION;
    // Topspin bites the table and kicks forward; backspin deadens the bounce.
    ball.vz += travel * ball.spinTop * SPIN_BOUNCE_KICK;
    ball.spinSide *= SPIN_DECAY_ON_BOUNCE;
    ball.spinTop *= SPIN_DECAY_ON_BOUNCE;
    if (state.lastHitter !== null) {
      const side: PlayerIndex = ball.z < NET_Z ? 0 : 1;
      if (side !== state.lastHitter) {
        if (state.bouncedSinceHit) {
          // Second bounce on the receiving side: the return never came, the
          // point is over — no striking back after a double bounce.
          resolveDead(state);
          return state;
        }
        state.bouncedSinceHit = true;
      }
    }
    // Too weak to bounce again: the ball is rolling on the table ("deflated"),
    // so the point resolves instead of the rally hanging forever.
    if (ball.vy < MIN_BOUNCE_VY) {
      resolveDead(state);
      return state;
    }
  }

  // Racket hits: any seat on the side the ball is heading toward may return
  // it. A lagged seat probes the ball where it was lagTicks ago instead.
  for (const seat of state.seats) {
    const lag = Math.min(seat.lagTicks, ballTrail.length);
    const probe = lag > 0 ? (ballTrail[lag - 1] ?? ball) : ball;
    const plane = PLAYER_Z[seat.side];
    const toward = seat.side === 0 ? probe.vz < 0 : probe.vz > 0;
    if (!toward || Math.abs(probe.z - plane) > HIT_DEPTH) continue;
    const dx = probe.x - seat.racket.x;
    const dy = probe.y - seat.racket.y;
    // Elliptical hit region: full reach sideways and above the blade centre,
    // short reach below it — the handle doesn't return balls.
    const vertReach = dy < 0 ? HIT_RADIUS_BELOW : HIT_RADIUS;
    if (
      (dx * dx) / (HIT_RADIUS * HIT_RADIUS) + (dy * dy) / (vertReach * vertReach) >
      1
    ) {
      continue;
    }
    // The return leaves from where this player saw the ball.
    ball.x = probe.x;
    ball.y = probe.y;
    ball.z = plane + (seat.side === 0 ? 10 : -10);
    shoot(state, seat, dx, rand);
    state.lastHitter = seat.side;
    state.bouncedSinceHit = false;
    break;
  }

  // Dead ball: fell below the table, or flew past a racket plane. A side with
  // a lagged player keeps a grace window past its plane — the ball isn't ruled
  // dead while a compensated hit could still legitimately connect.
  const grace = (side: PlayerIndex): number => {
    let ticks = 0;
    for (const seat of state.seats) {
      if (seat.side === side) ticks = Math.max(ticks, seat.lagTicks);
    }
    return ticks * dt * Math.abs(ball.vz);
  };
  if (
    ball.y < FLOOR_Y ||
    ball.z < PLAYER_Z[0] - MISS_MARGIN - grace(0) ||
    ball.z > PLAYER_Z[1] + MISS_MARGIN + grace(1)
  ) {
    resolveDead(state);
  }

  return state;
}

function servingSeat(state: GameState): Seat | null {
  const mates = state.seats.filter((s) => s.side === state.server);
  if (mates.length === 0) return null;
  // Teammates take turns: the side's serve count picks the seat.
  return mates[state.serveTurns[state.server] % mates.length] ?? null;
}

function shoot(state: GameState, seat: Seat, contactOffsetX: number, rand: Rand): void {
  const dir = seat.side === 0 ? 1 : -1;
  // A moving racket brushes spin onto the ball: lateral movement gives side
  // spin, upward movement gives topspin (downward chop gives backspin) —
  // and overall swipe speed adds raw shot power.
  const swipe = Math.min(Math.hypot(seat.vel.x, seat.vel.y) / MAX_RACKET_SPEED, 1);
  const spinTop = clamp(seat.vel.y * SPIN_FACTOR, -MAX_SPIN, MAX_SPIN);
  state.ball.vz = SHOT_SPEED_Z * dir * (1 + swipe * POWER_BOOST);
  // Topspin shots launch flatter, backspin shots float higher.
  state.ball.vy = SHOT_LIFT - spinTop * SPIN_LIFT_TILT;
  state.ball.vx =
    clamp(contactOffsetX * AIM_FACTOR, -MAX_SIDE_SPEED, MAX_SIDE_SPEED) +
    (rand() * 2 - 1) * 30;
  state.ball.spinSide = clamp(seat.vel.x * SPIN_FACTOR, -MAX_SPIN, MAX_SPIN);
  state.ball.spinTop = spinTop;
}

/**
 * If the last shot bounced on the receiving side, the receivers failed to
 * return it and the hitting side scores; otherwise the shot itself was a
 * fault (net, long, or wide) and the receiving side scores.
 */
function resolveDead(state: GameState): void {
  const faultBy = state.lastHitter ?? state.server;
  const to = state.bouncedSinceHit ? faultBy : opponent(faultBy);
  awardPoint(state, to);
}

function awardPoint(state: GameState, to: PlayerIndex): void {
  state.scores[to] += 1;
  // Win at 11, but from deuce (10-10) a two-point margin is required.
  if (state.scores[to] >= WIN_SCORE && state.scores[to] - state.scores[opponent(to)] >= 2) {
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
  state.netTouched = false;
  // Another serve for this side: its duo (if any) rotates the server.
  state.serveTurns[state.server] += 1;
  holdBall(state);
}

/** While waiting to serve, the ball tracks the serving player's racket. */
function holdBall(state: GameState): void {
  const seat = servingSeat(state);
  state.ball.x = seat ? seat.racket.x : 0;
  state.ball.y = HIT_HEIGHT;
  state.ball.z = state.server === 0 ? 0 : TABLE_LENGTH;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = 0;
  state.ball.spinSide = 0;
  state.ball.spinTop = 0;
}

/** Spin scales tried for a serve, in order, until the flight lands legally. */
const SERVE_SPIN_SCALES = [1, 0.7, 0.4, 0];

/**
 * Simulates a serve's flight (same integration as `step`, at the server tick
 * rate) and reports whether it clears the net cleanly and first lands on the
 * receiving side of the table.
 */
function serveIsLegal(
  side: PlayerIndex,
  x0: number,
  vx0: number,
  vy0: number,
  vz0: number,
  spinSide: number,
  spinTop: number,
): boolean {
  const dt = 1 / TICK_HZ;
  let x = x0;
  let y = HIT_HEIGHT;
  let z = side === 0 ? 0 : TABLE_LENGTH;
  let vx = vx0;
  let vy = vy0;
  const vz = vz0;
  const floatFactor = spinTop > 0 ? 1 : 0.5;
  const travel = Math.sign(vz) || 1;
  for (let i = 0; i < TICK_HZ * 3; i++) {
    const prevY = y;
    const prevZ = z;
    vy -= GRAVITY * dt;
    vx += spinSide * MAGNUS_SIDE * travel * dt;
    vy -= spinTop * MAGNUS_TOP * floatFactor * dt;
    x += vx * dt;
    y += vy * dt;
    z += vz * dt;
    if ((prevZ - NET_Z) * (z - NET_Z) < 0) {
      const t = (NET_Z - prevZ) / (z - prevZ);
      const heightAtNet = prevY + (y - prevY) * t;
      // Must clear the tape cleanly — a cord clip or block is not a serve.
      if (heightAtNet <= NET_HEIGHT + BALL_RADIUS) return false;
    }
    if (vy < 0 && y <= BALL_RADIUS) {
      const onReceivingSide = side === 0 ? z > NET_Z : z < NET_Z;
      return (
        onReceivingSide &&
        z >= 0 &&
        z <= TABLE_LENGTH &&
        Math.abs(x) <= TABLE_WIDTH / 2
      );
    }
    if (y < FLOOR_Y || z < PLAYER_Z[0] || z > PLAYER_Z[1]) return false;
  }
  return false;
}

function launchServe(state: GameState, rand: Rand): void {
  const seat = servingSeat(state);
  if (!seat) return;
  state.live = true;
  state.lastHitter = state.server;
  state.bouncedSinceHit = false;
  const ball = state.ball;
  const dir = seat.side === 0 ? 1 : -1;
  const vx = (rand() * 2 - 1) * 30;
  const vz = SHOT_SPEED_Z * dir;
  // Racket motion at launch styles the serve — topspin, backspin, or side
  // curve — but never adds raw power. The flight is pre-simulated and the
  // spin scaled down until the serve is guaranteed to land on the receiving
  // side, so no serve style can fly long or sky-high.
  const rawSide = clamp(seat.vel.x * SPIN_FACTOR, -MAX_SPIN, MAX_SPIN);
  const rawTop = clamp(seat.vel.y * SPIN_FACTOR, -MAX_SPIN, MAX_SPIN);
  for (const scale of SERVE_SPIN_SCALES) {
    const spinSide = rawSide * scale;
    const spinTop = rawTop * scale;
    const vy = SHOT_LIFT - spinTop * SPIN_LIFT_TILT;
    if (scale !== 0 && !serveIsLegal(seat.side, ball.x, vx, vy, vz, spinSide, spinTop)) {
      continue;
    }
    ball.vx = vx;
    ball.vy = vy;
    ball.vz = vz;
    ball.spinSide = spinSide;
    ball.spinTop = spinTop;
    return;
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
