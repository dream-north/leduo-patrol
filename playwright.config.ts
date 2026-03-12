import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3099",
    trace: "off",
    // Ensure CJK fonts render correctly
    launchOptions: {
      args: ["--font-render-hinting=none"],
    },
  },
  webServer: {
    command: "LEDUO_PATROL_ACCESS_KEY=showcase-key PORT=3099 node dist/server/index.js",
    url: "http://localhost:3099/?key=showcase-key",
    reuseExistingServer: false,
    timeout: 15000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
