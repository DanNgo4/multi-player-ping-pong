import {
  AIM_FACTOR,
  BACKSPIN_PACE_LOSS,
  BALL_RADIUS,
  COAST_BOUNCE_DAMP,
  COAST_Z_MARGIN,
  COUNTDOWN_SECONDS,
  FLOOR_Y,
  GRAVITY,
  HIT_DEPTH,
  HIT_HEIGHT,
  HIT_RADIUS,
  HIT_RADIUS_BELOW,
  HOLD_BALL_WINDOW,
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
  RENDER_LAG_TICKS,
  SERVE_DELAY,
  SERVE_HOLD_AHEAD,
  SHOT_LIFT,
  SHOT_SPEED_Z,
  SPIN_AIR_DECAY,
  SPIN_BOUNCE_KICK,
  SPIN_CARRY,
  SPIN_DECAY_ON_BOUNCE,
  SPIN_FACTOR,
  SPIN_FLOAT_FACTOR,
  SPIN_LIFT_TILT,
  SPIN_LIFT_TILT_BACK,
  SPIN_RECEIVE_LIFT,
  SPIN_RECEIVE_SIDE,
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

/**
 * How many ticks into the past a seat's hit checks look.
 *
 * `lagTicks` covers that player's measured network delay. On top of it every
 * player — even one on a perfect connection — is looking at a stale ball:
 * the client renders it interpolated between the two latest snapshots, which
 * lands one whole snapshot interval behind the server, and racket positions
 * only leave the client on its own ~1-tick cadence. RENDER_LAG_TICKS pays back
 * that fixed client-side delay so the server tests the ball where the player
 * actually saw it when they moved the racket.
 */
function seatLookback(seat: Seat): number {
  return seat.lagTicks + RENDER_LAG_TICKS;
}

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
    // Starts at the back of the reach: the base plane the player stands on.
    racket: { x, y: HIT_HEIGHT, z: PLAYER_Z[side] },
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
  // Park the ball as well as stopping it: suspending mid-coast would otherwise
  // strand a dead ball in mid-air for the whole of the next countdown.
  holdBall(state);
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
 * ago), used for lag compensation: hit checks run against the ball where it
 * was when that player's screen showed it, so players hit what they actually
 * saw. See `seatLookback` for how far back that is.
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
    state.serveTimer -= dt;
    // A point that just ended leaves the ball in flight: let it finish its arc
    // as a scenery object — gravity and bounces only, no net, no hits, no
    // scoring — and park it on the server's racket for the tail of the delay,
    // so the serve is still visibly held. A ball that never launched (the
    // first serve of a game) has nothing to coast and is held throughout.
    if (state.serveTimer <= HOLD_BALL_WINDOW || !state.coasting) {
      holdBall(state);
    } else {
      coastBall(state, dt);
    }
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
  // Backspin float is damped so a chopped ball hangs but never soars upward.
  ball.vy -= ball.spinTop * MAGNUS_TOP * floatFactor(ball.spinTop) * dt;
  // Air drags on the rotation too, so spin bleeds away over the flight. This
  // must stay in step with the same decay inside serveIsLegal().
  const spinDecay = Math.max(0, 1 - SPIN_AIR_DECAY * dt);
  ball.spinSide *= spinDecay;
  ball.spinTop *= spinDecay;
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
  // it, probing the ball where that player's screen showed it. The depth
  // window travels with the racket, so a player who has reached forward over
  // the table meets the ball there instead of back at their own plane; which
  // way they may play it still comes from the plane they stand behind.
  // Taking the ball out of the air before it has bounced on your own side is
  // allowed on purpose: this is an arcade volley, not a let.
  for (const seat of state.seats) {
    const lag = Math.min(seatLookback(seat), ballTrail.length);
    const probe = lag > 0 ? (ballTrail[lag - 1] ?? ball) : ball;
    const toward = seat.side === 0 ? probe.vz < 0 : probe.vz > 0;
    if (!toward || Math.abs(probe.z - seat.racket.z) > HIT_DEPTH) continue;
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
    // The return leaves from where — and from when — this player saw the ball,
    // so the spin it meets is the spin the probed snapshot carried too.
    ball.x = probe.x;
    ball.y = probe.y;
    // The return leaves from the blade, wherever the blade is: a shot taken
    // early starts further down the table and so has less of it to cross.
    ball.z = seat.racket.z + (seat.side === 0 ? 10 : -10);
    shoot(state, seat, dx, probe, rand);
    state.lastHitter = seat.side;
    state.bouncedSinceHit = false;
    break;
  }

  // Dead ball: fell below the table, or flew past a racket plane. A side keeps
  // a grace window past its plane so the ball isn't ruled dead while a
  // compensated hit could still legitimately connect. It has to cover the
  // whole lookback the hit checks use, not just measured ping: the probe
  // trails the live ball by that many ticks, so killing the ball at
  // MISS_MARGIN alone would throw away the tail of every player's probe
  // window — including a player on a perfect connection.
  const grace = (side: PlayerIndex): number => {
    let ticks = 0;
    for (const seat of state.seats) {
      if (seat.side === side) ticks = Math.max(ticks, seatLookback(seat));
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

/**
 * Magnus multiplier for the ball's vertical spin term: topspin dips at full
 * strength, backspin floats at a damped fraction of it. `step` and
 * `serveIsLegal` both go through here so the predicted flight is the real one.
 */
function floatFactor(spinTop: number): number {
  return spinTop >= 0 ? 1 : SPIN_FLOAT_FACTOR;
}

/**
 * How much the launch angle tilts per unit of spin. Topspin flattens the shot
 * hard; backspin lifts it, but only a little. The asymmetry is the point: a
 * chop that launched as much higher as a loop launches lower would fly the
 * length of the table, which is precisely what used to make backspin unusable.
 */
function liftTilt(spinTop: number): number {
  return spinTop >= 0 ? SPIN_LIFT_TILT : SPIN_LIFT_TILT_BACK;
}

/**
 * Forward-speed multiplier for a shot brushed with `spinTop` by the hitter's
 * own swipe. Backspin bleeds pace off the ball in proportion to how hard it
 * was chopped; topspin and flat shots are untouched.
 */
function backspinPace(spinTop: number): number {
  return spinTop >= 0 ? 1 : 1 - Math.min(-spinTop / MAX_SPIN, 1) * BACKSPIN_PACE_LOSS;
}

/**
 * Cosmetic flight for a ball that is already dead: the point is scored, the
 * rally is over, and this only stops the ball vanishing out of mid-air. It
 * runs gravity and a bounce off whatever surface is under the ball, and
 * nothing else — no spin, no net, no hit checks, no scoring — so it cannot
 * change the match.
 */
function coastBall(state: GameState, dt: number): void {
  const ball = state.ball;
  // Already come to rest: it stays exactly where it stopped, so the settled
  // ball renders as a still body rather than jittering on the spot.
  if (ball.vx === 0 && ball.vy === 0 && ball.vz === 0) return;
  const prevY = ball.y;
  ball.vy -= GRAVITY * dt;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.z += ball.vz * dt;
  // Clear of the table and still receding: stop it running away from — or
  // into — the camera and let it fall where the player missed it.
  if (ball.z < PLAYER_Z[0] - COAST_Z_MARGIN || ball.z > PLAYER_Z[1] + COAST_Z_MARGIN) {
    ball.vz = 0;
  }
  // The table is only a surface to a ball coming down onto it from above. One
  // that is already below the top and drifts back over the footprint has to
  // keep falling to the floor, not pop up through the wood.
  const overTable =
    ball.z >= 0 &&
    ball.z <= TABLE_LENGTH &&
    Math.abs(ball.x) <= TABLE_WIDTH / 2 &&
    prevY >= BALL_RADIUS;
  const rest = (overTable ? 0 : FLOOR_Y) + BALL_RADIUS;
  if (ball.vy >= 0 || ball.y > rest) return;
  ball.y = rest;
  ball.vy = -ball.vy * TABLE_RESTITUTION;
  ball.vx *= COAST_BOUNCE_DAMP;
  ball.vz *= COAST_BOUNCE_DAMP;
  if (ball.vy < MIN_BOUNCE_VY) {
    ball.vx = 0;
    ball.vy = 0;
    ball.vz = 0;
  }
}

function servingSeat(state: GameState): Seat | null {
  const mates = state.seats.filter((s) => s.side === state.server);
  if (mates.length === 0) return null;
  // Teammates take turns: the side's serve count picks the seat.
  return mates[state.serveTurns[state.server] % mates.length] ?? null;
}

/**
 * Launches the return. `seen` is the ball as the striking player saw it — the
 * lag-compensated snapshot the contact was judged against — so the spin the
 * blade meets is read from there rather than from the live ball, which may be
 * several ticks and a good chunk of SPIN_AIR_DECAY further on.
 */
function shoot(
  state: GameState,
  seat: Seat,
  contactOffsetX: number,
  seen: Ball,
  rand: Rand,
): void {
  const ball = state.ball;
  const dir = seat.side === 0 ? 1 : -1;
  // Side spin bends the flight along the direction of travel, so the way this
  // ball was actually drifting is its side spin taken against its own heading.
  const inSide = seen.spinSide;
  const inTop = seen.spinTop;
  const inDrift = inSide * -dir;
  // A moving racket brushes spin onto the ball: lateral movement gives side
  // spin, upward movement gives topspin (downward chop gives backspin) —
  // and swipe speed adds raw shot power. Only sideways and upward motion
  // counts toward that power: a chop takes pace *off* the ball, so a downward
  // swipe must not double as a drive.
  const swipe = Math.min(
    Math.hypot(seat.vel.x, Math.max(seat.vel.y, 0)) / MAX_RACKET_SPEED,
    1,
  );
  const spinTop = clamp(seat.vel.y * SPIN_FACTOR, -MAX_SPIN, MAX_SPIN);
  // Backspin bleeds the base speed *and* the swipe's boost, so the harder the
  // chop the less of the swing reaches the ball. Stripping only the downward
  // part of the swipe was not enough: a fast sideways chop kept the full boost
  // and came out quicker than a flat push, which is not a chop at all.
  const pace = backspinPace(spinTop);
  ball.vz = SHOT_SPEED_Z * dir * pace * (1 + swipe * POWER_BOOST * pace);
  // Side spin pushes the return on the way the incoming ball was curving, so
  // a hooking ball has to be aimed against.
  ball.vx =
    clamp(
      contactOffsetX * AIM_FACTOR + inDrift * SPIN_RECEIVE_SIDE,
      -MAX_SIDE_SPEED,
      MAX_SIDE_SPEED,
    ) +
    (rand() * 2 - 1) * 30;
  // The blade never stops the ball rotating, so a share of the incoming spin
  // rides back out with the hitter's own swipe spin brushed on top. The two
  // axes carry with opposite signs, because they are parameterised differently
  // against the direction of travel:
  //
  //   spinSide is travel-relative — the Magnus term multiplies it by
  //   sign(vz) — so once the return reverses vz, an unchanged value already
  //   bends the ball the other way in world terms. That is exactly what a
  //   conserved rotation does, so the carry keeps its sign.
  //
  //   spinTop is not travel-scaled: positive always means dip, whichever way
  //   the ball is going. Nothing flips on its own, so the reversal has to be
  //   written in — the opponent's topspin comes back to them as backspin.
  ball.spinSide = clamp(
    seat.vel.x * SPIN_FACTOR + inSide * SPIN_CARRY,
    -MAX_SPIN,
    MAX_SPIN,
  );
  ball.spinTop = clamp(spinTop - inTop * SPIN_CARRY, -MAX_SPIN, MAX_SPIN);
  // Topspin shots launch flatter, backspin shots a touch higher. On top of that
  // the incoming ball's own spin fights the blade: its topspin climbs off the
  // face and carries long, its backspin drags the return down toward the net.
  // A heavy ball therefore has to be answered with the swipe, not blocked.
  //
  // The launch is then whatever still fits on the table from where the blade
  // met the ball — see `landableLaunch`. Struck from the base plane at a
  // normal height nothing is taken off it, so ordinary rallies play exactly as
  // they did; it is the shots with no room left, taken from up the table or
  // off a ball sitting high, that come down into a drive instead of a lob.
  const baseLift = SHOT_LIFT - spinTop * liftTilt(spinTop) + inTop * SPIN_RECEIVE_LIFT;
  const launch = landableLaunch(seat.side, ball, baseLift);
  ball.vy = launch.vy;
  ball.vz = launch.vz;
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
    state.coasting = false;
    state.ball.vx = 0;
    state.ball.vy = 0;
    state.ball.vz = 0;
    return;
  }
  state.server = opponent(to);
  // The rally's last ball keeps its velocity so it can coast to a stop on
  // screen; `step` parks it on the server's racket later in the serve delay.
  prepareServe(state, true);
}

/**
 * Sets up the next serve. `coast` leaves the ball's motion alone — used when a
 * point has just ended and the dead ball should finish its flight; otherwise
 * the ball is parked on the server's racket straight away.
 */
function prepareServe(state: GameState, coast = false): void {
  state.live = false;
  state.serveTimer = SERVE_DELAY;
  state.lastHitter = null;
  state.bouncedSinceHit = false;
  state.netTouched = false;
  // Another serve for this side: its duo (if any) rotates the server.
  state.serveTurns[state.server] += 1;
  state.coasting = coast;
  if (!coast) holdBall(state);
}

/** While waiting to serve, the ball tracks the serving player's racket. */
function holdBall(state: GameState): void {
  const seat = servingSeat(state);
  state.coasting = false;
  // The ball sits just in front of the blade, so it follows the server's
  // racket wherever it goes — right up to the front of the reach. Serving from
  // out there is playable rather than suicidal because `landableLift` flattens
  // the serve to whatever length is left in front of it.
  const dir = state.server === 0 ? 1 : -1;
  state.ball.x = seat ? seat.racket.x : 0;
  state.ball.y = HIT_HEIGHT;
  state.ball.z = (seat ? seat.racket.z : PLAYER_Z[state.server]) + dir * SERVE_HOLD_AHEAD;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = 0;
  state.ball.spinSide = 0;
  state.ball.spinTop = 0;
}

/** Spin scales tried for a serve, in order, until the flight lands legally. */
const SERVE_SPIN_SCALES = [1, 0.7, 0.4, 0];

/**
 * Lift scales tried for a launch, longest first, until the ball comes down on
 * the receiving side. The ladder runs well past flat and into a downward
 * strike: a ball met high, or met from up the table with barely half the
 * length left to play with, has to be hit *down* to stay on. See
 * `landableLift`.
 */
const SHOT_LIFT_SCALES = [
  1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0, -0.2, -0.5, -0.9, -1.4, -2, -2.7,
];

/**
 * Pace scales tried for a launch, and only after every lift has been tried at
 * the one above. Giving up speed is the last thing a shot should do — arriving
 * sooner is the whole reward for stepping in — but there are balls no lift can
 * save: scraped off the table top and driven flat from up the table, a ball
 * high enough to clear the tape is already long, and one short enough to land
 * is already into the net. Those need the pace off, and nothing else will do.
 */
const SHOT_PACE_SCALES = [1, 0.85, 0.7, 0.55];

/** Where a simulated flight first came down, and how it got past the net. */
interface Landing {
  /** False when the ball never reached a first bounce (netted, flew away). */
  landed: boolean;
  /** False when the tape blocked or clipped it on the way. */
  clearedNet: boolean;
  x: number;
  z: number;
}

/**
 * Simulates a launch (same integration as `step`, at the server tick rate) up
 * to its first bounce. Both the serve legality check and the rally launch read
 * this, so what the engine predicts about a shot is what the shot then does —
 * the two integrations have to stay identical or a ball judged safe flies long.
 */
function simulateLaunch(
  x0: number,
  y0: number,
  z0: number,
  vx0: number,
  vy0: number,
  vz0: number,
  spinSide: number,
  spinTop: number,
): Landing {
  const dt = 1 / TICK_HZ;
  let x = x0;
  let y = y0;
  let z = z0;
  let vx = vx0;
  let vy = vy0;
  const vz = vz0;
  // Spin fades in the air exactly as it does in `step`, so the flight this
  // predicts is the flight the ball actually takes. Decay never flips a sign,
  // so the float factor stays fixed for the whole simulation.
  let curSide = spinSide;
  let curTop = spinTop;
  const spinDecay = Math.max(0, 1 - SPIN_AIR_DECAY * dt);
  const float = floatFactor(spinTop);
  const travel = Math.sign(vz) || 1;
  for (let i = 0; i < TICK_HZ * 3; i++) {
    const prevY = y;
    const prevZ = z;
    vy -= GRAVITY * dt;
    vx += curSide * MAGNUS_SIDE * travel * dt;
    vy -= curTop * MAGNUS_TOP * float * dt;
    curSide *= spinDecay;
    curTop *= spinDecay;
    x += vx * dt;
    y += vy * dt;
    z += vz * dt;
    if ((prevZ - NET_Z) * (z - NET_Z) < 0) {
      const t = (NET_Z - prevZ) / (z - prevZ);
      const heightAtNet = prevY + (y - prevY) * t;
      if (heightAtNet <= NET_HEIGHT + BALL_RADIUS) {
        return { landed: false, clearedNet: false, x, z };
      }
    }
    if (vy < 0 && y <= BALL_RADIUS) return { landed: true, clearedNet: true, x, z };
    if (y < FLOOR_Y || z < PLAYER_Z[0] || z > PLAYER_Z[1]) {
      return { landed: false, clearedNet: true, x, z };
    }
  }
  return { landed: false, clearedNet: true, x, z };
}

/** True when a simulated flight first came down on the far half of the table. */
function landsOnReceivingSide(side: PlayerIndex, landing: Landing): boolean {
  if (!landing.landed || !landing.clearedNet) return false;
  const beyondNet = side === 0 ? landing.z > NET_Z : landing.z < NET_Z;
  return beyondNet && landing.z >= 0 && landing.z <= TABLE_LENGTH;
}

/**
 * The launch velocity for a shot that has to fit on the table.
 *
 * A racket can now meet the ball anywhere from its own baseline to well up its
 * half, and it can meet it anywhere from the table surface to overhead — but
 * SHOT_LIFT is a single number tuned for a full-length rally stroke. Struck
 * with a third of the table already behind it, or off a ball sitting shoulder
 * high, that same lift throws the ball past the far baseline every time; and
 * since a shot that never bounced on the receiving side is scored as the
 * *hitter's* fault, stepping in could only ever lose the point.
 *
 * So the lift is tried longest-first down SHOT_LIFT_SCALES, and only if none
 * of them fits is any pace given up (SHOT_PACE_SCALES); the first pairing that
 * comes down on the receiving side is taken. The ladder is walked against the
 * same simulation `step` will actually run, spin and all, rather than a
 * closed-form guess that would drift from it. Nothing is ever added: the ball
 * never gets more lift or more speed than the stroke gave it, only less. A
 * shot with the whole table in front of it is therefore untouched, and a shot
 * with no room left turns into a drive and then a smash.
 *
 * A stroke that cannot be made to land at all is launched as struck. Taking
 * the flattest rung instead would be far worse than doing nothing: a ball
 * scraped off the table top at your own baseline cannot clear the tape cleanly
 * at any lift, and answering that by driving it into the floor in front of you
 * turns a ball that would have dribbled over the cord — a legal, playable shot
 * — into a certain loss. Backspin dropping short is fine too; that is what a
 * drop shot is.
 */
function landableLaunch(
  side: PlayerIndex,
  ball: Ball,
  baseLift: number,
): { vy: number; vz: number } {
  for (const paceScale of SHOT_PACE_SCALES) {
    const vz = ball.vz * paceScale;
    for (const liftScale of SHOT_LIFT_SCALES) {
      const vy = baseLift * liftScale;
      const landing = simulateLaunch(
        ball.x,
        ball.y,
        ball.z,
        ball.vx,
        vy,
        vz,
        ball.spinSide,
        ball.spinTop,
      );
      if (landsOnReceivingSide(side, landing)) return { vy, vz };
    }
  }
  return { vy: baseLift, vz: ball.vz };
}

/**
 * Whether a serve clears the net cleanly and first lands in the receiving
 * half, inside the sidelines.
 */
function serveIsLegal(
  side: PlayerIndex,
  x0: number,
  z0: number,
  vx0: number,
  vy0: number,
  vz0: number,
  spinSide: number,
  spinTop: number,
): boolean {
  // Wherever the server is holding the ball, including out over the table.
  const landing = simulateLaunch(x0, HIT_HEIGHT, z0, vx0, vy0, vz0, spinSide, spinTop);
  return landsOnReceivingSide(side, landing) && Math.abs(landing.x) <= TABLE_WIDTH / 2;
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
  // Racket motion at launch styles the serve — topspin, backspin, or side
  // curve — but never adds raw power. The flight is pre-simulated and the
  // spin scaled down until the serve is guaranteed to land on the receiving
  // side, so no serve style can fly long or sky-high.
  const rawSide = clamp(seat.vel.x * SPIN_FACTOR, -MAX_SPIN, MAX_SPIN);
  const rawTop = clamp(seat.vel.y * SPIN_FACTOR, -MAX_SPIN, MAX_SPIN);
  for (const scale of SERVE_SPIN_SCALES) {
    const spinSide = rawSide * scale;
    const spinTop = rawTop * scale;
    // Same launch profile as a rally shot, minus the swipe's power boost: a
    // chopped serve leaves flat and slow, which is what lets it stay short
    // enough to be legal at full spin instead of being scaled away.
    const struck = SHOT_SPEED_Z * dir * backspinPace(spinTop);
    // ...and, exactly as a rally shot does, only as much of it as still fits
    // on the table. That is what lets a player serve from anywhere in their
    // reach: the spin ladder below cannot shorten a serve on its own, because
    // its own last resort is a flat one.
    const { vy, vz } = landableLaunch(
      seat.side,
      { ...ball, vx, vz: struck, spinSide, spinTop },
      SHOT_LIFT - spinTop * liftTilt(spinTop),
    );
    if (
      scale !== 0 &&
      !serveIsLegal(seat.side, ball.x, ball.z, vx, vy, vz, spinSide, spinTop)
    ) {
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
