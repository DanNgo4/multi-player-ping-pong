/** PartyKit host for client connections; localhost in dev, set via env on Vercel. */
export const PARTYKIT_HOST = process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999";
