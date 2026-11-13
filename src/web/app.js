/* Généalogie — visualisation d'arbre GEDCOM (améliorée) */
"use strict";

const S = {
  data: null,
  P: new Map(),
  F: new Map(),
  focal: null,
  gens: 4,
  groups: [],
  upEdges: [],  // groupes parents reliés au focal
  boxes: [],
  t: { x: 0, y: 0, s: 1 },
  selected: null,
  hovered: null,
  pathSet: new Set(), // ids mis en avant (lignée du focal/sélection)
};

const NODE_W = 188, NODE_H = 60, COUPLE_GAP = 10, SIB_GAP = 44, ROW_H = 150;

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
  return "dates inconnues";
}
function parentsOf(pid) {
  const p = S.P.get(pid);
  if (!p || !p.famc) return null;
  const f = S.F.get(p.famc);
  if (!f) return null;
  return { father: f.husb, mother: f.wife };
}
function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0] ? parts[0][0] : "";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0] && parts[0][1] ? parts[0][1] : "");
  return (a + b).toUpperCase();
}

/* ----------------------- mise en avant de lignée ----------------------- */
function computePathSet() {
  const set = new Set();
  const root = S.selected || S.focal;
  if (!root || !S.P.has(root)) { S.pathSet = set; return; }
  // ancêtres
  (function up(id, depth) {
    if (!id || !S.P.has(id) || depth > S.gens) return;
    set.add(id);
    const par = parentsOf(id);
    if (par) { up(par.father, depth + 1); up(par.mother, depth + 1); }
  })(root, 0);
  // descendants
  (function down(id, depth) {
    if (!id || !S.P.has(id) || depth > S.gens) return;
    set.add(id);
    const p = S.P.get(id);
    if (!p || !p.fams) return;
    for (const fx of p.fams) {
      const f = S.F.get(fx);
      if (!f) continue;
      for (const c of f.children) down(c, depth + 1);
    }
  })(root, 0);
  S.pathSet = set;
}

/* ----------------------- construction de l'arbre ----------------------- */
function buildGroups() {
  S.groups = []; S.boxes = [];
  if (!S.focal || !S.P.has(S.focal)) {
    let best = null, bestScore = -1;
    for (const p of S.P.values()) {
      const score = (p.fams ? p.fams.length : 0) + (p.famc ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = p.id; }
    }
    S.focal = best;
    if (!best) { computePathSet(); return; }
  }

  const visited = new Set();

  function makeGroup(pid, dir, gen) {
    const g = { dir, gen, members: [], famLinks: [], subs: [], y: 0, x: 0, w: 0 };
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

  function computeWidth(g, subs) {
    if (!subs.length) { g.w = Math.max(g.w, NODE_W); return; }
    const subW = subs.reduce((a, s) => a + s.w, 0) + (subs.length - 1) * SIB_GAP;
    g.w = Math.max(g.w, subW);
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
          if (cg && cg.members.length) { cg.attachedTo = mid; childGroups.push(cg); growDown(cg, gen + 1); }
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
      for (const pid of par ? [par.father, par.mother] : []) {
        if (!pid || !S.P.has(pid) || visited.has(pid)) continue;
        const pg = makeGroup(pid, "up", gen + 1);
        if (pg && pg.members.length) { pg.attachedTo = mid; parentGroups.push(pg); growUp(pg, gen + 1); }
      }
    }
    const kept = [], seen = new Set();
    for (const pg of parentGroups) {
      const key = pg.members.join("+");
      if (seen.has(key)) continue;
      seen.add(key); kept.push(pg);
    }
    g.subs = kept;
    computeWidth(g, kept);
  }

  function layout(g, left) {
    if (!g.subs.length) {
      g.x = left + g.w / 2;
      return;
    }
    let cur = left;
    for (const s of g.subs) { layout(s, cur); cur += s.w + SIB_GAP; }
    g.x = (g.subs[0].x + g.subs[g.subs.length - 1].x) / 2;
  }

  const focal = makeGroup(S.focal, "down", 0);
  growDown(focal, 0);
  visited.clear();

  // arbre ascendant : ancre invisible reliée au groupe focal (pas de doublon du focal)
  const upRoot = { dir: "up", gen: 0, members: [], famLinks: [], subs: [], y: 0, x: 0, w: NODE_W, anchor: true, childTarget: focal };
  const par = parentsOf(S.focal);
  const pg = [];
  for (const pid of par ? [par.father, par.mother] : []) {
    if (pid && S.P.has(pid) && !visited.has(pid)) {
      const g2 = makeGroup(pid, "up", 1);
      if (g2 && g2.members.length) { g2.attachedTo = S.focal; pg.push(g2); growUp(g2, 1); }
    }
  }
  const dedup = [], ks = new Set();
  for (const g2 of pg) {
    const key = g2.members.join("+");
    if (!ks.has(key)) { ks.add(key); dedup.push(g2); }
  }
  upRoot.subs = dedup;
  computeWidth(upRoot, dedup);

  layout(focal, -focal.w / 2);
  let cur = focal.x - upRoot.w / 2;
  for (const s of upRoot.subs) { layout(s, cur); cur += s.w + SIB_GAP; }
  upRoot.x = upRoot.subs.length ? (upRoot.subs[0].x + upRoot.subs[upRoot.subs.length - 1].x) / 2 : focal.x;

  focal.y = 0; upRoot.y = 0;
  const walkDown = (g) => { for (const s of g.subs) { s.y = s.gen * ROW_H; walkDown(s); } };
  const walkUp = (g) => { for (const s of g.subs) { s.y = -s.gen * ROW_H; walkUp(s); } };
  walkDown(focal);
  walkUp(upRoot);

  function collect(g, out) { for (const s of g.subs) { out.push(s); collect(s, out); } return out; }
  S.groups = [focal, ...collect(focal, []), ...collect(upRoot, [])];
  S.upEdges = upRoot.subs; // parents à relier vers le focal
  computePathSet();
}

/* ----------------------- rendu canvas ----------------------- */
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  draw();
}
function screenToWorld(x, y) { return { x: (x - S.t.x) / S.t.s, y: (y - S.t.y) / S.t.s }; }

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  drawBackground(W, H);
  if (!isFinite(S.t.x) || !isFinite(S.t.y) || !isFinite(S.t.s) || S.t.s <= 0) {
    S.t = { x: W / 2, y: H / 2, s: 1 };
  }
  ctx.save();
  ctx.translate(S.t.x, S.t.y);
  ctx.scale(S.t.s, S.t.s);
  drawEdges();
  drawBoxes();
  ctx.restore();
}

function drawBackground(W, H) {
  const h = Number.isFinite(H) && H > 0 ? H : 1;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#101521");
  g.addColorStop(1, "#0c0f16");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // grille de points subtile
  const step = 28 * S.t.s;
  if (step < 8) return;
  const ox = ((S.t.x % step) + step) % step;
  const oy = ((S.t.y % step) + step) % step;
  ctx.fillStyle = "rgba(255,255,255,0.045)";
  for (let y = oy - step; y < H + step; y += step) {
    for (let x = ox - step; x < W + step; x += step) {
      ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function groupMemberX(g, i) {
  return g.x + (i - (g.members.length - 1) / 2) * (NODE_W + COUPLE_GAP);
}

function isHighlighted(id) { return S.pathSet.has(id); }

function drawCurve(fromX, fromY, toX, toY, hi) {
  ctx.strokeStyle = hi ? "rgba(124, 240, 200, 0.55)" : "rgba(140, 160, 190, 0.22)";
  ctx.lineWidth = hi ? 2.4 : 1.4;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  const midY = (fromY + toY) / 2;
  ctx.bezierCurveTo(fromX, midY, toX, midY, toX, toY);
  ctx.stroke();
}

function drawEdges() {
  const focalGroup = S.groups[0];

  for (const g of S.groups) {
    if (!g || !g.subs) continue;
    for (const s of g.subs) {
      // sens : toujours du nœud du haut vers le nœud du bas
      let upper = g, lower = s;
      if (s.y < g.y) { upper = s; lower = g; }
      const attachId = lower.attachedTo || (upper === g ? s.members[0] : g.members[0]);
      let attachIdx = lower.members ? -1 : -1;
      // point d'attache sur le nœud du bas = personne reliée (si connue)
      if (lower.members) attachIdx = lower.members.indexOf(attachId);
      if (attachIdx < 0 && lower.members) attachIdx = Math.floor(lower.members.length / 2);
      // pour côté ascendant, le parent (upper) est attaché à un enfant spécifique (lower.attachedTo)
      if (upper === s && lower === g) {
        // s au-dessus, g en dessous : on part du centre du parent s vers le point d'attache dans g
        const toX = lower.members && attachIdx >= 0 ? groupMemberX(lower, attachIdx) : lower.x;
        const toY = lower.y - NODE_H / 2;
        const fromX = upper.x;
        const fromY = upper.y + NODE_H / 2;
        const hi = upper.members.some(isHighlighted) && lower.members.some(isHighlighted);
        drawCurve(fromX, fromY, toX, toY, hi);
      } else {
        // g au-dessus, s en dessous (descendance)
        attachIdx = g.members.indexOf(s.attachedTo);
        if (attachIdx < 0) attachIdx = Math.floor(g.members.length / 2);
        const fromX = groupMemberX(g, attachIdx);
        const fromY = g.y + NODE_H / 2;
        const toX = s.x;
        const toY = s.y - NODE_H / 2;
        const hi = s.members.some(isHighlighted) && g.members.some(isHighlighted);
        drawCurve(fromX, fromY, toX, toY, hi);
      }
    }
    // liens couple
    for (const l of g.famLinks) {
      const ai = g.members.indexOf(l.a), bi = g.members.indexOf(l.b);
      if (ai < 0 || bi < 0) continue;
      const ax = groupMemberX(g, ai), bx = groupMemberX(g, bi);
      const x1 = ax + (bx > ax ? NODE_W / 2 : -NODE_W / 2);
      const x2 = bx + (bx > ax ? -NODE_W / 2 : NODE_W / 2);
      const hi = isHighlighted(l.a) || isHighlighted(l.b);
      ctx.strokeStyle = hi ? "rgba(255, 209, 102, 0.55)" : "rgba(200, 210, 225, 0.25)";
      ctx.lineWidth = hi ? 2.2 : 1.6;
      ctx.beginPath();
      ctx.moveTo(x1, g.y);
      ctx.lineTo(x2, g.y);
      ctx.stroke();
      if (l.year) {
        ctx.fillStyle = hi ? "#ffd166" : "rgba(160,175,195,0.7)";
        ctx.font = "500 11px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText("⚭ " + l.year, (x1 + x2) / 2, g.y - 4);
      }
    }
  }

  // liaisons ascendantes : des parents (au-dessus) vers le focal (au centre)
  if (focalGroup) {
    for (const s of (S.upEdges || [])) {
      const fromX = s.x;
      const fromY = s.y + NODE_H / 2;       // bas du groupe parent
      const attachId = s.attachedTo || S.focal;
      let attachIdx = focalGroup.members.indexOf(attachId);
      if (attachIdx === -1) attachIdx = 0;
      const toX = groupMemberX(focalGroup, attachIdx);
      const toY = focalGroup.y - NODE_H / 2; // haut du focal
      const hi = s.members.some(isHighlighted) && isHighlighted(attachId);
      drawCurve(fromX, fromY, toX, toY, hi);
    }
  }
}

function drawBoxes() {
  S.boxes = [];
  for (const g of S.groups) {
    if (!g) continue;
    for (let i = 0; i < g.members.length; i++) {
      const p = S.P.get(g.members[i]);
      if (!p) continue;
      drawPersonBox(groupMemberX(g, i), g.y, p);
    }
  }
}

function roundRectPath(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function drawPersonBox(cx, cy, p) {
  const w = NODE_W, h = NODE_H;
  const x = cx - w / 2, y = cy - h / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  S.boxes.push({ x, y, w, h, pid: p.id });

  const isFocal = p.id === S.focal;
  const isSel = p.id === S.selected;
  const isHover = p.id === S.hovered;
  const hi = isHighlighted(p.id);

  const pal = {
    M: { base: "#182a40", top: "#234669", border: "#4a90e2", accent: "#6db3ff" },
    F: { base: "#3a1d2b", top: "#5a2d41", border: "#e06a8a", accent: "#ff9fba" },
    U: { base: "#252b36", top: "#343c4b", border: "#8b95a7", accent: "#b8c2d3" },
  }[p.sex] || { base: "#252b36", top: "#343c4b", border: "#8b95a7", accent: "#b8c2d3" };

  // ombre / halo
  if (isFocal || isSel || isHover) {
    ctx.save();
    ctx.shadowColor = isFocal ? "rgba(255,209,102,0.45)" : isSel ? "rgba(124,240,200,0.35)" : "rgba(255,255,255,0.12)";
    ctx.shadowBlur = isFocal ? 22 : 14;
    roundRectPath(ctx, x, y, w, h, 12);
    ctx.fillStyle = pal.base;
    ctx.fill();
    ctx.restore();
  }

  // fond
  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, pal.top);
  grad.addColorStop(1, pal.base);
  roundRectPath(ctx, x, y, w, h, 12);
  ctx.fillStyle = grad;
  ctx.fill();

  // bordure
  ctx.lineWidth = isFocal ? 2.6 : isSel ? 2.2 : (isHover ? 1.8 : 1);
  ctx.strokeStyle = isFocal ? "#ffd166" : isSel ? "#7cf0c8" : (hi ? pal.accent : "rgba(255,255,255,0.10)");
  ctx.stroke();

  // barre d'accent à gauche
  ctx.save();
  roundRectPath(ctx, x, y, w, h, 12);
  ctx.clip();
  ctx.fillStyle = pal.border;
  ctx.fillRect(x, y, 4, h);
  ctx.restore();

  // avatar / initiales
  const ax = x + 22, ay = cy;
  ctx.beginPath(); ctx.arc(ax, ay, 13, 0, Math.PI * 2);
  ctx.fillStyle = pal.border;
  ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1;
  ctx.strokeStyle = pal.accent; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = "#eef4ff";
  ctx.font = "700 11px Inter, system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(initials(p.name), ax, ay + 0.5);

  // texte
  const tx = x + 42;
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f3f6fb";
  ctx.font = "600 13px Inter, system-ui, sans-serif";
  ctx.fillText(truncate(p.name || "?", 17), tx, y + 24);
  ctx.fillStyle = "rgba(230,236,245,0.65)";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.fillText(truncate(lifeLine(p), 20), tx, y + 42);

  // indicateur focal
  if (isFocal) {
    ctx.fillStyle = "#ffd166";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("★", x + w - 8, y + 14);
  }
}

function truncate(s, n) { s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; }

/* ----------------------- vue / animation ----------------------- */
function computeFit() {
  if (!S.boxes.length) return { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2, s: 1 };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const b of S.boxes) { x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); }
  if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) {
    return { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2, s: 1 };
  }
  const cw = canvas.clientWidth || 1, ch = canvas.clientHeight || 1, pad = 70;
  const dx = (x2 - x1) || 1, dy = (y2 - y1) || 1;
  const s = Math.max(0.08, Math.min((cw - 2 * pad) / dx, (ch - 2 * pad) / dy, 1.5));
  const tx = (cw - (x1 + x2) * s) / 2, ty = (ch - (y1 + y2) * s) / 2;
  return { s: isFinite(s) ? s : 1, x: isFinite(tx) ? tx : cw / 2, y: isFinite(ty) ? ty : ch / 2 };
}

let animId = null;
function animateTo(target, ms = 320) {
  if (animId) cancelAnimationFrame(animId);
  const from = { ...S.t }, t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  (function step(now) {
    const k = Math.min(1, (now - t0) / ms);
    const e = ease(k);
    S.t.x = from.x + (target.x - from.x) * e;
    S.t.y = from.y + (target.y - from.y) * e;
    S.t.s = from.s + (target.s - from.s) * e;
    draw();
    if (k < 1) animId = requestAnimationFrame(step); else animId = null;
  })(t0);
}
function fitView(animated) {
  const t = computeFit();
  if (animated) animateTo(t); else { S.t = t; draw(); }
}
function zoomBy(factor, cx, cy) {
  if (animId) { cancelAnimationFrame(animId); animId = null; }
  if (cx == null) { cx = canvas.clientWidth / 2; cy = canvas.clientHeight / 2; }
  const ns = Math.min(4, Math.max(0.06, S.t.s * factor));
  const wx = (cx - S.t.x) / S.t.s, wy = (cy - S.t.y) / S.t.s;
  S.t.x = cx - wx * ns; S.t.y = cy - wy * ns; S.t.s = ns;
  draw();
}

/* ----------------------- fiche détail ----------------------- */
const detail = document.getElementById("detail");

function eventBlock(label, date, place) {
  if (!date && !place) return "";
  return `<div class="event"><div class="label">${label}</div>
    <div class="value">${esc(date || "date inconnue")}${place ? "<br><span style='color:var(--muted)'>" + esc(place) + "</span>" : ""}</div></div>`;
}

function showDetail(pid) {
  const p = S.P.get(pid);
  if (!p) return;
  S.selected = pid;
  computePathSet(); draw();
  const sex = p.sex || "U";
  const sexLabel = { M: "Homme", F: "Femme", U: "Inconnu" }[sex] || "Inconnu";

  let html = `<button class="close" title="Fermer">✕</button>
    <div class="avatar ${sex.toLowerCase()}">${esc(initials(p.name))}</div>
    <h2>${esc(p.name)} <span class="badge ${sex.toLowerCase()}">${sexLabel}</span></h2>
    <div class="years">${esc(lifeLine(p))}</div>
    ${eventBlock("Naissance", p.birth, p.birthPlace)}
    ${eventBlock("Décès", p.death, p.deathPlace)}`;

  const par = parentsOf(pid);
  const parList = [par && par.father, par && par.mother].filter(id => id && S.P.has(id));
  if (parList.length) {
    html += `<h3>Parents</h3>`;
    for (const id of parList) {
      const q = S.P.get(id);
      html += `<a class="link" data-pid="${id}"><span class="lname">${esc(q.name)}</span><small>${esc(year(q.birth) || "")}</small></a>`;
    }
  }

  if (p.fams && p.fams.length) {
    for (const fx of p.fams) {
      const f = S.F.get(fx); if (!f) continue;
      const other = f.husb === pid ? f.wife : f.husb;
      if (other && S.P.has(other)) {
        const q = S.P.get(other);
        html += `<h3>Union${f.marriage ? " · " + esc(f.marriage) : ""}</h3>`;
        html += `<a class="link" data-pid="${other}"><span class="lname">${esc(q.name)}</span><small>${esc(lifeLine(q))}</small></a>`;
      }
      const kids = (f.children || []).filter(c => S.P.has(c));
      if (kids.length) {
        html += `<h3>${other && S.P.has(other) ? "Enfants" : "Enfants"}</h3>`;
        for (const cid of kids) {
          const c = S.P.get(cid);
          html += `<a class="link" data-pid="${cid}"><span class="lname">${esc(c.name)}</span><small>${esc(lifeLine(c))}</small></a>`;
        }
      }
    }
  }

  html += `<button class="focus-btn" id="detail-focus">◎ Centrer l'arbre sur cette personne</button>`;
  detail.innerHTML = html;
  detail.classList.remove("hidden");
  detail.querySelector(".close").onclick = () => { detail.classList.add("hidden"); S.selected = null; computePathSet(); draw(); };
  detail.querySelector("#detail-focus").onclick = () => focusPerson(pid);
  detail.querySelectorAll("a.link").forEach(a => a.onclick = () => showDetail(a.dataset.pid));
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

/* ----------------------- interactions ----------------------- */
let dragging = false, dragMoved = false, dragStart = null;

canvas.addEventListener("mousedown", e => {
  dragging = true; dragMoved = false;
  dragStart = { x: e.clientX - S.t.x, y: e.clientY - S.t.y };
  canvas.classList.add("dragging");
});
window.addEventListener("mousemove", e => {
  const rect = canvas.getBoundingClientRect();
  if (dragging) {
    const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
    if (Math.abs(dx - S.t.x) > 2 || Math.abs(dy - S.t.y) > 2) dragMoved = true;
    S.t.x = dx; S.t.y = dy; draw(); return;
  }
  // hover
  const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  let h = null;
  for (let i = S.boxes.length - 1; i >= 0; i--) {
    const b = S.boxes[i];
    if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) { h = b.pid; break; }
  }
  if (h !== S.hovered) { S.hovered = h; canvas.style.cursor = h ? "pointer" : (dragging ? "grabbing" : "grab"); draw(); }
});
window.addEventListener("mouseup", e => {
  if (!dragging) return;
  dragging = false; canvas.classList.remove("dragging");
  canvas.style.cursor = S.hovered ? "pointer" : "grab";
  if (!dragMoved && e.target === canvas) {
    const rect = canvas.getBoundingClientRect();
    const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    let hit = null;
    for (let i = S.boxes.length - 1; i >= 0; i--) {
      const b = S.boxes[i];
      if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) { hit = b.pid; break; }
    }
    if (hit) showDetail(hit); else { detail.classList.add("hidden"); S.selected = null; computePathSet(); draw(); }
  }
});
canvas.addEventListener("dblclick", e => {
  const rect = canvas.getBoundingClientRect();
  const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  for (let i = S.boxes.length - 1; i >= 0; i--) {
    const b = S.boxes[i];
    if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) { focusPerson(b.pid); return; }
  }
});
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

function focusPerson(pid) {
  if (!S.P.has(pid)) return;
  S.focal = pid; S.selected = pid;
  buildGroups();
  fitView(true);
  showDetail(pid);
  toast(`Centré sur ${S.P.get(pid).name}`);
}

/* ----------------------- recherche ----------------------- */
const searchInput = document.getElementById("search");
const searchResults = document.getElementById("search-results");
let searchIndex = [];

function buildSearchIndex() {
  searchIndex = S.data.persons.map(p => ({
    id: p.id, label: p.name, sub: lifeLine(p),
    hay: (p.name + " " + (p.birthPlace||"") + " " + (p.deathPlace||"")).toLowerCase(),
  }));
}

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim().toLowerCase();
  if (q.length < 2) { searchResults.classList.add("hidden"); return; }
  const hits = searchIndex.filter(e => e.hay.includes(q)).slice(0, 12);
  if (!hits.length) { searchResults.classList.add("hidden"); return; }
  searchResults.innerHTML = hits.map(h =>
    `<div class="result" data-pid="${h.id}"><span class="name">${esc(h.label)}</span><span class="dates">${esc(h.sub)}</span></div>`
  ).join("");
  searchResults.classList.remove("hidden");
  searchResults.querySelectorAll(".result").forEach(r => r.onclick = () => {
    searchResults.classList.add("hidden"); searchInput.value = ""; focusPerson(r.dataset.pid);
  });
});
searchInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { const f = searchResults.querySelector(".result"); if (f) { searchResults.classList.add("hidden"); searchInput.value = ""; focusPerson(f.dataset.pid); } }
  else if (e.key === "Escape") { searchResults.classList.add("hidden"); searchInput.blur(); }
});
document.addEventListener("click", e => { if (!searchResults.contains(e.target) && e.target !== searchInput) searchResults.classList.add("hidden"); });

/* ----------------------- chargement / upload ----------------------- */
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
function showError(msg) {
  uploadError.textContent = msg;
  uploadError.classList.remove("hidden");
  welcome.classList.remove("hidden");
  toast(msg, true);
}
function applyData(data) {
  if (data.error) { showError(data.error); return false; }
  S.data = data; loadMaps();
  if (data.loaded && data.count > 0) {
    welcome.classList.add("hidden");
    buildSearchIndex();
    S.focal = null; S.selected = null;
    buildGroups(); fitView(false);
    detail.classList.add("hidden");
    fileInfo.textContent = `${data.file} · ${data.count} personne${data.count > 1 ? "s" : ""}`;
  } else {
    welcome.classList.remove("hidden"); fileInfo.textContent = "";
  }
  return true;
}
async function loadData() {
  try { applyData(await (await fetch("/api/data")).json()); }
  catch (err) { showError("Impossible de joindre le serveur : " + err.message); }
}
async function upload(file) {
  uploadError.classList.add("hidden");
  try {
    const res = await fetch("/api/upload?name=" + encodeURIComponent(file.name), { method: "POST", body: file });
    const data = await res.json();
    if (!res.ok || data.error) { showError(data.error || "Import impossible"); return false; }
    if (applyData(data)) toast(`${data.file} importé · ${data.count} personnes`);
    return true;
  } catch (e) { showError("Import impossible : " + e.message); return false; }
}

const fileInput = document.getElementById("file-input");
document.getElementById("btn-upload").onclick = () => fileInput.click();
document.getElementById("welcome-upload").onclick = () => fileInput.click();
fileInput.onchange = async () => { if (fileInput.files.length) await upload(fileInput.files[0]); fileInput.value = ""; };
document.getElementById("welcome-demo").onclick = async () => {
  uploadError.classList.add("hidden");
  try {
    const res = await fetch("/demo.ged");
    await upload(new File([await res.blob()], "exemple.ged", { type: "text/plain" }));
  } catch (e) { showError("Démo indisponible : " + e.message); }
};

/* ----------------------- contrôles ----------------------- */
document.getElementById("gen-dec").onclick = () => setGens(S.gens - 1);
document.getElementById("gen-inc").onclick = () => setGens(S.gens + 1);
document.getElementById("gen-value").textContent = S.gens;
function setGens(n) {
  S.gens = Math.min(8, Math.max(1, n));
  document.getElementById("gen-value").textContent = S.gens;
  buildGroups(); fitView(true);
}
document.getElementById("btn-recenter").onclick = () => { if (S.selected) focusPerson(S.selected); else if (S.focal) { S.selected = S.focal; computePathSet(); showDetail(S.focal); fitView(true); } else fitView(true); };
document.getElementById("btn-fit").onclick = () => fitView(true);
document.getElementById("btn-zoom-in").onclick = () => zoomBy(1.22);
document.getElementById("btn-zoom-out").onclick = () => zoomBy(1 / 1.22);

window.addEventListener("resize", resize);
resize();
loadData();
