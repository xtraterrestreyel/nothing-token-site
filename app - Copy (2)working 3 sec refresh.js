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
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) return;

  function tick() {
    el.classList.add("glitching");
    setTimeout(() => el.classList.remove("glitching"), 280);
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

  valueEl.textContent = live ? shortenAddress(addr, 6, 6) : "not deployed yet";
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

function renderCurve(curve) {
  const fill = document.getElementById("curve-bar-fill");
  const percentEl = document.getElementById("curve-percent");
  const mcEl = document.getElementById("curve-marketcap");
  const badge = document.getElementById("curve-badge");
  const stamp = document.getElementById("graduation-stamp");
  const venueEl = document.getElementById("graduation-venue");
  const stampTime = document.getElementById("graduation-time");

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

  // Flash the big wordmark the same color as the trade
  wordmark.classList.remove("trade-buy", "trade-sell");
  void wordmark.offsetWidth;
  wordmark.classList.add(type === "buy" ? "trade-buy" : "trade-sell");

  setTimeout(() => {
    sub.textContent = "idle";
    document.getElementById("pulse-orb").querySelector(".core").style.stroke = "var(--violet)";
    label.classList.remove("hide-for-arrow");
    showArrow.classList.remove("flashing");
    wordmark.classList.remove("trade-buy", "trade-sell");
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
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
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
    try {
      await processRetryQueue();
    } catch (e) {
      console.warn("Retry queue processing failed", e);
    }
    setTimeout(reconcile, CONFIG.POLL_INTERVAL_MS);
  }
  reconcile();
}

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */
function init() {
  document.getElementById("footer-year").textContent = new Date().getFullYear();
  initVoidField();
  initGlitch();
  initContractPill();
  initAgeCounter();

  const hasMint = isLikelyMintAddress(CONFIG.CONTRACT_ADDRESS);

  if (hasMint && isRpcConfigured()) {
    startLiveFeed();
    startCurveTracking();
  } else if (hasMint && !isRpcConfigured()) {
    // Real token set, but no working RPC yet — say so instead of
    // silently failing forever.
    setStatus("needs-rpc");
    document.getElementById("feed-hint").textContent = "add a Helius API key in app.js to go live (see README)";
    document.getElementById("curve-badge").textContent = "add an RPC key to track the curve";
  } else {
    startDemoFeed();
    startDemoCurve();
  }
}

document.addEventListener("DOMContentLoaded", init);