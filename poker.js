/* =========================================================
   NOTHING — poker.js
   ---------------------------------------------------------
   IMPORTANT: update POKER_WS_URL below if your Worker's URL is
   different from what's shown here (check by running
   `npx wrangler deploy` again — it prints the URL every time).

   This connects as a spectator the moment your wallet is
   connected (reusing the same Phantom connection lounge.js
   already set up — no second "connect" step), so you can see who's
   at the table before deciding to sit down. Clicking an open seat
   sends a join request; from that point on the server includes
   your own hole cards in every update it sends you (and only
   yours — this is exactly why the dealer has to live on a real
   server instead of in your browser).
   ========================================================= */

const POKER_WS_URL = "wss://nic-poker-table.extraterrestreyel.workers.dev/table/ws";
const MAX_SEATS = 6;

let pokerSocket = null;
let pokerConnectedWallet = null;
let pokerLastState = null;

const RANK_LABELS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUIT_LABELS = ["\u2660", "\u2665", "\u2666", "\u2663"]; // spade heart diamond club

function pokerShortWallet(w) {
  if (!w) return "?";
  return w.slice(0, 4) + "\u2026" + w.slice(-4);
}

function cardEl(cardInt, faceDown) {
  const el = document.createElement("div");
  el.className = "poker-card" + (faceDown ? " face-down" : "");
  if (!faceDown && cardInt != null) {
    const rank = Math.floor(cardInt / 4);
    const suit = cardInt % 4;
    el.textContent = RANK_LABELS[rank] + SUIT_LABELS[suit];
    if (suit === 1 || suit === 2) el.classList.add("red");
  }
  return el;
}

function connectPokerSocket(wallet) {
  if (pokerSocket && pokerSocket.readyState <= 1) return; // already connecting/open
  pokerConnectedWallet = wallet;

  pokerSocket = new WebSocket(POKER_WS_URL);

  pokerSocket.addEventListener("open", () => {
    console.log("[NOTHING poker] connected to table");
  });

  pokerSocket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "state") {
      pokerLastState = msg.state;
      renderPokerTable(msg.state);
    } else if (msg.type === "error") {
      console.warn("[NOTHING poker] server error:", msg.message);
      const log = document.getElementById("poker-log");
      if (log) {
        const line = document.createElement("div");
        line.className = "poker-log-error";
        line.textContent = msg.message;
        log.prepend(line);
      }
    }
  });

  pokerSocket.addEventListener("close", () => {
    console.log("[NOTHING poker] table connection closed");
    pokerSocket = null;
    setTimeout(() => {
      if (pokerConnectedWallet) connectPokerSocket(pokerConnectedWallet);
    }, 2000);
  });

  pokerSocket.addEventListener("error", (e) => {
    console.warn("[NOTHING poker] socket error", e);
  });
}

function sendPokerMessage(msg) {
  if (pokerSocket && pokerSocket.readyState === 1) {
    pokerSocket.send(JSON.stringify(msg));
  }
}

function joinSeat(seatIndex) {
  if (!pokerConnectedWallet) return;
  sendPokerMessage({ type: "join", wallet: pokerConnectedWallet, seatIndex });
}

function leaveSeat() {
  sendPokerMessage({ type: "leave" });
}

function sendAction(action, amount) {
  sendPokerMessage({ type: "action", action, amount });
}

function renderSeat(state, seatIndex) {
  const wrap = document.createElement("div");
  wrap.className = "poker-seat";
  const seat = state.seats[seatIndex];

  if (!seat) {
    wrap.classList.add("empty");
    if (state.mySeat === null && pokerConnectedWallet) {
      const btn = document.createElement("button");
      btn.className = "poker-sit-btn";
      btn.textContent = `Sit (Seat ${seatIndex + 1})`;
      btn.addEventListener("click", () => joinSeat(seatIndex));
      wrap.appendChild(btn);
    } else {
      wrap.textContent = `Seat ${seatIndex + 1} \u2014 open`;
    }
    return wrap;
  }

  if (seatIndex === state.dealerSeat) wrap.classList.add("dealer");
  if (seatIndex === state.toActSeat) wrap.classList.add("to-act");
  if (seat.folded) wrap.classList.add("folded");
  if (seatIndex === state.mySeat) wrap.classList.add("is-me");

  const nameEl = document.createElement("div");
  nameEl.className = "poker-seat-name";
  nameEl.textContent = pokerShortWallet(seat.wallet) + (seatIndex === state.mySeat ? " (you)" : "");
  wrap.appendChild(nameEl);

  const chipsEl = document.createElement("div");
  chipsEl.className = "poker-seat-chips";
  chipsEl.textContent = `${seat.chips} chips`;
  wrap.appendChild(chipsEl);

  if (seat.committedThisRound > 0) {
    const betEl = document.createElement("div");
    betEl.className = "poker-seat-bet";
    betEl.textContent = `bet ${seat.committedThisRound}`;
    wrap.appendChild(betEl);
  }

  const cardsRow = document.createElement("div");
  cardsRow.className = "poker-seat-cards";
  if (seat.cards) {
    seat.cards.forEach((c) => cardsRow.appendChild(cardEl(c, false)));
  } else if (seat.hasCards && !seat.folded) {
    cardsRow.appendChild(cardEl(null, true));
    cardsRow.appendChild(cardEl(null, true));
  }
  wrap.appendChild(cardsRow);

  if (seat.allIn) {
    const tag = document.createElement("div");
    tag.className = "poker-seat-tag";
    tag.textContent = "ALL IN";
    wrap.appendChild(tag);
  } else if (seat.folded) {
    const tag = document.createElement("div");
    tag.className = "poker-seat-tag";
    tag.textContent = "FOLDED";
    wrap.appendChild(tag);
  }

  return wrap;
}

function renderActions(state) {
  const container = document.getElementById("poker-actions");
  container.innerHTML = "";

  if (state.mySeat === null) return;
  const mySeatData = state.seats[state.mySeat];
  if (!mySeatData) return;

  if (state.toActSeat === state.mySeat && !mySeatData.folded && !mySeatData.allIn) {
    const toCall = state.currentBet - mySeatData.committedThisRound;

    const foldBtn = document.createElement("button");
    foldBtn.className = "poker-action-btn poker-fold-btn";
    foldBtn.textContent = "Fold";
    foldBtn.addEventListener("click", () => sendAction("fold"));
    container.appendChild(foldBtn);

    const callBtn = document.createElement("button");
    callBtn.className = "poker-action-btn";
    callBtn.textContent = toCall > 0 ? `Call ${toCall}` : "Check";
    callBtn.addEventListener("click", () => sendAction(toCall > 0 ? "call" : "check"));
    container.appendChild(callBtn);

    const minRaiseTo = state.currentBet + state.minRaise;
    const raiseWrap = document.createElement("div");
    raiseWrap.className = "poker-raise-wrap";
    const raiseInput = document.createElement("input");
    raiseInput.type = "number";
    raiseInput.className = "poker-raise-input";
    raiseInput.min = minRaiseTo;
    raiseInput.value = minRaiseTo;
    raiseWrap.appendChild(raiseInput);
    const raiseBtn = document.createElement("button");
    raiseBtn.className = "poker-action-btn poker-raise-btn";
    raiseBtn.textContent = state.currentBet > 0 ? "Raise to" : "Bet";
    raiseBtn.addEventListener("click", () => {
      const amt = Number(raiseInput.value);
      sendAction(state.currentBet > 0 ? "raise" : "bet", amt);
    });
    raiseWrap.appendChild(raiseBtn);
    container.appendChild(raiseWrap);
  } else if (state.phase !== "waiting" && state.phase !== "showdown") {
    const waiting = document.createElement("p");
    waiting.className = "poker-waiting-note";
    waiting.textContent = mySeatData.folded
      ? "You folded this hand."
      : mySeatData.allIn
      ? "You're all-in \u2014 waiting for the rest of the hand to play out."
      : "Waiting for your turn\u2026";
    container.appendChild(waiting);
  }
}

function renderPokerTable(state) {
  const tableWrap = document.getElementById("poker-table-wrap");
  const joinRow = document.getElementById("poker-join-row");
  const hint = document.getElementById("poker-hint");

  tableWrap.hidden = false;
  joinRow.innerHTML = "";

  if (state.mySeat !== null) {
    const leaveBtn = document.createElement("button");
    leaveBtn.className = "poker-leave-btn";
    leaveBtn.textContent = "Leave table";
    leaveBtn.addEventListener("click", leaveSeat);
    joinRow.appendChild(leaveBtn);
    hint.textContent = `you're seated \u2014 seat ${state.mySeat + 1}`;
  } else {
    hint.textContent = "pick an open seat below";
  }

  document.getElementById("poker-phase").textContent =
    state.phase === "waiting" ? "waiting for players\u2026" : state.phase;
  document.getElementById("poker-pot").textContent = `Pot: ${state.pot}`;

  const communityEl = document.getElementById("poker-community");
  communityEl.innerHTML = "";
  state.community.forEach((c) => communityEl.appendChild(cardEl(c, false)));

  const topRow = document.getElementById("poker-seats-top");
  const bottomRow = document.getElementById("poker-seats-bottom");
  topRow.innerHTML = "";
  bottomRow.innerHTML = "";
  for (let i = 0; i < MAX_SEATS; i++) {
    const seatEl = renderSeat(state, i);
    (i < MAX_SEATS / 2 ? topRow : bottomRow).appendChild(seatEl);
  }

  renderActions(state);

  if (state.lastShowdown && state.phase === "showdown") {
    const log = document.getElementById("poker-log");
    const existing = log.dataset.lastHand;
    if (existing !== String(state.handNumber)) {
      log.dataset.lastHand = String(state.handNumber);
      state.lastShowdown.pots.forEach((pot) => {
        const line = document.createElement("div");
        line.className = "poker-log-line";
        const names = pot.winners.map((w) => pokerShortWallet(state.seats[w]?.wallet)).join(", ");
        line.textContent = pot.handName
          ? `${names} won ${pot.amount} with ${pot.handName}`
          : `${names} won ${pot.amount} (everyone else folded)`;
        log.prepend(line);
      });
    }
  }
}

function initPokerJoinFlow() {
  const joinRow = document.getElementById("poker-join-row");

  function tryConnect() {
    const provider = window?.solana;
    const wallet = provider?.publicKey?.toString();
    if (wallet && wallet !== pokerConnectedWallet) {
      joinRow.innerHTML = `<p class="poker-connect-note">Connecting to the table\u2026</p>`;
      connectPokerSocket(wallet);
    } else if (!wallet) {
      joinRow.innerHTML = `<p class="poker-connect-note">Connect your wallet above to see the table.</p>`;
      document.getElementById("poker-table-wrap").hidden = true;
    }
  }

  tryConnect();
  // The wallet connects via the nav button elsewhere on the page — check
  // periodically rather than trying to hook into that button directly,
  // since it's simpler and this only needs to notice a change, not react
  // instantly.
  setInterval(tryConnect, 1500);
}

document.addEventListener("DOMContentLoaded", initPokerJoinFlow);
