import type { GameState, MatchStatus, PlayerIndex } from "./game/types";

export type Role = "player" | "spectator";

export type ClientMessage =
  | { type: "racket"; x: number; y: number }
  | { type: "restart" };

export type ServerMessage =
  | { type: "welcome"; role: Role; playerIndex: PlayerIndex | null; state: GameState }
  | { type: "state"; state: GameState; players: number; spectators: number };

export interface MatchInfo {
  id: string;
  players: number;
  spectators: number;
  scores: [number, number];
  status: MatchStatus;
}

/** POSTed from a match room to the lobby room whenever match state changes. */
export type LobbyUpdate = MatchInfo & { gone?: boolean };

export type LobbyServerMessage = { type: "matches"; matches: MatchInfo[] };

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as ClientMessage;
    if (msg.type === "racket" && Number.isFinite(msg.x) && Number.isFinite(msg.y)) return msg;
    if (msg.type === "restart") return msg;
    return null;
  } catch {
    return null;
  }
}
