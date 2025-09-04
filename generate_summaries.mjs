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

const MODEL        = process.env.OPENAI_MODEL || "gpt-4o"; // set to "gpt-5" if you have access
const RSS_URL      = process.env.RSS_URL || "https://www.boston.com/feed/bdc-msn-rss";
const MAX_ARTICLES = Number(process.env.MAX_ARTICLES || 16);
const HISTORY_FILE = "data/summaries.json"; // used for history-aware variety
const UA           = "Mozilla/5.0 (compatible; BostonSpeedReadBot/1.0; +https://github.com/)";

const client  = new OpenAI({ apiKey: OPENAI_API_KEY });
const parser  = new Parser();
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));

/* =========================
   Fetch & extract article
   ========================= */
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

    const ogImg =
      doc.querySelector('meta[property="og:image"]')?.content ||
      doc.querySelector('meta[name="twitter:image"]')?.content || null;

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

function clip(s, max = 7000) { return (s || "").replace(/\s+/g, " ").slice(0, max); }

function dedupe(items) {
  const seen = new Set();
  return items.filter(it => {
    const key = (it.link || it.guid || it.title || "").split("?")[0];
    if (seen.has(key)) return false; seen.add(key); return true;
  });
}

/* =========================
   Hook extraction (cheap heuristics)
   ========================= */
function extractHooks(text) {
  const hooks = { numbers: [], quotes: [], dates: [], actors: [], impacts: [], comparisons: [] };
  const t = (text || "").replace(/\s+/g, " ");

  // numbers & money & percents
  (t.match(/\$[\d,.]+|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+%/g) || []).slice(0,3)
    .forEach(v => hooks.numbers.push(v));

  // simple quotes
  (t.match(/“([^”]{10,140})”/g) || []).slice(0,2)
    .forEach(q => hooks.quotes.push(q.replace(/[“”]/g,"")));

  // dates/deadlines/day refs
  (t.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|January|February|March|April|May|June|July|August|September|October|November|December)\b[^.]{0,40}/gi) || [])
    .slice(0,2).forEach(d => hooks.dates.push(d.trim()));

  // proper nouns (rough): 2–4 capitalized words
  (t.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3})\b/g) || []).slice(0,4)
    .forEach(n => hooks.actors.push(n));

  // impacts
  (t.match(/\b(could|would|faces?|penalty|ban|cost|delay|risk|cut|tax|fee|fine|closure|layoffs?)\b[^.]{0,60}/gi) || [])
    .slice(0,2).forEach(s => hooks.impacts.push(s.trim()));

  // comparisons
  (t.match(/\b(vs\.|compared with|more than|less than|tops|lags|ranks?)\b[^.]{0,60}/gi) || [])
    .slice(0,1).forEach(s => hooks.comparisons.push(s.trim()));

  return hooks;
}

/* =========================
   Repetition guard / history
   ========================= */
function firstTwoWords(s) { return (s || "").trim().split(/\s+/).slice(0,2).join(" ").toLowerCase(); }

async function loadRecentOpeners(limit = 200) {
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
  } catch {
    return [];
  }
}

/* =========================
   Style constraints
   ========================= */
const BANNED_PHRASES = [
  "discover","find out","learn","see how","see why","read how","read why",
  "here’s how","here's how","here’s why","here's why","this is why","this is how",
  "unveil","unveils","unveiled","reveal","reveals","revealed","uncover","explore"
];

// NO questions in #3: ban question marks and questiony openers
const QUESTIONY_OPENERS = [
  "what","which","how","why","where","who","when","does","do","can","should","will","is","are","could","would","did"
];

// diverse declarative/imperative variants used only when rewrite is needed
const VARIANTS = [
  "Read what Patão said about Boston’s sports culture and building an NWSL team.",
  "Inside: the board’s role—and what happens next—at the nonprofit.",
  "Next step is scheduled—agenda details are inside.",
  "See the key number and who it affects in the full report.",
  "Inside the quote driving pushback—read it in context.",
  "Two paths are on the table; the trade-offs are laid out inside.",
  "New data point reframes the issue—the figure is in the story.",
  "Where the plan faces its toughest test comes next—full breakdown inside.",
  "The name behind the holdup appears in the article.",
  "A small rule has big effects—the specific provision is named.",
  "Which precincts shifted most—and why—are detailed in the piece.",
  "What happens if a vote stalls is outlined in the article.",
  "Commuters vs. businesses: the impacts are broken down.",
  "One paragraph explains the opposition’s strategy—read it in the story.",
  "One map tells the story—pressure points are shown inside.",
  "An unexpected actor could decide it—them being identified in the piece.",
  "Next hearing date and items are listed inside.",
  "A budget line carries the weight—the amount is listed.",
  "What experts flagged privately surfaces publicly here—see the document pull-quote.",
  "The metric the mayor watches shows up in the story.",
  "A wording change matters—the exact line is quoted."
];

const FIRST_WORD_CAP = 2; // don't start bullet #3 with the same word >2 times per run

/* =========================
   Declarative move set (no questions)
   ========================= */
const MOVES = {
  readWhat:     (h) => `Read what ${h.actor || "officials"} said ${h.when ? "on " + h.when : "today"}.`,
  insideBoard:  (h) => `Inside: the board’s role—and what happens next.`,
  nextStep:     (h) => `Next step is scheduled${h.when ? ` (${h.when})` : ""}—agenda details inside.`,
  contrast:     (h) => `Two paths are on the table; the trade-offs are laid out inside.`,
  stakeholder:  (h) => `${h.actor || "One union"} could be decisive—why they matter is in the piece.`,
  stat:         (h) => `See the key number${h.number ? ` (${h.number})` : ""} and who it affects.`,
  quote:        (h) => `Inside the quote driving pushback—read it in context.`,
  map:          (h) => `One map tells the story—hotspots are shown inside.`,
  money:        (h) => `A budget line carries most of the weight—the amount is listed.`
};

function pickMove(counts) {
  const all = ["readWhat","insideBoard","nextStep","contrast","stakeholder","stat","quote","map","money"];
  for (const m of all.sort((a,b)=>(counts[a]||0)-(counts[b]||0))) return m;
  return "readWhat";
}

function buildHook(hooks) {
  return {
    actor: hooks.actors[0],
    number: hooks.numbers[0],
    when: hooks.dates[0]
  };
}

/* =========================
   Validators / rewrite logic
   ========================= */
function isQuestionish(s = "") {
  const lower = s.trim().toLowerCase();
  if (lower.includes("?")) return true;
  const first = lower.split(/\s+/)[0] || "";
  return QUESTIONY_OPENERS.includes(first);
}

function needsRewrite(b3, recentOpeners) {
  if (!b3) return true;
  const lower = b3.toLowerCase();
  if (isQuestionish(lower)) return true;
  if (BANNED_PHRASES.some(p => lower.includes(p))) return true;
  const open2 = firstTwoWords(lower);
  if (open2 && recentOpeners.includes(open2)) return true;
  return false;
}

function chooseVariant(recentOpeners, usedOpeners, firstWordFreq) {
  const pool = VARIANTS.slice().sort(() => Math.random() - 0.5);
  for (const v of pool) {
    if (isQuestionish(v)) continue;
    const op2 = firstTwoWords(v);
    const first = v.trim().split(/\s+/)[0].toLowerCase();
    if (recentOpeners.includes(op2)) continue;
    if (usedOpeners.has(op2)) continue;
    if ((firstWordFreq[first] || 0) >= FIRST_WORD_CAP) continue;
    usedOpeners.add(op2);
    firstWordFreq[first] = (firstWordFreq[first] || 0) + 1;
    return v;
  }
  // fallback
  const v = pool[0];
  const op2 = firstTwoWords(v);
  const first = v.trim().split(/\s+/)[0].toLowerCase();
  usedOpeners.add(op2);
  firstWordFreq[first] = (firstWordFreq[first] || 0) + 1;
  return v;
}

function finalizeVariant(candidate, recentOpeners, usedOpeners, firstWordFreq) {
  if (!candidate) candidate = "Further context is in the full story.";
  candidate = candidate.replace(/\?+/g, "").trim(); // belt & suspenders
  const op2 = firstTwoWords(candidate);
  const first = candidate.trim().split(/\s+/)[0].toLowerCase();
  if (!recentOpeners.includes(op2)) recentOpeners.push(op2);
  usedOpeners.add(op2);
  firstWordFreq[first] = (firstWordFreq[first] || 0) + 1;
  return candidate;
}

/* =========================
   Summarization
   ========================= */
async function summarizeItem(item, recentOpeners, usedOpeners, firstWordFreq, runMoveCounts) {
  const { title, link, contentSnippet, isoDate, pubDate, categories } = item;
  const { text, image } = await extractArticle(link);
  const hooks = extractHooks(text);
  const articleText = text || contentSnippet || title;

  const avoidList = Array.from(new Set([...recentOpeners, ...BANNED_PHRASES])).slice(0, 100);
  const styleSeeds = [
    "Use declarative/imperative phrasing for bullet 3—no questions, no question marks.",
    "Reference a concrete noun/number/name when available, without spoiling the detail.",
    "Vary lead-ins across stories; avoid repeating the same first two words.",
    "Keep all bullets ≤ 22 words, clear and newsy.",
  ];
  const styleSeed = styleSeeds[Math.floor(Math.random() * styleSeeds.length)];

  const system = `
You are a Boston-area news copy editor. Produce EXACTLY three bullets (<= 22 words each).

Bullet 1–2: clear, specific, neutral.
Bullet 3: MUST be declarative or imperative (no questions, no "?"), creating a respectful, specific curiosity cue in a serious Boston.com tone.
- Use concrete nouns, names, places, or numbers when available.
- No hype, no ellipses, no stock phrasing ("discover/find out/learn/see how/why/reveal").
- Do not spoil the detail teased in bullet 3.

Return strict JSON: {"bullets": ["...", "...", "..."]}.
`.trim();

  const user = `
TITLE: ${title}
URL: ${link}
PUBLISHED: ${isoDate || pubDate || ""}
SECTION: ${(categories || [])[0] || ""}

HOOKS:
- numbers: ${hooks.numbers.join(", ") || "—"}
- quotes: ${hooks.quotes.join(" | ") || "—"}
- dates: ${hooks.dates.join(", ") || "—"}
- actors: ${hooks.actors.join(", ") || "—"}
- impacts: ${hooks.impacts.join(" | ") || "—"}
- comparisons: ${hooks.comparisons.join(" | ") || "—"}

ARTICLE (truncated):
${clip(articleText)}

Constraints for bullet 3:
- Declarative/imperative only; do NOT use a question mark.
- Avoid these (case-insensitive): ${avoidList.join(", ")}
- ${styleSeed}
`.trim();

  const resp = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
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
  if (bullets.length < 3) while (bullets.length < 3) bullets.push("Further context is in the full story.");

  // Validate/enforce bullet #3 (declarative + variety)
  let moveUsed = "model";
  if (needsRewrite(bullets[2], recentOpeners)) {
    const move = pickMove(runMoveCounts);
    const h    = buildHook(hooks);
    const candidate = MOVES[move](h);
    bullets[2] = finalizeVariant(candidate, recentOpeners, usedOpeners, firstWordFreq);
    moveUsed = move;
    runMoveCounts[move] = (runMoveCounts[move] || 0) + 1;
  } else {
    // Cap first-word repetition & record opener
    const first = (bullets[2] || "").trim().split(/\s+/)[0].toLowerCase();
    const op2   = firstTwoWords(bullets[2]);
    usedOpeners.add(op2);
    firstWordFreq[first] = (firstWordFreq[first] || 0) + 1;
  }

  // Update history memory
  const openerNow = firstTwoWords(bullets[2]);
  if (openerNow) recentOpeners.push(openerNow);

  return { bullets, image, moveUsed };
}

/* =========================
   Main
   ========================= */
async function main(){
  const recentOpeners  = await loadRecentOpeners(220);
  const usedOpeners    = new Set();
  const firstWordFreq  = Object.create(null);
  const runMoveCounts  = Object.create(null);

  const feed   = await parser.parseURL(RSS_URL);
  const items  = dedupe(feed.items || []).slice(0, MAX_ARTICLES);
  const results = [];

  for (const item of items) {
    try {
      const s = await summarizeItem(item, recentOpeners, usedOpeners, firstWordFreq, runMoveCounts);
      results.push({
        title: item.title || "",
        url: item.link,
        author: item.creator || item.author || "",
        section: (item.categories || [])[0] || "Top",
        published: item.isoDate || item.pubDate || "",
        image: s.image,
        bullets: s.bullets,
        meta: { move: s.moveUsed } // lightweight metadata for future biasing
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

main().catch(err => { console.error(err); process.exit(1); });
