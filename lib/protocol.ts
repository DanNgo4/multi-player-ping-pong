import type { GameState, MatchStatus, PlayerIndex } from "./game/types";

export type Role = "player" | "spectator";

/** Display name per seat, parallel to GameState.seats; null when the player gave no name. */
export type SeatNames = (string | null)[];

export interface ChatEntry {
  from: string;
  text: string;
}

export type ClientMessage =
  /**
   * Racket position. `z` is how far the player has reached forward over their
   * own end. It is optional on the wire because a client that predates the
   * forward reach sends none: every reader has to cope with its absence, and
   * the room reads a missing or non-finite z as the player's base plane.
   */
  | { type: "racket"; x: number; y: number; z?: number }
  | { type: "restart" }
  | { type: "chat"; text: string }
  /** A spectator asks to grab a free seat on a side; score is kept as-is. */
  | { type: "join"; side: PlayerIndex }
  /** A player gives up their seat to watch. Refused mid-game in a 1v1. */
  | { type: "spectate" }
  /** Toggles the sender's ready flag; play starts when all players are ready. */
  | { type: "ready" }
  /**
   * Latency probe; the server echoes t back in a pong. `rtt` is the client's
   * last measured round-trip in ms — it feeds lag compensation (server caps
   * it, so inflating it buys at most a small fixed advantage).
   */
  | { type: "ping"; t: number; rtt?: number };

/** Who is at the table, for HUD display; parallel to GameState.seats. */
export interface SeatInfo {
  side: PlayerIndex;
  name: string | null;
}

export type ServerMessage =
  | {
      type: "welcome";
      role: Role;
      /** Your seat's id within state.seats; null for spectators. */
      seatId: string | null;
      side: PlayerIndex | null;
      state: GameState;
      names: SeatNames;
      watchers: string[];
      creator: string | null;
      /** Recent chat lines so a joiner sees the running conversation. */
      chat: ChatEntry[];
    }
  /** Per-tick snapshot; deliberately slim — presence data travels in "meta". */
  | { type: "state"; state: GameState }
  /** Presence and identity; broadcast only when it actually changes. */
  | {
      type: "meta";
      players: number;
      spectators: number;
      seats: SeatInfo[];
      watchers: string[];
      creator: string | null;
    }
  | { type: "chat"; from: string; text: string }
  | { type: "pong"; t: number };

export interface MatchInfo {
  id: string;
  players: number;
  spectators: number;
  /** Player count per side, e.g. [2, 1] for a 2v1 in progress. */
  sides: [number, number];
  scores: [number, number];
  status: MatchStatus;
  names: SeatNames;
  creator: string | null;
}

/** POSTed from a match room to the lobby room whenever match state changes. */
export type LobbyUpdate = MatchInfo & { gone?: boolean };

/** A finished game, kept by the lobby for the history list and leaderboard. */
export interface MatchResult {
  id: string;
  title: string;
  /** Display names per side at the moment the game ended. */
  names: [string[], string[]];
  scores: [number, number];
  winner: PlayerIndex;
  /** Epoch milliseconds. */
  endedAt: number;
}

/** Match rooms POST either a live-state update or a finished-game result. */
export type LobbyPost = LobbyUpdate | { result: MatchResult };

export type LobbyServerMessage = {
  type: "matches";
  matches: MatchInfo[];
  results: MatchResult[];
};

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as ClientMessage;
    // z is deliberately not required here: what an absent or bad one falls
    // back to is the sender's base plane, and only the room knows which side
    // they sit on. It is validated in the room's racket handler instead.
    if (msg.type === "racket" && Number.isFinite(msg.x) && Number.isFinite(msg.y)) return msg;
    if (msg.type === "restart") return msg;
    if (msg.type === "chat" && typeof msg.text === "string") return msg;
    if (msg.type === "join" && (msg.side === 0 || msg.side === 1)) return msg;
    if (msg.type === "spectate") return msg;
    if (msg.type === "ready") return msg;
    if (msg.type === "ping" && Number.isFinite(msg.t)) {
      return msg.rtt !== undefined && !Number.isFinite(msg.rtt)
        ? { type: "ping", t: msg.t }
        : msg;
    }
    return null;
  } catch {
    return null;
  }
}

/** Normalises a user-supplied display name; null when empty. */
export function sanitizeName(raw: string | null): string | null {
  const trimmed = (raw ?? "").trim().slice(0, 24);
  return trimmed.length > 0 ? trimmed : null;
}

export function matchTitle(creator: string | null, roomId: string): string {
  return creator ? `${creator}'s match` : `Match ${roomId}`;
}

/** Normalises a chat line; null when empty after trimming. */
export function sanitizeChat(raw: string): string | null {
  const trimmed = raw.trim().slice(0, 140);
  return trimmed.length > 0 ? trimmed : null;
}
