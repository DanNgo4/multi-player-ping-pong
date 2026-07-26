"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import usePartySocket from "partysocket/react";
import { PARTYKIT_HOST } from "@/lib/party-host";
import type { LobbyServerMessage, MatchInfo } from "@/lib/protocol";

export default function Lobby() {
  const router = useRouter();
  const [matches, setMatches] = useState<MatchInfo[]>([]);
  const [code, setCode] = useState("");

  usePartySocket({
    host: PARTYKIT_HOST,
    party: "lobby",
    room: "index",
    onMessage(evt) {
      const msg = JSON.parse(evt.data as string) as LobbyServerMessage;
      if (msg.type === "matches") setMatches(msg.matches);
    },
  });

  const createMatch = () => {
    const id = Math.random().toString(36).slice(2, 8);
    router.push(`/play/${id}`);
  };

  return (
    <main className="lobby">
      <h1>Ping Pong Live</h1>
      <p>Play a friend, or watch a live match as it happens.</p>
      <div className="actions">
        <button className="button" onClick={createMatch} data-testid="create-match">
          Create match
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = code.trim();
            if (trimmed) router.push(`/play/${trimmed}`);
          }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Room code"
            aria-label="Room code"
          />
          <button className="button" type="submit">
            Join
          </button>
        </form>
      </div>
      <section>
        <h2>Live matches</h2>
        {matches.length === 0 ? (
          <p data-testid="no-matches">No live matches right now. Create one!</p>
        ) : (
          <ul className="match-list" data-testid="match-list">
            {matches.map((m) => (
              <li key={m.id}>
                <span>Room {m.id}</span>
                <span>
                  {m.scores[0]} : {m.scores[1]}
                </span>
                <span>{m.status}</span>
                <span>
                  {m.players}/2 players, {m.spectators} watching
                </span>
                {m.players < 2 && m.status === "waiting" ? (
                  <Link href={`/play/${m.id}`}>Join</Link>
                ) : null}
                <Link href={`/watch/${m.id}`}>Watch</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
