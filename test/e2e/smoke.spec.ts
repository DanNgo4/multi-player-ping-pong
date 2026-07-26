import { expect, test, type Browser, type Page } from "@playwright/test";

async function newPlayer(browser: Browser, name: string, viewport?: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext(
    viewport ? { viewport, hasTouch: true } : {},
  );
  await context.addInitScript(
    (value) => window.localStorage.setItem("pingpong.name", value),
    name,
  );
  return context.newPage();
}

test("lobby renders and persists the player name", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Ping Pong Live" })).toBeVisible();
  await expect(page.getByTestId("create-match")).toBeVisible();
  await page.getByTestId("name-input").fill("Alice");
  await page.reload();
  await expect(page.getByTestId("name-input")).toHaveValue("Alice");
});

test("named players, spectator chat, and mid-match side join", async ({ browser }) => {
  const room = `e2e-${Date.now().toString(36)}`;

  const alice = await newPlayer(browser, "Alice");
  await alice.goto(`/play/${room}`);
  await expect(alice.getByTestId("status")).toHaveText(/waiting/i, { timeout: 15_000 });
  await expect(alice.getByTestId("presence")).toContainText("You are on Team 1");
  await expect(alice.getByTestId("match-title")).toHaveText("Alice's match");
  await expect(alice.getByTestId("team-0")).toContainText("Alice");

  const bob = await newPlayer(browser, "Bob");
  await bob.goto(`/play/${room}`);
  await expect(bob.getByTestId("presence")).toContainText("You are on Team 2", {
    timeout: 15_000,
  });
  await expect(alice.getByTestId("status")).not.toHaveText(/waiting/i, { timeout: 10_000 });
  await expect(alice.getByTestId("presence")).toContainText("2/4 players");
  await expect(alice.getByTestId("team-1")).toContainText("Bob");
  await expect(bob.getByTestId("match-title")).toHaveText("Alice's match");

  const carol = await newPlayer(browser, "Carol");
  await carol.goto(`/watch/${room}`);
  await expect(carol.getByTestId("presence")).toContainText("Spectating", {
    timeout: 15_000,
  });
  await expect(carol.getByTestId("switch-view")).toBeVisible();
  await expect(alice.getByTestId("watchers")).toContainText("Carol");

  // Spectator chat reaches the players.
  await carol.getByTestId("chat-input").fill("go alice!");
  await carol.getByTestId("chat-send").click();
  await expect(alice.getByTestId("chat-log")).toContainText("Carol");
  await expect(alice.getByTestId("chat-log")).toContainText("go alice!");

  // A late joiner gets the chat history replayed.
  const dave = await newPlayer(browser, "Dave");
  await dave.goto(`/watch/${room}`);
  await expect(dave.getByTestId("chat-log")).toContainText("go alice!", { timeout: 15_000 });

  // Spectator grabs a free seat on Team 1 mid-match; score continues.
  await carol.getByTestId("join-side-0").click();
  await expect(carol.getByTestId("presence")).toContainText("You are on Team 1", {
    timeout: 10_000,
  });
  await expect(alice.getByTestId("presence")).toContainText("3/4 players");
  await expect(alice.getByTestId("team-0")).toContainText("Carol");
});

test("match is playable on a mobile viewport", async ({ browser }) => {
  const room = `e2e-m-${Date.now().toString(36)}`;
  const dana = await newPlayer(browser, "Dana", { width: 390, height: 844 });
  await dana.goto(`/play/${room}`);
  await expect(dana.getByTestId("status")).toHaveText(/waiting/i, { timeout: 15_000 });
  await expect(dana.getByTestId("court")).toBeVisible();
  await expect(dana.getByTestId("presence")).toContainText("You are on Team 1");
  // The canvas must not overflow the small viewport.
  const box = await dana.getByTestId("court").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(390);
  await expect(dana.getByTestId("chat-input")).toBeVisible();
});
