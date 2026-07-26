"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import usePartySocket from "partysocket/react";
import {
  BALL_RADIUS,
  HIT_HEIGHT,
  NET_HEIGHT,
  NET_Z,
  PLAYER_Z,
  RACKET_MAX_X,
  RACKET_MAX_Y,
  RACKET_RADIUS,
  TABLE_LENGTH,
  TABLE_WIDTH,
} from "@/lib/game/constants";
import {
  createInitialState,
  type GameState,
  type MatchStatus,
  type PlayerIndex,
  type Racket,
} from "@/lib/game/types";
import { PARTYKIT_HOST } from "@/lib/party-host";
import type { ClientMessage, Role, ServerMessage } from "@/lib/protocol";

const CANVAS_W = 800;
const CANVAS_H = 500;

// Perspective camera sitting behind the viewer's end of the table.
const FOV = 420;
const CAM_BACK = 140;
const CAM_HEIGHT = 190;
const PIXELS = 2.2;
const CX = CANVAS_W / 2;
const CY = 96;

interface Projected {
  x: number;
  y: number;
  scale: number;
}

function project(x: number, y: number, z: number, flip: boolean): Projected {
  const viewZ = flip ? TABLE_LENGTH - z : z;
  const viewX = flip ? -x : x;
  const scale = (FOV / (FOV + CAM_BACK + viewZ)) * PIXELS;
  return { x: CX + viewX * scale, y: CY + (CAM_HEIGHT - y) * scale, scale };
}

/** Inverse of project() in the viewer's own racket plane, for mouse input. */
function unprojectOwnPlane(px: number, py: number, viewer: PlayerIndex): Racket {
  const planeZ = PLAYER_Z[viewer];
  const flip = viewer === 1;
  const viewZ = flip ? TABLE_LENGTH - planeZ : planeZ;
  const scale = (FOV / (FOV + CAM_BACK + viewZ)) * PIXELS;
  const viewX = (px - CX) / scale;
  const x = flip ? -viewX : viewX;
  const y = CAM_HEIGHT - (py - CY) / scale;
  return {
    x: Math.min(Math.max(x, -RACKET_MAX_X), RACKET_MAX_X),
    y: Math.min(Math.max(y, 0), RACKET_MAX_Y),
  };
}

interface Props {
  room: string;
  intent: "play" | "watch";
}

export default function GameClient({ room, intent }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState>(createInitialState());
  const racketRef = useRef<Racket>({ x: 0, y: HIT_HEIGHT });
  const roleRef = useRef<Role | null>(null);
  const playerIndexRef = useRef<PlayerIndex | null>(null);
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
        roleRef.current = msg.role;
        playerIndexRef.current = msg.playerIndex;
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

  // Mouse moves the racket; positions stream to the server at ~30 Hz.
  useEffect(() => {
    if (role !== "player" || playerIndex === null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
      const py = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
      racketRef.current = unprojectOwnPlane(px, py, playerIndex);
    };
    canvas.addEventListener("pointermove", onPointerMove);

    let lastSent = "";
    const sender = setInterval(() => {
      const r = racketRef.current;
      const key = `${r.x.toFixed(1)}:${r.y.toFixed(1)}`;
      if (key !== lastSent) {
        lastSent = key;
        sendMessage({ type: "racket", x: r.x, y: r.y });
      }
    }, 33);

    return () => {
      canvas.removeEventListener("pointermove", onPointerMove);
      clearInterval(sender);
    };
  }, [role, playerIndex, sendMessage]);

  // Render loop.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      const viewer = playerIndexRef.current ?? 0;
      const localRacket = roleRef.current === "player" ? racketRef.current : null;
      drawFrame(ctx, stateRef.current, viewer, localRacket);
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
      <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} data-testid="court" />
      {role === "player" && status === "gameover" ? (
        <button className="button" onClick={() => sendMessage({ type: "restart" })}>
          Play again
        </button>
      ) : null}
      {role === "player" ? (
        <p className="hint">Move your racket with the mouse to return the ball</p>
      ) : null}
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

function drawFrame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewer: PlayerIndex,
  localRacket: Racket | null,
): void {
  const flip = viewer === 1;
  const halfW = TABLE_WIDTH / 2;

  // Room: wall above the horizon, floor below.
  ctx.fillStyle = "#2c2019";
  ctx.fillRect(0, 0, CANVAS_W, 250);
  ctx.fillStyle = "#6b4f33";
  ctx.fillRect(0, 250, CANVAS_W, CANVAS_H - 250);

  // Table top.
  const nearL = project(-halfW, 0, 0, flip);
  const nearR = project(halfW, 0, 0, flip);
  const farR = project(halfW, 0, TABLE_LENGTH, flip);
  const farL = project(-halfW, 0, TABLE_LENGTH, flip);
  ctx.fillStyle = "#c07818";
  ctx.beginPath();
  ctx.moveTo(nearL.x, nearL.y);
  ctx.lineTo(nearR.x, nearR.y);
  ctx.lineTo(farR.x, farR.y);
  ctx.lineTo(farL.x, farL.y);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#f3f5f9";
  ctx.lineWidth = 3;
  ctx.stroke();

  // Centre line.
  const centreNear = project(0, 0, 0, flip);
  const centreFar = project(0, 0, TABLE_LENGTH, flip);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(centreNear.x, centreNear.y);
  ctx.lineTo(centreFar.x, centreFar.y);
  ctx.stroke();

  // Net.
  const netL = project(-halfW - 12, 0, NET_Z, flip);
  const netR = project(halfW + 12, 0, NET_Z, flip);
  const netTopL = project(-halfW - 12, NET_HEIGHT, NET_Z, flip);
  const netTopR = project(halfW + 12, NET_HEIGHT, NET_Z, flip);
  ctx.fillStyle = "rgba(235, 240, 248, 0.4)";
  ctx.beginPath();
  ctx.moveTo(netL.x, netL.y);
  ctx.lineTo(netR.x, netR.y);
  ctx.lineTo(netTopR.x, netTopR.y);
  ctx.lineTo(netTopL.x, netTopL.y);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#f3f5f9";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(netTopL.x, netTopL.y);
  ctx.lineTo(netTopR.x, netTopR.y);
  ctx.stroke();

  // Far racket (the viewer's opponent, or player 2 for spectators).
  const farIndex: PlayerIndex = viewer === 0 ? 1 : 0;
  const farRacket = state.rackets[farIndex];
  drawRacket(ctx, project(farRacket.x, farRacket.y, PLAYER_Z[farIndex], flip), "#3f6cf0");

  // Ball shadow, then ball.
  const showBall = state.status === "playing" || state.status === "countdown";
  if (showBall) {
    const shadow = project(state.ball.x, 0, state.ball.z, flip);
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.beginPath();
    ctx.ellipse(
      shadow.x,
      shadow.y,
      Math.max(3, BALL_RADIUS * shadow.scale),
      Math.max(1.5, BALL_RADIUS * shadow.scale * 0.35),
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();

    const ball = project(state.ball.x, state.ball.y, state.ball.z, flip);
    ctx.fillStyle = "#ffd34d";
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, Math.max(3, BALL_RADIUS * ball.scale * 1.2), 0, Math.PI * 2);
    ctx.fill();
  }

  // Near racket last so it overlaps everything, like a first-person paddle.
  const nearRacket = localRacket ?? state.rackets[viewer];
  drawRacket(ctx, project(nearRacket.x, nearRacket.y, PLAYER_Z[viewer], flip), "#e33d2e");

  if (state.status === "countdown") {
    ctx.fillStyle = "#f3f5f9";
    ctx.font = "bold 72px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(String(Math.ceil(state.countdown)), CX, 200);
  }
}

function drawRacket(ctx: CanvasRenderingContext2D, p: Projected, color: string): void {
  const r = RACKET_RADIUS * p.scale;
  // Handle.
  ctx.strokeStyle = "#d8a24a";
  ctx.lineWidth = Math.max(3, r * 0.28);
  ctx.beginPath();
  ctx.moveTo(p.x, p.y + r * 0.6);
  ctx.lineTo(p.x + r * 0.5, p.y + r * 1.5);
  ctx.stroke();
  // Blade.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, r * 0.85, r, -0.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
  ctx.lineWidth = 2;
  ctx.stroke();
}
