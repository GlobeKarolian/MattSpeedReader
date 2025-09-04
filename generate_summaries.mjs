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
   Small helpers
   ========================= */
function clip(s, max = 7000) { return (s || "").replace(/\s+/g, " ").slice(0, max); }
function firstTwoWords(s) { return (s || "").trim().split(/\s+/).slice(0,2).join(" ").toLowerCase(); }

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

function dedupe(items) {
  const seen = new Set();
  return items.filter(it => {
    const key = (it.link || it.guid || it.title || "").split("?")[0];
    if (seen.has(key)) return false; seen.add(key); return true;
  });
}

/* =========================
   Actor cleaning / hook extraction
   ========================= */
const ACTOR_STOP = new Set([
  "Boston.com","Sports News","News","Today","Opinion","Local News","Restaurant News","Most Popular",
  "Sign Up","Read More","Newsletter","Email","Comments","Create an Account","Minutes to Read","Share","Globe","AP","Associated Press","Reuters"
]);

const QUESTIONY_OPENERS = [
  "what","which","how","why","where","who","when","does","do","can","should","will","is","are","could","would","did"
];

// Reject things that look like datestamps/times or UI junk
function cleanActor(raw = "") {
  let s = (raw || "").replace(/\u00A0/g," ").trim();
  if (!s) return "";

  if (ACTOR_STOP.has(s)) return "";

  // Drop leading interrogatives from titles like "What Josh McDaniels said ..."
  const first = s.split(/\s+/)[0].toLowerCase();
  if (QUESTIONY_OPENERS.includes(first)) s = s.split(/\s+/).slice(1).join(" ").trim();

  // Reject Month Day, Year or HH:MM AM/PM style strings and lone years
  if (/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(s)) return "";
  if (/\b\d{1,2}:\d{2}\s?(AM|PM)\b/i.test(s)) return "";
  if (/^\d{4}$/.test(s)) return "";

  // Avoid bare locations that commonly creep in as non-actors
  if (/^Las Vegas$/i.test(s)) return "";

  // Remove leading articles
  s = s.replace(/^(The|A|An)\s+/i,"").trim();

  // Very short single token? skip
  if (!/\s/.test(s) && s.length < 4) return "";

  return s;
}

function actorsFromTitle(title=""){
  const m = title.match(/\b([A-Z][\p{L}’'-]+(?:\s[A-Z][\p{L}’'-]+){0,3})\b/gu) || [];
  const out = [];
  for (const cand of m) {
    const c = cleanActor(cand);
    if (c) out.push(c);
  }
  return [...new Set(out)];
}

function pickBestActor(hooks, title){
  const fromTitle = actorsFromTitle(title);
  if (fromTitle.length) return fromTitle[0];
  for (const a of hooks.actors || []) {
    const c = cleanActor(a);
    if (c) return c;
  }
  return "";
}

function extractHooks(text, title = ""){
  const hooks = { numbers: [], quotes: [], dates: [], actors: [], impacts: [], comparisons: [] };
  const t = (text || "").replace(/\s+/g, " ");

  // ACTORS: prefer from TITLE, then BODY; clean each
  hooks.actors.push(...actorsFromTitle(title));
  const bodyActors = (t.match(/\b([A-Z][\p{L}’'-]+(?:\s[A-Z][\p{L}’'-]+){1,3})\b/gu) || [])
    .map(cleanActor).filter(Boolean).slice(0,6);
  hooks.actors.push(...bodyActors);

  // numbers & money & percents
  (t.match(/\$[\d,.]+|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+%/g) || [])
    .slice(0,4).forEach(v => hooks.numbers.push(v));

  // quotes (short)
  (t.match(/“([^”]{10,140})”/g) || [])
    .slice(0,2).forEach(q => hooks.quotes.push(q.replace(/[“”]/g,"")));

  // dates: Month day, (year) (optional time) — we keep for model context, but NEVER inject into teaser
  (t.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?(?:,\s*\d{1,2}:\d{2}\s?(?:AM|PM))?/gi) || [])
    .slice(0,2).forEach(d => hooks.dates.push(d.trim()));

  // impacts
  (t.match(/\b(could|would|faces?|penalty|ban|cost|delay|risk|cut|tax|fee|fine|closure|layoffs?|suspend|probation)\b[^.]{0,60}/gi) || [])
    .slice(0,2).forEach(s => hooks.impacts.push(s.replace(/\s+/g," ").trim()));

  // comparisons
  (t.match(/\b(vs\.|compared with|more than|less than|tops|lags|ranks?)\b[^.]{0,60}/gi) || [])
    .slice(0,1).forEach(s => hooks.comparisons.push(s.replace(/\s+/g," ").trim()));

  // unique & trim
  hooks.actors = [...new Set(hooks.actors)].filter(Boolean).slice(0,4);
  hooks.numbers = [...new Set(hooks.numbers)];
  hooks.dates = [...new Set(hooks.dates)];
  return hooks;
}

/* =========================
   History / repetition guard
   ========================= */
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
  } catch { return []; }
}

const FIRST_WORD_CAP = 3; // don't start teaser with same word >3 times per run
const BANNED_PHRASES = /(discover|find out|learn|see how|see why|reveal|unveil|uncover)/i;

/* =========================
   Domain detection → teaser templates
   ========================= */
function detectDomain(text="", section=""){
  const s = (section||"").toLowerCase();
  const t = (text||"").toLowerCase();
  if (/\bsport|patriots|bruins|celtics|red sox|revs|nws l|coach|contract|game|season\b/.test(s+t)) return "sports";
  if (/\barts|entertain|celebrity|film|series|tv|cast|director|premiere|episode\b/.test(s+t)) return "entertainment";
  if (/\bcity council|select board|board of directors|commission|hearing|vote|ordinance|zoning|mayor|governor|legislature\b/.test(t)) return "gov";
  if (/\bcourt|arraign|indicted|charges?|trial|jury|appeal|appeals\b/.test(t)) return "courts";
  if (/\breal estate|home sales|median price|zillow|bbj\b/.test(s+t)) return "realestate";
  return "general";
}

/* =========================
   Teaser builder (bullet #3) — deterministic, no dates
   ========================= */
function buildTeaser(hooks, domain, title){
  const actor = pickBestActor(hooks, title);
  const num   = hooks.numbers[0];

  // Declarative/imperative only; NEVER include raw dates/timestamps
  const T = {
    sports: [
      actor ? `Read what ${actor} said.` : null,
      num ? `See the number that defines the deal (${num}).` : null,
      `How the move changes the lineup is broken down inside.`
    ],
    entertainment: [
      `Production timeline and who’s attached are inside.`,
      `Read the quote shaping reactions.`,
      `Release window and episode plan are in the story.`
    ],
    gov: [
      `Next step is scheduled—agenda details inside.`,
      `Inside: the board’s role—and what happens next.`,
      `A budget line carries the weight—the amount is listed.`
    ],
    courts: [
      `Key filings and the next court date are listed inside.`,
      `Read the line lawyers are leaning on.`,
      `What’s at stake if the motion fails is outlined.`
    ],
    realestate: [
      num ? `See the ranking’s key number (${num}).` : `See the ranking and what moved it.`,
      `Neighborhoods driving the shift are shown on the map.`,
      `Price bands and who’s buying are broken down.`
    ],
    general: [
      actor ? `Read what ${actor} said.` : null,
      num ? `One figure reframes the story—see the number (${num}).` : `One figure reframes the story—see the number.`,
      `What happens next is laid out inside.`
    ]
  };

  const list = T[domain] || T.general;
  let line = list.find(Boolean) || `What happens next is laid out inside.`;

  // Guardrails: no banned words, no ellipses, trim
  line = line.replace(/\.\.\.$/,"").trim();
  if (BANNED_PHRASES.test(line)) line = `What happens next is laid out inside.`;
  return line;
}

/* =========================
   Summarization (model for bullets 1–2 only, teaser local)
   ========================= */
async function summarizeItem(item, recentOpeners, openerFreq){
  const { title, link, contentSnippet, isoDate, pubDate, categories } = item;
  const { text, image } = await extractArticle(link);
  const hooks   = extractHooks(text, title);
  const articleText = text || contentSnippet || title;
  const section = (item.categories || [])[0] || "";
  const domain  = detectDomain(text, section);

  // Model produces exactly TWO factual bullets (no curiosity language)
  const system = `
You are a Boston-area news copy editor.
Return strict JSON: {"bullets":["...", "..."]}.
Write EXACTLY TWO bullets (<=22 words each), specific and neutral, summarizing the article’s most important facts.
No curiosity-gap phrasing. No questions. No ellipses. No hype.
`.trim();

  const user = `
TITLE: ${title}
URL: ${link}
PUBLISHED: ${isoDate || pubDate || ""}
SECTION: ${section}

ARTICLE (truncated):
${clip(articleText)}
`.trim();

  let two = [];
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
    two = Array.isArray(obj.bullets) ? obj.bullets.slice(0,2) : [];
  } catch (e) {
    console.warn("Model 2-bullet summarize fail:", link, e.message);
    two = (articleText.match(/[^.!?]+[.!?]/g) || []).slice(0,2).map(s => s.trim());
  }

  two = two.map(b => b.replace(/\s+/g," ").replace(/\.\.\.$/, "").trim());

  // Local teaser (#3) — no dates
  let teaser = buildTeaser(hooks, domain, title);

  // Variety across page & runs
  const opener = firstTwoWords(teaser);
  const firstWord = teaser.split(/\s+/)[0].toLowerCase();
  if (recentOpeners.includes(opener) || (openerFreq[firstWord] || 0) >= FIRST_WORD_CAP) {
    // Try alternate actor/number; otherwise neutral
    const altHooks = { ...hooks, actors: hooks.actors.slice(1), numbers: hooks.numbers.slice(1) };
    const alt = buildTeaser(altHooks, domain, title);
    teaser = (alt && firstTwoWords(alt) !== opener) ? alt : "What happens next is laid out inside.";
  }
  openerFreq[firstWord] = (openerFreq[firstWord] || 0) + 1;
  if (!recentOpeners.includes(opener)) recentOpeners.push(opener);

  const bullets = [two[0] || "", two[1] || "", teaser];
  return { bullets, image };
}

/* =========================
   Main
   ========================= */
async function main(){
  const recentOpeners  = await loadRecentOpeners(220);
  const openerFreq     = Object.create(null);

  const feed   = await parser.parseURL(RSS_URL);
  const items  = dedupe(feed.items || []).slice(0, MAX_ARTICLES);
  const results = [];

  for (const item of items) {
    try {
      const s = await summarizeItem(item, recentOpeners, openerFreq);
      results.push({
        title: item.title || "",
        url: item.link,
        author: item.creator || item.author || "",
        section: (item.categories || [])[0] || "Top",
        published: item.isoDate || item.pubDate || "",
        image: s.image,
        bullets: s.bullets
      });
      await sleep(250); // polite pacing
    } catch (e) {
      console.warn("Summarize fail:", item.link, e.message);
    }
  }

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(HISTORY_FILE, JSON.stringify(results, null, 2));
  console.log(`Wrote ${HISTORY_FILE} (${results.length} stories)`);
}

main().catch(err => { console.error(err); process.exit(1); });
