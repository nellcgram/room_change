"use strict";

/* ================= Constants ================= */
const SVG_NS = "http://www.w3.org/2000/svg";
const STORAGE_KEY = "roomChangeState_v1";
let SCALE = 3;
const MARGIN = 46;

const JOB_TAGS = [
  { key: "unassigned", label: "Unassigned", color: "#9AA0A6" },
  { key: "seating",    label: "Seating",    color: "#5B7FA6" },
  { key: "storage",    label: "Storage",    color: "#B98A4B" },
  { key: "surface",    label: "Surface",    color: "#6E8B63" },
  { key: "light",      label: "Light",      color: "#C99A2E" },
  { key: "footrest",   label: "Footrest",   color: "#8A6E8A" },
  { key: "decorative", label: "Decorative", color: "#B06B75" },
  { key: "other",      label: "Other",      color: "#8B8D85" }
];

const ZONE_TYPES = {
  "reading-nook": { label: "Reading Nook", requiredTags: ["seating", "surface", "light", "footrest"] },
  "custom":       { label: "Custom", requiredTags: [] }
};

/* ================= State ================= */
function defaultState() {
  return {
    room: {
      width: 132, length: 144,
      doors: [{ id: uid("dr"), label: "Door", wall: "left", pos: 0, width: 32 }]
    },
    items: [],
    zones: [],
    lanes: []
  };
}

function normalizeState(parsed) {
  const base = defaultState();
  parsed = parsed || {};
  const parsedRoom = parsed.room || {};
  let doors = Array.isArray(parsedRoom.doors) ? parsedRoom.doors : null;
  if (!doors) {
    // Migrate the old single-door room shape (doorWall/doorPos/doorWidth) into the doors array.
    doors = parsedRoom.doorWall
      ? [{ id: uid("dr"), label: "Door", wall: parsedRoom.doorWall, pos: parsedRoom.doorPos || 0, width: parsedRoom.doorWidth || 32 }]
      : base.room.doors;
  }
  return {
    room: {
      width: parsedRoom.width || base.room.width,
      length: parsedRoom.length || base.room.length,
      doors
    },
    items: Array.isArray(parsed.items) ? parsed.items : [],
    zones: Array.isArray(parsed.zones) ? parsed.zones : [],
    lanes: Array.isArray(parsed.lanes) ? parsed.lanes : []
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeState(JSON.parse(raw));
  } catch (err) {
    console.warn("Could not read saved layout, starting fresh.", err);
  }
  return defaultState();
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn("Could not save layout.", err);
  }
}

let state = load();
let selectedId = null;
let drag = null;

/* ================= Helpers ================= */
function uid(prefix) {
  return prefix + "-" + Math.random().toString(36).slice(2, 9);
}
function spawnPosition(w, d) {
  const margin = 16;
  const stagger = (state.items.length + state.lanes.length) * 18;
  const cx = Math.min(state.room.width - w / 2 - margin, margin + w / 2 + stagger);
  const cy = Math.min(state.room.length - d / 2 - margin, margin + d / 2 + stagger);
  return { cx: Math.max(w / 2, cx), cy: Math.max(d / 2, cy) };
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function round1(n) { return Math.round(n * 10) / 10; }
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in (attrs || {})) el.setAttribute(k, attrs[k]);
  return el;
}
function jobTag(key) {
  return JOB_TAGS.find(t => t.key === key) || JOB_TAGS[JOB_TAGS.length - 1];
}

/* ================= Geometry (rotated-rectangle overlap) ================= */
function getCorners(rect) {
  const rad = ((rect.rotation || 0) * Math.PI) / 180;
  const hw = rect.w / 2, hd = rect.d / 2;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, ly]) => ({
    x: rect.cx + lx * cos - ly * sin,
    y: rect.cy + lx * sin + ly * cos
  }));
}
function edgeAxes(corners) {
  const axes = [];
  for (let i = 0; i < 2; i++) {
    const p1 = corners[i], p2 = corners[i + 1];
    const ex = p2.x - p1.x, ey = p2.y - p1.y;
    const len = Math.hypot(ex, ey) || 1;
    axes.push({ x: -ey / len, y: ex / len });
  }
  return axes;
}
function project(corners, axis) {
  let min = Infinity, max = -Infinity;
  for (const c of corners) {
    const p = c.x * axis.x + c.y * axis.y;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return [min, max];
}
function rectsOverlap(a, b) {
  const ca = getCorners(a), cb = getCorners(b);
  const axes = edgeAxes(ca).concat(edgeAxes(cb));
  for (const axis of axes) {
    const [minA, maxA] = project(ca, axis);
    const [minB, maxB] = project(cb, axis);
    if (maxA < minB || maxB < minA) return false;
  }
  return true;
}
function isOutsideRoom(rect, room) {
  const corners = getCorners(rect);
  return corners.some(c => c.x < -0.05 || c.y < -0.05 || c.x > room.width + 0.05 || c.y > room.length + 0.05);
}

/* ================= Issues ================= */
function computeIssues() {
  const issues = [];

  for (const item of state.items) {
    if (item.jobTag === "unassigned") {
      issues.push({
        id: "job-" + item.id, severity: "warn",
        message: `"${item.name}" has no job assigned — that's usually how a piece turns into a place to pile things.`,
        relatedIds: [item.id]
      });
    }
  }

  for (let i = 0; i < state.items.length; i++) {
    for (let j = i + 1; j < state.items.length; j++) {
      const a = state.items[i], b = state.items[j];
      if (rectsOverlap(a, b)) {
        issues.push({
          id: `col-${a.id}-${b.id}`, severity: "error",
          message: `"${a.name}" and "${b.name}" overlap.`,
          relatedIds: [a.id, b.id]
        });
      }
    }
  }

  for (const item of state.items) {
    if (isOutsideRoom(item, state.room)) {
      issues.push({
        id: "bounds-" + item.id, severity: "error",
        message: `"${item.name}" sticks outside the room's walls.`,
        relatedIds: [item.id]
      });
    }
  }

  for (const lane of state.lanes) {
    for (const item of state.items) {
      if (rectsOverlap(lane, item)) {
        issues.push({
          id: `lane-${lane.id}-${item.id}`, severity: "error",
          message: `"${item.name}" is blocking a path you marked as clear.`,
          relatedIds: [item.id, lane.id]
        });
      }
    }
  }

  for (const zone of state.zones) {
    const preset = ZONE_TYPES[zone.type] || ZONE_TYPES.custom;
    const required = zone.type === "custom" ? (zone.requiredTags || []) : preset.requiredTags;
    const assigned = state.items.filter(i => i.zoneId === zone.id);
    const missing = required.filter(tag => !assigned.some(i => i.jobTag === tag));
    if (missing.length) {
      const labels = missing.map(t => jobTag(t).label);
      issues.push({
        id: "zone-" + zone.id, severity: "warn",
        message: `"${zone.name}" is missing: ${labels.join(", ")}.`,
        relatedIds: assigned.map(i => i.id)
      });
    }
  }

  return issues;
}

/* ================= Coordinate conversion ================= */
function computeScale() {
  const container = document.querySelector(".sheet-scroll");
  const availW = Math.max(240, container.clientWidth - 24);
  const maxByWidth = availW / state.room.width;
  return Math.max(1.5, Math.min(5, maxByWidth));
}
function clientToModel(clientX, clientY) {
  const svg = document.getElementById("canvas");
  const rect = svg.getBoundingClientRect();
  return {
    x: (clientX - rect.left - MARGIN) / SCALE,
    y: (clientY - rect.top - MARGIN) / SCALE
  };
}

/* ================= Drag handling ================= */
function beginDrag(kind, id, extra) {
  drag = Object.assign({ kind, id }, extra || {});
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}
function onPointerMove(e) {
  if (!drag) return;
  const p = clientToModel(e.clientX, e.clientY);
  const isItem = drag.kind === "item-move" || drag.kind === "item-rotate";
  const obj = isItem ? state.items.find(i => i.id === drag.id) : state.lanes.find(l => l.id === drag.id);
  if (!obj) { drag = null; return; }

  if (drag.kind === "item-move" || drag.kind === "lane-move") {
    obj.cx = drag.origCx + (p.x - drag.startModel.x);
    obj.cy = drag.origCy + (p.y - drag.startModel.y);
  } else if (drag.kind === "item-rotate") {
    const angle = Math.atan2(p.y - obj.cy, p.x - obj.cx) * (180 / Math.PI);
    obj.rotation = Math.round(angle + 90);
  } else if (drag.kind === "lane-resize") {
    const w = Math.max(10, p.x - drag.left);
    const d = Math.max(10, p.y - drag.top);
    obj.w = w; obj.d = d;
    obj.cx = drag.left + w / 2; obj.cy = drag.top + d / 2;
  }
  render();
}
function onPointerUp() {
  drag = null;
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  save();
  render();
}

/* ================= Rendering: canvas ================= */
function renderCanvas(errorIds) {
  const svg = document.getElementById("canvas");
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  SCALE = computeScale();
  const pxRoomW = state.room.width * SCALE;
  const pxRoomL = state.room.length * SCALE;
  const pxW = pxRoomW + MARGIN * 2;
  const pxH = pxRoomL + MARGIN * 2;
  svg.setAttribute("width", pxW);
  svg.setAttribute("height", pxH);
  svg.setAttribute("viewBox", `0 0 ${pxW} ${pxH}`);

  const root = svgEl("g", { transform: `translate(${MARGIN},${MARGIN})` });
  svg.appendChild(root);

  root.appendChild(svgEl("rect", { x: 0, y: 0, width: pxRoomW, height: pxRoomL, class: "room-wall" }));

  for (const door of state.room.doors) {
    const dp = door.pos * SCALE, dw = door.width * SCALE;
    let dx1, dy1, dx2, dy2, labelDx = 0, labelDy = -6;
    if (door.wall === "top") { dx1 = dp; dy1 = 0; dx2 = dp + dw; dy2 = 0; labelDy = 14; }
    else if (door.wall === "bottom") { dx1 = dp; dy1 = pxRoomL; dx2 = dp + dw; dy2 = pxRoomL; labelDy = -6; }
    else if (door.wall === "left") { dx1 = 0; dy1 = dp; dx2 = 0; dy2 = dp + dw; labelDx = 4; }
    else { dx1 = pxRoomW; dy1 = dp; dx2 = pxRoomW; dy2 = dp + dw; labelDx = -34; }
    root.appendChild(svgEl("line", { x1: dx1, y1: dy1, x2: dx2, y2: dy2, class: "room-door" }));
    const doorLabel = svgEl("text", {
      x: (dx1 + dx2) / 2 + labelDx, y: (dy1 + dy2) / 2 + labelDy,
      "text-anchor": "middle", class: "room-door-label"
    });
    doorLabel.textContent = door.label || "door";
    root.appendChild(doorLabel);
  }

  for (const lane of state.lanes) root.appendChild(renderLaneEl(lane, errorIds));
  for (const item of state.items) root.appendChild(renderPieceEl(item, errorIds));
}

function renderPieceEl(item, errorIds) {
  const pxCx = item.cx * SCALE, pxCy = item.cy * SCALE;
  const pxW = item.w * SCALE, pxD = item.d * SCALE;
  const tag = jobTag(item.jobTag);
  const isSelected = item.id === selectedId;
  const hasError = errorIds.has(item.id);

  const g = svgEl("g", {
    class: "piece" + (isSelected ? " selected" : "") + (hasError ? " issue" : ""),
    transform: `translate(${pxCx},${pxCy}) rotate(${item.rotation || 0})`
  });

  const rectAttrs = { x: -pxW / 2, y: -pxD / 2, width: pxW, height: pxD, class: "piece-body" };
  let styleStr = "";
  if (item.jobTag === "unassigned") {
    rectAttrs.class += " unassigned";
  } else {
    styleStr = `fill:${tag.color}; fill-opacity:0.55;`;
  }
  if (styleStr) rectAttrs.style = styleStr;
  const rect = svgEl("rect", rectAttrs);

  const label = svgEl("text", { x: 0, y: 4, "text-anchor": "middle", class: "piece-label" });
  label.textContent = item.name;

  g.appendChild(rect);
  g.appendChild(label);

  if (isSelected) {
    const stemLen = 22;
    const handleY = -pxD / 2 - stemLen;
    g.appendChild(svgEl("line", { x1: 0, y1: -pxD / 2, x2: 0, y2: handleY, class: "rotate-stem" }));
    const handle = svgEl("circle", { cx: 0, cy: handleY, r: 7, class: "rotate-handle" });
    handle.addEventListener("pointerdown", e => {
      e.stopPropagation(); e.preventDefault();
      selectedId = item.id;
      beginDrag("item-rotate", item.id, {});
    });
    g.appendChild(handle);
  }

  const startMove = e => {
    e.stopPropagation(); e.preventDefault();
    selectedId = item.id;
    const p = clientToModel(e.clientX, e.clientY);
    beginDrag("item-move", item.id, { startModel: p, origCx: item.cx, origCy: item.cy });
    render();
  };
  rect.addEventListener("pointerdown", startMove);
  label.addEventListener("pointerdown", startMove);
  g.addEventListener("click", () => { selectedId = item.id; render(); });

  return g;
}

function renderLaneEl(lane, errorIds) {
  const pxCx = lane.cx * SCALE, pxCy = lane.cy * SCALE;
  const pxW = lane.w * SCALE, pxD = lane.d * SCALE;
  const hasError = errorIds.has(lane.id);

  const g = svgEl("g", { class: "lane", transform: `translate(${pxCx},${pxCy})` });
  const rect = svgEl("rect", {
    x: -pxW / 2, y: -pxD / 2, width: pxW, height: pxD,
    class: "lane-rect" + (hasError ? " issue" : "")
  });
  rect.addEventListener("pointerdown", e => {
    e.stopPropagation(); e.preventDefault();
    const p = clientToModel(e.clientX, e.clientY);
    beginDrag("lane-move", lane.id, { startModel: p, origCx: lane.cx, origCy: lane.cy });
  });
  g.appendChild(rect);

  const del = svgEl("text", {
    x: -pxW / 2 + 4, y: -pxD / 2 + 14, class: "piece-label",
    style: "cursor:pointer; fill:#C7311F;"
  });
  del.textContent = "✕ remove path";
  del.addEventListener("pointerdown", e => e.stopPropagation());
  del.addEventListener("click", e => {
    e.stopPropagation();
    state.lanes = state.lanes.filter(l => l.id !== lane.id);
    save(); render();
  });
  g.appendChild(del);

  const handle = svgEl("circle", { cx: pxW / 2, cy: pxD / 2, r: 6, class: "lane-handle" });
  handle.addEventListener("pointerdown", e => {
    e.stopPropagation(); e.preventDefault();
    beginDrag("lane-resize", lane.id, { left: lane.cx - lane.w / 2, top: lane.cy - lane.d / 2 });
  });
  g.appendChild(handle);

  return g;
}

/* ================= Rendering: side panels ================= */
function renderFurnitureList() {
  const ul = document.getElementById("furniture-list");
  ul.innerHTML = "";
  document.getElementById("furniture-count").textContent = state.items.length;
  if (!state.items.length) {
    ul.innerHTML = '<li class="issue-empty">No furniture yet. Use "+ Add Furniture" above the sheet.</li>';
    return;
  }
  for (const item of state.items) {
    const tag = jobTag(item.jobTag);
    const li = document.createElement("li");
    li.className = "item-row" + (item.id === selectedId ? " selected" : "");
    li.innerHTML =
      `<span class="item-swatch" style="background:${tag.color}"></span>` +
      `<span class="item-name">${escapeHtml(item.name)}</span>` +
      `<span class="item-dims">${item.w}×${item.d}"</span>` +
      `<button class="item-del" type="button" title="Remove">✕</button>`;
    li.addEventListener("click", e => {
      if (e.target.closest(".item-del")) return;
      selectedId = item.id; render();
    });
    li.querySelector(".item-del").addEventListener("click", e => {
      e.stopPropagation();
      state.items = state.items.filter(i => i.id !== item.id);
      if (selectedId === item.id) selectedId = null;
      save(); render();
    });
    ul.appendChild(li);
  }
}

function renderZoneList() {
  const ul = document.getElementById("zone-list");
  ul.innerHTML = "";
  document.getElementById("zones-count").textContent = state.zones.length;
  if (!state.zones.length) {
    ul.innerHTML = '<li class="issue-empty">No zones yet. Group furniture (like a reading corner) to get a checklist.</li>';
    return;
  }
  for (const zone of state.zones) {
    const preset = ZONE_TYPES[zone.type] || ZONE_TYPES.custom;
    const required = zone.type === "custom" ? (zone.requiredTags || []) : preset.requiredTags;
    const assigned = state.items.filter(i => i.zoneId === zone.id);
    const chips = required.map(tag => {
      const met = assigned.some(i => i.jobTag === tag);
      return `<span class="zone-req-chip ${met ? "met" : "unmet"}">${met ? "✓" : "—"} ${jobTag(tag).label}</span>`;
    }).join("");
    const li = document.createElement("li");
    li.className = "zone-row";
    li.innerHTML =
      `<div class="zone-row-head"><span class="zone-name">${escapeHtml(zone.name)}</span>` +
      `<button class="item-del" type="button" title="Delete zone">✕</button></div>` +
      `<div class="muted" style="font-size:0.78rem">${assigned.length} piece${assigned.length === 1 ? "" : "s"} assigned</div>` +
      `<div class="zone-req-list">${chips || '<span class="muted" style="font-size:0.78rem">No requirements set.</span>'}</div>`;
    li.querySelector(".item-del").addEventListener("click", () => {
      state.zones = state.zones.filter(z => z.id !== zone.id);
      state.items.forEach(i => { if (i.zoneId === zone.id) i.zoneId = null; });
      save(); render();
    });
    ul.appendChild(li);
  }
}

function renderIssueList(issues) {
  const ul = document.getElementById("issue-list");
  ul.innerHTML = "";
  document.getElementById("issues-count").textContent = issues.length;
  if (!issues.length) {
    ul.innerHTML = '<li class="issue-empty">No problems found. Looking good.</li>';
    return;
  }
  for (const issue of issues) {
    const li = document.createElement("li");
    li.className = "issue-row" + (issue.severity === "warn" ? " issue-warn" : "");
    li.textContent = issue.message;
    li.addEventListener("click", () => {
      if (issue.relatedIds && issue.relatedIds.length) {
        selectedId = issue.relatedIds[0];
        render();
      }
    });
    ul.appendChild(li);
  }
}

function renderSelectedPanel() {
  const body = document.getElementById("selected-body");
  const item = state.items.find(i => i.id === selectedId);
  if (!item) {
    body.innerHTML = '<p class="muted">Click a piece on the sheet to edit it here.</p>';
    return;
  }
  document.getElementById("panel-selected").open = true;
  body.innerHTML = `
    <div class="stacked-form">
      <label>Name<input type="text" id="sel-name" value="${escapeHtml(item.name)}"></label>
      <div class="inline-row">
        <label>Width (in)<input type="number" id="sel-w" value="${item.w}" min="1" step="1"></label>
        <label>Depth (in)<input type="number" id="sel-d" value="${item.d}" min="1" step="1"></label>
      </div>
      <div class="inline-row">
        <label>Center from left wall (in)<input type="number" id="sel-x" value="${round1(item.cx)}" step="1"></label>
        <label>Center from top wall (in)<input type="number" id="sel-y" value="${round1(item.cy)}" step="1"></label>
      </div>
      <label>Angle (degrees)<input type="number" id="sel-rot" value="${Math.round(item.rotation || 0)}" step="1"></label>
      <label>Job<select id="sel-job">${JOB_TAGS.map(t => `<option value="${t.key}" ${t.key === item.jobTag ? "selected" : ""}>${t.label}</option>`).join("")}</select></label>
      <label>Zone<select id="sel-zone"><option value="">— none —</option>${state.zones.map(z => `<option value="${z.id}" ${z.id === item.zoneId ? "selected" : ""}>${escapeHtml(z.name)}</option>`).join("")}</select></label>
      <button type="button" class="btn btn-ghost" id="sel-delete">Remove This Piece</button>
    </div>`;

  const $ = id => document.getElementById(id);
  $("sel-name").addEventListener("input", e => { item.name = e.target.value; save(); render(); });
  $("sel-w").addEventListener("input", e => { item.w = parseFloat(e.target.value) || item.w; save(); render(); });
  $("sel-d").addEventListener("input", e => { item.d = parseFloat(e.target.value) || item.d; save(); render(); });
  $("sel-x").addEventListener("input", e => { item.cx = parseFloat(e.target.value) || 0; save(); render(); });
  $("sel-y").addEventListener("input", e => { item.cy = parseFloat(e.target.value) || 0; save(); render(); });
  $("sel-rot").addEventListener("input", e => { item.rotation = parseFloat(e.target.value) || 0; save(); render(); });
  $("sel-job").addEventListener("change", e => { item.jobTag = e.target.value; save(); render(); });
  $("sel-zone").addEventListener("change", e => { item.zoneId = e.target.value || null; save(); render(); });
  $("sel-delete").addEventListener("click", () => {
    state.items = state.items.filter(i => i.id !== item.id);
    selectedId = null; save(); render();
  });
}

/* ================= Master render ================= */
function render() {
  const issues = computeIssues();
  const errorIds = new Set();
  issues.filter(i => i.severity === "error").forEach(i => i.relatedIds.forEach(id => errorIds.add(id)));

  renderCanvas(errorIds);
  renderDoorList();
  renderFurnitureList();
  renderZoneList();
  renderIssueList(issues);

  const selectedBody = document.getElementById("selected-body");
  const active = document.activeElement;
  if (!(selectedBody.contains(active) && active !== document.body)) {
    renderSelectedPanel();
  }
}

/* ================= Modal ================= */
function openModal(html, onMount) {
  const backdrop = document.getElementById("modal-backdrop");
  const content = document.getElementById("modal-content");
  content.innerHTML = html;
  backdrop.hidden = false;
  onMount(content);
  backdrop.addEventListener("click", function onBackdrop(e) {
    if (e.target === backdrop) { closeModal(); backdrop.removeEventListener("click", onBackdrop); }
  });
}
function closeModal() {
  document.getElementById("modal-backdrop").hidden = true;
  document.getElementById("modal-content").innerHTML = "";
}

/* ================= Wiring ================= */
function populateRoomForm() {
  document.getElementById("room-width").value = state.room.width;
  document.getElementById("room-length").value = state.room.length;
}

const WALL_LABELS = { top: "Top", right: "Right", bottom: "Bottom", left: "Left" };

function renderDoorList() {
  const ul = document.getElementById("door-list");
  ul.innerHTML = "";
  if (!state.room.doors.length) {
    ul.innerHTML = '<li class="issue-empty">No doors yet.</li>';
    return;
  }
  for (const door of state.room.doors) {
    const li = document.createElement("li");
    li.className = "item-row";
    li.innerHTML =
      `<span class="item-name">${escapeHtml(door.label || "Door")}</span>` +
      `<span class="item-dims">${WALL_LABELS[door.wall] || door.wall} wall, ${door.width}"</span>` +
      `<button class="item-del" type="button" title="Remove">✕</button>`;
    li.querySelector(".item-del").addEventListener("click", () => {
      state.room.doors = state.room.doors.filter(d => d.id !== door.id);
      save(); render();
    });
    ul.appendChild(li);
  }
}

function wireEvents() {
  document.getElementById("form-room").addEventListener("submit", e => {
    e.preventDefault();
    state.room.width = parseFloat(document.getElementById("room-width").value) || state.room.width;
    state.room.length = parseFloat(document.getElementById("room-length").value) || state.room.length;
    save(); render();
  });

  document.getElementById("btn-add-door").addEventListener("click", () => {
    openModal(`
      <h2>Add a Door</h2>
      <form class="stacked-form" id="add-door-form">
        <label>Label<input type="text" id="ad-label" required placeholder="e.g. Closet Door" value="Closet Door"></label>
        <label>Which wall is it on?
          <select id="ad-wall">
            <option value="top">Top</option>
            <option value="right">Right</option>
            <option value="bottom">Bottom</option>
            <option value="left">Left</option>
          </select>
        </label>
        <label>Position along that wall (inches from the wall's start)
          <input type="number" id="ad-pos" min="0" step="1" value="0">
        </label>
        <label>Width (inches)<input type="number" id="ad-width" min="10" max="120" step="1" value="30"></label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="ad-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">Add Door</button>
        </div>
      </form>
    `, content => {
      content.querySelector("#ad-cancel").addEventListener("click", closeModal);
      content.querySelector("#add-door-form").addEventListener("submit", e => {
        e.preventDefault();
        const label = content.querySelector("#ad-label").value.trim() || "Door";
        const wall = content.querySelector("#ad-wall").value;
        const pos = parseFloat(content.querySelector("#ad-pos").value) || 0;
        const width = parseFloat(content.querySelector("#ad-width").value) || 30;
        state.room.doors.push({ id: uid("dr"), label, wall, pos, width });
        save(); closeModal(); render();
      });
    });
  });

  document.getElementById("btn-add-furniture").addEventListener("click", () => {
    openModal(`
      <h2>Add Furniture</h2>
      <form class="stacked-form" id="add-furn-form">
        <label>Name<input type="text" id="af-name" required placeholder="e.g. Cedar chest"></label>
        <div class="inline-row">
          <label>Width (in)<input type="number" id="af-w" min="1" step="1" required></label>
          <label>Depth (in)<input type="number" id="af-d" min="1" step="1" required></label>
        </div>
        <label>Job<select id="af-job">${JOB_TAGS.map(t => `<option value="${t.key}">${t.label}</option>`).join("")}</select></label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="af-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
    `, content => {
      content.querySelector("#af-cancel").addEventListener("click", closeModal);
      content.querySelector("#add-furn-form").addEventListener("submit", e => {
        e.preventDefault();
        const name = content.querySelector("#af-name").value.trim() || "Untitled";
        const w = parseFloat(content.querySelector("#af-w").value) || 12;
        const d = parseFloat(content.querySelector("#af-d").value) || 12;
        const job = content.querySelector("#af-job").value;
        const pos = spawnPosition(w, d);
        const item = {
          id: uid("f"), name, w, d,
          cx: pos.cx, cy: pos.cy,
          rotation: 0, jobTag: job, zoneId: null
        };
        state.items.push(item);
        selectedId = item.id;
        save(); closeModal(); render();
      });
    });
  });

  document.getElementById("btn-add-lane").addEventListener("click", () => {
    const w = Math.min(30, state.room.width * 0.4);
    const d = Math.min(48, state.room.length * 0.4);
    const pos = spawnPosition(w, d);
    state.lanes.push({ id: uid("l"), cx: pos.cx, cy: pos.cy, w, d });
    save(); render();
  });

  document.getElementById("btn-add-zone").addEventListener("click", () => {
    openModal(`
      <h2>New Zone</h2>
      <form class="stacked-form" id="add-zone-form">
        <label>Zone name<input type="text" id="az-name" required placeholder="e.g. Reading Nook"></label>
        <label>Type
          <select id="az-type">
            <option value="reading-nook">Reading Nook (needs seating, surface, light, footrest)</option>
            <option value="custom">Custom (pick what it needs)</option>
          </select>
        </label>
        <div id="az-custom-tags" hidden>
          <p class="muted" style="margin:4px 0">What does this zone need at least one of?</p>
          ${JOB_TAGS.filter(t => t.key !== "unassigned").map(t =>
            `<label style="flex-direction:row; align-items:center; gap:6px;"><input type="checkbox" value="${t.key}" class="az-tag-cb"> ${t.label}</label>`
          ).join("")}
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="az-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">Create Zone</button>
        </div>
      </form>
    `, content => {
      const typeSel = content.querySelector("#az-type");
      const customBox = content.querySelector("#az-custom-tags");
      typeSel.addEventListener("change", () => { customBox.hidden = typeSel.value !== "custom"; });
      content.querySelector("#az-cancel").addEventListener("click", closeModal);
      content.querySelector("#add-zone-form").addEventListener("submit", e => {
        e.preventDefault();
        const name = content.querySelector("#az-name").value.trim() || "Untitled Zone";
        const type = typeSel.value;
        const requiredTags = type === "custom"
          ? Array.from(content.querySelectorAll(".az-tag-cb:checked")).map(cb => cb.value)
          : [];
        state.zones.push({ id: uid("z"), name, type, requiredTags });
        save(); closeModal(); render();
      });
    });
  });

  document.getElementById("btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "room-change-backup.json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  document.getElementById("input-import").addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        state = normalizeState(JSON.parse(reader.result));
        selectedId = null;
        save(); populateRoomForm(); render();
      } catch (err) {
        alert("That file could not be read as a Room Change backup. Nothing was changed.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  document.getElementById("canvas").addEventListener("pointerdown", e => {
    if (e.target.id === "canvas") { selectedId = null; render(); }
  });

  window.addEventListener("resize", debounce(render, 150));
}

/* ================= Init ================= */
function init() {
  populateRoomForm();
  wireEvents();
  render();
}
init();
