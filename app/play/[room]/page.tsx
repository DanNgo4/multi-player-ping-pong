import GameGate from "@/app/_components/GameGate";

export default async function PlayPage({ params }: { params: Promise<{ room: string }> }) {
  const { room } = await params;
  return <GameGate room={room} intent="play" />;
}
