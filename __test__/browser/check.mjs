// Serves the production build with `vite preview`, opens it in headless
// Chromium and fails on any page error or wrong search result.
import { chromium } from "playwright";
import { preview } from "vite";

const failures = [];
const server = await preview();
try {
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error("vite preview has no local URL");

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => failures.push(`page error: ${error}`));
    page.on("console", (message) => {
      if (message.type() === "error") {
        failures.push(`console error: ${message.text()}`);
      }
    });
    page.on("requestfailed", (request) => {
      failures.push(
        `request failed: ${request.url()} ${request.failure()?.errorText}`,
      );
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        failures.push(`HTTP ${response.status()}: ${response.url()}`);
      }
    });

    const response = await page.goto(url);
    const headers = response?.headers() ?? {};
    if (headers["cross-origin-opener-policy"] !== "same-origin") {
      failures.push("missing Cross-Origin-Opener-Policy: same-origin");
    }
    if (headers["cross-origin-embedder-policy"] !== "require-corp") {
      failures.push("missing Cross-Origin-Embedder-Policy: require-corp");
    }

    await page.waitForFunction(
      () => document.getElementById("out")?.textContent !== "pending",
      undefined,
      { timeout: 60_000 },
    );
    const text = (await page.locator("#out").textContent()) ?? "";
    console.log(`browser result: ${text}`);
    const result = JSON.parse(text);
    if (result.ok !== true) failures.push("the page reported a failure");
    if (result.crossOriginIsolated !== true) {
      failures.push("the page is not cross-origin isolated");
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log("browser check passed");
}
