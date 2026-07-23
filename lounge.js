/* =========================================================
   NOTHING — lounge.js
   ---------------------------------------------------------
   IMPORTANT: RPC_ENDPOINT and CONTRACT_ADDRESS below must be
   kept in sync with the same values in app.js — this is a
   separate page with its own script, so it doesn't share state
   with the main site's config automatically. Update both files
   together whenever either one changes.

   Tier thresholds are placeholders — adjust TIER_CONFIG below
   once you know your actual holder distribution (e.g. check
   the holder tree on the main site to see realistic amounts
   people actually hold before picking real cutoffs).
   ========================================================= */

const LOUNGE_CONFIG = {
  RPC_ENDPOINT: "https://mainnet.helius-rpc.com/?api-key=5904e072-7870-4664-943c-db1469731658",
  CONTRACT_ADDRESS: "9bvi3AgBNSYtMFpTaqPUrhTxY9vd7MpfsTPortTXpump",
};

// Three tiers, lowest to highest. "min" is the $NIC balance required.
// Adjust these once you know real holder distribution.
const TIER_CONFIG = [
  {
    key: "bronze",
    name: "Bronze",
    min: 10000,
    desc: "Entry-level tournaments. Everyone holding at least this much is eligible.",
  },
  {
    key: "silver",
    name: "Silver",
    min: 100000,
    desc: "Mid-tier tournaments, smaller fields, better odds at the top of the leaderboard.",
  },
  {
    key: "gold",
    name: "Gold",
    min: 1000000,
    desc: "Top-tier tournaments for the largest holders — the smallest fields, the most bragging rights.",
  },
];

/* ---------------------------------------------------------
   Starfield background — identical to the main site's, kept
   here separately since this page doesn't load app.js (which
   has a lot of unrelated logic this page doesn't need).
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

function shortenAddress(addr, left = 4, right = 4) {
  if (!addr) return "";
  if (addr.length <= left + right + 3) return addr;
  return `${addr.slice(0, left)}\u2026${addr.slice(-right)}`;
}

/* ---------------------------------------------------------
   Tier rendering — shows all three tiers, locked by default.
   --------------------------------------------------------- */
function renderTierCards(currentBalance) {
  const grid = document.getElementById("lounge-tier-grid");
  grid.innerHTML = "";

  TIER_CONFIG.forEach((tier) => {
    const unlocked = currentBalance !== null && currentBalance >= tier.min;
    const card = document.createElement("div");
    card.className = "lounge-tier-card" + (unlocked ? " unlocked" : "");
    card.innerHTML = `
      <p class="lounge-tier-name">${tier.name}</p>
      <p class="lounge-tier-req">Requires ${tier.min.toLocaleString()}+ $NIC</p>
      <p class="lounge-tier-desc">${tier.desc}</p>
      ${unlocked ? '<span class="lounge-tier-badge">Unlocked</span>' : ""}
    `;
    grid.appendChild(card);
  });
}

async function rpcCall(method, params) {
  const res = await fetch(LOUNGE_CONFIG.RPC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

async function getTokenBalance(owner) {
  const result = await rpcCall("getTokenAccountsByOwner", [
    owner,
    { mint: LOUNGE_CONFIG.CONTRACT_ADDRESS },
    { encoding: "jsonParsed" },
  ]);
  const accounts = result?.value || [];
  let total = 0;
  for (const acc of accounts) {
    const amt = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    if (typeof amt === "number") total += amt;
  }
  return total;
}

async function checkTierForWallet(address) {
  const statusEl = document.getElementById("lounge-tier-status-text");
  const hintEl = document.getElementById("tier-hint");
  statusEl.textContent = "Checking your $NIC balance\u2026";
  statusEl.classList.remove("qualified");

  try {
    const balance = await getTokenBalance(address);
    renderTierCards(balance);

    const highestUnlocked = [...TIER_CONFIG].reverse().find((t) => balance >= t.min);
    if (highestUnlocked) {
      statusEl.textContent = `You hold ${balance.toLocaleString(undefined, { maximumFractionDigits: 0 })} $NIC — eligible for ${highestUnlocked.name} tournaments and below.`;
      statusEl.classList.add("qualified");
      hintEl.textContent = `${highestUnlocked.name} tier`;
    } else {
      statusEl.textContent = `You hold ${balance.toLocaleString(undefined, { maximumFractionDigits: 0 })} $NIC — below the Bronze tier threshold (${TIER_CONFIG[0].min.toLocaleString()}) for now.`;
      hintEl.textContent = "no tier yet";
    }
  } catch (e) {
    console.warn("[NOTHING lounge] balance check failed", e);
    statusEl.textContent = "Couldn't check your balance right now — try reconnecting in a moment.";
    hintEl.textContent = "check failed";
  }
}

/* ---------------------------------------------------------
   Nav wallet connect — same pattern as the main site, plus
   triggers a tier check on connect.
   --------------------------------------------------------- */
function initNavWallet() {
  const btn = document.getElementById("nav-wallet-btn");
  if (!btn) return;

  function setConnectedUI(address) {
    btn.textContent = shortenAddress(address);
    btn.classList.add("connected");
    btn.title = "Connected \u2014 click to disconnect";
    checkTierForWallet(address);
  }

  function setDisconnectedUI() {
    btn.textContent = "Connect Wallet";
    btn.classList.remove("connected");
    btn.title = "";
    document.getElementById("lounge-tier-status-text").textContent =
      "Connect your wallet above to see which tournaments you're eligible for.";
    document.getElementById("lounge-tier-status-text").classList.remove("qualified");
    document.getElementById("tier-hint").textContent = "connect your wallet to check";
    renderTierCards(null);
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
    } catch (e) {
      console.log("[NOTHING lounge] wallet connection was cancelled");
    }
  });

  // Same silent-reconnect fix as the main site — checking isConnected
  // alone resets to false on every fresh page load even on a trusted
  // site, which is why this required reconnecting on every page.
  const provider = window?.solana;
  if (provider?.isPhantom) {
    provider.connect({ onlyIfTrusted: true })
      .then((resp) => setConnectedUI(resp.publicKey.toString()))
      .catch(() => {
        // Not previously trusted, or needs manual connect — fine, no-op.
      });
  }

  // Keep the button's displayed state HONEST going forward, not just
  // right after page load. Without this, the button can silently drift
  // out of sync with Phantom's real connection state — and since the
  // click handler above trusts isConnected to decide whether to connect
  // or disconnect, a stale "Connect Wallet" label while actually already
  // connected means clicking it silently disconnects you instead.
  setInterval(() => {
    const p = window?.solana;
    if (!p?.isPhantom) return;
    const actuallyConnected = !!(p.isConnected && p.publicKey);
    const displayedAsConnected = btn.classList.contains("connected");
    if (actuallyConnected && !displayedAsConnected) {
      setConnectedUI(p.publicKey.toString());
    } else if (!actuallyConnected && displayedAsConnected) {
      setDisconnectedUI();
    }
  }, 2000);
}

/* ---------------------------------------------------------
   Leaderboard tabs — UI only for now. Real weekly/monthly/
   Hall of Nothing data gets wired in once the poker backend
   (and something to actually rank) exists.
   --------------------------------------------------------- */
function initLeaderboardTabs() {
  const tabs = document.querySelectorAll(".lounge-tab");
  const body = document.getElementById("lounge-leaderboard-body");

  const emptyMessages = {
    weekly: "No tournaments have run yet — this fills in once the tables open.",
    monthly: "No tournaments have run yet — this fills in once the tables open.",
    hall: "The Hall of Nothing archives every weekly and monthly winner, permanently \u2014 empty until the first tournament wraps.",
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const key = tab.dataset.tab;
      body.innerHTML = `<p class="lounge-leaderboard-empty">${emptyMessages[key]}</p>`;
    });
  });
}

function initWalletDebugStrip() {
  const el = document.getElementById("wallet-debug-strip");
  if (!el) return;
  setInterval(() => {
    const p = window?.solana;
    const parts = [
      `window.solana exists: ${!!p}`,
      `isPhantom: ${!!p?.isPhantom}`,
      `isConnected: ${!!p?.isConnected}`,
      `publicKey: ${p?.publicKey ? p.publicKey.toString().slice(0, 6) + "..." : "none"}`,
    ];
    el.textContent = parts.join("  |  ");
  }, 1000);
}

function init() {
  document.getElementById("footer-year").textContent = new Date().getFullYear();
  initVoidField();
  renderTierCards(null);
  initNavWallet();
  initLeaderboardTabs();
  initWalletDebugStrip();
}

document.addEventListener("DOMContentLoaded", init);