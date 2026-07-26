export const COURT_WIDTH = 800;
export const COURT_HEIGHT = 500;

export const PADDLE_WIDTH = 12;
export const PADDLE_HEIGHT = 100;
/** Distance from the side wall to the back of each paddle. */
export const PADDLE_MARGIN = 24;
/** Paddle movement speed in px/s. */
export const PADDLE_SPEED = 420;

export const BALL_RADIUS = 8;
/** Initial ball speed in px/s. */
export const BALL_SPEED = 360;
/** Speed added on every paddle hit, up to BALL_MAX_SPEED. */
export const BALL_SPEED_INCREMENT = 24;
export const BALL_MAX_SPEED = 760;
/** Steepest deflection off a paddle edge, in radians. */
export const MAX_BOUNCE_ANGLE = Math.PI / 3;

export const WIN_SCORE = 11;
export const TICK_HZ = 30;
export const COUNTDOWN_SECONDS = 3;
