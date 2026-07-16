import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  requireAdminAuth,
  initAdminSidebar,
  bindAdminLogout
} from "./admin-ui-common.js";

requireAdminAuth();
initAdminSidebar({ closeOnOutsideClick: true });

const broadcastForm = document.getElementById("broadcastForm");
const broadcastTitle = document.getElementById("broadcastTitle");
const broadcastMessage = document.getElementById("broadcastMessage");
const broadcastType = document.getElementById("broadcastType");
const broadcastIcon = document.getElementById("broadcastIcon");
const broadcastIconPreview = document.getElementById("broadcastIconPreview");
const broadcastPriority = document.getElementById("broadcastPriority");
const broadcastStatus = document.getElementById("broadcastStatus");
const broadcastExpiry = document.getElementById("broadcastExpiry");
const broadcastConfirmText = document.getElementById("broadcastConfirmText");
const broadcastCtaText = document.getElementById("broadcastCtaText");
const broadcastConfirmColor = document.getElementById("broadcastConfirmColor");
const broadcastTarget = document.getElementById("broadcastTarget");
const broadcastPaths = document.getElementById("broadcastPaths");
const broadcastEditor = document.getElementById("broadcastEditor");
const broadcastSaveBtn = document.getElementById("broadcastSaveBtn");
const broadcastClearBtn = document.getElementById("broadcastClearBtn");
const broadcastSearch = document.getElementById("broadcastSearch");
const broadcastCount = document.getElementById("broadcastCount");
const broadcastTableBody = document.getElementById("broadcastTableBody");

let broadcasts = [];
let editId = "";

function dateToEndMs(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function fmtDate(v) {
  if (!v) return "-";
  if (typeof v === "number") return new Date(v).toLocaleString("en-IN");
  if (v.toDate) return v.toDate().toLocaleString("en-IN");
  if (v.seconds) return new Date(Number(v.seconds) * 1000).toLocaleString("en-IN");
  return String(v);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeType(value) {
  const t = String(value || "").trim().toLowerCase();
  if (t === "broadcast" || t === "popup") return "broadcast";
  return "announcement";
}

function typeLabel(value) {
  return normalizeType(value) === "broadcast" ? "Broadcast Popup" : "Announcement";
}

function plainText(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html || "";
  return tmp.textContent || tmp.innerText || "";
}

function extractUrl(text) {
  const msg = String(text || "");
  const http = msg.match(/https?:\/\/[^\s]+/i);
  if (http) return http[0];
  const wa = msg.match(/wa\.me\/\S+/i);
  if (wa) return `https://${wa[0]}`;
  return "";
}

function normalizeUrl(url) {
  let u = String(url || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return u;
  if (u.startsWith("wa.me/")) return `https://${u}`;
  if (u.startsWith("www.")) return `https://${u}`;
  if (u.includes("/")) return `/${u.replace(/^\/+/, "")}`;
  if (u.includes(".")) return `https://${u}`;
  return `/${u.replace(/^\/+/, "")}`;
}

function extractUrlFromHtml(messageHtml, rawText) {
  const html = String(messageHtml || "");
  if (html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const a = tmp.querySelector("a[href]");
    if (a) {
      const href = a.getAttribute("href");
      if (href) return normalizeUrl(href);
    }
  }
  return normalizeUrl(extractUrl(rawText));
}

let savedRange = null;
function saveSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !broadcastEditor) return;
  const range = sel.getRangeAt(0);
  if (broadcastEditor.contains(range.commonAncestorContainer)) {
    savedRange = range;
  }
}

function restoreSelection() {
  if (!savedRange) return;
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(savedRange);
}

function execEditorCommand(cmd) {
  if (!broadcastEditor) return;
  restoreSelection();
  broadcastEditor.focus();
  if (cmd === "createLink") {
    const url = normalizeUrl(prompt("Enter URL"));
    if (!url) return;
    const sel = window.getSelection();
    const isCollapsed = !sel || sel.rangeCount === 0 || sel.isCollapsed;
    if (isCollapsed) {
      const safeUrl = url.replace(/"/g, "&quot;");
      document.execCommand(
        "insertHTML",
        false,
        `<a href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a>`
      );
    } else {
      document.execCommand("createLink", false, url);
      const link = broadcastEditor.querySelector("a[href]:not([target])");
      if (link) {
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener");
      }
    }
    return;
  }
  document.execCommand(cmd, false, null);
}

if (broadcastEditor) {
  document.querySelectorAll(".broadcast-editor-toolbar [data-cmd]").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => execEditorCommand(btn.dataset.cmd));
  });
  ["keyup", "mouseup", "mouseout", "input", "touchend"].forEach((evt) => {
    broadcastEditor.addEventListener(evt, saveSelection);
  });
}


function resetForm() {
  editId = "";
  if (broadcastForm) broadcastForm.reset();
  if (broadcastType) broadcastType.value = "broadcast";
  if (broadcastIcon) broadcastIcon.value = "none";
  updateIconPreview();
  if (broadcastPriority) broadcastPriority.value = 1;
  if (broadcastStatus) broadcastStatus.value = "active";
  if (broadcastConfirmText) broadcastConfirmText.value = "Okay!";
  if (broadcastCtaText) broadcastCtaText.value = "";
  if (broadcastConfirmColor) broadcastConfirmColor.value = "#000000";
  if (broadcastTarget) broadcastTarget.value = "all";
  if (broadcastPaths) broadcastPaths.selectedIndex = 0;
  if (broadcastEditor) broadcastEditor.innerHTML = "";
  if (broadcastSaveBtn) broadcastSaveBtn.innerHTML = `<i class="bi bi-check-lg"></i> Save Broadcast`;
  updateIconPreview();
}

function iconClass(value) {
  const v = String(value || "").toLowerCase();
  if (v === "info") return "bi-info-circle";
  if (v === "warning") return "bi-exclamation-triangle";
  if (v === "success") return "bi-check-circle";
  if (v === "error") return "bi-x-circle";
  if (v === "whatsapp") return "bi-whatsapp";
  if (v === "telegram") return "bi-telegram";
  return "bi-megaphone";
}

function updateIconPreview() {
  if (!broadcastIconPreview || !broadcastIcon) return;
  const cls = iconClass(broadcastIcon.value);
  broadcastIconPreview.innerHTML = `<i class="bi ${cls}"></i>`;
}

if (broadcastIcon) {
  broadcastIcon.addEventListener("change", updateIconPreview);
}

async function loadBroadcasts() {
  if (!broadcastTableBody) return;
  const snap = await getDocs(collection(db, "broadcasts"));
  broadcasts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  broadcasts.sort((a, b) => {
    const pa = Number(a.priority || 0);
    const pb = Number(b.priority || 0);
    if (pb !== pa) return pb - pa;
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });
  renderBroadcasts();
}

function renderBroadcasts() {
  if (!broadcastTableBody) return;
  const term = String(broadcastSearch?.value || "").trim().toLowerCase();
  const filtered = broadcasts.filter((b) => {
    const hay = `${b.title || ""} ${b.message || ""} ${typeLabel(b.type)}`.toLowerCase();
    return !term || hay.includes(term);
  });

  if (broadcastCount) broadcastCount.textContent = filtered.length;

  if (!filtered.length) {
    broadcastTableBody.innerHTML = `<tr><td colspan="9" class="text-center text-muted py-4">No broadcasts found.</td></tr>`;
    return;
  }

  broadcastTableBody.innerHTML = filtered.map((b) => {
    const active = b.active !== false;
    const title = escapeHtml(b.title || "(untitled)");
    const msg = escapeHtml(b.messageText || b.message || "");
    const shortMsg = msg.length > 120 ? `${msg.slice(0, 120)}...` : msg;
    const type = typeLabel(b.type);
    const status = active ? "Active" : "Inactive";
    const target = b.targetUsers || "all";
    const expiry = fmtDate(b.endAt);
    return `
      <tr>
        <td>
          <div class="form-check d-flex justify-content-center">
            <input type="checkbox" class="form-check-input bc-active" data-id="${b.id}" ${active ? "checked" : ""}>
          </div>
        </td>
        <td title="${title}"><div class="text-truncate" style="max-width:180px;">${title}</div></td>
        <td title="${msg}"><div class="text-truncate" style="max-width:280px;">${shortMsg}</div></td>
        <td><span class="badge bg-light text-dark border">${type}</span></td>
        <td><span class="badge ${active ? "bg-success" : "bg-secondary"}">${status}</span></td>
        <td><small>${expiry}</small></td>
        <td><small>${escapeHtml(target)}</small></td>
        <td><small>${fmtDate(b.updatedAt || b.createdAt)}</small></td>
        <td class="text-end">
          <button class="btn btn-sm btn-light border bc-edit" data-id="${b.id}"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-light border text-danger bc-delete" data-id="${b.id}"><i class="bi bi-trash"></i></button>
        </td>
      </tr>
    `;
  }).join("");
}

if (broadcastSearch) {
  broadcastSearch.addEventListener("input", () => renderBroadcasts());
}

if (broadcastForm) {
  broadcastForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const title = broadcastTitle?.value.trim();
    const messageHtml = String(broadcastEditor?.innerHTML || "").trim();
    const rawText = plainText(messageHtml).trim();
    const ctaUrl = extractUrlFromHtml(messageHtml, rawText);
    const messageText = rawText.replace(/https?:\/\/[^\s]+/gi, "").replace(/wa\.me\/\S+/gi, "").trim() || rawText;
    const ctaTextInput = String(broadcastCtaText?.value || "").trim();
    const ctaLabel = ctaTextInput || (ctaUrl.toLowerCase().includes("wa.me") || ctaUrl.toLowerCase().includes("whatsapp")
      ? "Join"
      : "Open");
    const type = normalizeType(broadcastType?.value);
    const priority = Number(broadcastPriority?.value || 0);
    const active = broadcastStatus ? broadcastStatus.value === "active" : true;
    const endAt = dateToEndMs(broadcastExpiry?.value);
    const iconType = String(broadcastIcon?.value || "none").toLowerCase();
    const confirmText = String(broadcastConfirmText?.value || "Okay!").trim();
    const confirmColor = String(broadcastConfirmColor?.value || "#000000").trim();
    const targetUsers = String(broadcastTarget?.value || "all").trim();
    const paths = Array.from(broadcastPaths?.selectedOptions || []).map((o) => o.value).filter(Boolean);

    if (!title || !messageText) return alert("Title and description are required.");

    if (broadcastSaveBtn) broadcastSaveBtn.textContent = "Saving...";

    try {
      const docRef = editId
        ? doc(db, "broadcasts", editId)
        : doc(collection(db, "broadcasts"));

      const payload = {
        title,
        message: messageHtml,
        messageText,
        type,
        priority,
        active,
        startAt: null,
        endAt: endAt || null,
        iconType,
        confirmText,
        confirmColor,
        targetUsers,
        paths,
        ctaUrl: ctaUrl || null,
        ctaLabel: ctaUrl ? ctaLabel : null,
        updatedAt: serverTimestamp(),
      };

      if (editId) {
        await updateDoc(docRef, payload);
        alert("Announcement updated!");
      } else {
        await setDoc(docRef, {
          ...payload,
          createdAt: Date.now(),
        });
        alert("Announcement created!");
      }

      resetForm();
      await loadBroadcasts();
    } catch (err) {
      alert("Error: " + err.message);
    } finally {
      if (broadcastSaveBtn) {
        broadcastSaveBtn.innerHTML = `<i class="bi bi-check-lg"></i> Save Broadcast`;
      }
    }
  });
}

if (broadcastClearBtn) {
  broadcastClearBtn.addEventListener("click", () => resetForm());
}

if (broadcastTableBody) {
  broadcastTableBody.addEventListener("click", async (e) => {
    const editBtn = e.target.closest(".bc-edit");
    const delBtn = e.target.closest(".bc-delete");

    if (editBtn) {
      const id = editBtn.getAttribute("data-id");
      const bc = broadcasts.find((b) => b.id === id);
      if (!bc) return;
      editId = id;
      if (broadcastTitle) broadcastTitle.value = bc.title || "";
      if (broadcastEditor) broadcastEditor.innerHTML = bc.message || "";
      if (broadcastType) broadcastType.value = normalizeType(bc.type);
      if (broadcastIcon) broadcastIcon.value = String(bc.iconType || "none").toLowerCase();
      updateIconPreview();
      if (broadcastPriority) broadcastPriority.value = Number(bc.priority || 0);
      if (broadcastStatus) broadcastStatus.value = bc.active === false ? "inactive" : "active";
      if (broadcastExpiry) {
        const d = bc.endAt ? new Date(Number(bc.endAt)) : null;
        broadcastExpiry.value = d ? d.toISOString().slice(0, 10) : "";
      }
      if (broadcastConfirmText) broadcastConfirmText.value = bc.confirmText || "Okay!";
      if (broadcastCtaText) broadcastCtaText.value = bc.ctaLabel || "";
      if (broadcastConfirmColor) broadcastConfirmColor.value = bc.confirmColor || "#000000";
      if (broadcastTarget) broadcastTarget.value = bc.targetUsers || "all";
      if (broadcastPaths && Array.isArray(bc.paths)) {
        bc.paths.forEach((p) => {
          const exists = Array.from(broadcastPaths.options).some((opt) => opt.value === p);
          if (!exists) {
            const opt = document.createElement("option");
            opt.value = p;
            opt.textContent = p;
            broadcastPaths.appendChild(opt);
          }
        });
        Array.from(broadcastPaths.options).forEach((opt) => {
          opt.selected = bc.paths.includes(opt.value);
        });
      }
      if (broadcastSaveBtn) broadcastSaveBtn.textContent = "Update Broadcast";
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    if (delBtn) {
      const id = delBtn.getAttribute("data-id");
      if (!confirm("Delete this announcement?")) return;
      try {
        await deleteDoc(doc(db, "broadcasts", id));
        await loadBroadcasts();
      } catch (err) {
        alert("Error: " + err.message);
      }
    }
  });

  broadcastTableBody.addEventListener("change", async (e) => {
    const chk = e.target;
    if (!chk.classList.contains("bc-active")) return;
    const id = chk.getAttribute("data-id");
    try {
      await updateDoc(doc(db, "broadcasts", id), {
        active: chk.checked,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      alert("Error: " + err.message);
    }
  });
}

bindAdminLogout("btnLogout");

loadBroadcasts();

