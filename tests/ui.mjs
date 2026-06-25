import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.HTTP_URL || "http://127.0.0.1:4311";
const roomCode = `UI-${Date.now().toString().slice(-8)}`;
const openListPage = "https://al.chirmyram.com/tlv1/%E4%B8%AD%E5%89%A7/%E5%A4%A7%E6%98%8E%E7%8E%8B%E6%9C%9D1566/Season%201/%E5%A4%A7%E6%98%8E%E7%8E%8B%E6%9C%9D1566.Da.Ming.Wang.Chao.2007.S01E01.1080p.WEB-DL.AAC.H.264-OurTV.mp4";
const episodeName = "大明王朝1566.Da.Ming.Wang.Chao.2007.S01E01.1080p.WEB-DL.AAC.H.264-OurTV.mp4";

const executablePath = process.env.CHROME_PATH ||
  "/Users/lion/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const browser = await chromium.launch({ headless: true, executablePath });
const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await guestContext.addInitScript(() => {
  localStorage.setItem("afterglow-profile", JSON.stringify({
    name: "Maya",
    region: "North America · Virginia"
  }));
});
const host = await hostContext.newPage();
const guest = await guestContext.newPage();

try {
  await host.goto(baseUrl);
  await host.locator("#room-modal").waitFor({ state: "visible" });
  await host.screenshot({ path: "preview-room-entry.png", fullPage: false });
  await host.locator("#new-room-name").fill("大明王朝首映厅");
  await host.locator("#new-room-code").fill(roomCode);
  await host.locator("#create-room-button").click();
  await host.waitForURL(`**/?room=${roomCode}`);
  await host.locator("#room-modal").waitFor({ state: "hidden" });
  assert.equal(await host.locator("#copy-room").textContent(), roomCode);

  await guest.goto(baseUrl);
  await guest.locator("[data-room-mode='join']").click();
  await guest.locator("#join-room-code").fill(`${baseUrl}/?room=${roomCode}`);
  await guest.locator("#join-room-button").click();
  await guest.waitForURL(`**/?room=${roomCode}`);
  await guest.locator("#room-modal").waitFor({ state: "hidden" });
  await host.locator("#member-count").waitFor();
  await host.waitForFunction(() => document.querySelector("#member-count")?.textContent === "2");
  await guest.waitForFunction(() => document.querySelector("#member-count")?.textContent === "2");

  // --- OpenList source selection ---
  await host.locator("#empty-add-source").click();
  await host.locator("#source-modal").waitFor({ state: "visible" });
  await host.locator("[data-source-tab='openlist']").click();
  await host.waitForTimeout(300);
  await host.locator("#openlist-address").fill(openListPage);
  await host.locator("#openlist-connect-button").click();

  // Wait for file browser
  await host.waitForTimeout(2000);
  const errText = await host.locator("#source-error").textContent();
  if (errText.trim()) throw new Error("OpenList error: " + errText);

  const episodeRow = host.locator("#openlist-file-list .file-row").filter({ hasText: "E01" });
  await episodeRow.first().waitFor({ state: "visible", timeout: 15_000 });
  assert.ok((await episodeRow.count()) >= 1);
  await host.screenshot({ path: "preview-openlist-browser.png", fullPage: false });

  await episodeRow.first().click();
  await host.locator("#openlist-selected").waitFor({ state: "visible" });
  await host.locator("#confirm-source").click();

  // --- Verify media sync ---
  await host.waitForFunction(() => document.querySelector("#media-title")?.textContent?.includes("S01E01"));
  await guest.waitForFunction(() => document.querySelector("#media-title")?.textContent?.includes("S01E01"));

  await host.screenshot({ path: "preview-room-multiuser.png", fullPage: true });

  console.log(JSON.stringify({
    ok: true,
    roomCode,
    users: 2,
    openListSelected: episodeName,
    hostTitle: await host.locator("#media-title").textContent(),
    guestTitle: await guest.locator("#media-title").textContent()
  }));
} finally {
  await browser.close();
}
