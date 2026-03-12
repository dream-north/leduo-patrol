import { test, expect, type Page } from "@playwright/test";

const KEY = "showcase-key";
const BASE = `http://localhost:3099/?key=${KEY}`;
const DEMO = `${BASE}&demo=subagent-tree`;

async function goDemo(page: Page) {
  await page.goto(DEMO);
  await page.waitForSelector(".shell", { timeout: 8000 });
}

async function captureFull(page: Page, path: string) {
  await page.screenshot({
    path,
    fullPage: true,
  });
}

// ─── 1. 整体界面 ──────────────────────────────────────────────────────────────
test("showcase: 整体控制台布局", async ({ page }) => {
  await goDemo(page);
  await captureFull(page, "docs/screenshots/01-overview.png");
});

// ─── 2. 左侧边栏：当前会话 tab（active 高亮） ──────────────────────────────────
test("showcase: 当前会话 tab 激活态", async ({ page }) => {
  await goDemo(page);
  // 默认显示「当前会话」tab
  const tab = page.locator(".sidebar-tab").first();
  await expect(tab).toHaveClass(/active/);
  await captureFull(page, "docs/screenshots/02-sessions-tab-active.png");
});

// ─── 3. 新建会话 tab ──────────────────────────────────────────────────────────
test("showcase: 新建会话 tab", async ({ page }) => {
  await goDemo(page);
  await page.locator(".sidebar-tab").nth(1).click();
  await page.waitForSelector(".create-panel", { timeout: 3000 });
  await captureFull(page, "docs/screenshots/03-create-tab.png");
});

// ─── 4. 两个 tab 对比（激活 vs 非激活） ──────────────────────────────────────
test("showcase: tab 对比（session vs create）", async ({ page }) => {
  await goDemo(page);
  await captureFull(page, "docs/screenshots/04-tabs-compare-sessions.png");
  await page.locator(".sidebar-tab").nth(1).click();
  await captureFull(page, "docs/screenshots/05-tabs-compare-create.png");
});

// ─── 5. session-chip active 态（左侧边框 + 背景高亮） ─────────────────────────
test("showcase: 当前会话卡片选中态", async ({ page }) => {
  await goDemo(page);
  const chips = page.locator(".session-chip");
  const count = await chips.count();
  if (count > 0) {
    // 点击第一个会话
    await chips.first().click();
  }
  await captureFull(page, "docs/screenshots/06-session-chip-active.png");
});

// ─── 6. 新建会话表单（带 label） ──────────────────────────────────────────────
test("showcase: 新建会话表单", async ({ page }) => {
  await goDemo(page);
  await page.locator(".sidebar-tab").nth(1).click();
  await page.waitForSelector(".create-panel");
  await captureFull(page, "docs/screenshots/07-create-form.png");
});

// ─── 7. 时间线视图（SubAgent 折叠） ──────────────────────────────────────────
test("showcase: 时间线 SubAgent 树（展开）", async ({ page }) => {
  await goDemo(page);
  await captureFull(page, "docs/screenshots/08-timeline-expanded.png");
});

// ─── 8. 时间线折叠后 ─────────────────────────────────────────────────────────
test("showcase: 时间线 SubAgent 树（折叠）", async ({ page }) => {
  await goDemo(page);
  const collapseBtn = page.locator(".timeline-collapse-btn").first();
  if (await collapseBtn.isVisible()) {
    await collapseBtn.click();
  }
  // 若不存在折叠按钮，则保留当前状态截图，确保 showcase 产物完整
  await captureFull(page, "docs/screenshots/09-timeline-collapsed.png");
});

// ─── 9. 右侧审批面板 ─────────────────────────────────────────────────────────
test("showcase: 右侧审批 + 状态面板", async ({ page }) => {
  await goDemo(page);
  const rightPanel = page.locator(".panel").nth(2);
  if (await rightPanel.isVisible()) {
    await captureFull(page, "docs/screenshots/10-approvals-panel.png");
  }
});

// ─── 10. 完整侧边栏（含多个 session-chip） ───────────────────────────────────
test("showcase: 侧边栏完整视图", async ({ page }) => {
  await goDemo(page);
  await captureFull(page, "docs/screenshots/11-sidebar-full.png");
});
