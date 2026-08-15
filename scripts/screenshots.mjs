/** Capture application screenshots using the locally installed Edge browser. */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "screenshots");
fs.mkdirSync(outDir, { recursive: true });

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "http://localhost:4310";
const PAGES = [
  ["dashboard", "/"],
  ["makes", "/makes"],
  ["make-detail-ford", "/makes"],           // resolved below by clicking Ford
  ["models", "/models"],
  ["model-detail", "/models"],
  ["year-browser-1995", "/years/1995"],
  ["submodels", "/submodels"],
  ["alias-lookup", "/aliases?q=F150"],
  ["review", "/review"],
  ["sources-audit", "/sources"],
  ["vehicle-selector", "/selector"],
  ["admin", "/admin"],
  ["std-projects", "/std/projects"],
  ["std-upload", "/std/upload"],
  ["std-templates", "/std/templates"],
  ["std-map", "@std-map"],
  ["std-review", "@std-review"],
  ["std-export", "@std-export"],
];

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: true,
  args: ["--no-sandbox", "--window-size=1600,1000"],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();

for (const [name, url] of PAGES) {
  if (name === "make-detail-ford") {
    await page.goto(`${BASE}/makes`, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForSelector("table.data a", { timeout: 15000 });
    const ford = await page.$$eval("table.data a",
      (as) => as.find((a) => a.textContent?.trim() === "Ford")?.getAttribute("href"));
    await page.goto(`${BASE}${ford}`, { waitUntil: "networkidle0", timeout: 30000 });
  } else if (name === "model-detail") {
    await page.goto(`${BASE}/models?q=F-150`, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForSelector("table.data a", { timeout: 15000 });
    const href = await page.$$eval("table.data a",
      (as) => as.find((a) => a.textContent?.trim() === "F-150")?.getAttribute("href"));
    await page.goto(`${BASE}${href}`, { waitUntil: "networkidle0", timeout: 30000 });
  } else if (url.startsWith("@std-")) {
    // use the newest standardization project for the workspace screenshots
    const projects = await page.evaluate(async () =>
      (await fetch("/api/std/projects").then((r) => r.json())).map((p) => p.id));
    if (!projects.length) { console.log(`skipped ${name} (no projects)`); continue; }
    const pid = Math.max(...projects);
    const sub = url.replace("@std-", "");
    await page.goto(`${BASE}/std/projects/${pid}/${sub}`,
      { waitUntil: "networkidle0", timeout: 60000 });
  } else {
    await page.goto(`${BASE}${url}`, { waitUntil: "networkidle0", timeout: 30000 });
  }
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
  console.log(`captured ${name}.png`);
}
await browser.close();
console.log("SCREENSHOTS_DONE");
