// admin-prizearena.js - Admin Prize Arena with Contests, Winners, and Orders tabs.

import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where,
  orderBy,
  limit,
  addDoc,
  updateDoc,
  deleteDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  appendMaintenanceKey,
  shouldTriggerSharedSync
} from "../scripts/status-sync.js";
import { readAllServiceDocsFromCollection } from "../scripts/services-collection.js";
import {
  requireAdminAuth,
  initAdminSidebar,
  bindAdminLogout
} from "./admin-ui-common.js";

requireAdminAuth();

const $ = (id) => document.getElementById(id);

const AUTO_DRAW_API = "/api/prize-auto-draw";
const STATUS_SYNC_API = "/api/status-check";
const CLAIM_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
const DEFAULT_WINNERS_COUNT = 3;
const DEFAULT_REWARD_QTY = 100;
const STATUS_SYNC_MIN_GAP_MS = 5 * 60 * 1000;

const adminEmailEl = $("adminEmail");
const statEarnings = $("statEarnings");
const statParticipants = $("statParticipants");
const statActive = $("statActive");

const contestsBody = $("contestsBody");
const winnersBody = $("winnersBody");
const ordersBody = $("ordersBody");

const contestForm = $("contestForm");
const settingsForm = $("settingsForm");

const participantsListEl = $("participantsList");
const participantsContestTitle = $("participantsContestTitle");
const rewardServiceSelect = $("contestRewardService");

const tabButtons = Array.from(document.querySelectorAll("[data-pa-tab]"));
const paneContests = $("paPaneContests");
const paneWinners = $("paPaneWinners");
const paneOrders = $("paPaneOrders");

const ordersCountEl = $("ordersCount");
const ordersChargeTotalEl = $("ordersChargeTotal");
const ordersVendorTotalEl = $("ordersVendorTotal");

const adminEmail = localStorage.getItem("quickboostAdminName")
  || localStorage.getItem("smmAdminEmail")
  || sessionStorage.getItem("smmAdminEmail")
  || "";
if (adminEmailEl) adminEmailEl.textContent = adminEmail || "admin";

const fmtInr = (n) => `\u20B9${Number(n || 0).toFixed(2)}`;
const escapeHtml = (v) => String(v || "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[c]));

const normalizeUsername = (name) => String(name || "").trim().toLowerCase();

const fmtDateTime = (ts) => {
  const ms = Number(ts || 0);
  if (!ms) return "-";
  const d = new Date(ms);
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }) + " " + d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
};

const toLocalInputValue = (ts) => {
  const d = new Date(Number(ts || Date.now()));
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const statusOf = (contest) => {
  const ends = Number(contest.endsAt || 0);
  if (contest.winnersGenerated || Number(contest.winnerCountResolved || 0) > 0) return "ended";
  if (String(contest.status || "").toLowerCase() === "ended") return "ended";
  if (ends && ends <= Date.now()) return "ended";
  return "active";
};

const winnerDocId = (contestId, username) => {
  const c = String(contestId || "").trim();
  const u = normalizeUsername(username).replace(/[^a-z0-9_-]/g, "_") || "winner";
  return `${c}__${u}`;
};

let allContests = [];
let rewardServices = [];

function switchTab(tab) {
  const target = String(tab || "contests").trim().toLowerCase();
  tabButtons.forEach((btn) => {
    const tabName = String(btn.getAttribute("data-pa-tab") || "").toLowerCase();
    btn.classList.toggle("active", tabName === target);
  });

  paneContests?.classList.toggle("d-none", target !== "contests");
  paneWinners?.classList.toggle("d-none", target !== "winners");
  paneOrders?.classList.toggle("d-none", target !== "orders");
}

function buildStatusApiUrl() {
  return appendMaintenanceKey(STATUS_SYNC_API);
}

function shouldTriggerStatusSync() {
  return shouldTriggerSharedSync({ minGapMs: STATUS_SYNC_MIN_GAP_MS });
}

async function triggerStatusSync() {
  if (!shouldTriggerStatusSync()) return;
  try {
    await fetch(buildStatusApiUrl(), {
      method: "GET",
      cache: "no-store",
      keepalive: true
    });
  } catch (err) {
    console.warn("Status sync trigger failed:", err?.message || err);
  }
}

async function triggerAutoDraw() {
  try {
    await fetch(AUTO_DRAW_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "adminpanel" })
    });
  } catch (err) {
    console.warn("Auto draw trigger failed:", err?.message || err);
  }
}

function getContestById(id) {
  return allContests.find((row) => row.id === id) || null;
}

function renderRewardServiceOptions(selectedId = "") {
  if (!rewardServiceSelect) return;

  const options = ['<option value="">Select reward service</option>'];
  rewardServices.forEach((service) => {
    const selected = service.id === selectedId ? "selected" : "";
    const modeLabel = service.source === "manual" ? "Manual" : "Auto";
    const label = `[${modeLabel}] ${service.displayId} - ${service.title}`;
    options.push(`<option value="${escapeHtml(service.id)}" ${selected}>${escapeHtml(label)}</option>`);
  });

  rewardServiceSelect.innerHTML = options.join("");
}

function getSelectedRewardService() {
  const id = String(rewardServiceSelect?.value || "").trim();
  return rewardServices.find((row) => row.id === id) || null;
}

async function loadRewardServiceCatalog() {
  const map = new Map();

  try {
    const [serviceStore, manualSnap] = await Promise.all([
      readAllServiceDocsFromCollection(db, {
        includeDeleted: false
      }),
      getDocs(collection(db, "manual_services"))
    ]);

    serviceStore.rows.forEach((row) => {
      if (row.deleted === true || row.active === false) return;
      const id = String(row.panelServiceId || row.serviceId || "").trim();
      if (!id) return;

      map.set(id, {
        id,
        displayId: String(row.displayId || id).trim(),
        title: String(row.name || row.title || "Unnamed Service").trim(),
        source: "vendor"
      });
    });

    manualSnap.forEach((docSnap) => {
      const row = docSnap.data() || {};
      if (row.active === false) return;
      const id = `manual_${docSnap.id}`;
      map.set(id, {
        id,
        displayId: String(docSnap.id),
        title: String(row.title || "Manual Service").trim(),
        source: "manual"
      });
    });
  } catch (err) {
    console.warn("Reward service catalog failed:", err?.message || err);
  }

  rewardServices = Array.from(map.values()).sort((a, b) => a.title.localeCompare(b.title));
  renderRewardServiceOptions();
}

async function loadContests() {
  if (!contestsBody) return;

  try {
    const snap = await getDocs(collection(db, "prize_contests"));
    allContests = [];
    snap.forEach((row) => allContests.push({ id: row.id, ...(row.data() || {}) }));
    allContests.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    renderContests();
    renderStats();
  } catch (err) {
    console.warn("Load contests failed:", err?.message || err);
    contestsBody.innerHTML = '<tr class="empty-row"><td colspan="9">Failed to load contests.</td></tr>';
  }
}

function renderContests() {
  if (!allContests.length) {
    contestsBody.innerHTML = '<tr class="empty-row"><td colspan="9">No contests yet. Create one!</td></tr>';
    return;
  }

  contestsBody.innerHTML = allContests.map((contest) => {
    const st = statusOf(contest);
    const rewardLabel = contest.rewardServiceTitle
      ? `${contest.rewardServiceTitle} (x${Number(contest.rewardQty || 1)})`
      : "-";

    return `
      <tr data-id="${contest.id}">
        <td data-label="Title"><strong>${escapeHtml(contest.title || "-")}</strong></td>
        <td data-label="Prize">${escapeHtml(contest.prize || "-")}</td>
        <td data-label="Fee">${fmtInr(contest.fee)}</td>
        <td data-label="Winner Slots">${Number(contest.winnersCount || 1)}</td>
        <td data-label="Reward">${escapeHtml(rewardLabel)}</td>
        <td data-label="Players">${Number(contest.participantsCount || 0)}</td>
        <td data-label="Ends">${escapeHtml(fmtDateTime(contest.endsAt))}</td>
        <td data-label="Status"><span class="pa-badge ${st}">${st}</span></td>
        <td data-label="Actions" class="text-end">
          <button class="icon-btn" data-action="participants" data-id="${contest.id}" title="Participants"><i class="bi bi-people"></i></button>
          <button class="icon-btn" data-action="edit" data-id="${contest.id}" title="Edit"><i class="bi bi-pencil"></i></button>
          <button class="icon-btn danger" data-action="delete" data-id="${contest.id}" title="Delete"><i class="bi bi-trash"></i></button>
        </td>
      </tr>
    `;
  }).join("");
}

function renderStats() {
  const earnings = allContests.reduce((sum, contest) => sum + Number(contest.totalEarnings || 0), 0);
  const players = allContests.reduce((sum, contest) => sum + Number(contest.participantsCount || 0), 0);
  const active = allContests.filter((contest) => statusOf(contest) === "active").length;

  if (statEarnings) statEarnings.textContent = fmtInr(earnings);
  if (statParticipants) statParticipants.textContent = String(players);
  if (statActive) statActive.textContent = String(active);
}

async function getContestWinners(contestId) {
  const snap = await getDocs(query(
    collection(db, "prize_winners"),
    where("contestId", "==", contestId),
    limit(300)
  ));

  const rows = [];
  snap.forEach((row) => rows.push({ id: row.id, ...(row.data() || {}) }));
  rows.sort((a, b) => {
    const ar = Number(a.rank || 0);
    const br = Number(b.rank || 0);
    if (ar && br && ar !== br) return ar - br;
    return Number(a.createdAt || 0) - Number(b.createdAt || 0);
  });
  return rows;
}

async function loadWinners() {
  if (!winnersBody) return;

  try {
    const snap = await getDocs(query(
      collection(db, "prize_winners"),
      orderBy("createdAt", "desc"),
      limit(160)
    ));

    const rows = [];
    snap.forEach((row) => rows.push({ id: row.id, ...(row.data() || {}) }));

    if (!rows.length) {
      winnersBody.innerHTML = '<tr class="empty-row"><td colspan="7">No winners yet.</td></tr>';
      return;
    }

    winnersBody.innerHTML = rows.map((winner) => {
      const claimState = String(winner.claimStatus || "unclaimed").toLowerCase();
      const delivery = String(winner.delivery || "pending").toLowerCase();
      const deliveryBadge = delivery === "sent" ? "sent" : (delivery === "failed" ? "failed" : "pending");

      return `
        <tr data-id="${winner.id}">
          <td data-label="Winner"><strong>${escapeHtml(String(winner.username || "-").toUpperCase())}</strong></td>
          <td data-label="Contest">${escapeHtml(winner.contestTitle || "-")}</td>
          <td data-label="Prize">${escapeHtml(winner.prize || "-")}</td>
          <td data-label="Reward">${escapeHtml(winner.rewardServiceTitle || "-")} (x${Number(winner.rewardQty || 1)})</td>
          <td data-label="Claim"><span class="pa-badge ${claimState === "claimed" ? "sent" : "pending"}">${escapeHtml(claimState)}</span></td>
          <td data-label="Delivery"><span class="pa-badge ${deliveryBadge}">${escapeHtml(delivery)}</span></td>
          <td data-label="Action" class="text-end">
            ${delivery === "sent"
              ? '<button class="btn-send" disabled><i class="bi bi-check2"></i> Sent</button>'
              : `<button class="btn-send" data-action="mark-delivered" data-id="${winner.id}"><i class="bi bi-send"></i> Mark Sent</button>`}
          </td>
        </tr>
      `;
    }).join("");
  } catch (err) {
    console.warn("Load winners failed:", err?.message || err);
    winnersBody.innerHTML = '<tr class="empty-row"><td colspan="7">Failed to load winners.</td></tr>';
  }
}

async function loadPrizeOrders() {
  if (!ordersBody) return;

  try {
    const snap = await getDocs(query(
      collection(db, "prize_orders"),
      orderBy("createdAt", "desc"),
      limit(300)
    ));

    const rows = [];
    snap.forEach((row) => rows.push({ id: row.id, ...(row.data() || {}) }));

    const contestChargeByContest = new Map();
    rows.forEach((row) => {
      const contestId = String(row.contestId || "").trim();
      const charge = Number(row.contestCharge || 0);
      if (!contestId) return;
      if (!contestChargeByContest.has(contestId)) {
        contestChargeByContest.set(contestId, charge);
        return;
      }
      const old = Number(contestChargeByContest.get(contestId) || 0);
      if (charge > old) contestChargeByContest.set(contestId, charge);
    });

    const totalCharge = contestChargeByContest.size
      ? Array.from(contestChargeByContest.values()).reduce((sum, val) => sum + Number(val || 0), 0)
      : rows.reduce((sum, row) => sum + Number(row.contestCharge || 0), 0);
    const totalVendor = rows.reduce((sum, row) => sum + Number(row.vendorCost || 0), 0);

    if (ordersCountEl) ordersCountEl.textContent = String(rows.length);
    if (ordersChargeTotalEl) ordersChargeTotalEl.textContent = fmtInr(totalCharge);
    if (ordersVendorTotalEl) ordersVendorTotalEl.textContent = fmtInr(totalVendor);

    if (!rows.length) {
      ordersBody.innerHTML = '<tr class="empty-row"><td colspan="11">No reward orders yet.</td></tr>';
      return;
    }

    ordersBody.innerHTML = rows.map((row) => {
      const mode = String(row.mode || "manual").toLowerCase();
      const status = String(row.status || "pending").toLowerCase();
      const statusClass = status.includes("fail") ? "failed" : (status.includes("complete") ? "sent" : "pending");
      const serviceLabel = row.vendorOrderId
        ? `${row.rewardServiceTitle || "-"} (#${row.vendorOrderId})`
        : (row.rewardServiceTitle || "-");
      const rawLink = String(row.link || row.claimLink || "").trim();
      const safeLink = rawLink ? escapeHtml(rawLink) : "";
      const linkCell = safeLink
        ? `<a href="${safeLink}" target="_blank" rel="noopener noreferrer">${safeLink}</a>`
        : "-";

      return `
        <tr data-id="${row.id}">
          <td data-label="Order ID">#${escapeHtml(row.orderId || "-")}</td>
          <td data-label="Contest">${escapeHtml(row.contestTitle || "-")}</td>
          <td data-label="Winner">${escapeHtml(String(row.username || "-").toUpperCase())}</td>
          <td data-label="Link">${linkCell}</td>
          <td data-label="Service">${escapeHtml(serviceLabel)}</td>
          <td data-label="Qty">${Number(row.rewardQty || 0)}</td>
          <td data-label="Total Charge">${fmtInr(row.contestCharge || 0)}</td>
          <td data-label="Vendor Cost">${fmtInr(row.vendorCost || 0)}</td>
          <td data-label="Mode">${escapeHtml(mode)}</td>
          <td data-label="Status"><span class="pa-badge ${statusClass}">${escapeHtml(status)}</span></td>
          <td data-label="Date">${escapeHtml(fmtDateTime(row.createdAt))}</td>
        </tr>
      `;
    }).join("");
  } catch (err) {
    console.warn("Load prize orders failed:", err?.message || err);
    ordersBody.innerHTML = '<tr class="empty-row"><td colspan="11">Failed to load reward orders.</td></tr>';
  }
}

function openContestModal(contest) {
  $("contestModalTitle").textContent = contest ? "Edit Contest" : "New Contest";
  $("contestId").value = contest?.id || "";
  $("contestTitle").value = contest?.title || "";
  $("contestPrize").value = contest?.prize || "";
  $("contestFee").value = contest?.fee != null ? Number(contest.fee) : "";
  $("contestEnds").value = toLocalInputValue(contest?.endsAt || (Date.now() + 24 * 3600 * 1000));
  $("contestWinnerCount").value = contest?.winnersCount != null ? Number(contest.winnersCount) : DEFAULT_WINNERS_COUNT;
  $("contestRewardQty").value = contest?.rewardQty != null ? Number(contest.rewardQty) : DEFAULT_REWARD_QTY;

  renderRewardServiceOptions(String(contest?.rewardServiceId || "").trim());
}

contestForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const id = $("contestId").value.trim();
  const title = $("contestTitle").value.trim();
  const prize = $("contestPrize").value.trim();
  const fee = Number($("contestFee").value || 0);
  const endsLocal = $("contestEnds").value;
  const winnersCount = Math.max(1, Number($("contestWinnerCount").value || DEFAULT_WINNERS_COUNT));
  const rewardQty = Math.max(1, Number($("contestRewardQty").value || DEFAULT_REWARD_QTY));

  if (!title || !prize || !endsLocal || fee < 0) return;

  const endsAt = new Date(endsLocal).getTime();
  if (!Number.isFinite(endsAt)) return alert("Please select a valid end date and time.");

  const selectedService = getSelectedRewardService();
  if (!selectedService) return alert("Please select reward service.");

  const status = endsAt <= Date.now() ? "ended" : "active";
  const existing = id ? getContestById(id) : null;

  const payload = {
    title,
    prize,
    fee,
    endsAt,
    status,
    winnersCount,
    rewardQty,
    rewardServiceId: selectedService.id,
    rewardServiceTitle: selectedService.title,
    rewardServiceDisplayId: selectedService.displayId,
    updatedAt: Date.now()
  };

  if (!id || status === "active") {
    payload.winnersGenerated = false;
    payload.winnerCountResolved = 0;
    payload.winnerUsernames = [];
  }

  if (status === "ended" && existing?.winnersGenerated) {
    payload.winnersGenerated = true;
    payload.winnerCountResolved = Number(existing.winnerCountResolved || 0);
    payload.winnerUsernames = Array.isArray(existing.winnerUsernames) ? existing.winnerUsernames : [];
  }

  try {
    if (id) {
      await updateDoc(doc(db, "prize_contests", id), payload);
    } else {
      await addDoc(collection(db, "prize_contests"), {
        ...payload,
        participantsCount: 0,
        totalEarnings: 0,
        createdAt: Date.now(),
        createdAtTs: serverTimestamp()
      });
    }

    bootstrap.Modal.getInstance($("contestModal"))?.hide();
    await triggerAutoDraw();
    await Promise.allSettled([loadContests(), loadWinners(), loadPrizeOrders()]);
  } catch (err) {
    console.warn("Save contest failed:", err?.message || err);
    alert("Could not save contest.");
  }
});

async function deleteContest(id) {
  if (!id) return;
  if (!confirm("Delete this contest? Participants and winners will be removed.")) return;

  try {
    const [participantSnap, winnerSnap] = await Promise.all([
      getDocs(query(collection(db, "prize_participants"), where("contestId", "==", id))),
      getDocs(query(collection(db, "prize_winners"), where("contestId", "==", id)))
    ]);

    await Promise.all(participantSnap.docs.map((row) => deleteDoc(row.ref)));
    await Promise.all(winnerSnap.docs.map((row) => deleteDoc(row.ref)));
    await deleteDoc(doc(db, "prize_contests", id));

    await Promise.allSettled([loadContests(), loadWinners(), loadPrizeOrders()]);
  } catch (err) {
    console.warn("Delete contest failed:", err?.message || err);
    alert("Could not delete contest.");
  }
}

function renderWinnerSummaryHtml(winners) {
  if (!winners.length) {
    return '<div class="text-muted small mb-3">No winners selected yet.</div>';
  }

  return `
    <div class="alert alert-success py-2 mb-3">
      <strong>Selected Winners (${winners.length})</strong><br>
      ${winners.map((winner, index) => `#${Number(winner.rank || index + 1)} ${escapeHtml(String(winner.username || "-").toUpperCase())}`).join(" • ")}
    </div>
  `;
}

async function openParticipantsModal(contestId) {
  const contest = getContestById(contestId);
  if (!contest) return;

  participantsContestTitle.textContent = `${contest.title} • ${contest.prize}`;
  participantsListEl.innerHTML = "Loading...";
  bootstrap.Modal.getOrCreateInstance($("participantsModal")).show();

  try {
    const [winnerRows, participantSnap] = await Promise.all([
      getContestWinners(contestId),
      getDocs(query(collection(db, "prize_participants"), where("contestId", "==", contestId)))
    ]);

    const participants = [];
    participantSnap.forEach((row) => participants.push({ id: row.id, ...(row.data() || {}) }));
    participants.sort((a, b) => Number(b.joinedAt || 0) - Number(a.joinedAt || 0));

    const maxWinners = Math.max(1, Number(contest.winnersCount || 1));
    const winnerKeys = new Set(winnerRows.map((winner) => normalizeUsername(winner.username)));
    const canPickMore = winnerRows.length < maxWinners;

    if (!participants.length) {
      participantsListEl.innerHTML = `
        ${renderWinnerSummaryHtml(winnerRows)}
        <div class="text-center text-muted py-4">No participants yet.</div>
      `;
      return;
    }

    participantsListEl.innerHTML = `
      ${renderWinnerSummaryHtml(winnerRows)}
      <div class="d-flex justify-content-between align-items-center mb-3">
        <strong>${participants.length} participant${participants.length > 1 ? "s" : ""}</strong>
        <button type="button" class="btn-new" data-action="random-winner" data-id="${contestId}" ${canPickMore ? "" : "disabled"}>
          <i class="bi bi-shuffle"></i> Pick Random Winner
        </button>
      </div>
      <div class="table-responsive">
        <table class="pa-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Fee</th>
              <th>Joined</th>
              <th class="text-end">Action</th>
            </tr>
          </thead>
          <tbody>
            ${participants.map((participant) => {
              const username = String(participant.username || "").trim();
              const isWinner = winnerKeys.has(normalizeUsername(username));
              const disabled = isWinner || !canPickMore;
              return `
                <tr>
                  <td><strong>${escapeHtml(username || "-")}</strong></td>
                  <td>${fmtInr(participant.fee)}</td>
                  <td>${escapeHtml(fmtDateTime(participant.joinedAt))}</td>
                  <td class="text-end">
                    <button
                      class="btn-send"
                      data-action="pick-winner"
                      data-contest="${contestId}"
                      data-user="${escapeHtml(username)}"
                      ${disabled ? "disabled" : ""}
                    >
                      ${isWinner ? '<i class="bi bi-check2"></i> Winner' : '<i class="bi bi-trophy"></i> Make Winner'}
                    </button>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    console.warn("Load participants failed:", err?.message || err);
    participantsListEl.innerHTML = '<div class="text-danger text-center py-4">Failed to load participants.</div>';
  }
}

async function pickWinner(contestId, username) {
  const contest = getContestById(contestId);
  const cleanUsername = String(username || "").trim();
  if (!contest || !cleanUsername) return;

  try {
    const [participantSnap, winnerRows] = await Promise.all([
      getDocs(query(collection(db, "prize_participants"), where("contestId", "==", contestId))),
      getContestWinners(contestId)
    ]);

    const hasParticipant = participantSnap.docs.some((row) => {
      const uname = String(row.data()?.username || "").trim();
      return normalizeUsername(uname) === normalizeUsername(cleanUsername);
    });

    if (!hasParticipant) {
      alert("Selected user is not a participant anymore.");
      return;
    }

    const maxWinners = Math.max(1, Number(contest.winnersCount || 1));
    const alreadyWinner = winnerRows.some((row) => normalizeUsername(row.username) === normalizeUsername(cleanUsername));

    if (alreadyWinner) {
      alert("This participant is already selected as winner.");
      return;
    }

    if (winnerRows.length >= maxWinners) {
      alert(`Winner slots already full (${maxWinners}).`);
      return;
    }

    const refLink = prompt(`Optional note/link for ${cleanUsername}:`, "");
    if (refLink == null) return;

    const rank = winnerRows.length + 1;
    const now = Date.now();
    const configuredDeadline = Number(contest.claimDeadlineAt || 0);
    const deadlineAt = configuredDeadline > now ? configuredDeadline : (now + CLAIM_WINDOW_MS);

    const winnerRef = doc(db, "prize_winners", winnerDocId(contestId, cleanUsername));
    await setDoc(winnerRef, {
      contestId,
      contestTitle: contest.title || "",
      username: cleanUsername,
      usernameKey: normalizeUsername(cleanUsername),
      prize: contest.prize || "Reward",
      rewardServiceId: contest.rewardServiceId || "contest_reward",
      rewardServiceTitle: contest.rewardServiceTitle || contest.prize || "Reward",
      rewardServiceDisplayId: contest.rewardServiceDisplayId || "",
      rewardQty: Math.max(1, Number(contest.rewardQty || 1)),
      rank,
      winnersCount: maxWinners,
      link: String(refLink || "").trim(),
      source: "admin_manual",
      claimStatus: "unclaimed",
      claimDeadlineAt: deadlineAt,
      delivery: "pending",
      createdAt: now,
      createdAtTs: serverTimestamp(),
      updatedAt: now
    }, { merge: true });

    const nextResolved = rank;
    await updateDoc(doc(db, "prize_contests", contestId), {
      status: "ended",
      winnersGenerated: nextResolved >= maxWinners,
      winnerCountResolved: nextResolved,
      updatedAt: Date.now()
    });

    await Promise.allSettled([
      loadContests(),
      loadWinners(),
      openParticipantsModal(contestId),
      loadPrizeOrders()
    ]);
  } catch (err) {
    console.warn("Pick winner failed:", err?.message || err);
    alert("Could not save winner.");
  }
}

async function pickRandomWinner(contestId) {
  const contest = getContestById(contestId);
  if (!contest) return;

  try {
    const [participantSnap, winnerRows] = await Promise.all([
      getDocs(query(collection(db, "prize_participants"), where("contestId", "==", contestId))),
      getContestWinners(contestId)
    ]);

    const winnerSet = new Set(winnerRows.map((row) => normalizeUsername(row.username)));
    const candidates = [];
    participantSnap.forEach((row) => {
      const username = String(row.data()?.username || "").trim();
      if (!username) return;
      if (winnerSet.has(normalizeUsername(username))) return;
      candidates.push(username);
    });

    if (!candidates.length) {
      alert("No eligible participants left to pick.");
      return;
    }

    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    await pickWinner(contestId, picked);
  } catch (err) {
    console.warn("Random pick failed:", err?.message || err);
    alert("Could not pick random winner.");
  }
}

async function markWinnerDelivered(winnerId) {
  if (!winnerId) return;
  if (!confirm("Mark this winner reward as delivered?")) return;

  try {
    await updateDoc(doc(db, "prize_winners", winnerId), {
      delivery: "sent",
      deliveredAt: Date.now(),
      updatedAt: Date.now()
    });

    await loadWinners();
  } catch (err) {
    console.warn("Update delivery failed:", err?.message || err);
    alert("Could not update winner delivery.");
  }
}

async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, "prize_settings", "main"));
    const settings = snap.exists() ? (snap.data() || {}) : {};
    $("settingHeroPill").value = settings.heroPill || "Prize Pool Arena";
    $("settingHeroTitle").value = settings.heroTitle || "Win Free Followers / Views Daily";
    $("settingHeroSubtitle").value = settings.heroSubtitle || "Join with \u20B91 and win big prizes in 24 hours";
  } catch (err) {
    console.warn("Settings load failed:", err?.message || err);
  }
}

settingsForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await setDoc(doc(db, "prize_settings", "main"), {
      heroPill: $("settingHeroPill").value.trim(),
      heroTitle: $("settingHeroTitle").value.trim(),
      heroSubtitle: $("settingHeroSubtitle").value.trim(),
      updatedAt: Date.now()
    }, { merge: true });

    bootstrap.Modal.getInstance($("settingsModal"))?.hide();
  } catch (err) {
    console.warn("Save settings failed:", err?.message || err);
    alert("Could not save settings.");
  }
});

document.addEventListener("click", (event) => {
  const tabBtn = event.target.closest("[data-pa-tab]");
  if (tabBtn) {
    switchTab(tabBtn.getAttribute("data-pa-tab"));
    return;
  }

  const btn = event.target.closest("[data-action]");
  if (!btn) return;

  const action = btn.getAttribute("data-action");
  const id = btn.getAttribute("data-id");

  if (action === "edit") {
    openContestModal(getContestById(id));
    bootstrap.Modal.getOrCreateInstance($("contestModal")).show();
  } else if (action === "delete") {
    deleteContest(id);
  } else if (action === "participants") {
    openParticipantsModal(id);
  } else if (action === "pick-winner") {
    pickWinner(btn.getAttribute("data-contest"), btn.getAttribute("data-user"));
  } else if (action === "random-winner") {
    pickRandomWinner(id);
  } else if (action === "mark-delivered") {
    markWinnerDelivered(id);
  }
});

$("btnNewContest")?.addEventListener("click", () => openContestModal(null));
bindAdminLogout("btnLogout");

(async function init() {
  initAdminSidebar();
  switchTab("contests");

  await triggerStatusSync();
  await loadRewardServiceCatalog();
  await triggerAutoDraw();

  await Promise.allSettled([
    loadContests(),
    loadWinners(),
    loadPrizeOrders(),
    loadSettings()
  ]);

  setInterval(() => {
    loadPrizeOrders();
    loadWinners();
  }, 30000);
})();


