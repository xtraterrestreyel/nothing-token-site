/* =========================================================
   NOTHING — app.js
   ---------------------------------------------------------
   HOW TO GO LIVE:
   1. Get a free RPC API key (see CONFIG.RPC_ENDPOINT below —
      this is required, not optional; read that comment first).
   2. Once your token exists, set CONTRACT_ADDRESS to the real
      mint address, and LAUNCH_DATE to when it actually launched.
   3. Commit + push. The site auto-switches from DEMO to LIVE.

   HOW LIVE MODE WORKS (read before trusting it too much):
   This is a static site with no backend. "Live" means the
   visitor's own browser talks directly to Solana over a
   WebSocket subscription — not polling on a timer:
     - Trade feed: subscribes to new transactions that mention
       the mint (Solana's `logsSubscribe`) and gets notified the
       moment one confirms, then classifies it as buy vs. sell.
       This is the same "push, not poll" model Dexscreener uses,
       so the lag you get is basically just Solana's own
       confirmation time (roughly 1-2s), not an artificial delay
       from checking on an interval.
     - Bonding curve + graduation: subscribes to the bonding
       curve account itself (`accountSubscribe`) and re-decodes
       it the instant it changes — no third-party pump.fun API
       involved, so there's nothing for pump.fun's servers to
       block, and no polling delay either.
   If a WebSocket subscription can't be established for some
   reason (e.g. a restrictive network), the trade feed falls
   back to polling automatically so it still works, just slower.
   This is a solid approximation, not a professional indexer —
   free RPC tiers can occasionally drop a notification under
   heavy load. For a bulletproof feed later, swap this for a
   dedicated indexer/webhook (Helius, Shyft, Bitquery, etc).
   ========================================================= */

const CONFIG = {
  CONTRACT_ADDRESS: "9bvi3AgBNSYtMFpTaqPUrhTxY9vd7MpfsTPortTXpump", // <-- set this
  LAUNCH_DATE: "2026-07-19T00:00:00Z",                     // <-- set this

  // IMPORTANT — Solana's public endpoint (api.mainnet-beta.solana.com)
  // is intended for backend/server use and deliberately blocks direct
  // browser requests (CORS). A static site has no backend, so you need
  // an RPC provider that explicitly supports browser calls. Helius has
  // a free tier built for exactly this:
  //   1. Sign up at https://www.helius.dev (free, no credit card)
  //   2. Copy your API key
  //   3. Replace YOUR_HELIUS_API_KEY below with it
  // Note: this key will be visible to anyone who views the page source
  // — that's unavoidable in a pure static site. Free-tier keys are
  // rate-limited per key, so the worst case if someone copies it is
  // your free quota gets used up faster; you can regenerate the key
  // anytime from the Helius dashboard if that happens.
  RPC_ENDPOINT: "https://mainnet.helius-rpc.com/?api-key=5904e072-7870-4664-943c-db1469731658",

  // Only used as a fallback if the live WebSocket subscription can't
  // connect (see startLiveFeed). Not used at all in the normal path.
  POLL_INTERVAL_MS: 3000,
  MAX_FEED_ROWS: 30,
  // Safety-net re-check for the bonding curve, in case a single
  // account-change notification ever gets dropped by the RPC provider.
  // The subscription below is what actually drives real-time updates.
  CURVE_SAFETY_RECHECK_MS: 4000,

  // pump.fun's on-chain program + bonding curve layout. Confirmed against
  // pump.fun's own public IDL — this is stable, documented on-chain
  // structure, not a scraped private API, so it won't 403 on us.
  PUMP_PROGRAM_ID: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  // Real token reserves at a fresh bonding curve — used to compute
  // progress toward graduation. Pump.fun could change this in the future.
  BONDING_CURVE_INITIAL_REAL_TOKEN_RESERVES: 793100000000000,

  // Meme gallery — list filenames here (in the order you want them shown),
  // and drop the actual files in the "images" folder next to index.html.
  // Pre-filled with 10 placeholder slots (meme-1.png ... meme-10.png) —
  // just save your real images over those exact filenames and refresh.
  MEME_IMAGES: [
    "meme-1.png",
    "meme-2.png",
    "meme-3.png",
    "meme-4.png",
    "meme-5.png",
    "meme-6.png",
    "meme-7.png",
    "meme-8.png",
    "meme-9.png",
    "meme-10.png",
  ],

  // "Share on X" button — no login or API key needed, this is just a
  // pre-filled compose link. Update SHARE_URL to your Blink link once
  // that's deployed, so shares include the one-click buy card too.
  SHARE_TEXT: "Buying nothing has never been this easy. $NIC on Solana.",
  SHARE_URL: "https://nothingiscoming.com/",
};

const state = {
  buys: 0,
  sells: 0,
  lastSignature: null,
  bondingCurveAddress: null,
  connection: null,
  seenSignatures: new Set(),
  pendingRetryQueue: new Map(), // signature -> { attempts }
  wsReconnectDelay: 1500,
  subscriptionActive: false,
};

function getConnection() {
  if (!state.connection) {
    state.connection = new solanaWeb3.Connection(CONFIG.RPC_ENDPOINT, "confirmed");
  }
  return state.connection;
}

/* ---------------------------------------------------------
   Utility
   --------------------------------------------------------- */
function trimSeenSignatures() {
  if (state.seenSignatures.size > 500) {
    const arr = Array.from(state.seenSignatures);
    state.seenSignatures = new Set(arr.slice(-300));
  }
}

function isLikelyMintAddress(addr) {
  if (!addr || typeof addr !== "string") return false;
  if (addr === "REPLACE_WITH_YOUR_CONTRACT_ADDRESS") return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

function isRpcConfigured() {
  return typeof CONFIG.RPC_ENDPOINT === "string" &&
    !CONFIG.RPC_ENDPOINT.includes("YOUR_HELIUS_API_KEY");
}

function shortenAddress(addr, left = 4, right = 4) {
  if (!addr) return "";
  if (addr.length <= left + right + 3) return addr;
  return `${addr.slice(0, left)}…${addr.slice(-right)}`;
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/* ---------------------------------------------------------
   Starfield background (ambient motion, cheap on CPU)
   --------------------------------------------------------- */
function initVoidField() {
  const canvas = document.getElementById("void-field");
  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let w, h, particles;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    const count = Math.floor((w * h) / 14000);
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.2 + 0.2,
      vx: (Math.random() - 0.5) * 0.05,
      vy: (Math.random() - 0.5) * 0.05,
      a: Math.random() * 0.5 + 0.15,
    }));
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#ECEAE4";
    for (const p of particles) {
      ctx.globalAlpha = p.a;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      if (!reduceMotion) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = w;
        if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        if (p.y > h) p.y = 0;
      }
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  resize();
  draw();
}

/* ---------------------------------------------------------
   Wordmark glitch — fires on a random interval
   --------------------------------------------------------- */
function initGlitch() {
  const el = document.getElementById("wordmark");
  const sub = document.getElementById("wordmark-sub");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) return;

  function tick() {
    el.classList.add("glitching");
    sub.classList.add("glitching");
    setTimeout(() => {
      el.classList.remove("glitching");
      sub.classList.remove("glitching");
    }, 280);
    setTimeout(tick, 2600 + Math.random() * 4200);
  }
  setTimeout(tick, 1400);
}

/* ---------------------------------------------------------
   Contract address pill + external links
   --------------------------------------------------------- */
function initContractPill() {
  const valueEl = document.getElementById("ca-value");
  const copyBtn = document.getElementById("ca-copy");
  const addr = CONFIG.CONTRACT_ADDRESS;
  const live = isLikelyMintAddress(addr);

  valueEl.textContent = live ? addr : "not deployed yet";
  valueEl.title = live ? addr : "";

  copyBtn.addEventListener("click", async () => {
    if (!live) return;
    try {
      await navigator.clipboard.writeText(addr);
      copyBtn.textContent = "copied";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "copy";
        copyBtn.classList.remove("copied");
      }, 1400);
    } catch (e) {
      // Clipboard API blocked — fail quietly, it's not load-bearing.
    }
  });

  const dex = document.getElementById("link-dexscreener");
  const pump = document.getElementById("link-pumpfun");
  const solscan = document.getElementById("link-solscan");
  if (live) {
    dex.href = `https://dexscreener.com/solana/${addr}`;
    pump.href = `https://pump.fun/coin/${addr}`;
    solscan.href = `https://solscan.io/token/${addr}`;
  } else {
    [dex, pump, solscan].forEach((a) => {
      a.href = "#";
      a.addEventListener("click", (e) => e.preventDefault());
      a.style.opacity = "0.4";
      a.style.pointerEvents = "none";
    });
  }
}

/* ---------------------------------------------------------
   Share on X — a plain web intent link, no login or API key
   required on our end. Opens X's own compose screen (app on mobile
   if installed, web otherwise) pre-filled with text + link, already
   signed into whichever account the visitor is using on that device.
   --------------------------------------------------------- */
function initShareButton() {
  const btn = document.getElementById("link-share-x");
  if (!btn) return;
  const url = new URL("https://twitter.com/intent/tweet");
  url.searchParams.set("text", CONFIG.SHARE_TEXT);
  url.searchParams.set("url", CONFIG.SHARE_URL);
  btn.href = url.toString();
}

/* ---------------------------------------------------------
   Age counter ("time since nothing began")
   --------------------------------------------------------- */
function initAgeCounter() {
  const el = document.getElementById("stat-age");
  const launch = new Date(CONFIG.LAUNCH_DATE).getTime();
  function tick() {
    el.textContent = formatDuration(Date.now() - launch);
  }
  tick();
  setInterval(tick, 1000);
}

/* ---------------------------------------------------------
   Bonding curve tracker (pump.fun stage → graduation)
   ---------------------------------------------------------
   Reads the mint's bonding-curve account straight off Solana and
   decodes it by hand. Layout (confirmed against pump.fun's public
   IDL): 8-byte discriminator, then 5 little-endian u64 fields
   (virtualTokenReserves, virtualSolReserves, realTokenReserves,
   realSolReserves, tokenTotalSupply), then 1 byte (complete).
   Graduation is realTokenReserves reaching 0 / `complete` flipping
   true. There's no on-chain "graduated at" timestamp, so — same as
   before — the first time this site sees it graduate, it stamps
   that moment and saves it in the visitor's own browser
   (localStorage, scoped to this mint). That's a local record of
   when this browser first noticed, not an on-chain timestamp.
   --------------------------------------------------------- */
function graduationStorageKey() {
  return `nothing_graduation_ts_${CONFIG.CONTRACT_ADDRESS}`;
}

async function getBondingCurveAddress() {
  if (state.bondingCurveAddress) return state.bondingCurveAddress;
  if (typeof solanaWeb3 === "undefined") {
    throw new Error("solanaWeb3 library failed to load");
  }
  const mint = new solanaWeb3.PublicKey(CONFIG.CONTRACT_ADDRESS);
  const programId = new solanaWeb3.PublicKey(CONFIG.PUMP_PROGRAM_ID);
  const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("bonding-curve"), mint.toBytes()],
    programId
  );
  state.bondingCurveAddress = pda.toBase58();
  return state.bondingCurveAddress;
}

function decodeBondingCurveBytes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // offset 0-7: discriminator (skip)
  const virtualTokenReserves = view.getBigUint64(8, true);
  const virtualSolReserves = view.getBigUint64(16, true);
  const realTokenReserves = view.getBigUint64(24, true);
  const realSolReserves = view.getBigUint64(32, true);
  const tokenTotalSupply = view.getBigUint64(40, true);
  const complete = bytes[48] === 1;
  return { virtualTokenReserves, virtualSolReserves, realTokenReserves, realSolReserves, tokenTotalSupply, complete };
}

async function fetchBondingCurveOnce() {
  const pda = await getBondingCurveAddress();
  const conn = getConnection();
  const info = await conn.getAccountInfo(new solanaWeb3.PublicKey(pda), "confirmed");
  if (!info || !info.data) {
    // Account doesn't exist — most likely the curve account was closed
    // after migration, which itself is a strong graduation signal.
    return null;
  }
  return decodeBondingCurveBytes(new Uint8Array(info.data));
}

function computeBondingProgress(curve) {
  if (curve.complete) return 100;
  const INITIAL = CONFIG.BONDING_CURVE_INITIAL_REAL_TOKEN_RESERVES;
  const real = Number(curve.realTokenReserves);
  const pct = real >= INITIAL ? 0 : (1 - real / INITIAL) * 100;
  return Math.max(0, Math.min(100, pct));
}

function computeMarketCapSol(curve) {
  const vSol = Number(curve.virtualSolReserves);
  const vTok = Number(curve.virtualTokenReserves);
  const supply = Number(curve.tokenTotalSupply);
  if (!vTok) return null;
  const marketCapLamports = (vSol * supply) / vTok;
  return marketCapLamports / 1e9;
}

// Current price per (UI) token in SOL, derived from the bonding curve's
// virtual reserves — only meaningful pre-graduation. Once a token
// graduates to PumpSwap, price lives in that AMM's own pool instead,
// which this site doesn't currently read, so this returns null there.
function currentPricePerTokenSol() {
  const curve = state.lastCurve;
  if (!curve || curve.complete) return null;
  const vSol = Number(curve.virtualSolReserves);
  const vTok = Number(curve.virtualTokenReserves);
  if (!vTok) return null;
  return (vSol / vTok) / 1000; // assumes 6 decimals, standard for pump.fun tokens
}

function renderCurve(curve) {
  const fill = document.getElementById("curve-bar-fill");
  const percentEl = document.getElementById("curve-percent");
  const mcEl = document.getElementById("curve-marketcap");
  const badge = document.getElementById("curve-badge");
  const stamp = document.getElementById("graduation-stamp");
  const venueEl = document.getElementById("graduation-venue");
  const stampTime = document.getElementById("graduation-time");

  state.lastCurve = curve; // cached for other features (e.g. wallet P&L) to reuse

  // A null curve means the account is gone — treat as graduated.
  const graduated = curve === null || curve.complete;
  console.log("[NOTHING] curve update:", curve === null ? "account closed (graduated)" : {
    complete: curve.complete,
    realTokenReserves: curve.realTokenReserves.toString(),
    virtualSolReserves: curve.virtualSolReserves.toString(),
    virtualTokenReserves: curve.virtualTokenReserves.toString(),
  });

  if (!graduated) {
    const progress = computeBondingProgress(curve);
    const mcSol = computeMarketCapSol(curve);
    fill.style.width = `${progress.toFixed(1)}%`;
    fill.classList.remove("graduated");
    percentEl.textContent = `${progress.toFixed(1)}% to graduation`;
    mcEl.textContent = mcSol != null ? `MC ${mcSol.toFixed(2)} SOL` : "MC —";
    badge.textContent = "on bonding curve";
    badge.classList.remove("graduated");
    stamp.hidden = true;
    return;
  }

  fill.style.width = "100%";
  fill.classList.add("graduated");
  percentEl.textContent = "100% — graduated";
  mcEl.textContent = curve ? `MC ${(computeMarketCapSol(curve) ?? 0).toFixed(2)} SOL` : "MC —";
  badge.textContent = "graduated · trading live";
  badge.classList.add("graduated");

  let ts = localStorage.getItem(graduationStorageKey());
  if (!ts) {
    ts = String(Date.now());
    localStorage.setItem(graduationStorageKey(), ts);
  }
  stamp.hidden = false;
  // Since March 2025 pump.fun graduations go to its own AMM, PumpSwap,
  // by default. We can't confirm the exact venue from on-chain bonding
  // curve data alone, so we say so plainly and link out to Dexscreener,
  // which resolves the real pool automatically.
  venueEl.textContent = "PumpSwap (check Dexscreener above to confirm)";
  stampTime.textContent = new Date(Number(ts)).toLocaleString();
}

function renderCurveUnavailable(message) {
  document.getElementById("curve-badge").textContent = message || "curve data unavailable";
}

async function startCurveTracking() {
  // Initial paint so the panel isn't empty while we wait for the first
  // change notification (subscriptions only fire on *future* changes).
  try {
    renderCurve(await fetchBondingCurveOnce());
  } catch (e) {
    console.warn("Initial bonding curve fetch failed", e);
    renderCurveUnavailable("curve data unavailable — check RPC setup");
  }

  try {
    const pda = new solanaWeb3.PublicKey(await getBondingCurveAddress());
    const conn = getConnection();

    // Real-time path: Solana notifies us the instant this account's data
    // changes (i.e. on every buy/sell against the curve, and again when
    // it closes at graduation) — no waiting on a timer.
    conn.onAccountChange(pda, (accountInfo) => {
      try {
        renderCurve(decodeBondingCurveBytes(new Uint8Array(accountInfo.data)));
      } catch (e) {
        console.warn("Failed to decode bonding curve update", e);
      }
    }, "confirmed");

    // This is the actual reliability guarantee, not just a rare
    // edge-case backstop — onAccountChange (above) is a nice speed boost
    // when it works, but the same class of provider silently just stops
    // delivering, so this runs on a short fixed interval unconditionally.
    setInterval(async () => {
      try {
        renderCurve(await fetchBondingCurveOnce());
      } catch (e) {
        console.warn("Bonding curve safety recheck failed", e);
      }
    }, CONFIG.CURVE_SAFETY_RECHECK_MS);
  } catch (e) {
    console.warn("Could not subscribe to bonding curve changes, falling back to polling", e);
    async function poll() {
      try {
        renderCurve(await fetchBondingCurveOnce());
      } catch (err) {
        console.warn("Bonding curve fetch failed", err);
        renderCurveUnavailable("curve data unavailable — check RPC setup");
      }
      setTimeout(poll, CONFIG.CURVE_SAFETY_RECHECK_MS);
    }
    poll();
  }
}

/* ---------------------------------------------------------
   Demo bonding curve — loops through a fake launch →
   graduation cycle so the panel isn't empty pre-launch.
   --------------------------------------------------------- */
function startDemoCurve() {
  const fill = document.getElementById("curve-bar-fill");
  const percentEl = document.getElementById("curve-percent");
  const mcEl = document.getElementById("curve-marketcap");
  const badge = document.getElementById("curve-badge");
  const stamp = document.getElementById("graduation-stamp");
  const venueEl = document.getElementById("graduation-venue");
  const stampTime = document.getElementById("graduation-time");

  badge.textContent = "demo — no token deployed yet";
  let progress = Math.random() * 25;
  let graduated = false;

  function tick() {
    if (!graduated) {
      progress = Math.min(100, progress + Math.random() * 6);
      mcEl.textContent = `MC ${(progress * 0.9).toFixed(2)} SOL (demo)`;
      if (progress >= 100) {
        graduated = true;
        fill.classList.add("graduated");
        badge.textContent = "demo — graduated (simulated)";
        percentEl.textContent = "100% — graduated";
        stamp.hidden = false;
        venueEl.textContent = "PumpSwap (demo)";
        stampTime.textContent = `${new Date().toLocaleString()} (demo)`;
        setTimeout(() => {
          progress = 0;
          graduated = false;
          fill.classList.remove("graduated");
          stamp.hidden = true;
          badge.textContent = "demo — no token deployed yet";
        }, 7000);
      } else {
        percentEl.textContent = `${progress.toFixed(1)}% to graduation`;
      }
    }
    fill.style.width = `${progress}%`;
    setTimeout(tick, 2200);
  }
  tick();
}

/* ---------------------------------------------------------
   Feed + orb rendering (shared by live + demo modes)
   --------------------------------------------------------- */
function pushFeedEvent({ type, wallet, amountSol }) {
  if (type === "buy") state.buys += 1;
  if (type === "sell") state.sells += 1;

  document.getElementById("stat-buys").textContent = state.buys;
  document.getElementById("stat-sells").textContent = state.sells;

  const list = document.getElementById("feed-list");
  const row = document.createElement("div");
  row.className = `feed-row ${type}`;
  row.innerHTML = `
    <span class="feed-tag">${type === "buy" ? "BUY" : "SELL"}</span>
    <span class="feed-wallet">${shortenAddress(wallet)}</span>
    <span class="feed-amount">${amountSol.toFixed(2)} SOL</span>
    <span class="feed-time">now</span>
  `;
  list.appendChild(row);

  while (list.children.length > CONFIG.MAX_FEED_ROWS) {
    list.removeChild(list.firstChild);
  }

  document.getElementById("feed-hint").textContent = `${state.buys + state.sells} events observed`;

  burstOrb(type);
}

function burstOrb(type) {
  const ring = document.getElementById("burst-ring");
  const sub = document.getElementById("core-sub");
  const label = document.getElementById("core-label");
  const arrowUp = document.getElementById("arrow-up");
  const arrowDown = document.getElementById("arrow-down");
  const wordmark = document.getElementById("wordmark");
  const wordmarkSub = document.getElementById("wordmark-sub");

  // Ring burst around the core
  ring.classList.remove("burst-buy", "burst-sell");
  void ring.getBBox();
  ring.classList.add(type === "buy" ? "burst-buy" : "burst-sell");

  // Sub-label + core stroke color
  sub.textContent = type;
  document.getElementById("pulse-orb").querySelector(".core").style.stroke =
    type === "buy" ? "var(--buy)" : "var(--sell)";

  // Directional arrow flash in the center of the orb, replacing the Ø briefly
  const showArrow = type === "buy" ? arrowUp : arrowDown;
  const hideArrow = type === "buy" ? arrowDown : arrowUp;
  hideArrow.classList.remove("flashing");
  showArrow.classList.remove("flashing");
  void showArrow.getBBox();
  label.classList.add("hide-for-arrow");
  showArrow.classList.add("flashing");

  // Flash the big wordmark — and its "is coming" subtitle right along with
  // it — the same color as the trade
  wordmark.classList.remove("trade-buy", "trade-sell");
  wordmarkSub.classList.remove("trade-buy", "trade-sell");
  void wordmark.offsetWidth;
  wordmark.classList.add(type === "buy" ? "trade-buy" : "trade-sell");
  wordmarkSub.classList.add(type === "buy" ? "trade-buy" : "trade-sell");

  // Mirror the same flash on the persistent nav indicator, so the buy/sell
  // signal stays visible no matter where the visitor has scrolled to.
  const navCore = document.querySelector("#nav-pulse-indicator .nav-pulse-core");
  const navArrowUp = document.querySelector("#nav-pulse-indicator .nav-pulse-arrow-up");
  const navArrowDown = document.querySelector("#nav-pulse-indicator .nav-pulse-arrow-down");
  if (navCore && navArrowUp && navArrowDown) {
    const navShowArrow = type === "buy" ? navArrowUp : navArrowDown;
    const navHideArrow = type === "buy" ? navArrowDown : navArrowUp;
    navHideArrow.classList.remove("flashing");
    navShowArrow.classList.remove("flashing");
    void navShowArrow.getBBox();
    navShowArrow.classList.add("flashing");
    navCore.style.stroke = type === "buy" ? "var(--buy)" : "var(--sell)";
  }

  setTimeout(() => {
    sub.textContent = "idle";
    document.getElementById("pulse-orb").querySelector(".core").style.stroke = "var(--violet)";
    label.classList.remove("hide-for-arrow");
    showArrow.classList.remove("flashing");
    wordmark.classList.remove("trade-buy", "trade-sell");
    wordmarkSub.classList.remove("trade-buy", "trade-sell");
    if (navCore) navCore.style.stroke = "var(--violet)";
    if (navArrowUp) navArrowUp.classList.remove("flashing");
    if (navArrowDown) navArrowDown.classList.remove("flashing");
  }, 1200);
}

function setStatus(mode) {
  const dot = document.getElementById("status-dot");
  const label = document.getElementById("status-label");
  dot.classList.remove("live", "demo");
  if (mode === "live") {
    dot.classList.add("live");
    label.textContent = "LIVE ON SOLANA";
  } else if (mode === "needs-rpc") {
    dot.classList.add("demo");
    label.textContent = "SET AN RPC KEY — SEE README";
  } else {
    dot.classList.add("demo");
    label.textContent = "DEMO MODE — NO TOKEN DEPLOYED YET";
  }
}

/* ---------------------------------------------------------
   DEMO MODE — simulated ticks so the page isn't dead
   before a real contract address is set.
   --------------------------------------------------------- */
function startDemoFeed() {
  setStatus("demo");
  document.getElementById("feed-hint").textContent = "simulated activity — set a real contract address to go live";

  function fakeWallet() {
    const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let out = "";
    for (let i = 0; i < 44; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function tick() {
    const type = Math.random() > 0.48 ? "buy" : "sell";
    pushFeedEvent({
      type,
      wallet: fakeWallet(),
      amountSol: Math.random() * 4 + 0.02,
    });
    setTimeout(tick, 2500 + Math.random() * 5500);
  }
  setTimeout(tick, 1800);
}

/* ---------------------------------------------------------
   LIVE MODE — polls your RPC provider for real transactions
   on CONFIG.CONTRACT_ADDRESS and classifies buy vs sell.
   --------------------------------------------------------- */
async function rpcCall(method, params) {
  const res = await fetch(CONFIG.RPC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`RPC HTTP ${res.status} on ${method}: ${bodyText.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

// Returned when we genuinely couldn't determine the outcome yet (the RPC
// hadn't indexed the transaction even after retries) — distinct from a
// confirmed "not a trade," so callers know whether it's safe to stop
// looking at this signature or whether it should be retried later.
const INDETERMINATE = Symbol("indeterminate");

async function classifyTransaction(sig, attempt = 0) {
  const tx = await rpcCall("getTransaction", [
    sig,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);

  if (!tx) {
    // The logsSubscribe notification can arrive a beat before the same
    // transaction is actually queryable via getTransaction on the RPC's
    // end — a known indexing race, not a real failure. Retry a few times
    // with backoff before giving up on this attempt.
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      return classifyTransaction(sig, attempt + 1);
    }
    console.warn("[NOTHING] getTransaction not available yet for", sig, "— will retry on next poll");
    return INDETERMINATE;
  }

  if (!tx.meta || tx.meta.err) {
    console.log("[NOTHING] classify:", sig, "— failed/errored transaction, skipping");
    return null;
  }

  const feePayer = tx.transaction.message.accountKeys[0]?.pubkey
    ?? tx.transaction.message.accountKeys[0];

  const preSol = tx.meta.preBalances?.[0];
  const postSol = tx.meta.postBalances?.[0];
  if (preSol == null || postSol == null) {
    console.log("[NOTHING] classify:", sig, "— missing SOL balance data, skipping");
    return null;
  }

  const solDeltaLamports = postSol - preSol;
  const solDelta = Math.abs(solDeltaLamports) / 1e9;

  const pre = (tx.meta.preTokenBalances || []).find(
    (b) => b.owner === feePayer && b.mint === CONFIG.CONTRACT_ADDRESS
  );
  const post = (tx.meta.postTokenBalances || []).find(
    (b) => b.owner === feePayer && b.mint === CONFIG.CONTRACT_ADDRESS
  );
  const preAmt = pre ? Number(pre.uiTokenAmount.uiAmount || 0) : 0;
  const postAmt = post ? Number(post.uiTokenAmount.uiAmount || 0) : 0;
  const tokenDelta = postAmt - preAmt;

  // Only exclude transactions with zero SOL movement — those are plain
  // token transfers (e.g. a gift between wallets), not trades. Anything
  // with any real SOL movement counts, no matter how small — including
  // small/"dust" buys and sells.
  if (tokenDelta === 0 || solDelta < 0.000001) {
    console.log("[NOTHING] classify:", sig, "— not a trade (tokenDelta:", tokenDelta, "solDelta:", solDelta, ")");
    return null;
  }

  const type = tokenDelta > 0 ? "buy" : "sell";
  console.log("[NOTHING] classify:", sig, "—", type, solDelta.toFixed(4), "SOL");
  return { type, wallet: feePayer, amountSol: solDelta };
}

function queueForRetry(sig) {
  if (!state.pendingRetryQueue.has(sig)) {
    state.pendingRetryQueue.set(sig, { attempts: 0 });
  }
}

// Resolves anything sitting in the retry queue by looking each signature
// up directly (getTransaction), not through getSignaturesForAddress
// pagination — pagination's cursor only ever moves forward, so an older
// signature from an already-processed batch would otherwise fall
// permanently out of range even if we never marked it "seen."
async function processRetryQueue() {
  for (const [sig, info] of Array.from(state.pendingRetryQueue.entries())) {
    let result;
    try {
      result = await classifyTransaction(sig);
    } catch (e) {
      console.warn("[NOTHING] retry queue: error classifying", sig, e);
      result = INDETERMINATE;
    }

    if (result === INDETERMINATE) {
      info.attempts += 1;
      if (info.attempts >= 10) {
        console.warn("[NOTHING] giving up on", sig, "after repeated indeterminate results");
        state.pendingRetryQueue.delete(sig);
      }
      continue;
    }

    state.pendingRetryQueue.delete(sig);
    state.seenSignatures.add(sig);
    trimSeenSignatures();
    if (result) pushFeedEvent(result);
  }
}

async function fetchAndProcessSignatures() {
  const sigInfos = await rpcCall("getSignaturesForAddress", [
    CONFIG.CONTRACT_ADDRESS,
    { limit: state.lastSignature ? 15 : 5, until: state.lastSignature || undefined },
  ]);

  if (!sigInfos || sigInfos.length === 0) return;

  const ordered = [...sigInfos].reverse();
  state.lastSignature = sigInfos[0].signature;

  for (const info of ordered) {
    if (info.err) continue;
    if (state.seenSignatures.has(info.signature) || state.pendingRetryQueue.has(info.signature)) continue;
    try {
      const result = await classifyTransaction(info.signature);
      if (result === INDETERMINATE) {
        queueForRetry(info.signature);
        continue;
      }
      state.seenSignatures.add(info.signature);
      trimSeenSignatures();
      if (result) pushFeedEvent(result);
    } catch (e) {
      console.warn("Could not classify transaction", info.signature, e);
    }
  }
}

async function startLiveFeed() {
  console.log("[NOTHING] startLiveFeed() running for mint", CONFIG.CONTRACT_ADDRESS);
  setStatus("live");
  document.getElementById("feed-hint").textContent = "connecting to live feed…";

  // Small one-time backfill so the feed isn't empty on load.
  try {
    await fetchAndProcessSignatures();
  } catch (e) {
    console.warn("Initial backfill failed", e);
  }

  let ws = null;
  let reconnectDelay = 2000;
  let manualCloseForRefresh = false;

  function buildWsUrl(httpUrl) {
    if (httpUrl.startsWith("https://")) return "wss://" + httpUrl.slice(8);
    if (httpUrl.startsWith("http://")) return "ws://" + httpUrl.slice(7);
    return httpUrl;
  }

  function scheduleReconnect() {
    state.subscriptionActive = false;
    document.getElementById("feed-hint").textContent = "reconnecting live feed — backup polling active";
    setTimeout(connectWebSocket, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 20000);
  }

  // Real-time path: Solana notifies us the instant a transaction
  // mentioning this mint confirms — this is what makes it feel like
  // Dexscreener instead of a refresh-every-few-seconds page. Managed
  // directly (rather than via the @solana/web3.js Connection helper) so
  // that a failed or dropped connection is something we can actually see
  // and react to, instead of failing silently.
  function connectWebSocket() {
    try {
      ws = new WebSocket(buildWsUrl(CONFIG.RPC_ENDPOINT));
    } catch (e) {
      console.warn("Could not open live WebSocket", e);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log("[NOTHING] live websocket connected, requesting subscription…");
      reconnectDelay = 2000;
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [CONFIG.CONTRACT_ADDRESS] }, { commitment: "confirmed" }],
      }));
    };

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      // Subscription confirmation — only now do we know it actually worked.
      if (msg.id === 1 && typeof msg.result === "number") {
        console.log("[NOTHING] live subscription confirmed, id =", msg.result);
        state.subscriptionActive = true;
        document.getElementById("feed-hint").textContent = "subscribed — trades appear as they confirm";
        return;
      }
      if (msg.error) {
        console.warn("Live subscription rejected by RPC provider", msg.error);
        return;
      }

      if (msg.method === "logsNotification") {
        const value = msg.params?.result?.value;
        if (!value || value.err) return;
        const sig = value.signature;
        if (!sig || state.seenSignatures.has(sig) || state.pendingRetryQueue.has(sig)) return;
        console.log("[NOTHING] live notification received for", sig);
        try {
          const result = await classifyTransaction(sig);
          if (result === INDETERMINATE) {
            queueForRetry(sig);
            return;
          }
          state.seenSignatures.add(sig);
          trimSeenSignatures();
          if (result) pushFeedEvent(result);
        } catch (e) {
          console.warn("Could not classify live transaction", sig, e);
        }
      }
    };

    ws.onerror = (e) => {
      console.warn("Live WebSocket error", e);
    };

    ws.onclose = () => {
      console.log("[NOTHING] live websocket closed");
      if (manualCloseForRefresh) {
        manualCloseForRefresh = false;
        connectWebSocket();
      } else {
        scheduleReconnect();
      }
    };
  }

  connectWebSocket();

  // Rebuild the connection periodically regardless of whether it's still
  // open. Helius (and most providers) silently drop idle WebSockets after
  // roughly 10 minutes of inactivity with no close event our code can see
  // — refreshing well inside that window recovers from that automatically.
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      manualCloseForRefresh = true;
      ws.close();
    }
  }, 240000);

  // Reconciliation poll — this is the mechanism that actually guarantees
  // trades show up. logsSubscribe (above) is a nice speed bonus when a
  // provider actually delivers on it, but it's known to be unreliable
  // across RPC providers: many accept the subscription without ever
  // throwing an error, then simply never push a notification. Trusting
  // "no error" as proof it's working caused exactly that silent-gap bug
  // before, so this poll no longer slows down just because a subscription
  // claimed to succeed — it always runs on a short, fixed interval.
  async function reconcile() {
    try {
      await fetchAndProcessSignatures();
    } catch (e) {
      console.warn("Reconciliation poll failed", e);
    }
    setTimeout(reconcile, CONFIG.POLL_INTERVAL_MS);
  }
  reconcile();

  // The retry queue holds transactions the RPC provider hasn't finished
  // indexing yet — checked on its own faster loop, independent of the
  // general backup poll above, since these are time-sensitive: the
  // WebSocket already told us the trade happened, we're just waiting on
  // the provider to catch up. Checking more often here directly reduces
  // the visible delay between a trade happening and it showing on screen.
  async function retryLoop() {
    try {
      await processRetryQueue();
    } catch (e) {
      console.warn("Retry queue processing failed", e);
    }
    setTimeout(retryLoop, 800);
  }
  retryLoop();
}

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */
/* ---------------------------------------------------------
   Meme gallery — renders CONFIG.MEME_IMAGES as a horizontally
   scrollable strip. Missing/misspelled files are dropped silently
   (with a console warning) rather than showing broken-image icons.
   --------------------------------------------------------- */
/* ---------------------------------------------------------
   How-to-buy mascot image — hidden until confirmed loaded, so a
   missing images/mascot.png doesn't leave a broken-image icon
   sitting in the page. Drop a transparent PNG at that exact path
   to have it appear automatically.
   --------------------------------------------------------- */
function initMascotImage() {
  const img = document.getElementById("howtobuy-mascot");
  if (!img) return;
  img.addEventListener("load", () => img.classList.add("loaded"));
  img.addEventListener("error", () => {
    console.log("[NOTHING] no mascot image found at images/mascot.png — add one to show it here");
  });
  // If it's already loaded from cache by the time this runs, the load
  // event won't fire again — check directly.
  if (img.complete && img.naturalWidth > 0) {
    img.classList.add("loaded");
  }
}

function renderMemeGallery() {
  const scroll = document.getElementById("meme-scroll");
  const empty = document.getElementById("meme-empty");

  if (!CONFIG.MEME_IMAGES || CONFIG.MEME_IMAGES.length === 0) {
    return; // leave the "no memes yet" placeholder showing
  }

  if (empty) empty.remove();

  CONFIG.MEME_IMAGES.forEach((filename) => {
    const img = document.createElement("img");
    img.src = `images/${filename}`;
    img.alt = "NOTHING meme";
    img.loading = "lazy";
    img.className = "meme-item";
    img.addEventListener("error", () => {
      console.warn(
        "[NOTHING] meme image not found:", filename,
        "— check it's in the images/ folder and the filename matches exactly (case-sensitive)"
      );
      img.remove();
    });
    scroll.appendChild(img);
  });
}

/* ---------------------------------------------------------
   Meme gallery auto-scroll — continuously drifts back and forth
   (rather than jumping/wrapping, which would need duplicated
   content to hide the seam). Pauses the moment the pointer enters
   the gallery — not just a single image, so moving between
   neighboring images doesn't cause it to stutter on and off — and
   resumes shortly after the pointer leaves.
   --------------------------------------------------------- */
/* ---------------------------------------------------------
   Nav scroll-spy — highlights whichever section is currently in
   view as the visitor scrolls, not just on hover. Uses
   IntersectionObserver rather than tracking scroll position by
   hand, with rootMargin shifted up to account for the fixed nav
   bar's height so a section counts as "current" right as it
   clears the header, not only when centered in the viewport.
   --------------------------------------------------------- */
function initNavScrollSpy() {
  const sectionIds = [
    "pulse-section", "curve-section", "feed-section",
    "lineage-section", "howtobuy-section", "meme-section",
  ];
  const links = document.querySelectorAll(".site-nav-links a");
  const linkById = new Map();
  links.forEach((link) => {
    const id = link.getAttribute("href").replace("#", "");
    linkById.set(id, link);
  });

  const sections = sectionIds
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (sections.length === 0) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const link = linkById.get(entry.target.id);
        if (!link) return;
        links.forEach((l) => l.classList.remove("active"));
        link.classList.add("active");
      });
    },
    { rootMargin: "-100px 0px -65% 0px", threshold: 0 }
  );

  sections.forEach((section) => observer.observe(section));
}

/* ---------------------------------------------------------
   Nav wallet connect — lives in the persistent header so it's
   visible everywhere on the page, not buried in one section. Shows
   the connected address as plain text (no copy button — there's
   nothing here that needs copying, it's just a status indicator).
   This site never sees a private key or seed phrase at any point.
   --------------------------------------------------------- */
function initNavWallet() {
  const btn = document.getElementById("nav-wallet-btn");
  if (!btn) return;

  function setConnectedUI(address) {
    btn.textContent = shortenAddress(address);
    btn.classList.add("connected");
    btn.title = "Connected — click to disconnect";
  }

  function setDisconnectedUI() {
    btn.textContent = "Connect Wallet";
    btn.classList.remove("connected");
    btn.title = "";
  }

  btn.addEventListener("click", async () => {
    const provider = window?.solana;
    if (!provider || !provider.isPhantom) {
      window.open("https://phantom.app", "_blank", "noopener");
      return;
    }
    if (provider.isConnected && provider.publicKey) {
      try {
        await provider.disconnect();
      } catch (e) {
        // Not all wallets implement disconnect() the same way — safe to ignore.
      }
      setDisconnectedUI();
      return;
    }
    try {
      const resp = await provider.connect();
      setConnectedUI(resp.publicKey.toString());
      console.log("[NOTHING] nav: Phantom connected —", resp.publicKey.toString());
    } catch (e) {
      console.log("[NOTHING] nav: wallet connection was cancelled");
    }
  });

  // If Phantom is already connected from a previous visit (it remembers
  // trusted sites), reflect that immediately instead of asking again.
  const provider = window?.solana;
  if (provider?.isPhantom && provider.isConnected && provider.publicKey) {
    setConnectedUI(provider.publicKey.toString());
  }
}

/* ---------------------------------------------------------
   Buy Now — a real embedded swap (Jupiter Plugin) with $NIC
   pre-loaded as the output token, plus a live price chart. No
   redirect to pump.fun — the actual trade happens right here.
   Jupiter Plugin handles routing, wallet connection, and sending
   the transaction itself; this site never touches funds or keys.
   --------------------------------------------------------- */
const SOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

function initBuyNowChart() {
  const frame = document.getElementById("buynow-chart-frame");
  if (!frame || !isLikelyMintAddress(CONFIG.CONTRACT_ADDRESS)) return;
  // Dexscreener resolves a bare token mint to its primary trading pair
  // automatically — if the token has no pair yet, the placeholder text
  // behind the iframe stays visible until one exists.
  frame.src = `https://dexscreener.com/solana/${CONFIG.CONTRACT_ADDRESS}?embed=1&theme=dark&trades=0&info=0`;
}

function initJupiterSwap(attempt = 0) {
  const targetId = "jupiter-plugin";
  const target = document.getElementById(targetId);
  if (!target) return;

  if (!isLikelyMintAddress(CONFIG.CONTRACT_ADDRESS)) {
    target.innerHTML = `<p style="padding:24px;color:var(--dim);font-family:var(--font-mono);font-size:13px;line-height:1.6;">Set a real CONFIG.CONTRACT_ADDRESS in app.js to enable trading here.</p>`;
    return;
  }

  if (!window.Jupiter) {
    if (attempt > 20) {
      console.warn("[NOTHING] buynow: Jupiter Plugin script never loaded — check your connection or an ad blocker");
      target.innerHTML = `<p style="padding:24px;color:var(--dim);font-family:var(--font-mono);font-size:13px;line-height:1.6;">Couldn't load the trading widget — refresh the page, or check if an ad blocker is blocking plugin.jup.ag.</p>`;
      return;
    }
    setTimeout(() => initJupiterSwap(attempt + 1), 250);
    return;
  }

  window.Jupiter.init({
    displayMode: "integrated",
    integratedTargetId: targetId,
    formProps: {
      initialInputMint: SOL_MINT_ADDRESS,
      initialOutputMint: CONFIG.CONTRACT_ADDRESS,
      fixedMint: CONFIG.CONTRACT_ADDRESS,
    },
  });
  console.log("[NOTHING] buynow: Jupiter Plugin initialized for", CONFIG.CONTRACT_ADDRESS);
}

function initMemeAutoScroll() {
  const scroll = document.getElementById("meme-scroll");
  if (!scroll) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const SPEED_PX_PER_FRAME = 0.6;
  const RESUME_DELAY_MS = 1000;

  let direction = -1; // reversed: starts moving right-to-left
  let paused = false;
  let resumeTimer = null;

  // Seed the starting position at the far right so the first visible
  // motion is actually the reversed direction, instead of snapping back
  // immediately from being stuck at the left edge. Delayed slightly since
  // image dimensions (and therefore scrollWidth) aren't final until each
  // meme has finished loading.
  setTimeout(() => {
    scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth;
  }, 400);

  function tick() {
    if (!paused) {
      const maxScroll = scroll.scrollWidth - scroll.clientWidth;
      if (maxScroll > 0) {
        scroll.scrollLeft += SPEED_PX_PER_FRAME * direction;
        if (scroll.scrollLeft >= maxScroll - 1) {
          direction = -1;
        } else if (scroll.scrollLeft <= 1) {
          direction = 1;
        }
      }
    }
    requestAnimationFrame(tick);
  }

  scroll.addEventListener("mouseenter", () => {
    paused = true;
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
  });
  scroll.addEventListener("mouseleave", () => {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      paused = false;
      resumeTimer = null;
    }, RESUME_DELAY_MS);
  });

  requestAnimationFrame(tick);
}

/* ---------------------------------------------------------
   Holder data layer — fetches top holders (current balances only,
   from getTokenLargestAccounts) and traces provenance/transfers on
   demand. This feeds the tree renderer further below; nothing
   beyond the initial top-holder list is fetched until a wallet is
   actually clicked into.

   This keeps the initial "Generate" cheap (one getTokenLargestAccounts
   call plus one getAccountInfo per holder to resolve owners) and only
   spends the more expensive signature/transaction lookups on wallets
   you actually want to look into — a full since-launch history for
   every wallet would mean scanning potentially thousands of
   transactions, well beyond what a free RPC tier or a browser tab
   can reasonably do.
   --------------------------------------------------------- */
const LINEAGE_HOLDER_LIMIT = 10;
const LINEAGE_TX_PER_EXPAND = 6;
const LINEAGE_MAX_CHILDREN = 4;

// Looks at a holder's recent transactions to find the most recent one
// where their balance went UP, and identifies the counterparty whose
// balance went down in that same transaction — i.e. where their tokens
// most recently came from. This is what lets the map draw real
// provenance lines instead of an unconnected row of bubbles.
async function resolveImmediateSource(tokenAccount, ownerAddress) {
  let sigInfos = [];
  try {
    sigInfos = await rpcCall("getSignaturesForAddress", [tokenAccount, { limit: 8 }]);
  } catch (e) {
    return null;
  }

  for (const info of sigInfos || []) {
    if (info.err) continue;
    let tx;
    try {
      tx = await rpcCall("getTransaction", [
        info.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
    } catch (e) {
      continue;
    }
    if (!tx || !tx.meta) continue;

    const pre = tx.meta.preTokenBalances || [];
    const post = tx.meta.postTokenBalances || [];

    const ownPost = post.find((p) => p.mint === CONFIG.CONTRACT_ADDRESS && p.owner === ownerAddress);
    if (!ownPost) continue;
    const ownPre = pre.find((p) => p.accountIndex === ownPost.accountIndex);
    const ownPreAmt = ownPre ? Number(ownPre.uiTokenAmount.uiAmount || 0) : 0;
    const ownPostAmt = Number(ownPost.uiTokenAmount.uiAmount || 0);
    if (ownPostAmt <= ownPreAmt) continue; // this tx wasn't an increase for them

    for (const p of post) {
      if (p.mint !== CONFIG.CONTRACT_ADDRESS || !p.owner || p.owner === ownerAddress) continue;
      const pMatch = pre.find((x) => x.accountIndex === p.accountIndex);
      const pPreAmt = pMatch ? Number(pMatch.uiTokenAmount.uiAmount || 0) : 0;
      const pPostAmt = Number(p.uiTokenAmount.uiAmount || 0);
      if (pPostAmt < pPreAmt) {
        return { source: p.owner, amount: ownPostAmt - ownPreAmt };
      }
    }
  }
  return null;
}

async function fetchTopHolders() {
  console.log("[NOTHING] lineage: fetching top holders for", CONFIG.CONTRACT_ADDRESS);
  const result = await rpcCall("getTokenLargestAccounts", [CONFIG.CONTRACT_ADDRESS]);
  const accounts = (result?.value || []).slice(0, LINEAGE_HOLDER_LIMIT);
  console.log("[NOTHING] lineage: got", accounts.length, "largest accounts");

  const bondingCurveAddr = await getBondingCurveAddress().catch(() => null);

  // Independent lookups — resolve every owner in parallel rather than
  // one at a time, since none of these calls depend on each other.
  const holders = await Promise.all(
    accounts.map(async (acc) => {
      let owner = null;
      try {
        const info = await rpcCall("getAccountInfo", [acc.address, { encoding: "jsonParsed" }]);
        owner = info?.value?.data?.parsed?.info?.owner || null;
      } catch (e) {
        console.warn("[NOTHING] lineage: could not resolve owner for token account", acc.address, e);
      }
      const resolvedOwner = owner || acc.address;
      return {
        tokenAccount: acc.address,
        owner: resolvedOwner,
        amount: Number(acc.uiAmount ?? acc.uiAmountString ?? 0),
        isBondingCurve: bondingCurveAddr != null && resolvedOwner === bondingCurveAddr,
      };
    })
  );

  // Trace where each non-curve holder's tokens most recently came from —
  // again in parallel across holders, since each trace is independent.
  console.log("[NOTHING] lineage: tracing provenance for", holders.length, "holders");
  await Promise.all(
    holders.map(async (h) => {
      if (h.isBondingCurve) return;
      try {
        const result = await resolveImmediateSource(h.tokenAccount, h.owner);
        if (result) {
          h.source = result.source;
          h.sourceAmount = result.amount;
        }
      } catch (e) {
        console.warn("[NOTHING] lineage: source trace failed for", h.owner, e);
      }
    })
  );

  // Bonding curve reads as the "root" of the map, so put it first
  const bcIndex = holders.findIndex((h) => h.isBondingCurve);
  if (bcIndex > 0) {
    const [bc] = holders.splice(bcIndex, 1);
    holders.unshift(bc);
  }

  return holders;
}

// Traces where a specific wallet has recently sent tokens. Only called
// on demand when a bubble is clicked, not upfront for every holder.
async function fetchRecentRecipients(tokenAccount, sourceOwner) {
  const moved = new Map(); // recipient owner -> total token amount moved to them

  let sigInfos = [];
  try {
    sigInfos = await rpcCall("getSignaturesForAddress", [tokenAccount, { limit: LINEAGE_TX_PER_EXPAND }]);
  } catch (e) {
    console.warn("[NOTHING] lineage: could not fetch signatures for", tokenAccount, e);
    return moved;
  }
  console.log("[NOTHING] lineage: tracing", sigInfos.length, "recent tx for", shortenAddress(sourceOwner));

  for (const info of sigInfos || []) {
    if (info.err) continue;
    let tx;
    try {
      tx = await rpcCall("getTransaction", [
        info.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
    } catch (e) {
      continue;
    }
    if (!tx || !tx.meta) continue;

    const pre = tx.meta.preTokenBalances || [];
    const post = tx.meta.postTokenBalances || [];

    for (const p of post) {
      if (p.mint !== CONFIG.CONTRACT_ADDRESS) continue;
      if (!p.owner || p.owner === sourceOwner) continue;
      const preMatch = pre.find((x) => x.accountIndex === p.accountIndex);
      const preAmt = preMatch ? Number(preMatch.uiTokenAmount.uiAmount || 0) : 0;
      const postAmt = Number(p.uiTokenAmount.uiAmount || 0);
      const delta = postAmt - preAmt;
      if (delta > 0) {
        moved.set(p.owner, (moved.get(p.owner) || 0) + delta);
      }
    }
  }

  return new Map(
    Array.from(moved.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, LINEAGE_MAX_CHILDREN)
  );
}

// Checks a wallet's CURRENT balance of this specific mint — used to
// distinguish "still actually holds this token" from "received it in a
// past transaction but has since sold or moved it all on."
async function getCurrentTokenBalance(owner) {
  try {
    const result = await rpcCall("getTokenAccountsByOwner", [
      owner,
      { mint: CONFIG.CONTRACT_ADDRESS },
      { encoding: "jsonParsed" },
    ]);
    const accounts = result?.value || [];
    let total = 0;
    for (const acc of accounts) {
      const amt = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
      if (typeof amt === "number") total += amt;
    }
    return total;
  } catch (e) {
    console.warn("[NOTHING] lineage: could not verify current balance for", owner, e);
    return null; // unknown — distinct from a confirmed zero
  }
}

// Estimates a wallet's gain/loss on this token. Bounded best-effort, not
// a certified accounting statement — see caveats surfaced in the detail
// panel itself (scan limit, and price availability post-graduation).
const PNL_TX_SCAN_LIMIT = 25;

async function computeWalletPnL(owner) {
  let tokenAccounts = [];
  try {
    const result = await rpcCall("getTokenAccountsByOwner", [
      owner,
      { mint: CONFIG.CONTRACT_ADDRESS },
      { encoding: "jsonParsed" },
    ]);
    tokenAccounts = (result?.value || []).map((a) => a.pubkey);
  } catch (e) {
    console.warn("[NOTHING] pnl: could not find token accounts for", owner, e);
  }

  const currentBalance = await getCurrentTokenBalance(owner);

  if (tokenAccounts.length === 0) {
    return {
      currentBalance: currentBalance ?? 0,
      solSpent: 0,
      solReceived: 0,
      currentValueSol: null,
      estimatedPnlSol: null,
      txScanned: 0,
      historyAvailable: false,
    };
  }

  let solSpent = 0;
  let solReceived = 0;
  let txScanned = 0;

  for (const tokenAccount of tokenAccounts) {
    let sigInfos = [];
    try {
      sigInfos = await rpcCall("getSignaturesForAddress", [tokenAccount, { limit: PNL_TX_SCAN_LIMIT }]);
    } catch (e) {
      continue;
    }
    for (const info of sigInfos || []) {
      if (info.err) continue;
      let tx;
      try {
        tx = await rpcCall("getTransaction", [
          info.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ]);
      } catch (e) {
        continue;
      }
      if (!tx || !tx.meta) continue;
      txScanned++;

      const pre = tx.meta.preTokenBalances || [];
      const post = tx.meta.postTokenBalances || [];
      const ownPost = post.find((p) => p.mint === CONFIG.CONTRACT_ADDRESS && p.owner === owner);
      if (!ownPost) continue;
      const ownPre = pre.find((p) => p.accountIndex === ownPost.accountIndex);
      const preAmt = ownPre ? Number(ownPre.uiTokenAmount.uiAmount || 0) : 0;
      const postAmt = Number(ownPost.uiTokenAmount.uiAmount || 0);
      const tokenDelta = postAmt - preAmt;
      if (tokenDelta === 0) continue;

      const accountKeys = tx.transaction.message.accountKeys;
      const ownerIndex = accountKeys.findIndex((k) => (k.pubkey || k) === owner);
      if (ownerIndex === -1) continue;
      const preSol = tx.meta.preBalances?.[ownerIndex];
      const postSol = tx.meta.postBalances?.[ownerIndex];
      if (preSol == null || postSol == null) continue;
      const solDelta = (postSol - preSol) / 1e9;

      if (tokenDelta > 0 && solDelta < 0) {
        solSpent += Math.abs(solDelta);
      } else if (tokenDelta < 0 && solDelta > 0) {
        solReceived += solDelta;
      }
    }
  }

  const price = currentPricePerTokenSol();
  const currentValueSol = price !== null && currentBalance ? currentBalance * price : null;
  const estimatedPnlSol = currentValueSol !== null
    ? solReceived + currentValueSol - solSpent
    : solReceived - solSpent;

  return {
    currentBalance: currentBalance ?? 0,
    solSpent,
    solReceived,
    currentValueSol,
    estimatedPnlSol,
    txScanned,
    historyAvailable: true,
    priceAvailable: price !== null,
  };
}

function createTreeNode(holder, depth) {
  const wrap = document.createElement("div");
  wrap.className = "lineage-node-wrap";

  const node = document.createElement("button");
  node.type = "button";
  node.className = "lineage-node" +
    (holder.isBondingCurve ? " curve" : holder.soldSince ? " sold" : holder.isTopHolder ? " holder" : " child");
  node.dataset.owner = holder.owner;

  const label = document.createElement("div");
  label.className = "lineage-node-label";
  label.textContent = holder.isBondingCurve
    ? "CURVE"
    : holder.soldSince
    ? "SOLD"
    : holder.isTopHolder
    ? `#${holder.rank ?? ""}`
    : "wallet";
  node.appendChild(label);

  const addr = document.createElement("span");
  addr.className = "lineage-node-addr";
  addr.textContent = shortenAddress(holder.owner);
  node.appendChild(addr);

  const meta = document.createElement("div");
  meta.className = "lineage-node-meta";
  if (holder.isBondingCurve) {
    meta.textContent = "still on bonding curve";
  } else if (holder.soldSince) {
    meta.textContent = "no longer holding";
  } else if (holder.balanceUnknown) {
    meta.textContent = `~${holder.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} $NIC (unverified)`;
  } else {
    meta.textContent = `${holder.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} $NIC`;
  }
  node.appendChild(meta);

  wrap.appendChild(node);

  if (holder.isTopHolder && !holder.isBondingCurve) {
    const note = document.createElement("div");
    note.className = "lineage-node-provenance";
    if (holder.sourceIsCurve) {
      note.textContent = "\u2196 from bonding curve";
    } else if (holder.sourceOnMap) {
      note.textContent = `\u2196 from ${shortenAddress(holder.source)}`;
    } else if (holder.source) {
      note.textContent = `from ${shortenAddress(holder.source)} (off-map)`;
    } else {
      note.textContent = "source not found in recent history";
    }
    wrap.appendChild(note);
  }

  return { wrap, node };
}

/* ---------------------------------------------------------
   Holder tree — the bonding curve is the root, top holders are
   rectangular nodes connected to whichever source the data
   actually traced (the curve, or another top holder), and
   clicking a node traces its own recent transfers and expands
   directly underneath it. This replaced an earlier radial
   "bubble map" layout: CSS-driven parent/child connectors are
   far more reliable than manually computing every line's
   coordinates, and a tree only ever has one node per wallet by
   construction — duplicates simply aren't possible the way they
   were with freeform bubble placement.
   --------------------------------------------------------- */
const lineageState = {
  renderedOwners: new Set(), // every wallet currently drawn anywhere in the tree
  selectedNode: null,
};

function buildHolderTree(holders) {
  const curve = holders.find((h) => h.isBondingCurve) || null;
  const others = holders.filter((h) => h !== curve);
  const byOwner = new Map(holders.map((h) => [h.owner, h]));
  const childrenOf = new Map();
  const rootChildren = [];

  others.forEach((h) => {
    h.isTopHolder = true;
    h.sourceIsCurve = curve != null && h.source === curve.owner;
    h.sourceOnMap = Boolean(h.source && byOwner.has(h.source) && h.source !== h.owner);

    if (h.sourceOnMap && !h.sourceIsCurve) {
      if (!childrenOf.has(h.source)) childrenOf.set(h.source, []);
      childrenOf.get(h.source).push(h);
    } else {
      rootChildren.push(h);
    }
  });

  return { curve, rootChildren, childrenOf };
}

function renderNodeRecursive(holder, depth, childrenOf) {
  const li = document.createElement("li");
  const { wrap, node } = createTreeNode(holder, depth);
  li.appendChild(wrap);
  lineageState.renderedOwners.add(holder.owner);
  node.addEventListener("click", () => handleNodeClick(holder, node, li));

  const kids = (childrenOf.get(holder.owner) || []).filter((k) => !lineageState.renderedOwners.has(k.owner));
  if (kids.length > 0) {
    const ul = document.createElement("ul");
    kids.forEach((k) => ul.appendChild(renderNodeRecursive(k, depth + 1, childrenOf)));
    li.appendChild(ul);
  }
  return li;
}

function renderTree(holders) {
  const body = document.getElementById("lineage-body");
  body.innerHTML = "";
  lineageState.renderedOwners = new Set();
  lineageState.selectedNode = null;

  const { curve, rootChildren, childrenOf } = buildHolderTree(holders);
  const rootHolder = curve || holders[0];
  if (rootHolder) rootHolder.isTopHolder = false; // the root itself isn't labeled like a ranked holder

  const outer = document.createElement("div");
  outer.className = "lineage-tree-outer";
  const ul = document.createElement("ul");
  ul.className = "lineage-tree";

  const rootLi = document.createElement("li");
  const { wrap: rootWrap, node: rootNode } = createTreeNode(rootHolder, 0);
  rootLi.appendChild(rootWrap);
  lineageState.renderedOwners.add(rootHolder.owner);
  if (rootHolder.isBondingCurve) {
    rootNode.addEventListener("click", () => handleNodeClick(rootHolder, rootNode, rootLi));
  }

  const initialChildren = (curve ? rootChildren : holders.filter((h) => h !== rootHolder))
    .filter((h) => !lineageState.renderedOwners.has(h.owner));
  if (initialChildren.length > 0) {
    const childUl = document.createElement("ul");
    initialChildren.forEach((h) => childUl.appendChild(renderNodeRecursive(h, 1, childrenOf)));
    rootLi.appendChild(childUl);
  }

  ul.appendChild(rootLi);
  outer.appendChild(ul);
  body.appendChild(outer);
}

function selectNode(node) {
  if (lineageState.selectedNode && lineageState.selectedNode !== node) {
    lineageState.selectedNode.classList.remove("selected");
  }
  node.classList.add("selected");
  lineageState.selectedNode = node;
}

async function handleNodeClick(holder, node, li) {
  selectNode(node);
  openWalletDetail(holder);

  if (holder.isBondingCurve) return; // the curve isn't expandable — nothing to trace

  const existingChildUl = Array.from(li.children).find((el) => el.tagName === "UL");
  if (existingChildUl) {
    // Collapse: remove it and free up its wallets so they can be
    // rendered fresh if expanded again from here or elsewhere.
    existingChildUl.querySelectorAll("[data-owner]").forEach((el) => {
      lineageState.renderedOwners.delete(el.dataset.owner);
    });
    existingChildUl.remove();
    node.classList.remove("expanded");
    return;
  }

  node.classList.add("expanded");
  node.disabled = true;
  const labelEl = node.querySelector(".lineage-node-label");
  const originalLabel = labelEl.textContent;
  labelEl.textContent = "\u2026";

  try {
    const recipients = await fetchRecentRecipients(holder.tokenAccount || holder.owner, holder.owner);
    node.disabled = false;
    labelEl.textContent = originalLabel;

    if (recipients.size === 0) {
      const noteWrap = document.createElement("div");
      noteWrap.className = "lineage-tree-note-wrap";
      const note = document.createElement("p");
      note.className = "lineage-empty-note";
      note.textContent = "no recent transfers found";
      noteWrap.appendChild(note);
      const ul = document.createElement("ul");
      const noteLi = document.createElement("li");
      noteLi.appendChild(noteWrap);
      ul.appendChild(noteLi);
      li.appendChild(ul);
      return;
    }

    const entries = Array.from(recipients.entries());
    labelEl.textContent = "\u2026";
    const verified = await Promise.all(
      entries.map(async ([recipient, historicalAmount]) => {
        const currentBalance = await getCurrentTokenBalance(recipient);
        return { recipient, historicalAmount, currentBalance };
      })
    );
    labelEl.textContent = originalLabel;

    const ul = document.createElement("ul");
    let addedAny = false;
    verified.forEach(({ recipient, historicalAmount, currentBalance }) => {
      if (lineageState.renderedOwners.has(recipient)) {
        console.log("[NOTHING] lineage: skipping duplicate node for", recipient, "(already shown elsewhere in the tree)");
        return;
      }
      const displayAmount = currentBalance !== null && currentBalance > 0 ? currentBalance : historicalAmount;
      const childHolder = {
        owner: recipient,
        tokenAccount: recipient,
        amount: displayAmount,
        isBondingCurve: false,
        isTopHolder: false,
        soldSince: currentBalance === 0,
        balanceUnknown: currentBalance === null,
      };
      const childLi = document.createElement("li");
      const { wrap, node: childNode } = createTreeNode(childHolder, 1);
      childLi.appendChild(wrap);
      lineageState.renderedOwners.add(recipient);
      childNode.addEventListener("click", () => handleNodeClick(childHolder, childNode, childLi));
      ul.appendChild(childLi);
      addedAny = true;
    });

    if (addedAny) {
      li.appendChild(ul);
    } else {
      const noteWrap = document.createElement("div");
      noteWrap.className = "lineage-tree-note-wrap";
      const note = document.createElement("p");
      note.className = "lineage-empty-note";
      note.textContent = "already shown elsewhere in the tree";
      noteWrap.appendChild(note);
      const noteLi = document.createElement("li");
      noteLi.appendChild(noteWrap);
      const emptyUl = document.createElement("ul");
      emptyUl.appendChild(noteLi);
      li.appendChild(emptyUl);
    }
  } catch (e) {
    console.warn("[NOTHING] lineage: expand failed for", holder.owner, e);
    node.disabled = false;
    labelEl.textContent = originalLabel;
    node.classList.remove("expanded");
  }
}

function closeWalletDetail() {
  const panel = document.getElementById("lineage-detail-panel");
  panel.hidden = true;
  if (lineageState.selectedNode) {
    lineageState.selectedNode.classList.remove("selected");
    lineageState.selectedNode = null;
  }
}

function formatSol(n) {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(3)} SOL`;
}

async function openWalletDetail(holder) {
  const panel = document.getElementById("lineage-detail-panel");
  const body = document.getElementById("lineage-detail-body");
  panel.hidden = false;
  body.innerHTML = `<p class="lineage-detail-loading">tracing this wallet's activity\u2026</p>`;

  if (holder.isBondingCurve) {
    body.innerHTML = `
      <div class="lineage-detail-row">
        <span class="lineage-detail-label">address</span>
        <span class="lineage-detail-value">${shortenAddress(holder.owner)}</span>
      </div>
      <p class="lineage-detail-caveat">This is the bonding curve's own reserve, not a trader's wallet \u2014 gain/loss doesn't apply to it.</p>
      <a class="lineage-detail-link" href="https://solscan.io/account/${holder.owner}" target="_blank" rel="noopener">View on Solscan \u2197</a>
    `;
    return;
  }

  try {
    const pnl = await computeWalletPnL(holder.owner);
    const pnlClass = pnl.estimatedPnlSol == null ? "" : pnl.estimatedPnlSol >= 0 ? "gain" : "loss";
    const pnlLabel = pnl.estimatedPnlSol == null
      ? "unknown"
      : `${pnl.estimatedPnlSol >= 0 ? "GAIN" : "LOSS"} ${formatSol(pnl.estimatedPnlSol)}`;

    let caveat;
    if (!pnl.historyAvailable) {
      caveat = "This wallet has no remaining token account for this mint, so its trade history couldn't be scoped \u2014 gain/loss unavailable.";
    } else if (!pnl.priceAvailable && pnl.currentBalance > 0) {
      caveat = `Based on the last ~${PNL_TX_SCAN_LIMIT} transactions per token account, not full history. Current price unavailable (token has graduated off the bonding curve), so this reflects realized SOL flow only, not the value of tokens still held.`;
    } else {
      caveat = `Based on the last ~${PNL_TX_SCAN_LIMIT} transactions per token account \u2014 a wallet with a longer trading history may have older activity this misses.`;
    }

    body.innerHTML = `
      <div class="lineage-detail-row">
        <span class="lineage-detail-label">address</span>
        <span class="lineage-detail-value">${shortenAddress(holder.owner)}</span>
      </div>
      <div class="lineage-detail-row">
        <span class="lineage-detail-label">current balance</span>
        <span class="lineage-detail-value">${pnl.currentBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })} $NIC</span>
      </div>
      <div class="lineage-detail-row">
        <span class="lineage-detail-label">estimated gain / loss</span>
        <span class="lineage-detail-value ${pnlClass}">${pnlLabel}</span>
      </div>
      <div class="lineage-detail-row">
        <span class="lineage-detail-label">sol spent buying (recent)</span>
        <span class="lineage-detail-value">${pnl.solSpent.toFixed(3)} SOL</span>
      </div>
      <div class="lineage-detail-row">
        <span class="lineage-detail-label">sol received selling (recent)</span>
        <span class="lineage-detail-value">${pnl.solReceived.toFixed(3)} SOL</span>
      </div>
      <p class="lineage-detail-caveat">${caveat}</p>
      <a class="lineage-detail-link" href="https://solscan.io/account/${holder.owner}" target="_blank" rel="noopener">View on Solscan \u2197</a>
    `;
  } catch (e) {
    console.warn("[NOTHING] pnl: failed for", holder.owner, e);
    body.innerHTML = `<p class="lineage-detail-caveat">Couldn't trace this wallet \u2014 see console for details.</p>`;
  }
}

function openLineageModal() {
  const modal = document.getElementById("lineage-modal");
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeLineageModal() {
  const modal = document.getElementById("lineage-modal");
  modal.hidden = true;
  document.body.style.overflow = "";
  closeWalletDetail();
}

async function generateLineageMap() {
  console.log("[NOTHING] lineage: generate button clicked");

  const btn = document.getElementById("lineage-generate");
  const hint = document.getElementById("lineage-hint");
  const body = document.getElementById("lineage-body");

  openLineageModal();
  body.innerHTML = "";
  hint.textContent = "fetching top holders\u2026";

  const originalLabel = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Generating\u2026";
  }

  try {
    const holders = await fetchTopHolders();
    if (holders.length === 0) {
      console.log("[NOTHING] lineage: no holder accounts returned");
      body.innerHTML = `<p class="lineage-error">No holder data returned \u2014 the token may be too new, or fully on the bonding curve with no external accounts yet.</p>`;
      hint.textContent = "no data";
      return;
    }

    holders.forEach((h, i) => { h.rank = i + 1; });

    console.log("[NOTHING] lineage: rendering tree for", holders.length, "holders");
    renderTree(holders);
    hint.textContent = `${holders.length} top holders \u00b7 click any node to trace further \u00b7 ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    console.warn("[NOTHING] lineage map generation failed:", e);
    body.innerHTML = `<p class="lineage-error">Couldn't generate the map \u2014 check the console for details, or try again in a moment.</p>`;
    hint.textContent = "failed \u2014 see console";
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
}

function initLineageMap() {
  const btn = document.getElementById("lineage-generate");
  const closeBtn = document.getElementById("lineage-modal-close");
  if (btn) {
    btn.addEventListener("click", generateLineageMap);
    console.log("[NOTHING] lineage: generate button listener attached");
  } else {
    console.warn("[NOTHING] lineage: #lineage-generate button not found in the page \u2014 check index.html is up to date");
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", closeLineageModal);
  }
  const detailCloseBtn = document.getElementById("lineage-detail-close");
  if (detailCloseBtn) {
    detailCloseBtn.addEventListener("click", closeWalletDetail);
  }
}

function init() {
  document.getElementById("footer-year").textContent = new Date().getFullYear();
  initVoidField();
  initGlitch();
  initContractPill();
  initShareButton();
  initAgeCounter();
  renderMemeGallery();
  initMascotImage();
  initMemeAutoScroll();
  initBuyNowChart();
  initJupiterSwap();
  initNavWallet();
  initNavScrollSpy();

  const hasMint = isLikelyMintAddress(CONFIG.CONTRACT_ADDRESS);

  if (hasMint && isRpcConfigured()) {
    startLiveFeed();
    startCurveTracking();
    initLineageMap();
  } else if (hasMint && !isRpcConfigured()) {
    // Real token set, but no working RPC yet — say so instead of
    // silently failing forever.
    setStatus("needs-rpc");
    document.getElementById("feed-hint").textContent = "add a Helius API key in app.js to go live (see README)";
    document.getElementById("curve-badge").textContent = "add an RPC key to track the curve";
    document.getElementById("lineage-hint").textContent = "add an RPC key to enable this";
    document.getElementById("lineage-generate").disabled = true;
  } else {
    startDemoFeed();
    startDemoCurve();
    document.getElementById("lineage-hint").textContent = "needs a real contract address";
    document.getElementById("lineage-generate").disabled = true;
  }
}

document.addEventListener("DOMContentLoaded", init);