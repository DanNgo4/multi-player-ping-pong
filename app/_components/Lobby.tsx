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
  type MatchResult,
} from "@/lib/protocol";

export default function Lobby() {
  const router = useRouter();
  const [matches, setMatches] = useState<MatchInfo[]>([]);
  const [results, setResults] = useState<MatchResult[]>([]);
  const [code, setCode] = useState("");
  const [name, setName] = useState<string>(() => loadName());

  usePartySocket({
    host: PARTYKIT_HOST,
    party: "lobby",
    room: "index",
    onMessage(evt) {
      const msg = JSON.parse(evt.data as string) as LobbyServerMessage;
      if (msg.type === "matches") {
        setMatches(msg.matches);
        setResults(msg.results ?? []);
      }
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
      <section>
        <h2>Leaderboard</h2>
        {results.length === 0 ? (
          <p>No finished matches yet.</p>
        ) : (
          <ul className="match-list" data-testid="leaderboard">
            {leaderboard(results).map((row) => (
              <li key={row.name}>
                <span className="match-name">{row.name}</span>
                <span>{Math.round((row.wins / row.played) * 100)}%</span>
                <span className="match-players">
                  {row.wins} {row.wins === 1 ? "win" : "wins"} · {row.played} played
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>Recent matches</h2>
        {results.length === 0 ? (
          <p data-testid="no-results">Finished games will show up here.</p>
        ) : (
          <ul className="match-list" data-testid="result-list">
            {results.map((r) => (
              <li key={`${r.id}-${r.endedAt}`}>
                <span className="match-name">{r.title}</span>
                <span className="match-players">
                  {teamLabel(r, 0)} vs {teamLabel(r, 1)}
                </span>
                <span>
                  {r.scores[0]} : {r.scores[1]}
                </span>
                <span className="match-players">
                  {teamLabel(r, r.winner)} won · {timeLabel(r.endedAt)}
                </span>
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

function teamLabel(r: MatchResult, side: 0 | 1): string {
  const team = r.names[side];
  return team.length > 0 ? team.join(" & ") : "Empty side";
}

function timeLabel(endedAt: number): string {
  return new Date(endedAt).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Wins and games played per display name, ranked by win rate. */
function leaderboard(
  results: MatchResult[],
): { name: string; wins: number; played: number }[] {
  const rows = new Map<string, { name: string; wins: number; played: number }>();
  for (const r of results) {
    ([0, 1] as const).forEach((side) => {
      for (const name of r.names[side]) {
        const row = rows.get(name) ?? { name, wins: 0, played: 0 };
        row.played += 1;
        if (side === r.winner) row.wins += 1;
        rows.set(name, row);
      }
    });
  }
  // Equal win rates rank by volume, so 2/2 sits above 1/1.
  return [...rows.values()]
    .sort((a, b) => b.wins / b.played - a.wins / a.played || b.played - a.played)
    .slice(0, 10);
}
