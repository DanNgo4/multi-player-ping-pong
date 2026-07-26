import { routePartykitRequest } from "partyserver";
import type { Env } from "./env";

export { MatchServer } from "./match";
export { LobbyServer } from "./lobby";

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const routed = await routePartykitRequest(
      request as Parameters<typeof routePartykitRequest>[0],
      env as unknown as Parameters<typeof routePartykitRequest>[1],
    );
    return (routed as Response | null) ?? new Response("Not found", { status: 404 });
  },
};

export default worker;
