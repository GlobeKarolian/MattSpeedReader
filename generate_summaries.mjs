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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- Fetch & extract ----------------
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

// ---------------- History / repetition guard ----------------
async function loadRecentThirdBulletOpenings(limit = 120) {
  try {
    const raw = await fs.readFile(path.resolve(HISTORY_FILE), "utf-8");
    const arr = JSON.parse(raw);
    const openings = [];
    for (const it of arr.slice(0, limit)) {
      const b3 = it?.bullets?.[2] || "";
      const opening = firstTwoWords(b3);
      if (opening) openings.push(opening);
    }
    return openings;
  } catch {
    return [];
  }
}

function firstTwoWords(s) {
  return (s || "").trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase();
}

// Words/phrases we never allow in bullet 3 (anywhere, not just at start)
const BANNED_PHRASES = [
  "discover", "find out", "learn", "see how", "see why", "read how", "read why",
  "here’s how", "here's how", "here’s why", "here's why",
  "this is why", "this is how",
  "unveil", "unveils", "reveal", "reveals", "revealed"
];

// Diverse, concise replacements (<= 12–16 words) to keep tone newsy and varied
const VARIANTS = [
  "Which detail changes the stakes is inside.",
  "What officials weigh next could surprise you.",
  "Key number and who it affects are in the full report.",
  "Two paths emerge—see what each would mean for residents.",
  "One quote is driving the pushback—catch it in the story.",
  "A deadline forces a decision sooner than expected.",
  "New data point shifts the conversation—see the figure inside.",
  "Where the plan faces its toughest test comes next.",
  "The name behind the hold-up appears in the piece.",
  "A small rule has big effects—see which one.",
  "Which precincts moved most—and why—are in the write-up.",
  "What happens if a vote stalls is outlined in detail.",
  "How the change hits commuters versus businesses differs—see how.",
  "A single paragraph explains the opposition’s strategy.",
  "One map tells the story—see where pressure builds.",
  "An unexpected actor could decide it; they’re named inside.",
  "Next hearing date and what’s on the agenda are listed.",
  "A budget line does most of the work—see the amount.",
  "What experts flagged in private shows up publicly here.",
  "Which metric the mayor is watching appears in the story.",
  "A footnote reframes the issue—spot it inside.",
  "What lawyers argue next depends on one clause.",
  "A quiet change in wording matters—see where.",
  "Who benefits first—and who waits—breaks down in the article."
];

// ---------------- Post-processing / rewrite ----------------
function needsRewrite(b3, recentOpeners) {
  if (!b3) return true;
  const lower = b3.toLowerCase();
  if (BANNED_PHRASES.some(p => lower.includes(p))) return true;
  const open2 = firstTwoWords(lower);
  if (!open2) return false;
  if (recentOpeners.includes(open2)) return true;
  return false;
}

function chooseVariant(recentOpeners, usedOpeners) {
  // Shuffle a copy to vary outcomes
  const pool = VARIANTS.slice().sort(() => Math.random() - 0.5);
  for (const v of pool) {
    const op = firstTwoWords(v);
    if (!recentOpeners.includes(op) && !usedOpeners.has(op)) {
      usedOpeners.add(op);
      return v;
    }
  }
  // Fallback: return a random variant
  const v = VARIANTS[Math.floor(Math.random() * VARIANTS.length)];
  usedOpeners.add(firstTwoWords(v));
  return v;
}

// ---------------- Summarizer ----------------
async function summarizeItem(item, recentOpeners, usedOpeners) {
  const { title, link, contentSnippet, isoDate, pubDate, categories } = item;
  const { text, image } = await extractArticle(link);
  const articleText = text || contentSnippet || title;

  // Build a short avoid list to nudge variety
  const avoidList = Array.from(
    new Set([
      ...recentOpeners,
      "what is", "which is", "which are", "what happens", "how this",
      ...BANNED_PHRASES
    ])
  ).slice(0, 60);

  const styleSeeds = [
    "Pose a crisp question that tees up a specific detail (no fluff).",
    "Hint at a concrete quote, number, or map readers will see.",
    "Contrast two outcomes or viewpoints without resolving which is correct.",
    "Point to the next formal step (hearing, vote, deadline, filing).",
    "Name that a person/agency/precinct is central—without saying why."
  ];
  const styleSeed = styleSeeds[Math.floor(Math.random() * styleSeeds.length)];

  const system = `
You are a Boston-area news copy editor. Write EXACTLY three bullets (<= 22 words each).
Bullet 3 must create a respectful, specific curiosity gap in a serious, newsy voice (Boston.com tone).
- Use concrete nouns, names, places, or numbers when possible.
- Vary constructions: question, contrast, next step, or hinted specific.
- No hype, no ellipses, no stock phrasing.

Global rules:
- Concise, specific, clear journalistic style.
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
- Avoid these phrases anywhere (case-insensitive): ${avoidList.join(", ")}
- ${styleSeed}
`;

  const resp = await client.chat.completions.create({
    model: MODEL,
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
    const raw = (resp.choices[0]?.message?.content || "")
      .split(/\n|•|-|\*/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
    bullets = raw;
  }

  // Clean & trim
  bullets = (bullets || []).map((b) =>
    b.replace(/\s+/g, " ").replace(/\.\.\.$/, "").trim()
  ).slice(0, 3);

  // ----- Enforce diversity & ban list on bullet #3 (server-side) -----
  if (bullets.length < 3) {
    // pad defensively if model returns <3
    while (bullets.length < 3) bullets.push("Further context in the full story.");
  }

  if (needsRewrite(bullets[2], recentOpeners)) {
    bullets[2] = chooseVariant(recentOpeners, usedOpeners);
  }

  // Update repetition guard in-memory with this run's opener
  const openerNow = firstTwoWords(bullets[2]);
  if (openerNow) recentOpeners.push(openerNow);

  return { bullets, image };
}

// ---------------- Main ----------------
async function main() {
  const recentOpeners = await loadRecentThirdBulletOpenings(160);
  const usedOpeners = new Set();

  const feed = await parser.parseURL(RSS_URL);
  const items = dedupe(feed.items || []).slice(0, MAX_ARTICLES);

  const results = [];
  for (const item of items) {
    try {
      const s = await summarizeItem(item, recentOpeners, usedOpeners);
      results.push({
        title: item.title || "",
        url: item.link,
        author: item.creator || item.author || "",
        section: (item.categories || [])[0] || "Top",
        published: item.isoDate || item.pubDate || "",
        image: s.image,
        bullets: s.bullets,
      });
      await sleep(300); // polite pacing
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
