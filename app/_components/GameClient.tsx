"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import usePartySocket from "partysocket/react";
import {
  BALL_RADIUS,
  COURT_HEIGHT,
  COURT_WIDTH,
  PADDLE_HEIGHT,
  PADDLE_MARGIN,
  PADDLE_WIDTH,
} from "@/lib/game/constants";
import {
  createInitialState,
  type GameState,
  type MatchStatus,
  type PlayerIndex,
} from "@/lib/game/types";
import { PARTYKIT_HOST } from "@/lib/party-host";
import type { ClientMessage, Role, ServerMessage } from "@/lib/protocol";

interface Props {
  room: string;
  intent: "play" | "watch";
}

export default function GameClient({ room, intent }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState>(createInitialState());
  const [role, setRole] = useState<Role | null>(null);
  const [playerIndex, setPlayerIndex] = useState<PlayerIndex | null>(null);
  const [scores, setScores] = useState<[number, number]>([0, 0]);
  const [status, setStatus] = useState<MatchStatus>("waiting");
  const [winner, setWinner] = useState<PlayerIndex | null>(null);
  const [counts, setCounts] = useState({ players: 0, spectators: 0 });

  const socket = usePartySocket({
    host: PARTYKIT_HOST,
    room,
    query: { intent },
    onMessage(evt) {
      const msg = JSON.parse(evt.data as string) as ServerMessage;
      if (msg.type === "welcome") {
        setRole(msg.role);
        setPlayerIndex(msg.playerIndex);
        stateRef.current = msg.state;
      } else if (msg.type === "state") {
        stateRef.current = msg.state;
        setStatus(msg.state.status);
        setWinner(msg.state.winner);
        setScores((prev) =>
          prev[0] === msg.state.scores[0] && prev[1] === msg.state.scores[1]
            ? prev
            : [msg.state.scores[0], msg.state.scores[1]],
        );
        setCounts((prev) =>
          prev.players === msg.players && prev.spectators === msg.spectators
            ? prev
            : { players: msg.players, spectators: msg.spectators },
        );
      }
    },
  });

  const sendMessage = useCallback(
    (msg: ClientMessage) => socket.send(JSON.stringify(msg)),
    [socket],
  );

  useEffect(() => {
    if (role !== "player") return;
    const held = { up: false, down: false };
    const apply = () =>
      sendMessage({ type: "input", dir: held.up === held.down ? 0 : held.up ? -1 : 1 });
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") {
        held.up = down;
        apply();
        e.preventDefault();
      } else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") {
        held.down = down;
        apply();
        e.preventDefault();
      }
    };
    const keydown = onKey(true);
    const keyup = onKey(false);
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
    };
  }, [role, sendMessage]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      drawFrame(ctx, stateRef.current);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <main className="game">
      <header className="hud">
        <span data-testid="score" className="score">
          {scores[0]} : {scores[1]}
        </span>
        <span data-testid="status" className="status">
          {statusLabel(status, winner, playerIndex)}
        </span>
        <span data-testid="presence" className="presence">
          {counts.players}/2 players · {counts.spectators} watching
          {role === "spectator"
            ? " · Spectating"
            : role === "player" && playerIndex !== null
              ? ` · You are Player ${playerIndex + 1}`
              : ""}
        </span>
      </header>
      <canvas ref={canvasRef} width={COURT_WIDTH} height={COURT_HEIGHT} data-testid="court" />
      {role === "player" && status === "gameover" ? (
        <button className="button" onClick={() => sendMessage({ type: "restart" })}>
          Play again
        </button>
      ) : null}
      {role === "player" ? <p className="hint">Move with W/S or the arrow keys</p> : null}
    </main>
  );
}

function statusLabel(
  status: MatchStatus,
  winner: PlayerIndex | null,
  playerIndex: PlayerIndex | null,
): string {
  switch (status) {
    case "waiting":
      return "Waiting for an opponent...";
    case "countdown":
      return "Get ready...";
    case "playing":
      return "";
    case "gameover":
      if (winner === null) return "Game over";
      if (playerIndex !== null) return winner === playerIndex ? "You win!" : "You lose";
      return `Player ${winner + 1} wins`;
  }
}

function drawFrame(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0, 0, COURT_WIDTH, COURT_HEIGHT);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.setLineDash([10, 14]);
  ctx.beginPath();
  ctx.moveTo(COURT_WIDTH / 2, 0);
  ctx.lineTo(COURT_WIDTH / 2, COURT_HEIGHT);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#e8eefc";
  ctx.fillRect(PADDLE_MARGIN, state.paddles[0].y, PADDLE_WIDTH, PADDLE_HEIGHT);
  ctx.fillRect(
    COURT_WIDTH - PADDLE_MARGIN - PADDLE_WIDTH,
    state.paddles[1].y,
    PADDLE_WIDTH,
    PADDLE_HEIGHT,
  );
  ctx.beginPath();
  ctx.arc(state.ball.x, state.ball.y, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  if (state.status === "countdown") {
    ctx.font = "bold 64px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(String(Math.ceil(state.countdown)), COURT_WIDTH / 2, COURT_HEIGHT / 2 - 40);
  }
}
