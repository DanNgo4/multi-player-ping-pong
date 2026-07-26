// World units are arbitrary; x is lateral (0 at centre), y is up (0 at the
// table surface), z runs along the table from player 0's end to player 1's.

export const TABLE_WIDTH = 300;
export const TABLE_LENGTH = 540;
export const NET_Z = TABLE_LENGTH / 2;
export const NET_HEIGHT = 40;

export const BALL_RADIUS = 6;
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
export const HIT_RADIUS = 48;
/** Height the ball is held at before a serve. */
export const HIT_HEIGHT = 40;

/** Shot profile: chosen so a return clears the net and bounces on the far side. */
export const SHOT_SPEED_Z = 480;
export const SHOT_LIFT = 300;
/** Lateral speed per unit of contact offset from the racket centre. */
export const AIM_FACTOR = 3.5;
export const MAX_SIDE_SPEED = 240;
export const SERVE_DELAY = 1.2;

export const RACKET_RADIUS = 26;
export const RACKET_MAX_X = 210;
export const RACKET_MAX_Y = 220;

export const WIN_SCORE = 11;
export const TICK_HZ = 30;
export const COUNTDOWN_SECONDS = 3;
