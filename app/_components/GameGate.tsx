"use client";

import dynamic from "next/dynamic";

// The PartyKit socket needs a browser; skip server prerendering entirely.
const GameClient = dynamic(() => import("./GameClient"), { ssr: false });

export default function GameGate(props: { room: string; intent: "play" | "watch" }) {
  return <GameClient {...props} />;
}
