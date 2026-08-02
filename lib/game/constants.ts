// World units are arbitrary; x is lateral (0 at centre), y is up (0 at the
// table surface), z runs along the table from player 0's end to player 1's.

export const TABLE_WIDTH = 300;
export const TABLE_LENGTH = 540;
export const NET_Z = TABLE_LENGTH / 2;
/** Proportional to a real table: 15.25cm net on a 274cm table, at our scale. */
export const NET_HEIGHT = 30;

export const BALL_RADIUS = 6;
/** A ball well below the tape rebounds off the net with this restitution... */
export const NET_RESTITUTION = 0.18;
/** ...while one clipping the tape stumbles over with this much forward speed left. */
export const NET_CORD_DAMP = 0.45;
export const GRAVITY = 900;
export const TABLE_RESTITUTION = 0.75;
/** A bounce weaker than this means the ball is rolling — the point resolves. */
export const MIN_BOUNCE_VY = 80;
/** Below this height the ball is dead (fell off the table). */
export const FLOOR_Y = -80;

/** z of each player's racket plane, just off the table ends. */
export const PLAYER_Z: readonly [number, number] = [-30, TABLE_LENGTH + 30];
/** How far past a racket plane the ball may fly before the point is dead. */
export const MISS_MARGIN = 60;

/** Depth window around the racket plane in which a hit can connect. */
export const HIT_DEPTH = 40;
/** Racket-to-ball distance (in the racket plane) that still counts as a hit. */
export const HIT_RADIUS = 56;
/** Reach below the blade centre is short — the handle is not part of the bat. */
export const HIT_RADIUS_BELOW = 34;
/** Height the ball is held at before a serve. */
export const HIT_HEIGHT = 40;

/** Shot profile: chosen so a return clears the net and bounces on the far side. */
export const SHOT_SPEED_Z = 540;
export const SHOT_LIFT = 300;
/** Max extra forward speed (as a fraction) a full-speed swipe adds to a return. */
export const POWER_BOOST = 0.5;
/** Topspin launches flatter, backspin floatier: vy shifts by this per unit of spin. */
export const SPIN_LIFT_TILT = 0.08;
/** Lateral speed per unit of contact offset from the racket centre. */
export const AIM_FACTOR = 3.5;
export const MAX_SIDE_SPEED = 240;
export const SERVE_DELAY = 1.2;

// Spin: racket velocity at contact brushes spin onto the ball. Side spin
// curves the flight laterally (Magnus), topspin dips it and kicks it forward
// off the bounce; backspin (negative topspin) floats and deadens instead.
export const SPIN_FACTOR = 0.6;
export const MAX_SPIN = 420;
/** Lateral acceleration per unit of side spin, applied along travel direction. */
export const MAGNUS_SIDE = 1.5;
/** Extra downward acceleration per unit of topspin. */
export const MAGNUS_TOP = 1.4;
/** Forward speed gained per unit of topspin when the ball bites the table. */
export const SPIN_BOUNCE_KICK = 0.4;
export const SPIN_DECAY_ON_BOUNCE = 0.55;
/**
 * 1/s; air drag on the ball's rotation, applied every step of flight as
 * `spin *= max(0, 1 - SPIN_AIR_DECAY * dt)` — geometric decay, so spin has a
 * half-life of about 1.15 s in the air.
 *
 * A full crossing takes ~0.74 s for a hard drive and ~1.11 s for a slow one,
 * so a shot arrives with roughly 64% of its spin at speed and 51% when it has
 * floated. That is what makes a high, hanging ball the one you can take the
 * spin off and impose your own on, while a quick drive still bites. Magnus and
 * SPIN_BOUNCE_KICK read the live spin, so they weaken along with it.
 */
export const SPIN_AIR_DECAY = 0.6;

// Receiving spin: the rotation already on the ball fights the blade, so a flat
// return of a heavy ball does not come back the way a flat return of a dead
// ball does. Incoming spin is always clamped to ±MAX_SPIN, which bounds all
// three terms below; each is set small enough that a deliberate counter-swipe
// outweighs it, so heavy spin is answerable rather than an automatic point.

/**
 * Return vy gained per unit of incoming topspin. Topspin climbs off a flat
 * blade and carries long; backspin drags the return down toward the net.
 * At full spin this is worth ±25 of vy against a SHOT_LIFT of 300, while a
 * full counter-swipe moves vy by ±34 through SPIN_LIFT_TILT.
 */
export const SPIN_RECEIVE_LIFT = 0.06;
/**
 * Return vx gained per unit of incoming side spin, pushing the return the way
 * the incoming ball was already curving. Worth ±50 at full spin, which a
 * contact offset of ~14 off the blade centre cancels.
 */
export const SPIN_RECEIVE_SIDE = 0.12;
/**
 * Fraction of the incoming spin the ball keeps off the blade, reversed: a
 * passive bounce does not stop the ball rotating, and reversing the direction
 * of travel turns topspin into backspin (and flips which way side spin bends).
 * The hitter's own swipe spin is added on top of this.
 */
export const SPIN_CARRY = 0.25;

/** 1/s; how fast tracked racket velocity fades between input messages. */
export const RACKET_VEL_DECAY = 5;
export const MAX_RACKET_SPEED = 900;

export const RACKET_RADIUS = 26;
// The racket can chase balls curving well outside the table rectangle.
export const RACKET_MAX_X = 280;
export const RACKET_MAX_Y = 260;

export const WIN_SCORE = 11;
export const TICK_HZ = 30;
/** Lag compensation cap: hit checks may look at most this many ticks back. */
export const MAX_LAG_TICKS = 8;
/**
 * Client-side display delay every player carries on top of their ping, in
 * ticks. The client renders the ball interpolated between the two latest
 * snapshots — which is a full snapshot interval behind the server — and only
 * streams racket positions on its own ~1-tick cadence. Without paying this
 * back, the ball the server tests sits ahead of the ball the player aimed at,
 * and the error grows with lateral speed: near the table edges a racket drawn
 * right on the ball registers no hit at all.
 */
export const RENDER_LAG_TICKS = 2;
export const COUNTDOWN_SECONDS = 3;
