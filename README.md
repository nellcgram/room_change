# Room Change

A to-scale room planner for reworking a bedroom: drag furniture into place, mark
the paths that need to stay clear, and get called out when something (like a
cedar chest with no assigned job) is quietly becoming a junk pile.

## Using it

Open `index.html` in a browser (or visit the deployed site — see below).

- **Room Setup** — enter your room's width/length and where the door is, in inches.
- **+ Add Furniture** — add a piece with its real width/depth and a "job" (seating,
  storage, surface, light, footrest, decorative, other). Drag it to move it, drag
  the small orange handle to turn it to any angle.
- **+ Mark a Clear Path** — drag out a lane that has to stay open (e.g. door to
  closet); anything that overlaps it gets flagged.
- **Zones** — group furniture into a named zone (like "Reading Nook") and see a
  checklist of what it still needs.
- **Issues** — a running list of overlaps, blocked paths, pieces with no job, and
  zones missing something.
- **Get AI Design Review** — sends a text description of your room to Claude and
  shows back a written critique (what's actually wrong, and specific fixes). This
  needs a one-time setup — see **AI Design Review setup** below. Until it's set
  up, clicking the button just asks you to paste in a Worker URL.

Everything saves automatically to your browser's local storage. Use **Save Backup
File** / **Load Backup File** to back up your layout to a file or move it to
another device/browser.

## Tech

Plain HTML/CSS/JS, no build step, no dependencies. Furniture and paths are SVG
shapes; collision and clearance checks use rotated-rectangle overlap math so
furniture can sit at any angle.

## Deploying

This is a static site — GitHub Pages can serve it directly. In the repo's
**Settings → Pages**, set the source to "Deploy from a branch," branch `main`,
folder `/ (root)`.

## AI Design Review setup

The app itself can't safely hold an Anthropic API key (anyone viewing the page's
source could take it), so the "Get AI Design Review" button talks to a small
backend — a [Cloudflare Worker](https://workers.cloudflare.com/) — that holds the
key privately and forwards requests to Claude. This is a one-time setup, free on
Cloudflare's free tier, and only the app's owner needs to do it.

1. **Get an Anthropic API key** at [platform.claude.com](https://platform.claude.com) —
   sign up, create an API key under "API Keys." (New accounts get some free credit
   to start; no payment is required just to create a key.)
2. **Create a Cloudflare account** (free) at [dash.cloudflare.com](https://dash.cloudflare.com).
3. **Create a KV namespace** — in the Cloudflare dashboard, go to Workers & Pages →
   KV, create a namespace (e.g. `room-change-rate-limit`).
4. **Create a Worker** — Workers & Pages → Create → "Create Worker." Give it a
   name, then open its code editor and replace the default code with the contents
   of [`worker/analyze.js`](worker/analyze.js) from this repo.
5. **Bind the KV namespace** — in the Worker's Settings → Variables (or
   "Bindings"), add a KV namespace binding named exactly `RATE_LIMIT_KV`, pointing
   at the namespace from step 3.
6. **Add the API key as a secret** — in the same Settings → Variables area, add an
   environment variable named `ANTHROPIC_API_KEY`, paste in the key from step 1,
   and mark it as **Encrypt** (secret) — never as plain text.
7. **Deploy** the Worker and copy its URL (something like
   `https://room-change-analyze.<your-subdomain>.workers.dev`).
8. In the app, click **Get AI Design Review** once — it'll ask for that Worker
   URL. Paste it in and save. That's it; it's remembered from then on.

The Worker in this repo restricts requests to `https://nellcgram.github.io`
(edit `ALLOWED_ORIGIN` in `worker/analyze.js` if you fork this to your own site)
and caps total analyses to 100/day across all visitors, so a stray or abused
request can't run up a surprise bill.
