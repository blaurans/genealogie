/* Généalogie — visualisation d'arbre GEDCOM
 * Données : /api/data (JSON produit par le serveur Zig)
 * Rendu : canvas, pan/zoom, clic pour la fiche, recherche.
 */
"use strict";

/* ------------------------------------------------------------------ */
/* Données                                                             */
/* ------------------------------------------------------------------ */

const S = {
  data: null,        // payload serveur
  P: new Map(),      // id -> person
  F: new Map(),      // id -> family
  focal: null,       // id personne centrale
  gens: 4,           // nb de générations chaque direction
  groups: [],        // groupes dessinés
  boxes: [],         // hit-test {x,y,w,h,pid}
  t: { x: 0, y: 0, s: 1 },
  selected: null,
};

const NODE_W = 172, NODE_H = 54, COUPLE_GAP = 8, SIB_GAP = 36, ROW_H = 130;

function loadMaps() {
  S.P.clear(); S.F.clear();
  if (!S.data || !S.data.persons) return;
  for (const p of S.data.persons) S.P.set(p.id, p);
  for (const f of S.data.families) S.F.set(f.id, f);
}

function year(d) {
  if (!d) return "";
  const m = String(d).match(/\d{4}/);
  return m ? m[0] : "";
}

function lifeLine(p) {
  const b = year(p.birth), d = year(p.death);
  if (b && d) return `${b} – ${d}`;
  if (b) return `° ${b}`;
  if (d) return `† ${d}`;
  return "";
}

function parentsOf(pid) {
  const p = S.P.get(pid);
  if (!p || !p.famc) return null;
  const f = S.F.get(p.famc);
  if (!f) return null;
  return { father: f.husb, mother: f.wife };
}

/* ------------------------------------------------------------------ */
/* Construction de l'arbre                                             */
/* ------------------------------------------------------------------ */

/* Un "groupe" = une personne + ses conjoints sur une même rangée.
 * down : enfants dessinés dessous ; up : parents dessinés dessus.
 * w en pixels ; x = centre du groupe sur sa rangée.            */
function buildGroups() {
  S.groups = []; S.boxes = [];

  if (!S.focal || !S.P.has(S.focal)) {
    // recadrage : la personne avec le plus de liens
    let best = null, bestScore = -1;
    for (const p of S.P.values()) {
      const score = (p.fams ? p.fams.length : 0) + (p.famc ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = p.id; }
    }
    S.focal = best;
    if (!best) return;
  }

  const visited = new Set();

  function makeGroup(pid, dir, gen) {
    const g = { dir, gen, members: [], famLinks: [], subs: [], y: 0, x: 0, w: 0, childX: 0 };
    const queue = [pid];
    const inGroup = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (!id || !S.P.has(id) || visited.has(id) || inGroup.has(id)) continue;
      visited.add(id); inGroup.add(id);
      g.members.push(id);
      const p = S.P.get(id);
      if (!p.fams) continue;
      for (const fx of p.fams) {
        const f = S.F.get(fx);
        if (!f) continue;
        const other = f.husb === id ? f.wife : f.husb;
        if (other && S.P.has(other)) {
          g.famLinks.push({ a: id, b: other, year: year(f.marriage) });
          queue.push(other);
        }
      }
    }
    g.w = g.members.length * NODE_W + (g.members.length - 1) * COUPLE_GAP;
    return g;
  }

  function spousesIds(pid) {
    const out = [];
    const p = S.P.get(pid);
    if (p && p.fams) for (const fx of p.fams) {
      const f = S.F.get(fx);
      if (!f) continue;
      const o = f.husb === pid ? f.wife : f.husb;
      if (o && !out.includes(o)) out.push(o);
    }
    return out;
  }

  function growDown(g, gen) {
    if (gen >= S.gens) return;
    const seenFam = new Set(), seenChild = new Set();
    const childGroups = [];
    for (const mid of g.members) {
      const p = S.P.get(mid);
      if (!p || !p.fams) continue;
      for (const fx of p.fams) {
        if (seenFam.has(fx)) continue;
        seenFam.add(fx);
        const f = S.F.get(fx);
        if (!f) continue;
        for (const cid of f.children) {
          if (seenChild.has(cid) || visited.has(cid) || !S.P.has(cid)) continue;
          seenChild.add(cid);
          const cg = makeGroup(cid, "down", gen + 1);
          if (cg) { childGroups.push(cg); growDown(cg, gen + 1); }
        }
      }
    }
    g.subs = childGroups;
    computeWidth(g, childGroups);
  }

  function growUp(g, gen) {
    if (gen >= S.gens) return;
    const parentGroups = [];
    for (const mid of g.members) {
      const par = parentsOf(mid);
      const father = par && par.father && S.P.has(par.father) ? par.father : null;
      const mother = par && par.mother && S.P.has(par.mother) ? par.mother : null;
      for (const pid of [father, mother]) {
        if (!pid || visited.has(pid)) continue;
        const pg = makeGroup(pid, "up", gen + 1);
        if (pg) { pg.attachedTo = mid; parentGroups.push(pg); growUp(pg, gen + 1); }
      }
    }
    // dédoublonnage : un parent peut être présent dans deux groupes fusionnés
    const kept = [], seen = new Set();
    for (const pg of parentGroups) {
      const key = pg.members.join("+");
      if (seen.has(key)) continue;
      seen.add(key); kept.push(pg);
    }
    g.subs = kept;
    computeWidth(g, kept);
  }

  function computeWidth(g, subs) {
    if (!subs.length) { g.w = Math.max(g.w, NODE_W); return; }
    const subW = subs.reduce((a, s) => a + s.w, 0) + (subs.length - 1) * SIB_GAP;
    g.w = Math.max(g.w, subW);
  }

  function layout(g, left) {
    g.x = g.subs.length
      ? (g.subs[0].x + g.subs[g.subs.length - 1].x) / 2
      : left + g.w / 2;
    let cur = left;
    for (const s of g.subs) {
      layout(s, cur);
      cur += s.w + SIB_GAP;
    }
  }

  const focal = makeGroup(S.focal, "down", 0);
  visited.clear();
  // arbre ascendant : reconstruit l'arbre des parents du focal uniquement
  const upRoot = { dir: "up", gen: 0, members: [S.focal], famLinks: [], subs: [], w: NODE_W, attachedTo: null };
  const parents = parentsOf(S.focal);
  const pg = [];
  for (const pid of parents ? [parents.father, parents.mother] : []) {
    if (pid && S.P.has(pid) && !visited.has(pid)) {
      const g2 = makeGroup(pid, "up", 1);
      if (g2) { g2.attachedTo = S.focal; pg.push(g2); growUp(g2, 1); }
    }
  }
  const dedup = [], ks = new Set();
  for (const g2 of pg) {
    const key = g2.members.join("+");
    if (!ks.has(key)) { ks.add(key); dedup.push(g2); }
  }
  upRoot.subs = dedup;
  computeWidth(upRoot, dedup);

  // positionnement : focal au centre, groupes sur les rangées
  layout(focal, -focal.w / 2);
  upRoot.x = focal.x;
  let cur = focal.x - upRoot.w / 2;
  for (const s of upRoot.subs) { layout(s, cur); cur += s.w + SIB_GAP; }
  upRoot.x = upRoot.subs.length ? (upRoot.subs[0].x + upRoot.subs[upRoot.subs.length - 1].x) / 2 : focal.x;

  focal.y = 0;
  for (const g of walkTree(focal)) if (g !== focal) g.y = g.gen * ROW_H;
  for (const g of walkTree(upRoot)) if (g !== upRoot) g.y = -g.gen * ROW_H;

  S.groups = [focal, upRoot, ...descend(focal), ...descend(upRoot)];

  function* walkTree(g) { yield g; for (const s of g.subs) yield* walkTree(s); }
  function descend(g) { const out = []; for (const s of g.subs) { out.push(s, ...descend(s)); } return out; }
}

/* ------------------------------------------------------------------ */
/* Rendu canvas                                                        */
/* ------------------------------------------------------------------ */

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  draw();
}

function worldToScreen(x, y) { return { x: x * S.t.s + S.t.x, y: y * S.t.s + S.t.y }; }
function screenToWorld(x, y) { return { x: (x - S.t.x) / S.t.s, y: (y - S.t.y) / S.t.s }; }

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--bg");
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.translate(S.t.x, S.t.y);
  ctx.scale(S.t.s, S.t.s);

  drawEdges();
  drawBoxes();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function groupMemberX(g, i) {
  const n = g.members.length;
  return g.x + (i - (n - 1) / 2) * (NODE_W + COUPLE_GAP);
}

function drawEdges() {
  ctx.strokeStyle = "#5a6678";
  ctx.lineWidth = 1.4 / S.t.s;

  for (const g of S.groups) {
    if (!g.subs) continue;
    for (const s of g.subs) {
      // lien parent(s) → enfant : coude vertical
      const topRow = g.dir === "down" ? g : s;
      const childGroup = g.dir === "down" ? s : g;
      const attachId = s.attachedTo || childGroup.members[0];
      const attachIdx = Math.max(0, topRow.members.indexOf(attachId));
      const fromX = groupMemberX(topRow, attachIdx === -1 ? Math.floor(topRow.members.length / 2) : attachIdx);
      const fromY = topRow.y + (topRow.dir === "down" ? NODE_H / 2 : -NODE_H / 2);
      const toX = childGroup.x;
      const toY = childGroup.y + (childGroup.dir === "down" ? -NODE_H / 2 : NODE_H / 2);
      const midY = (fromY + toY) / 2;
      ctx.beginPath();
      ctx.moveTo(fromX, fromY);
      ctx.lineTo(fromX, midY);
      ctx.lineTo(toX, midY);
      ctx.lineTo(toX, toY);
      ctx.stroke();
      // petit trait horizontal sur la ligne du couple parent
      ctx.beginPath();
      ctx.moveTo(fromX - 6, fromY);
      ctx.lineTo(fromX + 6, fromY);
      ctx.stroke();
    }
    // liens de couple dans le groupe
    ctx.strokeStyle = "#8a95a6";
    ctx.lineWidth = 2 / S.t.s;
    for (const l of g.famLinks) {
      const ai = g.members.indexOf(l.a), bi = g.members.indexOf(l.b);
      if (ai < 0 || bi < 0) continue;
      const ax = groupMemberX(g, ai), bx = groupMemberX(g, bi);
      const x1 = ax + (bx > ax ? NODE_W / 2 : -NODE_W / 2);
      const x2 = bx + (bx > ax ? -NODE_W / 2 : NODE_W / 2);
      ctx.beginPath();
      ctx.moveTo(x1, g.y);
      ctx.lineTo(x2, g.y);
      ctx.stroke();
      if (l.year) {
        ctx.fillStyle = "#8a95a6";
        ctx.font = `${11 / S.t.s < 8 ? 8 : 11}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(l.year, (x1 + x2) / 2, g.y - 6 / S.t.s);
      }
    }
    ctx.strokeStyle = "#5a6678";
    ctx.lineWidth = 1.4 / S.t.s;
  }
}

function drawBoxes() {
  S.boxes = [];
  ctx.textAlign = "center";
  for (const g of S.groups) {
    if (g === null) continue;
    for (let i = 0; i < g.members.length; i++) {
      const p = S.P.get(g.members[i]);
      if (!p) continue;
      const cx = groupMemberX(g, i);
      drawPersonBox(cx, g.y, p, g.gen === 0 && g.dir === "down" && p.id === S.focal);
    }
  }
}

function drawPersonBox(cx, cy, p, isFocal) {
  const w = NODE_W, h = NODE_H;
  const x = cx - w / 2, y = cy - h / 2;
  S.boxes.push({ x, y, w, h, pid: p.id });

  const styles = {
    M: ["#24425f", "#4a7dbd"],
    F: ["#5a2c38", "#c0576e"],
    U: ["#333a44", "#7a8291"],
  };
  const [fill, border] = styles[p.sex] || styles.U;

  ctx.beginPath();
  roundRect(ctx, x, y, w, h, 10);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = isFocal ? 3 : 1.2;
  ctx.strokeStyle = isFocal ? "#f0b429" : border;
  ctx.stroke();

  ctx.fillStyle = "#eef2f8";
  ctx.font = "600 13px sans-serif";
  ctx.fillText(truncate(p.name, 20), cx, y + 21);

  ctx.fillStyle = "#9aa6b8";
  ctx.font = "12px sans-serif";
  ctx.fillText(truncate(lifeLine(p) || "—", 24), cx, y + 40);
}

function truncate(s, n) {
  s = s || "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function roundRect(c, x, y, w, h, r) {
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function fitView() {
  if (!S.boxes.length) { S.t = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2, s: 1 }; draw(); return; }
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const b of S.boxes) {
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const pad = 60;
  const s = Math.min((cw - 2 * pad) / (x2 - x1), (ch - 2 * pad) / (y2 - y1), 1.4);
  S.t.s = Math.max(0.1, s);
  S.t.x = (cw - (x1 + x2) * S.t.s) / 2;
  S.t.y = (ch - (y1 + y2) * S.t.s) / 2;
  draw();
}

/* ------------------------------------------------------------------ */
/* Fiche détail                                                        */
/* ------------------------------------------------------------------ */

const detail = document.getElementById("detail");

function showDetail(pid) {
  const p = S.P.get(pid);
  if (!p) return;
  S.selected = pid;
  const sexLabel = { M: "Homme", F: "Femme", U: "—" }[p.sex] || "—";

  let html = `<button class="close" title="Fermer">✕</button>
    <h2>${esc(p.name)}<span class="sex ${p.sex.toLowerCase()}">${sexLabel}</span></h2>
    <div class="years">${esc(lifeLine(p)) || "dates non connues"}</div>`;

  if (p.birth) html += event("Naissance", p.birth, p.birthPlace);
  if (p.death) html += event("Décès", p.death, p.deathPlace);

  const par = parentsOf(pid);
  const parList = [];
  if (par && par.father && S.P.has(par.father)) parList.push(par.father);
  if (par && par.mother && S.P.has(par.mother)) parList.push(par.mother);
  if (parList.length) {
    html += `<h3>Parents</h3>`;
    for (const id of parList) {
      const q = S.P.get(id);
      html += `<a class="link" data-pid="${id}">${esc(q.name)} <small>${esc(lifeLine(q))}</small></a>`;
    }
  }

  if (p.fams && p.fams.length) {
    html += `<h3>Union(s)</h3>`;
    for (const fx of p.fams) {
      const f = S.F.get(fx);
      if (!f) continue;
      const other = f.husb === pid ? f.wife : f.husb;
      if (other && S.P.has(other)) {
        const q = S.P.get(other);
        html += `<a class="link" data-pid="${other}">${esc(q.name)} <small>${esc(lifeLine(q))}${f.marriage ? " · ⚭ " + esc(f.marriage) : ""}</small></a>`;
      }
      if (f.children && f.children.length) {
        for (const cid of f.children) {
          const c = S.P.get(cid);
          if (!c) continue;
          html += `<a class="link" data-pid="${cid}">↳ ${esc(c.name)} <small>${esc(lifeLine(c))}</small></a>`;
        }
      }
    }
  }

  html += `<button id="detail-focus" style="margin-top:14px">◎ Centrer l'arbre sur cette personne</button>`;
  detail.innerHTML = html;
  detail.classList.remove("hidden");

  detail.querySelector(".close").onclick = () => detail.classList.add("hidden");
  detail.querySelector("#detail-focus").onclick = () => focusPerson(pid);
  detail.querySelectorAll("a.link").forEach(a => {
    a.onclick = () => showDetail(a.dataset.pid);
  });
}

function event(label, date, place) {
  return `<div class="event"><div class="label">${label}</div>
    <div class="value">${esc(date)}${place ? " — " + esc(place) : ""}</div></div>`;
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------------------------ */
/* Interactions                                                        */
/* ------------------------------------------------------------------ */

let dragging = false, dragMoved = false, dragStart = null;

canvas.addEventListener("mousedown", e => {
  dragging = true; dragMoved = false;
  dragStart = { x: e.clientX - S.t.x, y: e.clientY - S.t.y, tx: S.t.x, ty: S.t.y };
  canvas.classList.add("dragging");
});
window.addEventListener("mousemove", e => {
  if (!dragging) return;
  const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
  if (Math.abs(dx - dragStart.tx) > 3 || Math.abs(dy - dragStart.ty) > 3) dragMoved = true;
  S.t.x = dx; S.t.y = dy;
  draw();
});
window.addEventListener("mouseup", e => {
  if (!dragging) return;
  dragging = false;
  canvas.classList.remove("dragging");
  if (!dragMoved && e.target === canvas) {
    const w = screenToWorld(e.clientX - canvas.getBoundingClientRect().left, e.clientY - canvas.getBoundingClientRect().top);
    for (const b of S.boxes) {
      if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) {
        showDetail(b.pid);
        return;
      }
    }
    detail.classList.add("hidden");
  }
});
canvas.addEventListener("dblclick", e => {
  const rect = canvas.getBoundingClientRect();
  const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  for (const b of S.boxes) {
    if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) {
      focusPerson(b.pid);
      return;
    }
  }
});
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const factor = Math.exp(-e.deltaY * 0.0015);
  const ns = Math.min(4, Math.max(0.08, S.t.s * factor));
  const wx = (mx - S.t.x) / S.t.s, wy = (my - S.t.y) / S.t.s;
  S.t.x = mx - wx * ns;
  S.t.y = my - wy * ns;
  S.t.s = ns;
  draw();
}, { passive: false });

function focusPerson(pid) {
  if (!S.P.has(pid)) return;
  S.focal = pid;
  buildGroups();
  fitView();
  showDetail(pid);
  toast(`Arbre recentré sur ${S.P.get(pid).name}`);
}

/* ------------------------------------------------------------------ */
/* Recherche                                                           */
/* ------------------------------------------------------------------ */

const searchInput = document.getElementById("search");
const searchResults = document.getElementById("search-results");
let searchIndex = [];

function buildSearchIndex() {
  searchIndex = S.data.persons.map(p => ({
    id: p.id,
    label: p.name,
    sub: lifeLine(p),
    hay: (p.name + " " + p.birthPlace + " " + p.deathPlace).toLowerCase(),
  }));
}

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim().toLowerCase();
  if (q.length < 2) { searchResults.classList.add("hidden"); return; }
  const hits = searchIndex.filter(e => e.hay.includes(q)).slice(0, 12);
  if (!hits.length) { searchResults.classList.add("hidden"); return; }
  searchResults.innerHTML = hits.map(h =>
    `<div class="result" data-pid="${h.id}"><span>${esc(h.label)}</span><span class="dates">${esc(h.sub)}</span></div>`
  ).join("");
  searchResults.classList.remove("hidden");
  searchResults.querySelectorAll(".result").forEach(r => {
    r.onclick = () => {
      searchResults.classList.add("hidden");
      searchInput.value = "";
      focusPerson(r.dataset.pid);
    };
  });
});
searchInput.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    const first = searchResults.querySelector(".result");
    if (first) { searchResults.classList.add("hidden"); searchInput.value = ""; focusPerson(first.dataset.pid); }
  } else if (e.key === "Escape") {
    searchResults.classList.add("hidden");
    searchInput.blur();
  }
});
document.addEventListener("click", e => {
  if (!searchResults.contains(e.target) && e.target !== searchInput) searchResults.classList.add("hidden");
});

/* ------------------------------------------------------------------ */
/* Chargement des données / upload                                     */
/* ------------------------------------------------------------------ */

const welcome = document.getElementById("welcome");
const uploadError = document.getElementById("upload-error");
const fileInfo = document.getElementById("file-info");
const toastEl = document.getElementById("toast");
let toastTimer = null;

function toast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.classList.toggle("error", !!isError);
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2600);
}

function applyData(data) {
  if (data.error) { showError(data.error); return false; }
  S.data = data;
  loadMaps();
  if (data.loaded && data.count > 0) {
    welcome.classList.add("hidden");
    buildSearchIndex();
    S.focal = null;
    buildGroups();
    fitView();
    detail.classList.add("hidden");
    fileInfo.textContent = `${data.file} — ${data.count} personne${data.count > 1 ? "s" : ""}`;
  } else {
    welcome.classList.remove("hidden");
    fileInfo.textContent = "";
  }
  return true;
}

function showError(msg) {
  uploadError.textContent = msg;
  uploadError.classList.remove("hidden");
  welcome.classList.remove("hidden");
  toast(msg, true);
}

async function loadData() {
  try {
    const res = await fetch("/api/data");
    const data = await res.json();
    applyData(data);
  } catch (err) {
    showError("Impossible de joindre le serveur : " + err.message);
  }
}

async function upload(file) {
  uploadError.classList.add("hidden");
  const res = await fetch("/api/upload?name=" + encodeURIComponent(file.name), {
    method: "POST",
    body: file,
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    showError(data.error || "Import impossible");
    return false;
  }
  if (applyData(data)) toast(`${data.file} importé : ${data.count} personnes`);
  return true;
}

const fileInput = document.getElementById("file-input");
document.getElementById("btn-upload").onclick = () => fileInput.click();
document.getElementById("welcome-upload").onclick = () => fileInput.click();
fileInput.onchange = async () => {
  if (fileInput.files.length) await upload(fileInput.files[0]);
  fileInput.value = "";
};

document.getElementById("welcome-demo").onclick = async () => {
  uploadError.classList.add("hidden");
  const res = await fetch("/demo.ged");
  const blob = await res.blob();
  await upload(new File([blob], "exemple.ged", { type: "text/plain" }));
};

/* ------------------------------------------------------------------ */
/* Contrôles                                                           */
/* ------------------------------------------------------------------ */

document.getElementById("gen-dec").onclick = () => setGens(S.gens - 1);
document.getElementById("gen-inc").onclick = () => setGens(S.gens + 1);
document.getElementById("gen-value").textContent = S.gens;

function setGens(n) {
  S.gens = Math.min(8, Math.max(1, n));
  document.getElementById("gen-value").textContent = S.gens;
  buildGroups();
  fitView();
}

document.getElementById("btn-recenter").onclick = () => {
  if (S.selected) focusPerson(S.selected);
  else fitView();
};

window.addEventListener("resize", resize);
resize();
loadData();
