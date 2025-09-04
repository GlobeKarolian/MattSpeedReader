import fs from "fs/promises";
import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import OpenAI from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var.");
  process.exit(1);
}

const MODEL = process.env.OPENAI_MODEL || "gpt-5";
const RSS_URL = process.env.RSS_URL || "https://www.boston.com/feed/bdc-msn-rss";
const MAX_ARTICLES = Number(process.env.MAX_ARTICLES || 16);

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
const parser = new Parser();

const UA =
  "Mozilla/5.0 (compatible; BostonSpeedReadBot/1.0; +https://github.com/)";

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
    console.warn("extractArticle fail:", e.message);
    return { text: "", image: null };
  }
}

function clip(str, max = 7000) {
  return (str || "").replace(/\s+/g, " ").slice(0, max);
}

async function summarize({ title, link, contentSnippet, isoDate, pubDate, categories }) {
  const { text, image } = await extractArticle(link);
  const articleText = text || contentSnippet || title;

  const system = `
You are a Boston-area news copy editor. Summarize each story into EXACTLY three bullets (<= 22 words each).
Bullet 3 MUST create a respectful "curiosity gap": hint at a specific detail or consequence readers will learn by opening the story—no clickbait, no ellipses.

Rules:
- Be specific, use proper nouns and numbers.
- No hype phrases ("you won't believe", "shocking").
- Vary verbs; avoid repetitive openers across bullets.
- Never reveal the teased detail in bullet 3.
- Output strict JSON with keys: bullets (array of 3 strings).
`;

  const user = `
TITLE: ${title}
URL: ${link}
PUBLISHED: ${isoDate || pubDate || ""}
SECTION: ${(categories || [])[0] || ""}
ARTICLE (truncated):
${clip(articleText)}
`;

  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system.trim() },
      { role: "user", content: user.trim() }
    ]
  });

  let bullets = [];
  try {
    const obj = JSON.parse(resp.choices[0]?.message?.content || "{}");
    bullets = Array.isArray(obj.bullets) ? obj.bullets.slice(0, 3) : [];
  } catch {
    const raw = (resp.choices[0]?.message?.content || "")
      .split(/\n|•|-|\*/).map(s => s.trim()).filter(Boolean).slice(0,3);
    bullets = raw;
  }

  return { bullets, image };
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

async function main() {
  const feed = await parser.parseURL(RSS_URL);
  const items = dedupe(feed.items || []).slice(0, MAX_ARTICLES);

  const results = [];
  for (const item of items) {
    try {
      const s = await summarize(item);
      results.push({
        title: item.title || "",
        url: item.link,
        author: item.creator || item.author || "",
        section: (item.categories || [])[0] || "Top",
        published: item.isoDate || item.pubDate || "",
        image: s.image,
        bullets: s.bullets
      });
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.warn("Summarize fail:", item.link, e.message);
    }
  }

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/summaries.json", JSON.stringify(results, null, 2));
  console.log(`Wrote data/summaries.json (${results.length} stories)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
