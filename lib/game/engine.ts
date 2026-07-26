import {
  AIM_FACTOR,
  BALL_RADIUS,
  COUNTDOWN_SECONDS,
  FLOOR_Y,
  GRAVITY,
  HIT_DEPTH,
  HIT_HEIGHT,
  HIT_RADIUS,
  MAGNUS_SIDE,
  MAGNUS_TOP,
  MAX_SIDE_SPEED,
  MAX_SPIN,
  MISS_MARGIN,
  NET_CORD_DAMP,
  NET_HEIGHT,
  NET_RESTITUTION,
  NET_Z,
  PLAYER_Z,
  RACKET_VEL_DECAY,
  SERVE_DELAY,
  SHOT_LIFT,
  SHOT_SPEED_Z,
  SPIN_BOUNCE_KICK,
  SPIN_DECAY_ON_BOUNCE,
  SPIN_FACTOR,
  TABLE_LENGTH,
  TABLE_RESTITUTION,
  TABLE_WIDTH,
  WIN_SCORE,
} from "./constants";
import {
  MAX_PLAYERS,
  MAX_SEATS_PER_SIDE,
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

/** Adds a seat for a joining player; returns it, or null when the side/match is full. */
export function addSeat(state: GameState, side: PlayerIndex, id: string): Seat | null {
  if (state.seats.length >= MAX_PLAYERS) return null;
  const teammates = state.seats.filter((s) => s.side === side);
  if (teammates.length >= MAX_SEATS_PER_SIDE) return null;
  // Start away from an existing teammate so rackets don't stack.
  const first = teammates[0];
  const x = first === undefined ? 0 : first.racket.x <= 0 ? TABLE_WIDTH / 4 : -TABLE_WIDTH / 4;
  const seat: Seat = { id, side, racket: { x, y: HIT_HEIGHT }, vel: { x: 0, y: 0 } };
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
  suspendPlay(state);
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
  ball.vy -= ball.spinTop * MAGNUS_TOP * dt;
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
      if (side !== state.lastHitter) state.bouncedSinceHit = true;
    }
  }

  // Racket hits: any seat on the side the ball is heading toward may return it.
  for (const seat of state.seats) {
    const plane = PLAYER_Z[seat.side];
    const toward = seat.side === 0 ? ball.vz < 0 : ball.vz > 0;
    if (!toward || Math.abs(ball.z - plane) > HIT_DEPTH) continue;
    const dx = ball.x - seat.racket.x;
    const dy = ball.y - seat.racket.y;
    if (dx * dx + dy * dy > HIT_RADIUS * HIT_RADIUS) continue;
    ball.z = plane + (seat.side === 0 ? 10 : -10);
    shoot(state, seat, dx, rand);
    state.lastHitter = seat.side;
    state.bouncedSinceHit = false;
    break;
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

function servingSeat(state: GameState): Seat | null {
  return state.seats.find((s) => s.side === state.server) ?? null;
}

function shoot(state: GameState, seat: Seat, contactOffsetX: number, rand: Rand): void {
  const dir = seat.side === 0 ? 1 : -1;
  state.ball.vz = SHOT_SPEED_Z * dir;
  state.ball.vy = SHOT_LIFT;
  state.ball.vx =
    clamp(contactOffsetX * AIM_FACTOR, -MAX_SIDE_SPEED, MAX_SIDE_SPEED) +
    (rand() * 2 - 1) * 30;
  // A moving racket brushes spin onto the ball: lateral movement gives side
  // spin, upward movement gives topspin (downward chop gives backspin).
  state.ball.spinSide = clamp(seat.vel.x * SPIN_FACTOR, -MAX_SPIN, MAX_SPIN);
  state.ball.spinTop = clamp(seat.vel.y * SPIN_FACTOR, -MAX_SPIN, MAX_SPIN);
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
  state.netTouched = false;
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

function launchServe(state: GameState, rand: Rand): void {
  const seat = servingSeat(state);
  if (!seat) return;
  state.live = true;
  state.lastHitter = state.server;
  state.bouncedSinceHit = false;
  shoot(state, seat, 0, rand);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
