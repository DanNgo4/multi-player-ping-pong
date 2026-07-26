import type { DurableObjectNamespace } from "@cloudflare/workers-types";

/** Worker bindings; names match the party segment in /parties/:party/:room URLs. */
export interface Env {
  main: DurableObjectNamespace;
  lobby: DurableObjectNamespace;
}
