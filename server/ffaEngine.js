/** Four-way FFA on a 16×16 lattice with four 4×4 corners removed (plus / cross shape). */

export const FFA_W = 16;
export const FFA_H = 16;

/** The four 4×4 corners of the 16×16 grid are void (not playable). */
export function ffaIsHole(r, c) {
  if (r < 0 || r >= FFA_H || c < 0 || c >= FFA_W) return true;
  const inTL = r < 4 && c < 4;
  const inTR = r < 4 && c >= 12;
  const inBL = r >= 12 && c < 4;
  const inBR = r >= 12 && c >= 12;
  return inTL || inTR || inBL || inBR;
}

/** True on the 16×16 lattice excluding corner voids. */
export function ffaInPlayablePlus(r, c) {
  return !ffaIsHole(r, c);
}

/** Hub of the cross (rows 5–12, cols E–L): pawns get special movement here. */
export function ffaInMiddle(r, c) {
  return r >= 4 && r <= 11 && c >= 4 && c <= 11;
}

const CARDINAL_DIRS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

const DIAGONAL_DIRS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/** 2v2 hub: cannot step back toward home arm (black↓, grey↑, white←, beige→). */
const HUB_FORBIDDEN_STEP_2V2 = [
  [1, 0],
  [-1, 0],
  [0, -1],
  [0, 1],
];

function dirEq(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function pawnHubStepDirs2v2(army) {
  const forbid = HUB_FORBIDDEN_STEP_2V2[army];
  return CARDINAL_DIRS.filter((d) => !dirEq(d, forbid));
}

function pawnHubCaptureDirs2v2(army) {
  const forbid = HUB_FORBIDDEN_STEP_2V2[army];
  return DIAGONAL_DIRS.filter(([dr, dc]) => {
    if (forbid[0] !== 0 && dr === forbid[0]) return false;
    if (forbid[1] !== 0 && dc === forbid[1]) return false;
    return true;
  });
}

/** FFA: even vs odd armies. 2v2: P1+P2 (armies 0–1, south/north) vs P3+P4 (armies 2–3, west/east). */
export function armyTeam(army, teamMode = 'ffa') {
  if (teamMode === '2v2') return army < 2 ? 0 : 1;
  return army % 2;
}

function canCaptureArmy(attacker, targetArmy, teamMode) {
  if (targetArmy === attacker) return false;
  if (!teamMode) return targetArmy !== attacker;
  return armyTeam(targetArmy, teamMode) !== armyTeam(attacker, teamMode);
}

export function forwardForArmy(army, teamMode = 'ffa') {
  if (teamMode === '2v2') {
    const v = [
      [-1, 0],
      [1, 0],
      [0, 1],
      [0, -1],
    ];
    return v[army] ?? ARMY_FORWARD[army];
  }
  return ARMY_FORWARD[army];
}

/** Unit forward vectors (toward board center) for each army. */
export const ARMY_FORWARD = [
  [-1, 0],
  [0, -1],
  [1, 0],
  [0, 1],
];

function idx(r, c) {
  return r * FFA_W + c;
}

function onBoard(r, c) {
  return r >= 0 && r < FFA_H && c >= 0 && c < FFA_W;
}

function cellAt(board, r, c) {
  if (!ffaInPlayablePlus(r, c)) return null;
  return board[idx(r, c)];
}

function keyRC(r, c) {
  return `${r},${c}`;
}

function rot90(dr, dc) {
  return [-dc, dr];
}

function pawnStepDirs(state, r, c, army, teamMode = 'ffa') {
  const meta = state.pawnMeta[keyRC(r, c)];
  if (meta?.lock) {
    return [meta.lock];
  }
  if (ffaInMiddle(r, c) && teamMode === '2v2') {
    return pawnHubStepDirs2v2(army);
  }
  const F = forwardForArmy(army, teamMode);
  const L = rot90(F[0], F[1]);
  const Rdir = rot90(L[0], L[1]);
  if (ffaInMiddle(r, c)) {
    return [F, L, Rdir];
  }
  return [F];
}

function pawnCaptureDirs(state, r, c, army, teamMode = 'ffa') {
  const meta = state.pawnMeta[keyRC(r, c)];
  if (meta?.lock) {
    const F = meta.lock;
    const L = rot90(F[0], F[1]);
    return [
      [F[0] + L[0], F[1] + L[1]],
      [F[0] - L[0], F[1] - L[1]],
    ];
  }
  const F = forwardForArmy(army, teamMode);
  const L = rot90(F[0], F[1]);
  const Rdir = rot90(L[0], L[1]);
  if (ffaInMiddle(r, c) && teamMode === '2v2') {
    return pawnHubCaptureDirs2v2(army);
  }
  return [
    [F[0] + L[0], F[1] + L[1]],
    [F[0] + Rdir[0], F[1] + Rdir[1]],
  ];
}

function addRay(board, army, r, c, dr, dc, out, captureOnly, teamsMode) {
  let nr = r + dr;
  let nc = c + dc;
  while (ffaInPlayablePlus(nr, nc)) {
    const t = cellAt(board, nr, nc);
    if (!t) {
      if (!captureOnly) out.push([nr, nc]);
      nr += dr;
      nc += dc;
      continue;
    }
    if (canCaptureArmy(army, t.a, teamsMode)) out.push([nr, nc]);
    break;
  }
}

function addKnight(board, army, r, c, out, teamsMode) {
  const deltas = [
    [2, 1],
    [2, -1],
    [-2, 1],
    [-2, -1],
    [1, 2],
    [1, -2],
    [-1, 2],
    [-1, -2],
  ];
  for (const [dr, dc] of deltas) {
    const nr = r + dr;
    const nc = c + dc;
    if (!ffaInPlayablePlus(nr, nc)) continue;
    const t = cellAt(board, nr, nc);
    if (!t || canCaptureArmy(army, t.a, teamsMode)) out.push([nr, nc]);
  }
}

function addKing(board, army, r, c, out, teamsMode) {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (!ffaInPlayablePlus(nr, nc)) continue;
      const t = cellAt(board, nr, nc);
      if (!t || canCaptureArmy(army, t.a, teamsMode)) out.push([nr, nc]);
    }
  }
}

function collectPseudoMovesFull(state, r, c, p, out, attacksOnly, teamMode = false) {
  const board = state.board;
  const army = p.a;
  const t = p.t.toLowerCase();
  if (t === 'r') {
    for (const [dr, dc] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      addRay(board, army, r, c, dr, dc, out, attacksOnly, teamMode);
    }
    return;
  }
  if (t === 'b') {
    for (const [dr, dc] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      addRay(board, army, r, c, dr, dc, out, attacksOnly, teamMode);
    }
    return;
  }
  if (t === 'q') {
    for (const [dr, dc] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      addRay(board, army, r, c, dr, dc, out, attacksOnly, teamMode);
    }
    return;
  }
  if (t === 'n') {
    addKnight(board, army, r, c, out, teamMode);
    return;
  }
  if (t === 'k') {
    addKing(board, army, r, c, out, teamMode);
    return;
  }
  if (t === 'p') {
    const pawnMode = teamMode || 'ffa';
    if (!attacksOnly) {
      const steps = pawnStepDirs(state, r, c, army, pawnMode);
      for (const [dr, dc] of steps) {
        const nr = r + dr;
        const nc = c + dc;
        if (!ffaInPlayablePlus(nr, nc)) continue;
        const occ = cellAt(board, nr, nc);
        if (!occ) out.push([nr, nc]);
      }
    }
    const caps = pawnCaptureDirs(state, r, c, army, pawnMode);
    for (const [dr, dc] of caps) {
      const nr = r + dr;
      const nc = c + dc;
      if (!ffaInPlayablePlus(nr, nc)) continue;
      const occ = cellAt(board, nr, nc);
      if (occ && canCaptureArmy(army, occ.a, teamMode)) out.push([nr, nc]);
    }
  }
}

function kingSquareOf(board, army) {
  for (let r = 0; r < FFA_H; r++) {
    for (let c = 0; c < FFA_W; c++) {
      if (!ffaInPlayablePlus(r, c)) continue;
      const p = cellAt(board, r, c);
      if (p && p.a === army && p.t.toLowerCase() === 'k') return [r, c];
    }
  }
  return null;
}

function cloneBoard(board) {
  return board.map((x) => (x ? { ...x } : null));
}

function clonePawnMeta(pm) {
  const o = {};
  for (const k of Object.keys(pm)) {
    const v = pm[k];
    o[k] = v.lock ? { ...v, lock: [...v.lock] } : { ...v };
  }
  return o;
}

export function cloneFfaState(state) {
  return {
    board: cloneBoard(state.board),
    pawnMeta: clonePawnMeta(state.pawnMeta),
  };
}

function squaresAttackedByArmy(state, army, teamMode = false) {
  const attacked = new Set();
  const board = state.board;
  for (let r = 0; r < FFA_H; r++) {
    for (let c = 0; c < FFA_W; c++) {
      if (!ffaInPlayablePlus(r, c)) continue;
      const p = cellAt(board, r, c);
      if (!p || p.a !== army) continue;
      const raw = [];
      collectPseudoMovesFull(state, r, c, p, raw, p.t.toLowerCase() === 'p', teamMode);
      for (const [tr, tc] of raw) attacked.add(keyRC(tr, tc));
    }
  }
  return attacked;
}

export function ffaLegalMoves(state, fr, fc, teamMode = false) {
  const p = cellAt(state.board, fr, fc);
  if (!p) return [];
  const raw = [];
  collectPseudoMovesFull(state, fr, fc, p, raw, false, teamMode);
  const out = [];
  const army = p.a;
  const promoMode = teamMode === '2v2' ? '2v2' : 'ffa';
  for (const [tr, tc] of raw) {
    const test = cloneFfaState(state);
    const i0 = idx(fr, fc);
    const i1 = idx(tr, tc);
    test.board[i1] = { ...p };
    test.board[i0] = null;
    if (p.t.toLowerCase() === 'p') {
      const pr = ffaPawnReachesPromotionEdge(army, tr, tc, promoMode) ? 'q' : null;
      if (pr) test.board[i1].t = 'Q';
    }
    const ks = kingSquareOf(test.board, army);
    if (!ks) {
      out.push([tr, tc]);
      continue;
    }
    let safe = true;
    for (let a = 0; a < 4; a++) {
      if (a === army) continue;
      if (teamMode && armyTeam(a, teamMode) === armyTeam(army, teamMode)) continue;
      const atk = squaresAttackedByArmy(test, a, teamMode);
      if (atk.has(keyRC(ks[0], ks[1]))) {
        safe = false;
        break;
      }
    }
    if (safe) out.push([tr, tc]);
  }
  return out;
}

export function ffaPawnReachesPromotionEdge(army, tr, tc, teamMode = 'ffa') {
  if (teamMode === '2v2') {
    if (army === 0) return tr === 0;
    if (army === 1) return tr === FFA_H - 1;
    if (army === 2) return tc === FFA_W - 1;
    if (army === 3) return tc === 0;
    return false;
  }
  if (army === 0) return tr === 0;
  if (army === 2) return tr === FFA_H - 1;
  if (army === 1) return tc === 0;
  if (army === 3) return tc === FFA_W - 1;
  return false;
}

export function teamHasLivingKing(board, team, teamMode = '2v2') {
  for (let a = 0; a < 4; a++) {
    if (armyTeam(a, teamMode) !== team) continue;
    if (kingSquareOf(board, a)) return true;
  }
  return false;
}

/** @returns {null | 0 | 1} winning team when one side has no kings left */
export function ffaWinningTeam2v2(board) {
  const t0 = teamHasLivingKing(board, 0, '2v2');
  const t1 = teamHasLivingKing(board, 1, '2v2');
  if (t0 && t1) return null;
  if (!t0 && !t1) return null;
  return t0 ? 0 : 1;
}

/** Apply move; returns new state or null if illegal. */
export function ffaApplyMove(state, fr, fc, tr, tc, promotion, teamMode = false) {
  const moves = ffaLegalMoves(state, fr, fc, teamMode);
  if (!moves.some(([r2, c2]) => r2 === tr && c2 === tc)) return null;
  const next = cloneFfaState(state);
  const i0 = idx(fr, fc);
  const i1 = idx(tr, tc);
  const piece = next.board[i0];
  if (!piece) return null;
  next.board[i1] = { ...piece };
  next.board[i0] = null;

  const promoMode = teamMode === '2v2' ? '2v2' : 'ffa';
  if (piece.t.toLowerCase() === 'p' && ffaPawnReachesPromotionEdge(piece.a, tr, tc, promoMode)) {
    const pr = (promotion || 'q').toLowerCase().slice(0, 1);
    if ('qrbn'.includes(pr)) next.board[i1].t = pr === 'n' ? 'N' : pr.toUpperCase();
  }

  const oldKey = keyRC(fr, fc);
  delete next.pawnMeta[oldKey];
  if (piece.t.toLowerCase() === 'p') {
    const wasMid = ffaInMiddle(fr, fc);
    const nowMid = ffaInMiddle(tr, tc);
    let lock = null;
    if (teamMode === '2v2' && nowMid) {
      lock = null;
    } else if (wasMid && !nowMid) {
      lock = [Math.sign(tr - fr) || 0, Math.sign(tc - fc) || 0];
      if (lock[0] === 0 && lock[1] === 0) lock = null;
    } else if (!wasMid) {
      const prev = state.pawnMeta[oldKey]?.lock;
      if (prev) lock = prev;
    }
    const nk = keyRC(tr, tc);
    next.pawnMeta[nk] = { inMid: nowMid, lock };
  }

  return next;
}

function place(board, r, c, t, a) {
  board[idx(r, c)] = { t, a };
}

function fillStandardBlock(board, army, corner) {
  const back = 'RNBQKBNR';
  const files = 8;
  if (corner === 's') {
    for (let i = 0; i < files; i++) {
      place(board, 15, 4 + i, back[i], army);
      place(board, 14, 4 + i, 'P', army);
    }
  } else if (corner === 'n') {
    for (let i = 0; i < files; i++) {
      place(board, 0, 4 + i, back[7 - i], army);
      place(board, 1, 4 + i, 'P', army);
    }
  } else if (corner === 'e') {
    for (let i = 0; i < files; i++) {
      place(board, 4 + i, 15, back[7 - i], army);
      place(board, 4 + i, 14, 'P', army);
    }
  } else if (corner === 'w') {
    for (let i = 0; i < files; i++) {
      place(board, 4 + i, 0, back[i], army);
      place(board, 4 + i, 1, 'P', army);
    }
  }
}

export function createFfaState() {
  const board = Array(FFA_W * FFA_H).fill(null);
  fillStandardBlock(board, 0, 's');
  fillStandardBlock(board, 2, 'n');
  fillStandardBlock(board, 1, 'e');
  fillStandardBlock(board, 3, 'w');
  return { board, pawnMeta: {} };
}

/** 2v2: P1 black south, P2 grey north, P3 white west, P4 beige east (seat index = army). */
export function create2v2State() {
  const board = Array(FFA_W * FFA_H).fill(null);
  fillStandardBlock(board, 0, 's');
  fillStandardBlock(board, 1, 'n');
  fillStandardBlock(board, 2, 'w');
  fillStandardBlock(board, 3, 'e');
  return { board, pawnMeta: {} };
}

export function ffaArmiesAlive(board) {
  const alive = new Set();
  for (const p of board) {
    if (p && p.t.toLowerCase() === 'k') alive.add(p.a);
  }
  return alive;
}

export function ffaWinnerArmy(board) {
  const alive = [...ffaArmiesAlive(board)];
  if (alive.length === 1) return alive[0];
  return null;
}

export function serializeFfaBoard(state) {
  return {
    w: FFA_W,
    h: FFA_H,
    cells: state.board.map((p) => (p ? { t: p.t, a: p.a } : null)),
    pawnMeta: state.pawnMeta,
  };
}
