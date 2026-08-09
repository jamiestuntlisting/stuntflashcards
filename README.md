# 🎬 Stunt Flashcards

Paste a StuntListing list URL and learn everyone on it — names, faces, bios, and skills — with flashcards. Runs entirely on **Cloudflare Workers**.

**Live:** https://stunt-flashcards.jamie-181.workers.dev

## How it works

- Paste a list URL (e.g. `https://stuntlisting.com/lists/…`) and hit **Build flashcards**.
- The Worker fetches the page server-side (no CORS issues), finds the people on it, and returns a roster: name, headshot, About Me, and skills with descriptions.
- The app builds a shuffled deck:
  - **Headshot → name** — one card for *every* person on the list, so everybody's headshot gets used.
  - **About Me → who is it?** — the bio with the person's own name redacted; guess who wrote it.
  - **Skill → whose is it?** — a random selection of skills that have descriptions.
- Two study modes:
  - **No names** — answer in your head, flip to check, self-grade.
  - **Multiple choice** — pick from 4 names (keyboard 1–4).
- Finish a deck to see your score and re-run just the cards you missed. The roster and settings are saved in your browser (localStorage) — nothing is stored server-side.

## Project layout

```
src/worker.js     Cloudflare Worker: /api/list (fetch + parse a list URL),
                  /api/img (headshot proxy fallback), static assets
src/parser.js     Roster extraction: embedded JSON (Next/Nuxt/JSON-LD/app-state)
                  with a deep person-object scan, then HTML scraping fallback
public/           The flashcard app (no build step — plain HTML/CSS/JS)
test/             Parser unit tests + HTML fixtures (`npm test`)
```

## Deploying to Cloudflare

### Option A — GitHub Actions (already wired up)

`.github/workflows/deploy.yml` deploys on every push. It needs two repository secrets
(**Settings → Secrets and variables → Actions**):

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token → use the **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → Account ID (right sidebar) |

Once the secrets are set, push (or run the workflow manually from the Actions tab) and the app
goes live at `https://stunt-flashcards.<your-subdomain>.workers.dev`. The workflow runs `npm test`
before deploying, so a parser regression fails the build instead of shipping.

### Option B — from your machine

```bash
npm install
npx wrangler login
npm run deploy
```

## Local development

```bash
npm install
npm test        # parser unit tests
npm run dev     # http://localhost:8787
```

The setup screen has a **demo roster** (fictional people) so you can try the app without a list URL.

## Shareable list links

Loading a list rewrites the address bar to `/?list=<url>`, and opening that link builds the
same deck straight away. So a specific roster — a New York crew, a show's stunt team — can be
bookmarked or sent to someone as a ready-made study link.

## Configuration

All in `wrangler.jsonc` → `vars`:

- **`ALLOWED_HOSTS`**: comma-separated host suffixes `/api/list` may fetch, so the Worker can't be
  used as an open proxy. Default `stuntlisting.com`, which also covers subdomains like
  `site.staging.stuntlisting.com`. Add more suffixes if your lists live elsewhere.
- **`SAMPLE_LIST_URL`**: optional. A real, publicly-viewable list URL to offer as a one-click sample
  deck on the setup screen. Empty by default, which hides the button. The list is fetched live like
  any other, so no one's roster or headshots are copied into this repo and the sample never goes stale.
- **`SAMPLE_LIST_LABEL`**: the button's text (default "Load the New York sample").

## Notes & limits

- The list page must be **publicly viewable** (no login). If the page requires auth or renders its
  roster only via client-side JavaScript with no embedded data, the API responds with a specific,
  actionable error message.
- Headshots load straight from their original URLs; if a host blocks hotlinking, the app
  automatically retries through the Worker's `/api/img` proxy, then falls back to an initials avatar.
- Parsed rosters are cached at the edge for 10 minutes; headshots for a day.
