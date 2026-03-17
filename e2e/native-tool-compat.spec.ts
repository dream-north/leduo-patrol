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

// ─── Native Read tool (without mcp__acp__ prefix) renders with completed status ─
test("native Read tool renders with completed status in timeline", async ({ page }) => {
  await goDemo(page);

  // The demo data includes a Read tool timeline item (native, no prefix).
  // It should display "Read /src/config.ts" with "completed" status.
  const readRow = page.locator(".timeline-row", { hasText: "Read /src/config.ts" });
  await expect(readRow.first()).toBeVisible({ timeout: 5000 });

  // The status should show as completed (not failed or denied)
  const completedMeta = readRow.first().locator(".timeline-meta", { hasText: /completed/ });
  await expect(completedMeta).toBeVisible();

  await captureFull(page, "docs/screenshots/e2e-native-read-tool.png");
});

// ─── Native Write tool renders with completed status ─────────────────────────────
test("native Write tool renders with completed status in timeline", async ({ page }) => {
  await goDemo(page);

  const writeRow = page.locator(".timeline-row", { hasText: "Write /src/config.ts" });
  await expect(writeRow.first()).toBeVisible({ timeout: 5000 });

  const completedMeta = writeRow.first().locator(".timeline-meta", { hasText: /completed/ });
  await expect(completedMeta).toBeVisible();

  await captureFull(page, "docs/screenshots/e2e-native-write-tool.png");
});

// ─── AskUserQuestion renders grouped multi-question form ─────────────────────────
test("AskUserQuestion renders grouped multi-question form with all 3 questions", async ({ page }) => {
  await goDemo(page);

  // Should have exactly 1 multi-question form (all 3 questions grouped)
  const form = page.locator(".multi-question-form");
  await expect(form).toBeVisible({ timeout: 5000 });

  // Should have 3 question panels inside the form
  const questionPanels = form.locator(".question-panel");
  await expect(questionPanels).toHaveCount(3);

  // Verify headers
  await expect(form.locator(".question-header", { hasText: "作业排序" })).toBeVisible();
  await expect(form.locator(".question-header", { hasText: "作业状态" })).toBeVisible();
  await expect(form.locator(".question-header", { hasText: "错误类型" })).toBeVisible();

  // Verify question texts
  await expect(form.locator(".question-text", { hasText: "接口返回的作业列表" })).toBeVisible();

  // Verify option buttons with descriptions are shown
  await expect(form.locator(".question-option-label", { hasText: "已排序" }).first()).toBeVisible();
  await expect(form.locator(".question-option-desc").first()).toBeVisible();

  // Each question should have a custom input toggle
  const customToggles = form.locator(".question-custom-toggle");
  await expect(customToggles).toHaveCount(3);

  // Submit button should be disabled until all questions are answered
  const submitBtn = form.locator(".question-submit-all");
  await expect(submitBtn).toBeDisabled();
  await expect(submitBtn).toContainText("请回答所有问题");

  await captureFull(page, "docs/screenshots/e2e-native-ask-user-question.png");
});

// ─── All three tools visible together in the UI ─────────────────────────────────
test("Read + Write + AskUserQuestion all visible seamlessly", async ({ page }) => {
  await goDemo(page);

  // Read tool visible
  await expect(
    page.locator(".timeline-row", { hasText: "Read /src/config.ts" }).first(),
  ).toBeVisible({ timeout: 5000 });

  // Write tool visible
  await expect(
    page.locator(".timeline-row", { hasText: "Write /src/config.ts" }).first(),
  ).toBeVisible({ timeout: 5000 });

  // Multi-question form visible
  await expect(page.locator(".multi-question-form").first()).toBeVisible({ timeout: 5000 });

  await captureFull(page, "docs/screenshots/e2e-all-native-tools-combined.png");
});

// ─── Multi-question form: select all answers, submit becomes enabled ─────────────
test("AskUserQuestion multi-question form enables submit after all answered", async ({ page }) => {
  await goDemo(page);

  // Close any demo modals that might overlap the question form.
  // The demo may open a "新建会話" modal and/or a permission detail modal.
  // Use force:true because modals may stack on top of each other.
  for (const label of ["取消", "关闭"]) {
    const btn = page.locator(".modal-backdrop").getByRole("button", { name: label });
    if (await btn.count() > 0) {
      await btn.first().click({ force: true });
    }
  }

  const form = page.locator(".multi-question-form");
  await expect(form).toBeVisible({ timeout: 5000 });

  // Initially disabled
  const submitBtn = form.locator(".question-submit-all");
  await expect(submitBtn).toBeDisabled();

  // Select option for Q1
  await form.locator(".question-option-btn", { hasText: "已排序" }).first().click();
  await expect(form.locator(".question-selected-answer", { hasText: "已排序" })).toBeVisible();
  await expect(submitBtn).toBeDisabled(); // still 1/3

  // Select option for Q2
  await form.locator(".question-option-btn", { hasText: /Recommended/ }).first().click();
  await expect(submitBtn).toBeDisabled(); // still 2/3

  // Select option for Q3
  await form.locator(".question-option-btn", { hasText: "必须指定" }).first().click();

  // Now all answered - submit button should be enabled
  await expect(submitBtn).toBeEnabled();
  await expect(submitBtn).toContainText("提交全部 3 个回答");

  await captureFull(page, "docs/screenshots/e2e-multi-question-ask-user.png");
});
