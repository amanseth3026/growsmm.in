import { db } from "./firebase.js";
import {
  mergeCategoryOrder,
  readCachedCategoryOrder,
  writeCategoryOrderCache
} from "../category-order.js";
import {
  getDoc,
  doc,
  setDoc,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  SERVICE_COLLECTION_ID,
  readAllServiceDocsFromCollection,
  normalizeServiceRecord
} from "../scripts/services-collection.js";
import {
  requireAdminAuth,
  initAdminSidebar,
  bindAdminLogout
} from "./admin-ui-common.js";

requireAdminAuth();

const $ = (id) => document.getElementById(id);
const CATEGORY_REGISTRY_DOC_ID = "service_categories";

let allCategoryRows = [];
let serviceRows = [];
let manualCategoryRegistry = [];
let draggedCategoryName = "";
let dragScrollFrame = null;
let categoryActionState = {
  category: "",
  trigger: null
};

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeCategory(value) {
  const clean = String(value || "").trim();
  return clean || "General";
}

function normalizeManualCategoryInput(value) {
  return String(value || "").trim();
}

function categoryKey(value) {
  return normalizeCategory(value).toLowerCase();
}

function uniqueCategoryNames(values = []) {
  const map = new Map();
  values.forEach((value) => {
    const clean = normalizeManualCategoryInput(value);
    if (!clean) return;
    const key = clean.toLowerCase();
    if (!map.has(key)) {
      map.set(key, clean);
    }
  });
  return Array.from(map.values());
}

function getServiceRowsForCategories(categoryNames = []) {
  if (!Array.isArray(categoryNames) || !categoryNames.length) return [];
  const selectedKeys = new Set(categoryNames.map((value) => categoryKey(value)));
  return serviceRows.filter((row) => selectedKeys.has(categoryKey(row.data.category)));
}

function hydrateServiceRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const normalized = normalizeServiceRecord(
        row || {},
        row?.docId || row?.panelServiceId || row?.serviceId || ""
      );
      if (!normalized) return null;
      if (normalized.deleted === true) return null;
      return {
        docId: normalized.serviceId,
        data: normalized
      };
    })
    .filter(Boolean);
}

async function loadManualCategoryRegistry() {
  manualCategoryRegistry = [];
  const cached = readCachedCategoryOrder();
  if (cached) {
    manualCategoryRegistry = uniqueCategoryNames(cached);
    return;
  }

  try {
    const snap = await getDoc(doc(db, "meta", CATEGORY_REGISTRY_DOC_ID));
    if (!snap.exists()) return;
    const saved = snap.data()?.categories;
    if (!Array.isArray(saved)) return;
    manualCategoryRegistry = uniqueCategoryNames(saved);
    writeCategoryOrderCache(manualCategoryRegistry);
  } catch (err) {
    console.warn("Category registry load failed:", err);
  }
}

async function saveManualCategoryRegistry(categoryNames = []) {
  manualCategoryRegistry = uniqueCategoryNames(categoryNames);
  await setDoc(doc(db, "meta", CATEGORY_REGISTRY_DOC_ID), {
    categories: manualCategoryRegistry,
    updatedAt: serverTimestamp()
  }, { merge: true });
  writeCategoryOrderCache(manualCategoryRegistry);
}

async function rebuildServiceStoreDocs() {
  return;
}

async function chunkedServiceUpdates(docsToUpdate, payloadBuilder) {
  if (!docsToUpdate.length) return;

  const chunkSize = 400;
  for (let index = 0; index < docsToUpdate.length; index += chunkSize) {
    const chunk = docsToUpdate.slice(index, index + chunkSize);
    const batch = writeBatch(db);

    chunk.forEach((row) => {
      const payload = payloadBuilder(row) || {};
      const serviceId = String(row.docId || row.data?.panelServiceId || row.data?.serviceId || "").trim();
      if (!serviceId) return;

      const nextData = {
        ...(row.data || {}),
        ...payload,
        panelServiceId: serviceId,
        serviceId,
        active: payload?.active !== undefined ? payload.active !== false : row.data?.active !== false,
        updatedAt: serverTimestamp()
      };

      row.data = nextData;
      batch.set(doc(db, SERVICE_COLLECTION_ID, serviceId), nextData, { merge: true });
    });

    await batch.commit();
  }
}

function buildCategoryRows() {
  const grouped = new Map();

  serviceRows.forEach((row) => {
    const categoryName = normalizeCategory(row.data.category);
    const key = categoryKey(categoryName);

    if (!grouped.has(key)) {
      grouped.set(key, {
        category: categoryName,
        total: 0,
        active: 0,
        docs: []
      });
    }

    const group = grouped.get(key);
    group.total += 1;
    if (row.data.active !== false) group.active += 1;
    group.docs.push(row);
  });

  manualCategoryRegistry.forEach((categoryName) => {
    const key = categoryKey(categoryName);
    if (!grouped.has(key)) {
      grouped.set(key, {
        category: normalizeCategory(categoryName),
        total: 0,
        active: 0,
        docs: []
      });
    }
  });

  const orderedCategoryNames = mergeCategoryOrder(
    manualCategoryRegistry,
    Array.from(grouped.values()).map((row) => row.category)
  );

  manualCategoryRegistry = orderedCategoryNames;
  allCategoryRows = orderedCategoryNames.map((categoryName) => {
    const key = categoryKey(categoryName);
    return grouped.get(key) || {
      category: normalizeCategory(categoryName),
      total: 0,
      active: 0,
      docs: []
    };
  });
}

function getCategoryStatusBadge(row) {
  if (row.total === 0) {
    return '<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle">Empty</span>';
  }
  if (row.active === 0) {
    return '<span class="badge bg-danger-subtle text-danger border border-danger-subtle">Disabled</span>';
  }
  if (row.active === row.total) {
    return '<span class="badge bg-success-subtle text-success border border-success-subtle">Enabled</span>';
  }
  return '<span class="badge bg-warning-subtle text-warning border border-warning-subtle">Partial</span>';
}

function getCategoryRowIndex(categoryName) {
  return allCategoryRows.findIndex((row) => categoryKey(row.category) === categoryKey(categoryName));
}

function getCategoryRowData(categoryName) {
  return allCategoryRows.find((row) => categoryKey(row.category) === categoryKey(categoryName)) || null;
}

function isDeletableEmptyCategory(row) {
  if (!row) return false;
  if (categoryKey(row.category) === "general") return false;
  return Number(row.total || 0) === 0 || Number(row.active || 0) === 0;
}

function closeCategoryActionMenu() {
  const menu = $("categoryActionMenu");
  if (!menu) return;
  if (categoryActionState.trigger) {
    categoryActionState.trigger.setAttribute("aria-expanded", "false");
  }
  menu.classList.add("d-none");
  menu.style.top = "";
  menu.style.left = "";
  menu.style.visibility = "";
  menu.setAttribute("aria-hidden", "true");
  categoryActionState = { category: "", trigger: null };
}

function updateCategoryActionMenuButtons(categoryName) {
  const menu = $("categoryActionMenu");
  if (!menu) return;

  const rowIndex = getCategoryRowIndex(categoryName);
  const rowData = getCategoryRowData(categoryName);
  const isGeneral = categoryKey(categoryName) === "general";

  menu.querySelectorAll("[data-action]").forEach((button) => {
    const action = String(button.getAttribute("data-action") || "").trim();
    button.disabled = false;

    if (action === "move-up" && rowIndex <= 0) button.disabled = true;
    if (action === "move-down" && rowIndex >= allCategoryRows.length - 1) button.disabled = true;
    if (action === "delete" && isGeneral) button.disabled = true;

    if (action === "enable" && rowData?.active === rowData?.total && rowData?.total > 0) {
      button.disabled = false;
    }
  });
}

function openCategoryActionMenu(triggerButton, categoryName) {
  const menu = $("categoryActionMenu");
  if (!menu || !triggerButton) return;

  categoryActionState = {
    category: categoryName,
    trigger: triggerButton
  };

  updateCategoryActionMenuButtons(categoryName);

  menu.classList.remove("d-none");
  menu.setAttribute("aria-hidden", "false");
  menu.style.visibility = "hidden";

  requestAnimationFrame(() => {
    const triggerRect = triggerButton.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const padding = 12;
    const openAbove = triggerRect.bottom + menuRect.height + 12 > window.innerHeight && triggerRect.top > menuRect.height + 12;
    const top = openAbove
      ? Math.max(padding, triggerRect.top - menuRect.height - 8)
      : Math.min(window.innerHeight - menuRect.height - padding, triggerRect.bottom + 8);
    const left = Math.min(
      Math.max(padding, triggerRect.right - menuRect.width),
      window.innerWidth - menuRect.width - padding
    );

    menu.style.top = `${Math.max(padding, top)}px`;
    menu.style.left = `${Math.max(padding, left)}px`;
    menu.style.visibility = "visible";
  });
}

async function executeCategoryAction(action, categoryName) {
  const cleanAction = String(action || "").trim();
  const cleanCategory = String(categoryName || "").trim();
  if (!cleanAction || !cleanCategory) return;

  closeCategoryActionMenu();

  if (cleanAction === "rename") {
    await renameCategory(cleanCategory);
    return;
  }

  if (cleanAction === "move-up") {
    await reorderCategory(cleanCategory, -1);
    return;
  }

  if (cleanAction === "move-down") {
    await reorderCategory(cleanCategory, 1);
    return;
  }

  if (cleanAction === "enable") {
    await setCategoriesActive([cleanCategory], true);
    return;
  }

  if (cleanAction === "disable") {
    await setCategoriesActive([cleanCategory], false);
    return;
  }

  if (cleanAction === "delete") {
    await deleteCategories([cleanCategory]);
  }
}

function renderCategoryTable() {
  const body = $("categoryTableBody");
  if (!body) return;

  const search = String($("searchCategory")?.value || "").trim().toLowerCase();
  const visibleRows = allCategoryRows.filter((row) => !search || row.category.toLowerCase().includes(search));

  body.innerHTML = visibleRows.map((row) => `
    <tr data-category="${htmlEscape(row.category)}">
      <td>
        <div class="d-flex align-items-center gap-2">
          <span
            class="category-drag-handle text-muted"
            draggable="true"
            data-category="${htmlEscape(row.category)}"
            title="Drag to reorder"
            style="cursor: grab;"
          >
            <i class="bi bi-grip-vertical"></i>
          </span>
          <input type="checkbox" class="form-check-input cat-chk" data-category="${htmlEscape(row.category)}">
        </div>
      </td>
      <td class="fw-semibold">${htmlEscape(row.category)}</td>
      <td>${row.total}</td>
      <td>${row.active}</td>
      <td>${getCategoryStatusBadge(row)}</td>
      <td class="text-end text-nowrap">
        <button
          type="button"
          class="btn btn-sm btn-outline-dark category-action-trigger cat-menu-trigger"
          data-category="${htmlEscape(row.category)}"
          aria-haspopup="true"
          aria-expanded="false"
        >
          <i class="bi bi-three-dots-vertical me-1"></i> Actions
        </button>
      </td>
    </tr>
  `).join("");

  $("categoryCount").textContent = String(visibleRows.length);
  $("chkAllCategories").checked = false;
  updateTopActionsState();
}

function updateTopActionsState() {
  const selectedCount = document.querySelectorAll(".cat-chk:checked").length;
  const emptyCount = allCategoryRows.filter(isDeletableEmptyCategory).length;

  const deleteSelectedBtn = $("btnDeleteSelected");
  const enableSelectedBtn = $("btnEnableSelected");
  const disableSelectedBtn = $("btnDisableSelected");
  const deleteEmptyBtn = $("btnDeleteEmptyCategories");

  if (deleteSelectedBtn) deleteSelectedBtn.disabled = selectedCount === 0;
  if (enableSelectedBtn) enableSelectedBtn.disabled = selectedCount === 0;
  if (disableSelectedBtn) disableSelectedBtn.disabled = selectedCount === 0;
  if (deleteEmptyBtn) deleteEmptyBtn.disabled = emptyCount === 0;
}

async function loadCategories() {
  await loadManualCategoryRegistry();
  const serviceStore = await readAllServiceDocsFromCollection(db, {
    includeDeleted: false
  });
  serviceRows = hydrateServiceRows(serviceStore.rows);

  buildCategoryRows();
  renderCategoryTable();
}

function getSelectedCategories() {
  return Array.from(document.querySelectorAll(".cat-chk:checked"))
    .map((el) => String(el.getAttribute("data-category") || "").trim())
    .filter(Boolean);
}

function replaceCategoryInOrder(order = [], oldName, newName) {
  const oldKey = categoryKey(oldName);
  const newKey = categoryKey(newName);
  if (!oldKey || !newKey) return uniqueCategoryNames(order);
  if (oldKey === newKey) return uniqueCategoryNames(order);

  const hasNewElsewhere = order.some((name) => categoryKey(name) === newKey);
  if (hasNewElsewhere) {
    return uniqueCategoryNames(order.filter((name) => categoryKey(name) !== oldKey));
  }

  let replaced = false;
  const next = order.map((name) => {
    if (categoryKey(name) === oldKey) {
      replaced = true;
      return newName;
    }
    return name;
      }).filter(Boolean);

  if (!replaced) next.push(newName);
  return uniqueCategoryNames(next);
}

function removeCategoriesFromOrder(order = [], categoryNames = []) {
  const keys = new Set((Array.isArray(categoryNames) ? categoryNames : []).map((name) => categoryKey(name)));
  return uniqueCategoryNames(order.filter((name) => !keys.has(categoryKey(name))));
}

async function reorderCategory(categoryName, delta) {
  const clean = normalizeCategory(categoryName);
  const currentIndex = manualCategoryRegistry.findIndex((name) => categoryKey(name) === categoryKey(clean));
  if (currentIndex < 0) return;

  const nextIndex = currentIndex + Number(delta || 0);
  if (nextIndex < 0 || nextIndex >= manualCategoryRegistry.length) return;

  const nextRegistry = [...manualCategoryRegistry];
  const [moved] = nextRegistry.splice(currentIndex, 1);
  nextRegistry.splice(nextIndex, 0, moved);

  await saveManualCategoryRegistry(nextRegistry);
  await loadCategories();
}

function reorderCategoryByDrop(order = [], draggedName, targetName, insertAfter = false) {
  const next = uniqueCategoryNames(order);
  const draggedKey = categoryKey(draggedName);
  const targetKey = categoryKey(targetName);
  const fromIndex = next.findIndex((name) => categoryKey(name) === draggedKey);
  const targetIndex = next.findIndex((name) => categoryKey(name) === targetKey);

  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return next;

  const [moved] = next.splice(fromIndex, 1);
  const targetIndexAfterRemoval = next.findIndex((name) => categoryKey(name) === targetKey);
  const insertIndex = Math.min(
    next.length,
    Math.max(0, targetIndexAfterRemoval + (insertAfter ? 1 : 0))
  );

  next.splice(insertIndex, 0, moved);
  return uniqueCategoryNames(next);
}

async function dropCategoryOrder(draggedName, targetName, insertAfter = false) {
  const nextRegistry = reorderCategoryByDrop(manualCategoryRegistry, draggedName, targetName, insertAfter);
  const sameOrder = nextRegistry.length === manualCategoryRegistry.length
    && nextRegistry.every((name, index) => categoryKey(name) === categoryKey(manualCategoryRegistry[index]));
  if (sameOrder) return;

  await saveManualCategoryRegistry(nextRegistry);
  await loadCategories();
}

function clearCategoryDragHighlights() {
  document.querySelectorAll("#categoryTableBody tr.table-primary").forEach((row) => {
    row.classList.remove("table-primary");
  });
}

function scheduleCategoryAutoScroll(clientY) {
  const container = $("categoryTableScroll");
  if (!container) return;

  const rect = container.getBoundingClientRect();
  const threshold = 56;
  const step = 18;
  let delta = 0;

  if (clientY < rect.top + threshold) {
    delta = -step;
  } else if (clientY > rect.bottom - threshold) {
    delta = step;
  }

  if (!delta) return;

  if (dragScrollFrame) {
    cancelAnimationFrame(dragScrollFrame);
  }

  dragScrollFrame = requestAnimationFrame(() => {
    container.scrollTop += delta;
    dragScrollFrame = null;
  });
}

async function setCategoriesActive(categoryNames, activeValue) {
  const selected = Array.isArray(categoryNames) ? categoryNames.filter(Boolean) : [];
  if (!selected.length) {
    alert("Please select at least one category.");
    return;
  }

  const docsToUpdate = getServiceRowsForCategories(selected);
  if (!docsToUpdate.length) {
    alert("No services found for selected categories.");
    return;
  }

  await chunkedServiceUpdates(docsToUpdate, () => ({
    active: !!activeValue,
    updatedAt: serverTimestamp()
  }));

  await rebuildServiceStoreDocs();
  await loadCategories();
}

async function renameCategory(oldName) {
  const cleanOld = normalizeCategory(oldName);
  const nextNameRaw = prompt("Enter new category name:", cleanOld);
  if (nextNameRaw === null) return;

  const cleanNew = normalizeManualCategoryInput(nextNameRaw);
  if (!cleanNew) {
    alert("Category name cannot be empty.");
    return;
  }
  if (cleanOld === cleanNew) return;

  const docsToUpdate = getServiceRowsForCategories([cleanOld]);
  if (docsToUpdate.length) {
    await chunkedServiceUpdates(docsToUpdate, () => ({
      category: cleanNew,
      updatedAt: serverTimestamp()
    }));
  }

  const nextRegistry = replaceCategoryInOrder(manualCategoryRegistry, cleanOld, cleanNew);
  await saveManualCategoryRegistry(nextRegistry);

  if (docsToUpdate.length) {
    await rebuildServiceStoreDocs();
  }
  await loadCategories();
}

async function addCategory() {
  const nextNameRaw = prompt("Enter category name:");
  if (nextNameRaw === null) return;

  const cleanName = normalizeManualCategoryInput(nextNameRaw);
  if (!cleanName) {
    alert("Category name cannot be empty.");
    return;
  }

  const exists = allCategoryRows.some((row) => categoryKey(row.category) === categoryKey(cleanName));
  if (exists) {
    alert("Category already exists.");
    return;
  }

  await saveManualCategoryRegistry([...manualCategoryRegistry, cleanName]);
  await loadCategories();
}

async function deleteCategories(categoryNames) {
  const selected = Array.isArray(categoryNames) ? uniqueCategoryNames(categoryNames) : [];
  if (!selected.length) {
    alert("Please select at least one category.");
    return;
  }

  if (selected.some((name) => categoryKey(name) === "general")) {
    alert("General category cannot be deleted.");
    return;
  }

  const rowsByKey = new Map(allCategoryRows.map((row) => [categoryKey(row.category), row]));
  const validSelected = selected.filter((name) => rowsByKey.has(categoryKey(name)));
  if (!validSelected.length) {
    alert("No valid categories selected.");
    return;
  }

  const docsToMove = getServiceRowsForCategories(validSelected);
  const confirmMessage = docsToMove.length
    ? `Delete ${validSelected.length} categories? ${docsToMove.length} services will be moved to "General".`
    : `Delete ${validSelected.length} empty categories?`;

  if (!confirm(confirmMessage)) return;

  if (docsToMove.length) {
    await chunkedServiceUpdates(docsToMove, () => ({
      category: "General",
      updatedAt: serverTimestamp()
    }));
    await rebuildServiceStoreDocs();
  }

  const nextRegistry = removeCategoriesFromOrder(manualCategoryRegistry, validSelected);
  await saveManualCategoryRegistry(nextRegistry);
  await loadCategories();
}

async function deleteEmptyCategories() {
  const emptyCategories = allCategoryRows
    .filter(isDeletableEmptyCategory)
    .map((row) => row.category);

  if (!emptyCategories.length) {
    alert("No empty or disabled categories found.");
    return;
  }

  const confirmMessage = emptyCategories.length === 1
    ? `Delete 1 empty / disabled category?`
    : `Delete ${emptyCategories.length} empty / disabled categories?`;

  if (!confirm(confirmMessage)) return;
  await deleteCategories(emptyCategories);
}

function bindEvents() {
  $("searchCategory")?.addEventListener("input", renderCategoryTable);
  $("btnRefreshCategories")?.addEventListener("click", loadCategories);
  $("btnAddCategory")?.addEventListener("click", addCategory);
  $("btnDeleteSelected")?.addEventListener("click", async () => {
    await deleteCategories(getSelectedCategories());
  });

  $("btnDeleteEmptyCategories")?.addEventListener("click", async () => {
    await deleteEmptyCategories();
  });

  $("btnEnableSelected")?.addEventListener("click", async () => {
    await setCategoriesActive(getSelectedCategories(), true);
  });

  $("btnDisableSelected")?.addEventListener("click", async () => {
    await setCategoriesActive(getSelectedCategories(), false);
  });

  $("chkAllCategories")?.addEventListener("change", (e) => {
    const checked = !!e.target.checked;
    document.querySelectorAll(".cat-chk").forEach((chk) => {
      chk.checked = checked;
    });
    updateTopActionsState();
  });

  $("categoryTableBody")?.addEventListener("change", (e) => {
    if (!e.target.classList.contains("cat-chk")) return;
    updateTopActionsState();
  });

  $("categoryTableBody")?.addEventListener("dragstart", (e) => {
    const handle = e.target.closest(".category-drag-handle");
    if (!handle) return;

    draggedCategoryName = String(handle.getAttribute("data-category") || "").trim();
    if (!draggedCategoryName) return;

    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", draggedCategoryName);
  });

  $("categoryTableBody")?.addEventListener("dragover", (e) => {
    if (!draggedCategoryName) return;
    const row = e.target.closest("tr[data-category]");
    if (!row) return;

    e.preventDefault();
    const targetName = String(row.getAttribute("data-category") || "").trim();
    if (!targetName || categoryKey(targetName) === categoryKey(draggedCategoryName)) return;

    scheduleCategoryAutoScroll(e.clientY);
    clearCategoryDragHighlights();
    row.classList.add("table-primary");
  });

  $("categoryTableBody")?.addEventListener("dragleave", (e) => {
    const row = e.target.closest("tr[data-category]");
    if (!row) return;
    row.classList.remove("table-primary");
  });

  $("categoryTableBody")?.addEventListener("drop", async (e) => {
    if (!draggedCategoryName) return;
    const row = e.target.closest("tr[data-category]");
    if (!row) return;

    e.preventDefault();
    const targetName = String(row.getAttribute("data-category") || "").trim();
    if (!targetName || categoryKey(targetName) === categoryKey(draggedCategoryName)) return;

    const rect = row.getBoundingClientRect();
    const insertAfter = e.clientY > rect.top + (rect.height / 2);

    clearCategoryDragHighlights();
    const sourceName = draggedCategoryName;
    draggedCategoryName = "";
    await dropCategoryOrder(sourceName, targetName, insertAfter);
  });

  $("categoryTableBody")?.addEventListener("dragend", () => {
    draggedCategoryName = "";
    clearCategoryDragHighlights();
    if (dragScrollFrame) {
      cancelAnimationFrame(dragScrollFrame);
      dragScrollFrame = null;
    }
  });

  $("categoryTableBody")?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".cat-menu-trigger");
    if (!btn) return;

    const category = String(btn.getAttribute("data-category") || "").trim();
    if (!category) return;

    e.stopPropagation();
    if (btn.getAttribute("aria-expanded") === "true") {
      closeCategoryActionMenu();
      btn.setAttribute("aria-expanded", "false");
      return;
    }

    document.querySelectorAll(".cat-menu-trigger[aria-expanded='true']").forEach((openBtn) => {
      openBtn.setAttribute("aria-expanded", "false");
    });
    openCategoryActionMenu(btn, category);
    btn.setAttribute("aria-expanded", "true");
  });

  $("categoryActionMenu")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    e.stopPropagation();
    const action = String(btn.getAttribute("data-action") || "").trim();
    const category = String(categoryActionState.category || "").trim();
    if (!action || !category) return;
    await executeCategoryAction(action, category);
  });

  document.addEventListener("click", (e) => {
    const menu = $("categoryActionMenu");
    if (!menu || menu.classList.contains("d-none")) return;
    if (menu.contains(e.target) || e.target.closest(".cat-menu-trigger")) return;
    closeCategoryActionMenu();
    document.querySelectorAll(".cat-menu-trigger[aria-expanded='true']").forEach((openBtn) => {
      openBtn.setAttribute("aria-expanded", "false");
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeCategoryActionMenu();
      document.querySelectorAll(".cat-menu-trigger[aria-expanded='true']").forEach((openBtn) => {
        openBtn.setAttribute("aria-expanded", "false");
      });
    }
  });

  $("categoryTableScroll")?.addEventListener("scroll", () => {
    closeCategoryActionMenu();
  });

  window.addEventListener("scroll", closeCategoryActionMenu, true);
  window.addEventListener("resize", closeCategoryActionMenu);

  bindAdminLogout("btnLogout");
}

initAdminSidebar({ closeOnOutsideClick: true });
bindEvents();
loadCategories();

