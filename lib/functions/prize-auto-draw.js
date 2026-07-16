const admin = require("firebase-admin");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};

if (!admin.apps.length) {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    })
  });
}

const db = admin.firestore();
const { FieldValue } = admin.firestore;
const CLAIM_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;

function respond(statusCode, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body)
  };
}

function normalizeUsername(name) {
  return String(name || "").trim().toLowerCase();
}

function winnerDocId(contestId, username) {
  const c = String(contestId || "").trim();
  const u = normalizeUsername(username).replace(/[^a-z0-9_-]/g, "_") || "winner";
  return `${c}__${u}`;
}

function randomPick(array, count) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = copy[i];
    copy[i] = copy[j];
    copy[j] = temp;
  }
  return copy.slice(0, count);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return respond(405, { error: "Method Not Allowed" });
  }

  try {
    const now = Date.now();
    const contestSnap = await db.collection("prize_contests").get();

    let scanned = 0;
    let finalized = 0;
    let generatedWinners = 0;

    for (const contestDoc of contestSnap.docs) {
      const contest = contestDoc.data() || {};
      const endsAt = Number(contest.endsAt || 0);
      if (!endsAt || endsAt > now) continue;

      const status = String(contest.status || "active").toLowerCase();
      const needsFinalization = status === "active" || contest.winnersGenerated !== true;
      if (!needsFinalization) continue;

      scanned += 1;

      const winnerSnap = await db
        .collection("prize_winners")
        .where("contestId", "==", contestDoc.id)
        .get();

      const existingWinners = [];
      winnerSnap.forEach((row) => {
        const data = row.data() || {};
        const username = String(data.username || "").trim();
        if (username) existingWinners.push(username);
      });

      if (existingWinners.length) {
        await contestDoc.ref.set({
          status: "ended",
          winnersGenerated: true,
          winnerCountResolved: existingWinners.length,
          winnerUsernames: existingWinners,
          winnersResolvedAt: now,
          updatedAt: now
        }, { merge: true });
        finalized += 1;
        continue;
      }

      const participantSnap = await db
        .collection("prize_participants")
        .where("contestId", "==", contestDoc.id)
        .get();

      const participantMap = new Map();
      participantSnap.forEach((row) => {
        const data = row.data() || {};
        const username = String(data.username || "").trim();
        const key = normalizeUsername(username);
        if (!username || !key) return;
        if (!participantMap.has(key)) participantMap.set(key, username);
      });

      const participants = Array.from(participantMap.values());
      const winnerSlots = Math.max(1, Number(contest.winnersCount || 1));
      const winnerCount = Math.min(winnerSlots, participants.length);

      if (!winnerCount) {
        await contestDoc.ref.set({
          status: "ended",
          winnersGenerated: true,
          winnerCountResolved: 0,
          winnerUsernames: [],
          winnersResolvedAt: now,
          updatedAt: now
        }, { merge: true });
        finalized += 1;
        continue;
      }

      const picked = randomPick(participants, winnerCount);
      const batch = db.batch();

      const rewardServiceId = String(contest.rewardServiceId || "").trim();
      const rewardServiceTitle = String(contest.rewardServiceTitle || contest.prize || "Reward").trim();
      const rewardServiceDisplayId = String(contest.rewardServiceDisplayId || rewardServiceId).trim();
      const rewardQty = Math.max(1, Number(contest.rewardQty || 1));
      const configuredDeadline = Number(contest.claimDeadlineAt || 0);
      const deadlineAt = configuredDeadline > now ? configuredDeadline : (now + CLAIM_WINDOW_MS);

      picked.forEach((username, index) => {
        const docId = winnerDocId(contestDoc.id, username);
        const winnerRef = db.collection("prize_winners").doc(docId);

        batch.set(winnerRef, {
          contestId: contestDoc.id,
          contestTitle: String(contest.title || "").trim(),
          username,
          usernameKey: normalizeUsername(username),
          prize: String(contest.prize || "Reward").trim(),
          rewardServiceId,
          rewardServiceTitle,
          rewardServiceDisplayId,
          rewardQty,
          rank: index + 1,
          winnersCount: winnerSlots,
          source: "auto_draw",
          claimStatus: "unclaimed",
          claimDeadlineAt: deadlineAt,
          delivery: "pending",
          createdAt: now + index,
          createdAtTs: FieldValue.serverTimestamp(),
          updatedAt: now
        }, { merge: true });
      });

      batch.set(contestDoc.ref, {
        status: "ended",
        winnersGenerated: true,
        winnerCountResolved: picked.length,
        winnerUsernames: picked,
        winnersResolvedAt: now,
        updatedAt: now
      }, { merge: true });

      await batch.commit();
      finalized += 1;
      generatedWinners += picked.length;
    }

    return respond(200, {
      success: true,
      scanned,
      finalized,
      generatedWinners
    });
  } catch (err) {
    console.error("prize-auto-draw failed:", err);
    return respond(500, {
      success: false,
      error: err?.message || "Internal server error"
    });
  }
};
