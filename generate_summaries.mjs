import fs from "fs/promises";
import path from "path";
import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import OpenAI from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var.");
  process.exit(1);
}

// ===== Config (override via workflow env) =====
const MODEL = process.env.OPENAI_MODEL || "gpt-4o"; // set to gpt-5 in workflow if you have access
const RSS_URL = process.env.RSS_URL || "https://www.boston.com/feed/bdc-msn-rss";
const MAX_ARTICLES = Number(process.env.MAX_ARTICLES || 16);
const HISTORY_FILE = "data/summaries.json"; // used for repetition guard

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
const parser = new Parser();

const UA = "Mozilla/5.0 (compatible; BostonSpeedReadBot/1.0; +https://github.com/)";

// Small helper to be polite to remote servers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

async function extractArticle(url) {
  try {
    const html = await fetchHtml(url);
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    const ogImg =
      doc.querySelector('meta[property="og:image"]')?.content ||
      doc.querySelector('meta[name="twitter:image"]')?.content ||
      null;

    let text = "";
    try {
      const reader = new Readability(doc);
      const article = reader.parse();
      text = (article?.textContent || "").trim();
    } catch (_) {}

    return { text, image: ogImg };
  } catch (e) {
    console.warn("extractArticle fail:", url, e.message);
    return { text: "", image: null };
  }
}

function clip(str, max = 7000) {
  return (str || "").replace(/\s+/g, " ").slice(0, max);
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = (it.link || it.guid || it.title || "").split("?")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- Repetition Guard -------------------------------------------------------
// Read the previous summaries.json and collect openings of bullet #3
async function loadRecentThirdBulletOpenings(limit = 80) {
  try {
    const p = path.resolve(HISTORY_FILE);
    const raw = await fs.readFile(p, "utf-8");
    const arr = JSON.parse(raw);
    const openings = [];
    for (const it of arr.slice(0, limit)) {
      const b3 = it?.bullets?.[2] || "";
      const opening = b3.trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase(); // first 2 words
      if (opening) openings.push(opening);
    }
    return openings;
  } catch {
    return [];
  }
}

const BANNED_OPENERS = [
  "discover", "find out", "learn", "see how", "see why", "read how", "read why",
  "here’s how", "here’s why", "this is why", "this is how"
];

// A few style “nudges” we feed the model so bullets vary naturally
const STYLE_SEEDS = [
  "Pose a crisp question that tees up a key detail (no fluff).",
  "Hint at a specific quote, stat, or rule that changes the stakes.",
  "Contrast two viewpoints or outcomes without resolving which is right.",
  "Surface an unresolved next step (vote, hearing, deadline, report).",
  "Point to a number or name that readers will only get by clicking.",
  "Flag what surprised officials/experts—but don’t reveal it."
];

// ---- Summarizer -------------------------------------------------------------
async function summarizeItem(item, avoidOpeners = []) {
  const { title, link, contentSnippet, isoDate, pubDate, categories } = item;
  const { text, image } = await extractArticle(link);
  const articleText = text || contentSnippet || title;

  // Build a short list of openers to avoid this run
  // e.g., ["discover which", "find out why", ...]
  const avoidList = Array.from(
    new Set([
      ...avoidOpeners,
      ...BANNED_OPENERS.map((w) => w.toLowerCase()),
    ])
  ).slice(0, 40); // keep it short

  const styleSeed = STYLE_SEEDS[Math.floor(Math.random() * STYLE_SEEDS.length)];

  const system = `
You are a Boston-area news copy editor. Write EXACTLY three bullets (<= 22 words each).
Bullet 3 must create a respectful, specific curiosity gap that fits a serious news brand (Boston.com tone).

Style for bullet 3:
- Vary constructions across stories: use questions, contrasts, next steps, or hinted specifics.
- Avoid hype, ellipses, clickbait, and stock phrasing.
- Use concrete nouns, names, places, or numbers when possible.
- DO NOT reveal the teased detail.

Global rules:
- Be concise and specific; write in clear journalistic style.
- Avoid repeating verbs/openers across bullets.
- Output strict JSON with key: "bullets" (array of 3 strings).
`;

  const user = `
TITLE: ${title}
URL: ${link}
PUBLISHED: ${isoDate || pubDate || ""}
SECTION: ${(categories || [])[0] || ""}

ARTICLE (truncated):
${clip(articleText)}

Curiosity-bullet constraints:
- Avoid these opening phrases (case-insensitive): ${avoidList.join(", ") || "none"}
- ${styleSeed}
`;

  const resp = await client.chat.completions.create({
    model: MODEL,
    // No temperature: some models reject custom values; defaults are fine.
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system.trim() },
      { role: "user", content: user.trim() },
    ],
  });

  let bullets = [];
  try {
    const obj = JSON.parse(resp.choices[0]?.message?.content || "{}");
    bullets = Array.isArray(obj.bullets) ? obj.bullets.slice(0, 3) : [];
  } catch (e) {
    // Fallback if the model didn't return JSON as expected
    const raw = (resp.choices[0]?.message?.content || "")
      .split(/\n|•|-|\*/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
    bullets = raw;
  }

  // Final sanitation: enforce 3 bullets and strip trailing punctuation noise
  bullets = (bullets || []).map((b) =>
    b.replace(/\s+/g, " ").replace(/\.\.\.$/, "").trim()
  ).slice(0, 3);

  return { bullets, image };
}

async function main() {
  // Read recent bullet #3 openings to discourage repetition this run
  const recentOpeners = await loadRecentThirdBulletOpenings(120);

  const feed = await parser.parseURL(RSS_URL);
  const items = dedupe(feed.items || []).slice(0, MAX_ARTICLES);

  const results = [];
  for (const item of items) {
    try {
      const s = await summarizeItem(item, recentOpeners);
      results.push({
        title: item.title || "",
        url: item.link,
        author: item.creator || item.author || "",
        section: (item.categories || [])[0] || "Top",
        published: item.isoDate || item.pubDate || "",
        image: s.image,
        bullets: s.bullets,
      });

      // Update repetition guard in-memory with this run's opener to diversify within the same run
      const openerNow = (s.bullets?.[2] || "").trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase();
      if (openerNow) recentOpeners.push(openerNow);

      await sleep(350); // gentle pacing
    } catch (e) {
      console.warn("Summarize fail:", item.link, e.message);
    }
  }

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(HISTORY_FILE, JSON.stringify(results, null, 2));
  console.log(`Wrote ${HISTORY_FILE} (${results.length} stories)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
