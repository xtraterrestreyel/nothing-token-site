NOTHING
A joke fintech-style landing page for a Solana token that represents nothing.
Pure HTML/CSS/JS — no build step, no framework, works directly on GitHub Pages.
Files
`index.html` — page structure
`style.css` — void/glitch visual theme
`app.js` — starfield, glitch effect, orb pulse, live/demo trade feed
1. Get a free Helius RPC key (required)
Solana's public RPC endpoint blocks direct browser requests — it's meant for
servers, not websites. A static site has no server, so you need an RPC
provider that explicitly supports browser calls. Helius has a free tier
built for exactly this:
Sign up at https://www.helius.dev (free, no credit card)
Create a project and copy your API key
Open `app.js` and paste it into `CONFIG.RPC_ENDPOINT`:
```js
RPC_ENDPOINT: "https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY",
```
Note: this key will be visible to anyone who views the page source — that's
unavoidable on a pure static site. Free-tier keys are rate-limited per key,
so the worst case if someone copies it is your free quota runs out faster;
you can regenerate it anytime from the Helius dashboard.
Until this is set, the status badge will say "SET AN RPC KEY — SEE README"
even if you've already set a real contract address.
2. Set your contract address
Same file, just below the RPC key:
```js
const CONFIG = {
  CONTRACT_ADDRESS: "REPLACE_WITH_YOUR_CONTRACT_ADDRESS", // <- your mint address
  LAUNCH_DATE: "2026-07-19T00:00:00Z",                     // <- your launch time
  ...
};
```
Until you set a real address, the site runs in DEMO MODE — it shows a
"DEMO MODE" badge and simulates buy/sell ticks and curve progress so the
page isn't empty.
3. What "live" actually means here
This is a static site with no backend. Once both the RPC key and the mint
address are set, the visitor's own browser subscribes directly to Solana
over a WebSocket — it doesn't sit there polling on a timer:
Trade feed: subscribes to new transactions mentioning the mint
(`logsSubscribe`) and gets notified the instant one confirms, then infers
buy vs. sell from balance changes. This is the same "push, not poll"
model behind sites like Dexscreener, so the delay you see is basically
just Solana's own confirmation time (roughly 1-2s), not an artificial gap
from checking every few seconds. If the WebSocket subscription can't
connect for some reason (a restrictive network, mostly), it automatically
falls back to polling every few seconds so the feed still works, just
slower — and yes, that fallback path can occasionally miss something
under heavy load or a flaky connection. For a bulletproof feed at scale,
swap this for a dedicated indexer/webhook (Helius webhooks, Shyft,
Bitquery, etc).
Bonding curve + graduation: subscribes to the bonding curve account
itself (`accountSubscribe`) and re-decodes it the moment it changes — no
third-party pump.fun API involved, so there's nothing for pump.fun's
servers to block or rate-limit, and no polling delay either. A
low-frequency safety recheck runs in the background too, just in case a
single update notification ever gets dropped.
One honesty note: pump.fun doesn't publish a "graduated at" timestamp
on-chain. The first time this site sees the bonding curve account report
`complete`, it stamps that moment itself and saves it in the visitor's own
browser (`localStorage`, scoped to this mint) — a local record of when
that browser first noticed, not a blockchain-verified timestamp. Since
March 2025, pump.fun graduations go to its own AMM, PumpSwap, by default,
so that's what the graduation badge names; the Dexscreener link in the
header will always show you the actual pool if you want to confirm.
4. Add memes to the gallery (optional)
Drop your image files straight into the `images` folder next to `index.html`,
then list the filenames in `app.js`:
```js
MEME_IMAGES: [
  "meme-1.jpg",
  "meme-2.png",
],
```
Order in the list = order on the page. Filenames are case-sensitive. A
missing or misspelled file is skipped silently on the page itself — check
the browser console for a warning naming exactly which file it couldn't find.
5. Preview locally
Don't just double-click `index.html` — opening a file directly (`file://`)
gets treated as an untrusted origin and blocks these API calls even with
everything configured correctly. Serve it instead, from this folder:
```powershell
python -m http.server 8000
```
Then open http://localhost:8000
6. Deploy to GitHub Pages
```powershell
git init
git add .
git commit -m "nothing"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```
Then in the GitHub repo: Settings → Pages → Source → Deploy from branch →
main / (root). Your site will be live at
`https://<your-username>.github.io/<your-repo>/` within a minute or two.