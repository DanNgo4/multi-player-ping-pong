"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
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
  MAX_PLAYERS,
  MAX_SEATS_PER_SIDE,
  type GameState,
  type MatchStatus,
  type PlayerIndex,
  type Racket,
} from "@/lib/game/types";
import { loadName } from "@/lib/name-storage";
import { PARTYKIT_HOST } from "@/lib/party-host";
import {
  matchTitle,
  type ClientMessage,
  type Role,
  type SeatNames,
  type ServerMessage,
} from "@/lib/protocol";

const CANVAS_W = 800;
const CANVAS_H = 500;
/** Canvas backing store is rendered at 2x for crispness on hidpi/mobile. */
const DPR = 2;

// Perspective camera sitting behind the viewer's end of the table.
const FOV = 420;
const CAM_BACK = 140;
const CAM_HEIGHT = 190;
const PIXELS = 2.2;
const CX = CANVAS_W / 2;
const CY = 96;

/** If the ball moved further than this between snapshots it teleported (serve reset). */
const SNAP_DISTANCE = 200;
const MAX_CHAT_LINES = 50;

const NEAR_COLORS = ["#e33d2e", "#f2913d"];
const FAR_COLORS = ["#3f6cf0", "#7fa4ff"];

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
function unprojectOwnPlane(px: number, py: number, side: PlayerIndex): Racket {
  const planeZ = PLAYER_Z[side];
  const flip = side === 1;
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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

interface Snapshot {
  state: GameState;
  at: number;
}

/** Kept module-level so snapshot stamping stays out of React's render scope. */
function stamp(state: GameState): Snapshot {
  return { state, at: performance.now() };
}

/**
 * Interpolates ball and racket positions between the two latest snapshots so
 * 30 Hz network updates look smooth at display refresh rate.
 */
function interpolate(prev: Snapshot | null, cur: Snapshot, now: number): GameState {
  if (!prev || cur.state.status !== "playing" || !cur.state.live || !prev.state.live) {
    return cur.state;
  }
  const span = cur.at - prev.at;
  if (span <= 0 || span > 250) return cur.state;
  if (Math.abs(cur.state.ball.z - prev.state.ball.z) > SNAP_DISTANCE) return cur.state;
  const t = Math.min(Math.max((now - cur.at) / span, 0), 1);
  return {
    ...cur.state,
    ball: {
      ...cur.state.ball,
      x: lerp(prev.state.ball.x, cur.state.ball.x, t),
      y: lerp(prev.state.ball.y, cur.state.ball.y, t),
      z: lerp(prev.state.ball.z, cur.state.ball.z, t),
    },
    seats: cur.state.seats.map((seat) => {
      const before = prev.state.seats.find((s) => s.id === seat.id);
      if (!before) return seat;
      return {
        ...seat,
        racket: {
          x: lerp(before.racket.x, seat.racket.x, t),
          y: lerp(before.racket.y, seat.racket.y, t),
        },
      };
    }),
  };
}

interface ChatLine {
  from: string;
  text: string;
}

interface SeatMeta {
  side: PlayerIndex;
  name: string | null;
}

interface Props {
  room: string;
  intent: "play" | "watch";
}

export default function GameClient({ room, intent }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const prevSnapRef = useRef<Snapshot | null>(null);
  const curSnapRef = useRef<Snapshot>({ state: createInitialState(), at: 0 });
  const namesRef = useRef<SeatNames>([]);
  const racketRef = useRef<Racket>({ x: 0, y: HIT_HEIGHT });
  const roleRef = useRef<Role | null>(null);
  const seatIdRef = useRef<string | null>(null);
  const sideRef = useRef<PlayerIndex | null>(null);
  const viewEndRef = useRef<PlayerIndex>(0);
  const [name] = useState<string>(() => loadName());
  const [role, setRole] = useState<Role | null>(null);
  const [side, setSide] = useState<PlayerIndex | null>(null);
  const [scores, setScores] = useState<[number, number]>([0, 0]);
  const [status, setStatus] = useState<MatchStatus>("waiting");
  const [winner, setWinner] = useState<PlayerIndex | null>(null);
  const [counts, setCounts] = useState({ players: 0, spectators: 0 });
  const [seatMeta, setSeatMeta] = useState<SeatMeta[]>([]);
  const [watchers, setWatchers] = useState<string[]>([]);
  const [creator, setCreator] = useState<string | null>(null);
  const [viewEnd, setViewEnd] = useState<PlayerIndex>(0);
  const [chatLog, setChatLog] = useState<ChatLine[]>([]);
  const [chatText, setChatText] = useState("");

  const socket = usePartySocket({
    host: PARTYKIT_HOST,
    room,
    query: { intent, name },
    onMessage(evt) {
      const msg = JSON.parse(evt.data as string) as ServerMessage;
      if (msg.type === "welcome") {
        setRole(msg.role);
        setSide(msg.side);
        roleRef.current = msg.role;
        seatIdRef.current = msg.seatId;
        sideRef.current = msg.side;
        // Start the local racket where the server seated us (duo seats are
        // offset sideways) so teammates don't stack until the first input.
        const ownSeat = msg.state.seats.find((s) => s.id === msg.seatId);
        if (ownSeat) racketRef.current = { ...ownSeat.racket };
        prevSnapRef.current = null;
        curSnapRef.current = stamp(msg.state);
        namesRef.current = msg.names;
        setChatLog(msg.chat);
        applyMeta(msg.state, msg.names, msg.watchers, msg.creator);
      } else if (msg.type === "state") {
        prevSnapRef.current = curSnapRef.current;
        curSnapRef.current = stamp(msg.state);
        namesRef.current = msg.names;
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
        applyMeta(msg.state, msg.names, msg.watchers, msg.creator);
      } else if (msg.type === "chat") {
        setChatLog((prev) => [...prev.slice(-(MAX_CHAT_LINES - 1)), msg]);
      }
    },
  });

  const applyMeta = (
    state: GameState,
    names: SeatNames,
    nextWatchers: string[],
    nextCreator: string | null,
  ) => {
    const meta = state.seats.map((s, i) => ({ side: s.side, name: names[i] ?? null }));
    setSeatMeta((prev) =>
      prev.length === meta.length &&
      prev.every((m, i) => m.side === meta[i]?.side && m.name === meta[i]?.name)
        ? prev
        : meta,
    );
    setWatchers((prev) =>
      prev.length === nextWatchers.length && prev.every((w, i) => w === nextWatchers[i])
        ? prev
        : nextWatchers,
    );
    setCreator(nextCreator);
  };

  const sendMessage = useCallback(
    (msg: ClientMessage) => socket.send(JSON.stringify(msg)),
    [socket],
  );

  // Pointer (mouse or touch) moves the racket; positions stream at ~30 Hz.
  useEffect(() => {
    if (role !== "player" || side === null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const track = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
      const py = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
      racketRef.current = unprojectOwnPlane(px, py, side);
    };
    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      track(e);
    };
    canvas.addEventListener("pointermove", track);
    canvas.addEventListener("pointerdown", onPointerDown);

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
      canvas.removeEventListener("pointermove", track);
      canvas.removeEventListener("pointerdown", onPointerDown);
      clearInterval(sender);
    };
  }, [role, side, sendMessage]);

  // Render loop: draws the latest snapshot, interpolated from the previous one.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      const viewerSide = sideRef.current ?? viewEndRef.current;
      const localRacket = roleRef.current === "player" ? racketRef.current : null;
      drawFrame(
        ctx,
        interpolate(prevSnapRef.current, curSnapRef.current, performance.now()),
        namesRef.current,
        viewerSide,
        seatIdRef.current,
        localRacket,
      );
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    viewEndRef.current = viewEnd;
  }, [viewEnd]);

  useEffect(() => {
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatLog]);

  const sendChat = (e: FormEvent) => {
    e.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    sendMessage({ type: "chat", text });
    setChatText("");
  };

  const sideCounts: [number, number] = [
    seatMeta.filter((m) => m.side === 0).length,
    seatMeta.filter((m) => m.side === 1).length,
  ];

  const teamLabel = (team: PlayerIndex): string => {
    const members = seatMeta
      .filter((m) => m.side === team)
      .map((m, i) => m.name ?? `Player ${i + 1}`);
    return members.length > 0 ? members.join(" & ") : `Team ${team + 1}`;
  };

  const joinableSides = ([0, 1] as const).filter(
    (s) =>
      role === "spectator" &&
      counts.players < MAX_PLAYERS &&
      sideCounts[s] < MAX_SEATS_PER_SIDE,
  );

  const watcherLabel =
    watchers.length <= 4
      ? watchers.join(", ")
      : `${watchers.slice(0, 4).join(", ")} +${watchers.length - 4} more`;

  return (
    <main className="game">
      <header className="hud">
        <h1 className="match-title" data-testid="match-title">
          {matchTitle(creator, room)}
        </h1>
        <div className="scoreline">
          <span className="player-name" data-testid="team-0">
            {teamLabel(0)}
          </span>
          <span data-testid="score" className="score">
            {scores[0]} : {scores[1]}
          </span>
          <span className="player-name" data-testid="team-1">
            {teamLabel(1)}
          </span>
        </div>
        <span data-testid="status" className="status">
          {statusLabel(status, winner, side)}
        </span>
        <span data-testid="presence" className="presence">
          {counts.players}/{MAX_PLAYERS} players · {counts.spectators} watching
          {role === "spectator"
            ? " · Spectating"
            : role === "player" && side !== null
              ? ` · You are on Team ${side + 1}`
              : ""}
        </span>
        {watchers.length > 0 ? (
          <span className="watchers" data-testid="watchers">
            Watching: {watcherLabel}
          </span>
        ) : null}
      </header>
      <div className="game-layout">
        <div className="stage">
          <canvas
            ref={canvasRef}
            width={CANVAS_W * DPR}
            height={CANVAS_H * DPR}
            data-testid="court"
          />
          <div className="stage-controls">
            {joinableSides.map((s) => (
              <button
                key={s}
                className="button"
                data-testid={`join-side-${s}`}
                onClick={() => sendMessage({ type: "join", side: s })}
              >
                Play on Team {s + 1} ({sideCounts[s]}/{MAX_SEATS_PER_SIDE})
              </button>
            ))}
            {role === "spectator" ? (
              <button
                className="button secondary"
                data-testid="switch-view"
                onClick={() => setViewEnd((v) => (v === 0 ? 1 : 0))}
              >
                Switch view
              </button>
            ) : null}
            {role === "player" && status === "gameover" ? (
              <button
                className="button"
                data-testid="rematch"
                onClick={() => sendMessage({ type: "restart" })}
              >
                Rematch
              </button>
            ) : null}
          </div>
          {role === "player" ? (
            <p className="hint">
              Move your racket with mouse or touch — a fast swipe adds power, swipe up
              for topspin, chop down for backspin, sideways to curve it
            </p>
          ) : null}
        </div>
        <aside className="chat">
          <h2>Chat</h2>
          <div className="chat-log" ref={chatLogRef} data-testid="chat-log">
            {chatLog.map((line, i) => (
              <p key={i}>
                <strong>{line.from}:</strong> {line.text}
              </p>
            ))}
          </div>
          <form onSubmit={sendChat}>
            <input
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              placeholder="Say something..."
              aria-label="Chat message"
              maxLength={140}
              data-testid="chat-input"
            />
            <button className="button" type="submit" data-testid="chat-send">
              Send
            </button>
          </form>
        </aside>
      </div>
    </main>
  );
}

function statusLabel(
  status: MatchStatus,
  winner: PlayerIndex | null,
  side: PlayerIndex | null,
): string {
  switch (status) {
    case "waiting":
      return "Waiting for players...";
    case "countdown":
      return "Get ready...";
    case "playing":
      return "";
    case "gameover":
      if (winner === null) return "Game over";
      if (side !== null) return winner === side ? "Your team wins!" : "Your team loses";
      return `Team ${winner + 1} wins`;
  }
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  names: SeatNames,
  viewerSide: PlayerIndex,
  mySeatId: string | null,
  localRacket: Racket | null,
): void {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const flip = viewerSide === 1;
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

  const labelFor = (seatIndex: number, isMine: boolean): string => {
    if (isMine) return "You";
    return names[seatIndex] ?? `Player ${seatIndex + 1}`;
  };

  // Far side rackets (the viewer's opponents), with name labels.
  let farCount = 0;
  state.seats.forEach((seat, i) => {
    if (seat.side === viewerSide) return;
    const p = project(seat.racket.x, seat.racket.y, PLAYER_Z[seat.side], flip);
    drawRacket(ctx, p, FAR_COLORS[farCount % FAR_COLORS.length]!);
    drawLabel(ctx, p, labelFor(i, false));
    farCount += 1;
  });

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

  // Near side rackets last so they overlap everything, like first-person
  // paddles. Teammate first, the viewer's own racket on top.
  const nearSeats = state.seats
    .map((seat, i) => ({ seat, i }))
    .filter(({ seat }) => seat.side === viewerSide)
    .sort((a, b) => Number(a.seat.id === mySeatId) - Number(b.seat.id === mySeatId));
  let nearCount = 0;
  for (const { seat, i } of nearSeats) {
    const isMine = seat.id === mySeatId;
    const racket = isMine && localRacket ? localRacket : seat.racket;
    const p = project(racket.x, racket.y, PLAYER_Z[seat.side], flip);
    drawRacket(ctx, p, NEAR_COLORS[isMine ? 0 : (1 + nearCount) % NEAR_COLORS.length]!);
    drawLabel(ctx, p, labelFor(i, isMine));
    nearCount += 1;
  }

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

/** Name tag floating above a racket so everyone can tell whose it is. */
function drawLabel(ctx: CanvasRenderingContext2D, p: Projected, text: string): void {
  const size = Math.max(11, Math.round(16 * p.scale * 0.6));
  ctx.font = `600 ${size}px system-ui`;
  ctx.textAlign = "center";
  const y = p.y - RACKET_RADIUS * p.scale * 1.35;
  ctx.fillStyle = "rgba(6, 10, 20, 0.55)";
  const w = ctx.measureText(text).width + 10;
  ctx.fillRect(p.x - w / 2, y - size, w, size + 6);
  ctx.fillStyle = "#f3f5f9";
  ctx.fillText(text, p.x, y);
}
