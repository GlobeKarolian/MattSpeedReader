import fs from "fs/promises";
import path from "path";
import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import OpenAI from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

// ---------- Config ----------
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";  // set to gpt-5 if available
const RSS_URL = process.env.RSS_URL || "https://www.boston.com/feed/bdc-msn-rss";
const MAX_ARTICLES = Number(process.env.MAX_ARTICLES || 16);
const HISTORY_FILE = "data/summaries.json";  // used to diversify phrasing across runs
const UA = "Mozilla/5.0 (compatible; BostonSpeedReadBot/1.0; +https://github.com/)";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
const parser = new Parser();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Fetch & extract ----------
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
      doc.querySelector('meta[name="twitter:image"]')?.content || null;

    let text = "";
    try { const reader = new Readability(doc); text = (reader.parse()?.textContent || "").trim(); } catch {}
    return { text, image: ogImg };
  } catch (e) {
    console.warn("extractArticle fail:", url, e.message);
    return { text: "", image: null };
  }
}
function clip(s, max = 7000){ return (s || "").replace(/\s+/g, " ").slice(0, max); }
function dedupe(items){
  const seen = new Set();
  return items.filter(it => {
    const key = (it.link || it.guid || it.title || "").split("?")[0];
    if (seen.has(key)) return false; seen.add(key); return true;
  });
}

// ---------- History / repetition guard ----------
async function loadRecentOpeners(limit = 160){
  try {
    const raw = await fs.readFile(path.resolve(HISTORY_FILE), "utf-8");
    const arr = JSON.parse(raw);
    const out = [];
    for (const it of arr.slice(0, limit)) {
      const b3 = it?.bullets?.[2] || "";
      const open2 = firstTwoWords(b3);
      if (open2) out.push(open2);
    }
    return out;
  } catch { return []; }
}
function firstTwoWords(s){ return (s || "").trim().split(/\s+/).slice(0,2).join(" ").toLowerCase(); }

// Strong ban list (anywhere in bullet #3)
const BANNED_PHRASES = [
  "discover","find out","learn","see how","see why","read how","read why",
  "here’s how","here's how","here’s why","here's why","this is why","this is how",
  "unveil","unveils","unveiled","reveal","reveals","revealed","uncover","explore"
];

// Curated, concise, newsy variants (no banned phrasing)
const VARIANTS = [
  "Which detail shifts the stakes appears in the piece.",
  "What officials weigh next could change the outcome.",
  "Key number and who it affects are in the full report.",
  "Two paths emerge—what each would mean is explained.",
  "One quote is driving pushback—catch it in the story.",
  "A deadline forces a decision sooner than expected.",
  "New data point reframes the issue—see the figure inside.",
  "Where the plan faces its toughest test comes next.",
  "The name behind the holdup appears in the article.",
  "A small rule has big effects—the specific one is named.",
  "Which precincts moved most—and why—are detailed inside.",
  "What happens if a vote stalls is outlined in the piece.",
  "How commuters and businesses are hit differs—breakdown inside.",
  "A single paragraph explains the opposition’s strategy.",
  "One map tells the story—pressure points are shown.",
  "An unexpected actor could decide it; they’re identified.",
  "Next hearing and agenda items are listed.",
  "A budget line does most of the work—the amount is there.",
  "What experts flagged privately surfaces publicly here.",
  "Which metric the mayor watches shows up in the story.",
  "A wording change matters—the exact line is quoted.",
  "Who benefits first—and who waits—breaks down in the article."
];

// Per-run cap on first-word reuse (prevents “Which Which Which…”)
const FIRST_WORD_CAP = 2;

// ---------- Post-processing / rewrite ----------
function needsRewrite(b3, recentOpeners){
  if (!b3) return true;
  const lower = b3.toLowerCase();
  if (BANNED_PHRASES.some(p => lower.includes(p))) return true;
  const open2 = firstTwoWords(lower);
  if (open2 && recentOpeners.includes(open2)) return true;
  return false;
}
function chooseVariant(recentOpeners, usedOpeners, firstWordFreq){
  // prefer variants that don't violate opener history and respect first-word caps
  const shuffled = VARIANTS.slice().sort(() => Math.random() - 0.5);
  for (const v of shuffled) {
    const op2 = firstTwoWords(v);
    const first = v.trim().split(/\s+/)[0].toLowerCase();
    if (recentOpeners.includes(op2)) continue;
    if (usedOpeners.has(op2)) continue;
    if ((firstWordFreq[first] || 0) >= FIRST_WORD_CAP) continue;
    usedOpeners.add(op2);
    firstWordFreq[first] = (firstWordFreq[first] || 0) + 1;
    return v;
  }
  // fallback: pick any and increment counts
  const v = shuffled[0];
  const op2 = firstTwoWords(v);
  const first = v.trim().split(/\s+/)[0].toLowerCase();
  usedOpeners.add(op2);
  firstWordFreq[first] = (firstWordFreq[first] || 0) + 1;
  return v;
}

// ---------- Summarizer ----------
async function summarizeItem(item, recentOpeners, usedOpeners, firstWordFreq){
  const { title, link, contentSnippet, isoDate, pubDate, categories } = item;
  const { text, image } = await extractArticle(link);
  const articleText = text || contentSnippet || title;

  const avoidList = Array.from(new Set([...recentOpeners, ...BANNED_PHRASES])).slice(0, 80);
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
Bullet 3 creates a respectful, **specific** curiosity gap in a serious, newsy voice (Boston.com tone).
- Use concrete nouns, names, places, or numbers when possible.
- Vary constructions: question, contrast, next step, or hinted specific.
- No hype, no ellipses, no stock phrasing like “discover,” “find out,” “see how/why,” “reveal.”
Global rules: concise, specific, clear journalistic style. Avoid repeating verbs/openers across bullets.
Return strict JSON: {"bullets": [ "...", "...", "..." ]}.
`;

  const user = `
TITLE: ${title}
URL: ${link}
PUBLISHED: ${isoDate || pubDate || ""}
SECTION: ${(categories || [])[0] || ""}

ARTICLE (truncated):
${clip(articleText)}

Constraints for bullet 3:
- Avoid these (case-insensitive): ${avoidList.join(", ")}
- ${styleSeed}
`;

  const resp = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system.trim() },
      { role: "user", content: user.trim() }
    ]
  });

  let bullets = [];
  try {
    const obj = JSON.parse(resp.choices[0]?.message?.content || "{}");
    bullets = Array.isArray(obj.bullets) ? obj.bullets.slice(0,3) : [];
  } catch {
    const raw = (resp.choices[0]?.message?.content || "")
      .split(/\n|•|-|\*/).map(s => s.trim()).filter(Boolean).slice(0,3);
    bullets = raw;
  }

  bullets = (bullets || []).map(b => b.replace(/\s+/g, " ").replace(/\.\.\.$/, "").trim()).slice(0,3);
  if (bullets.length < 3) while (bullets.length < 3) bullets.push("Further context in the full story.");

  // Enforce rewrite for bullet #3 if needed
  if (needsRewrite(bullets[2], recentOpeners)) {
    bullets[2] = chooseVariant(recentOpeners, usedOpeners, firstWordFreq);
  } else {
    // Even if accepted, cap first-word repetition
    const first = (bullets[2] || "").trim().split(/\s+/)[0].toLowerCase();
    const op2 = firstTwoWords(bullets[2]);
    usedOpeners.add(op2);
    firstWordFreq[first] = (firstWordFreq[first] || 0) + 1;
  }

  // Update history memory for this run
  const openerNow = firstTwoWords(bullets[2]);
  if (openerNow) recentOpeners.push(openerNow);

  return { bullets, image };
}

// ---------- Main ----------
async function main(){
  const recentOpeners = await loadRecentOpeners(200);
  const usedOpeners = new Set();
  const firstWordFreq = Object.create(null);

  const feed = await parser.parseURL(RSS_URL);
  const items = dedupe(feed.items || []).slice(0, MAX_ARTICLES);

  const results = [];
  for (const item of items) {
    try {
      const s = await summarizeItem(item, recentOpeners, usedOpeners, firstWordFreq);
      results.push({
        title: item.title || "",
        url: item.link,
        author: item.creator || item.author || "",
        section: (item.categories || [])[0] || "Top",
        published: item.isoDate || item.pubDate || "",
        image: s.image,
        bullets: s.bullets
      });
      await sleep(300);
    } catch (e) {
      console.warn("Summarize fail:", item.link, e.message);
    }
  }

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(HISTORY_FILE, JSON.stringify(results, null, 2));
  console.log(`Wrote ${HISTORY_FILE} (${results.length} stories)`);
}

main().catch(err => { console.error(err); process.exit(1); });
