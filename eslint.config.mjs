import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
      ".partykit/**",
      ".wrangler/**",
      "next-env.d.ts",
    ],
  },
  ...coreWebVitals,
  ...nextTypescript,
  {
    // lib/game is a pure engine: it must run identically in the PartyKit tick
    // and in client-side prediction, with no framework or network coupling.
    files: ["lib/game/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "react",
                "react/*",
                "react-dom",
                "react-dom/*",
                "next",
                "next/*",
                "partyserver",
                "partyserver/*",
                "partysocket",
                "partysocket/*",
              ],
              message: "lib/game is a pure engine: no framework or network imports.",
            },
          ],
        },
      ],
    },
  },
  {
    // The app renders snapshots and sends inputs; server logic stays in party/.
    files: ["app/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/party/*", "@/party/*"],
              message: "app code must not import server party code; share types via lib/protocol.ts.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
