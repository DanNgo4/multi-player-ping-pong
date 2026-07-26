import type { GameState, MatchStatus, PlayerIndex } from "./game/types";

export type Role = "player" | "spectator";

/** Display name per seat, parallel to GameState.seats; null when the player gave no name. */
export type SeatNames = (string | null)[];

export interface ChatEntry {
  from: string;
  text: string;
}

export type ClientMessage =
  | { type: "racket"; x: number; y: number }
  | { type: "restart" }
  | { type: "chat"; text: string }
  /** A spectator asks to grab a free seat on a side; score is kept as-is. */
  | { type: "join"; side: PlayerIndex }
  /** A player gives up their seat to watch. Refused mid-game in a 1v1. */
  | { type: "spectate" };

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
  | {
      type: "state";
      state: GameState;
      players: number;
      spectators: number;
      names: SeatNames;
      watchers: string[];
      creator: string | null;
    }
  | { type: "chat"; from: string; text: string };

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
    if (msg.type === "racket" && Number.isFinite(msg.x) && Number.isFinite(msg.y)) return msg;
    if (msg.type === "restart") return msg;
    if (msg.type === "chat" && typeof msg.text === "string") return msg;
    if (msg.type === "join" && (msg.side === 0 || msg.side === 1)) return msg;
    if (msg.type === "spectate") return msg;
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
