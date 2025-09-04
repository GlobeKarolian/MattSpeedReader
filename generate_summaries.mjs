import fs from "fs/promises";
import path from "path";
import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import OpenAI from "openai";

/* =========================
   Config (override via env)
   ========================= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

const MODEL        = process.env.OPENAI_MODEL || "gpt-4o";  // set to "gpt-5" if you have access
const RSS_URL      = process.env.RSS_URL || "https://www.boston.com/feed/bdc-msn-rss";
const MAX_ARTICLES = Number(process.env.MAX_ARTICLES || 50);
const HISTORY_FILE = "data/summaries.json";
const UA           = "Mozilla/5.0 (compatible; BostonSpeedReadBot/1.0; +https://github.com/)";

const client  = new OpenAI({ apiKey: OPENAI_API_KEY });
const parser  = new Parser();
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));

/* =========================
   Helpers
   ========================= */
function clip(s, max = 9000) { return (s || "").replace(/\s+/g, " ").slice(0, max); }

async function fetchHtml(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

async function extractArticle(url) {
  try {
    const html = await fetchHtml(url);
    const dom  = new JSDOM(html, { url });
    const doc  = dom.window.document;

    // lead image
    const ogImg =
      doc.querySelector('meta[property="og:image"]')?.content ||
      doc.querySelector('meta[name="twitter:image"]')?.content ||
      null;

    // readable text
    let text = "";
    try {
      const reader  = new Readability(doc);
      const article = reader.parse();
      text = (article?.textContent || "").trim();
    } catch {}
    return { text, image: ogImg };
  } catch (e) {
    console.warn("extractArticle fail:", url, e.message);
    return { text: "", image: null };
  }
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(it => {
    const key = (it.link || it.guid || it.title || "").split("?")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* =========================
   Summarize (plain 3 bullets, Boston.com tone)
   ========================= */
async function summarizeThreeBullets({ title, link, contentSnippet, isoDate, pubDate, categories }) {
  const { text, image } = await extractArticle(link);
  const section = (categories || [])[0] || "";
  const articleText = text || contentSnippet || title;

  const system = `
You are a Boston.com editor. Write THREE concise news bullets that accurately summarize the story.
Editorial style:
- Straight, specific, neutral; no hype, no opinion.
- Each bullet 12–24 words; use names, places, numbers when available.
- No questions, no "discover"/"find out" phrasing, no ellipses, no emojis.
- Do not repeat the same fact across bullets.
Return strict JSON: {"bullets": ["...", "...", "..."]}.
`.trim();

  const user = `
TITLE: ${title}
URL: ${link}
SECTION: ${section}
PUBLISHED: ${isoDate || pubDate || ""}

ARTICLE (truncated to fit):
${clip(articleText)}
`.trim();

  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const obj = JSON.parse(resp.choices[0]?.message?.content || "{}");
    let bullets = Array.isArray(obj.bullets) ? obj.bullets : [];

    // sanitize & enforce exactly 3
    bullets = bullets
      .map(b => (b || "").replace(/\s+/g, " ").replace(/\.\.\.$/, "").trim())
      .filter(Boolean)
      .slice(0, 3);

    if (bullets.length === 3) return { bullets, image };
  } catch (e) {
    console.warn("Model summarize fail:", link, e.message);
  }

  // Fallback: naive sentence extraction (first 3 sentences)
  const fallback = (articleText.match(/[^.!?]+[.!?]/g) || [])
    .map(s => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3);

  return {
    bullets: fallback.length ? fallback : [
      "Story details unavailable at this time.",
      "Please open the article for the full report.",
      "We will improve this summary shortly."
    ],
    image
  };
}

/* =========================
   Main
   ========================= */
async function main(){
  const feed = await parser.parseURL(RSS_URL);
  const items = dedupe(feed.items || []).slice(0, MAX_ARTICLES);

  const results = [];
  for (const item of items) {
    try {
      const s = await summarizeThreeBullets(item);
      results.push({
        title: item.title || "",
        url: item.link,
        author: item.creator || item.author || "",
        section: (item.categories || [])[0] || "Top",
        published: item.isoDate || item.pubDate || "",
        image: s.image,
        bullets: s.bullets
      });
      await sleep(200); // polite pacing
    } catch (e) {
      console.warn("Summarize fail:", item.link, e.message);
    }
  }

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(HISTORY_FILE, JSON.stringify(results, null, 2));
  console.log(`Wrote ${HISTORY_FILE} (${results.length} stories)`);
}

main().catch(err => { console.error(err); process.exit(1); });
