# Boston Speed Read

Three-bullet AI summaries of Boston.com via RSS, with a curiosity-gap third bullet. Static site + GitHub Actions so your API key stays secret.

## Quick Start
1) Create a new GitHub repo.  
2) Upload all files from this ZIP to the root.  
3) Repo Settings → Secrets and variables → Actions → **New repository secret**: `OPENAI_API_KEY` = your key.  
4) Repo Settings → Pages → Build & deployment: **Deploy from a branch** → Branch: `main` → Folder: `/ (root)` → Save.  
5) Repo Settings → Actions → General → **Workflow permissions** → **Read and write permissions** → Save.  
6) Actions tab → **Summarize Boston.com** → **Run workflow**.  
7) Open your Pages URL: `https://<username>.github.io/<repo>/`.

## Config
- Default model: `gpt-5` (change to `gpt-4o` if needed) in `.github/workflows/summarize.yml`.
- Feed URL: `https://www.boston.com/feed/bdc-msn-rss` (override via `RSS_URL` env).
- Count: `MAX_ARTICLES` env (default 18).
- Styling: `styles.css` (mobile-first, Boston.com-ish palette).

## Local build (optional)
```bash
npm i
OPENAI_API_KEY=sk-... node generate_summaries.mjs
# creates data/summaries.json
# open index.html in a browser
```

## Notes
- The site reads `data/summaries.json` produced by the workflow and renders cards.
- Your OpenAI key never touches the browser.
- Hourly refresh (cron). Trigger manually anytime via Actions.
