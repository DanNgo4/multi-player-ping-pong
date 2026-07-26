"use client";

import dynamic from "next/dynamic";

// The PartyKit socket needs a browser; skip server prerendering entirely.
const Lobby = dynamic(() => import("./Lobby"), { ssr: false });

export default function LobbyGate() {
  return <Lobby />;
}
