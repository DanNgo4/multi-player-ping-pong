import type { GameState, MatchStatus, PaddleDir, PlayerIndex } from "./game/types";

export type Role = "player" | "spectator";

export type ClientMessage =
  | { type: "input"; dir: PaddleDir }
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
    if (msg.type === "input" && (msg.dir === -1 || msg.dir === 0 || msg.dir === 1)) return msg;
    if (msg.type === "restart") return msg;
    return null;
  } catch {
    return null;
  }
}
