"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import usePartySocket from "partysocket/react";
import { MAX_PLAYERS, MAX_SEATS_PER_SIDE } from "@/lib/game/types";
import { loadName, saveName } from "@/lib/name-storage";
import { PARTYKIT_HOST } from "@/lib/party-host";
import {
  matchTitle,
  type LobbyServerMessage,
  type MatchInfo,
} from "@/lib/protocol";

export default function Lobby() {
  const router = useRouter();
  const [matches, setMatches] = useState<MatchInfo[]>([]);
  const [code, setCode] = useState("");
  const [name, setName] = useState<string>(() => loadName());

  usePartySocket({
    host: PARTYKIT_HOST,
    party: "lobby",
    room: "index",
    onMessage(evt) {
      const msg = JSON.parse(evt.data as string) as LobbyServerMessage;
      if (msg.type === "matches") setMatches(msg.matches);
    },
  });

  const updateName = (value: string) => {
    setName(value);
    saveName(value);
  };

  const createMatch = () => {
    const id = Math.random().toString(36).slice(2, 8);
    router.push(`/play/${id}`);
  };

  return (
    <main className="lobby">
      <h1>Ping Pong Live</h1>
      <p>Play a friend, or watch a live match as it happens.</p>
      <label className="name-field">
        Your name
        <input
          value={name}
          onChange={(e) => updateName(e.target.value)}
          placeholder="Enter your name"
          aria-label="Your name"
          maxLength={24}
          data-testid="name-input"
        />
      </label>
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
                <span className="match-name">{matchTitle(m.creator, m.id)}</span>
                <span className="match-players">{playersLabel(m)}</span>
                <span>
                  {m.scores[0]} : {m.scores[1]}
                </span>
                <span>{m.status}</span>
                <span>
                  {m.players}/{MAX_PLAYERS} playing · {m.spectators} watching
                </span>
                {m.sides.some((count) => count < MAX_SEATS_PER_SIDE) ? (
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

function playersLabel(m: MatchInfo): string {
  const filled = m.names.filter((n): n is string => n !== null);
  if (filled.length === 0) return "Waiting for players";
  return filled.join(", ");
}
