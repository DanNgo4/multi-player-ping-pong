import { expect, test } from "@playwright/test";

test("lobby renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Ping Pong Live" })).toBeVisible();
  await expect(page.getByTestId("create-match")).toBeVisible();
});

test("two players start a match and a spectator can watch", async ({ browser }) => {
  const room = `e2e-${Date.now().toString(36)}`;

  const player1 = await (await browser.newContext()).newPage();
  await player1.goto(`/play/${room}`);
  await expect(player1.getByTestId("status")).toHaveText(/waiting/i, { timeout: 15_000 });
  await expect(player1.getByTestId("presence")).toContainText("You are Player 1");

  const player2 = await (await browser.newContext()).newPage();
  await player2.goto(`/play/${room}`);
  await expect(player2.getByTestId("presence")).toContainText("You are Player 2", {
    timeout: 15_000,
  });
  await expect(player1.getByTestId("status")).not.toHaveText(/waiting/i, { timeout: 10_000 });
  await expect(player1.getByTestId("presence")).toContainText("2/2 players");

  const spectator = await (await browser.newContext()).newPage();
  await spectator.goto(`/watch/${room}`);
  await expect(spectator.getByTestId("presence")).toContainText("Spectating", {
    timeout: 15_000,
  });
  await expect(spectator.getByTestId("presence")).toContainText("1 watching");
  await expect(spectator.getByTestId("score")).toBeVisible();
  await expect(spectator.getByTestId("court")).toBeVisible();
});
