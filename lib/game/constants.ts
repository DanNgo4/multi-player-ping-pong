// World units are arbitrary; x is lateral (0 at centre), y is up (0 at the
// table surface), z runs along the table from player 0's end to player 1's.

export const TABLE_WIDTH = 300;
export const TABLE_LENGTH = 540;
export const NET_Z = TABLE_LENGTH / 2;
export const NET_HEIGHT = 40;

export const BALL_RADIUS = 6;
/** A ball well below the tape rebounds off the net with this restitution... */
export const NET_RESTITUTION = 0.18;
/** ...while one clipping the tape stumbles over with this much forward speed left. */
export const NET_CORD_DAMP = 0.45;
export const GRAVITY = 900;
export const TABLE_RESTITUTION = 0.75;
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
/** 1/s; how fast tracked racket velocity fades between input messages. */
export const RACKET_VEL_DECAY = 5;
export const MAX_RACKET_SPEED = 900;

export const RACKET_RADIUS = 26;
export const RACKET_MAX_X = 210;
export const RACKET_MAX_Y = 220;

export const WIN_SCORE = 11;
export const TICK_HZ = 30;
export const COUNTDOWN_SECONDS = 3;
