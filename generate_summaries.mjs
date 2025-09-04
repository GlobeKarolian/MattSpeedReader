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
   Hook extraction (tight + sanitized)
   ========================= */
const ACTOR_STOP = new Set([
  "Boston.com","Sports News","News","Today","Opinion","Local News","Restaurant News","Most Popular",
  "Sign Up","Read More","Newsletter","Email","Comments","Create an Account","Minutes to Read","Sha","Share"
]);

function cleanActor(s=""){
  const t = s.replace(/\u00A0/g," ").trim();
  if (!t) return "";
  if (ACTOR_STOP.has(t)) return "";
  // drop things that look like UI/useless
  if (/^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(t)) return "";
  if (/^Read|Sign|Most|Sports$/i.test(t)) return "";
  return t;
}

function extractActorsFromTitle(title=""){
  const m = title.match(/\b([A-Z][\p{L}’'-]+(?:\s[A-Z][\p{L}’'-]+){0,3})\b/gu) || [];
  const out = [];
  for (const cand of m){
    const c = cleanActor(cand);
    if (c) out.push(c);
  }
  return [...new Set(out)].slice(0,3);
}

function extractHooks(text, title){
  const hooks = { numbers: [], quotes: [], dates: [], actors: [], impacts: [], comparisons: [] };
  const t = (text || "").replace(/\s+/g, " ");

  // Prefer actors from title, then body
  hooks.actors.push(...extractActorsFromTitle(title));
  const bodyActors = (t.match(/\b([A-Z][\p{L}’'-]+(?:\s[A-Z][\p{L}’'-]+){1,3})\b/gu) || [])
    .map(cleanActor).filter(Boolean).slice(0,4);
  hooks.actors.push(...bodyActors);

  // numbers & money & percents
  (t.match(/\$[\d,.]+|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+%/g) || []).slice(0,4)
    .forEach(v => hooks.numbers.push(v));

  // quotes (short)
  (t.match(/“([^”]{10,140})”/g) || []).slice(0,2)
    .forEach(q => hooks.quotes.push(q.replace(/[“”]/g,"")));

  // dates: month day, year [time]
  (t.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?(?:,\s*\d{1,2}:\d{2}\s?(?:AM|PM))?/gi) || [])
    .slice(0,2).forEach(d => hooks.dates.push(d.trim().slice(0,28)));

  // impacts
  (t.match(/\b(could|would|faces?|penalty|ban|cost|delay|risk|cut|tax|fee|fine|closure|layoffs?|suspend|probation)\b[^.]{0,60}/gi) || [])
    .slice(0,2).forEach(s => hooks.impacts.push(s.replace(/\s+/g," ").trim()));

  // comparisons
  (t.match(/\b(vs\.|compared with|more than|less than|tops|lags|ranks?)\b[^.]{0,60}/gi) || [])
    .slice(0,1).forEach(s => hooks.comparisons.push(s.replace(/\s+/g," ").trim()));

  // dedupe/trim
  hooks.actors = [...new Set(hooks.actors)].filter(Boolean).slice(0,4);
  hooks.numbers = [...new Set(hooks.numbers)];
  hooks.dates = [...new Set(hooks.dates)];
  return hooks;
}

/* =========================
   Domain detection → better moves
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
  } catch { return []; }
}

/* =========================
   Style constraints
   ========================= */
const BANNED_PHRASES = [
  "discover","find out","learn","see how","see why","read how","read why",
  "here’s how","here's how","here’s why","here's why","this is why","this is how",
  "unveil","unveils","unveiled","reveal","reveals","revealed","uncover","explore"
];
const QUESTIONY_OPENERS = ["what","which","how","why","where","who","when","does","do","can","should","will","is","are","could","would","did"];
const FIRST_WORD_CAP = 2;

/* =========================
   Move templates by domain (declarative only)
   ========================= */
const MOVES = {
  sports: {
    quote:   h => `Read ${h.actor || "the player"}’s key line in context.`,
    stat:    h => `See the figure that defines the deal${h.number ? ` (${h.number})` : ""}.`,
    next:    h => `Next on the calendar${h.when ? `: ${h.when}` : ""}—details inside.`,
    analysis:h => `How the move changes the lineup is broken down inside.`
  },
  entertainment: {
    timeline:h => `Production timeline and who’s attached are inside.`,
    quote:   h => `Read the line that’s shaping reactions.`,
    role:    h => `See how the role is framed—and what it signals.`,
    release: h => `Release window and episode plan are in the story.`
  },
  gov: {
    next:    h => `Next step is scheduled${h.when ? ` (${h.when})` : ""}—agenda details inside.`,
    money:   h => `A budget line carries the weight—the amount is listed.`,
    map:     h => `Where the plan faces its toughest test is mapped inside.`,
    board:   h => `Inside: the board’s role—and what happens next.`
  },
  courts: {
    docket:  h => `Key filings and next court date are listed inside.`,
    quote:   h => `Read the line lawyers are leaning on.`,
    stakes:  h => `What’s at stake if the motion fails is outlined.`
  },
  realestate: {
    rank:    h => `See the ranking and the number that moves the list.`,
    map:     h => `Neighborhoods driving the shift are shown on the map.`,
    money:   h => `Price bands and who’s buying are broken down.`
  },
  general: {
    readWhat:h => `Read what ${h.actor || "officials"} said${h.when ? ` on ${h.when}` : ""}.`,
    number:  h => `One figure reframes the story—see the number.`,
    next:    h => `What happens next is laid out inside.`,
    quote:   h => `A single line is driving pushback—read it in the piece.`
  }
};

function pickMoveForDomain(domain, hooks){
  switch(domain){
    case "sports": return hooks.numbers[0] ? "stat" : (hooks.quotes[0] ? "quote" : "analysis");
    case "entertainment": return hooks.dates[0] ? "timeline" : (hooks.quotes[0] ? "quote" : "role");
    case "gov": return hooks.dates[0] ? "next" : (/\bboard\b/i.test(hooks.impacts.join(" ")) ? "board" : (hooks.numbers[0] ? "money" : "map"));
    case "courts": return hooks.dates[0] ? "docket" : (hooks.quotes[0] ? "quote" : "stakes");
    case "realestate": return hooks.numbers[0] ? "rank" : "map";
    default: return hooks.actors[0] ? "readWhat" : (hooks.numbers[0] ? "number" : "next");
  }
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

function applyCapsAndRecord(line, recentOpeners, usedOpeners, firstWordFreq){
  let s = (line || "").replace(/\?+/g,"").trim();
  const op2 = firstTwoWords(s);
  const first = s.split(/\s+/)[0]?.toLowerCase() || "";
  usedOpeners.add(op2);
  firstWordFreq[first] = (firstWordFreq[first] || 0) + 1;
  if (!recentOpeners.includes(op2)) recentOpeners.push(op2);
  return s;
}

/* =========================
   Summarization
   ========================= */
async function summarizeItem(item, recentOpeners, usedOpeners, firstWordFreq){
  const { title, link, contentSnippet, isoDate, pubDate, categories } = item;
  const { text, image } = await extractArticle(link);
  const hooks   = extractHooks(text, title);
  const articleText = text || contentSnippet || title;
  const section = (item.categories || [])[0] || "";
  const domain  = detectDomain(text, section);

  const avoidList = Array.from(new Set([...recentOpeners, ...BANNED_PHRASES])).slice(0, 100);

  const system = `
You are a Boston-area news copy editor. Produce EXACTLY three bullets (<= 22 words each).
- Bullet 1–2: clear, specific, neutral.
- Bullet 3: MUST be declarative/imperative (no questions, no '?'), a specific curiosity cue in Boston.com tone.
- Use concrete nouns, names, places, or numbers when available. No hype. No ellipses. No stock phrasing ("discover/find out/learn/see how/why/reveal").
Return strict JSON: {"bullets": ["...", "...", "..."]}.
`.trim();

  const user = `
TITLE: ${title}
URL: ${link}
PUBLISHED: ${isoDate || pubDate || ""}
SECTION: ${section}
DOMAIN: ${domain}

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

  // Validate/enforce bullet #3 with domain-aware phrasing
  if (needsRewrite(bullets[2], recentOpeners)) {
    const moveKey = pickMoveForDomain(domain, hooks);
    const moveSet = MOVES[domain] || MOVES.general;
    const templ   = moveSet[moveKey] || MOVES.general.next;
    const candidate = templ({ actor: hooks.actors[0], number: hooks.numbers[0], when: hooks.dates[0] });
    bullets[2] = candidate;
  }

  // Cap first-word repetition & record opener
  const first = (bullets[2] || "").split(/\s+/)[0].toLowerCase();
  if ((firstWordFreq[first] || 0) >= FIRST_WORD_CAP) {
    // if over cap, switch to a neutral generic line
    bullets[2] = "What happens next is laid out inside.";
  }
  bullets[2] = applyCapsAndRecord(bullets[2], recentOpeners, usedOpeners, firstWordFreq);

  // Debug log to verify choices
  console.log("Move/domain:", domain, "title:", title, "actor:", hooks.actors[0] || "-", "date:", hooks.dates[0] || "-");

  return { bullets, image };
}

/* =========================
   History
   ========================= */
function firstTwoWords(s) { return (s || "").trim().split(/\s+/).slice(0,2).join(" ").toLowerCase(); }

/* =========================
   Main
   ========================= */
async function main(){
  const recentOpeners  = await loadRecentOpeners(220);
  const usedOpeners    = new Set();
  const firstWordFreq  = Object.create(null);

  const feed   = await parser.parseURL(RSS_URL);
  const items  = dedupe(feed.items || []).slice(0, MAX_ARTICLES);
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
