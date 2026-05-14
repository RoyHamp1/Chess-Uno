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

/** Hub of the cross (8×8 center): pawns get lateral / forward choice here. */
export function ffaInMiddle(r, c) {
  return r >= 4 && r <= 11 && c >= 4 && c <= 11;
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

function pawnStepDirs(state, r, c, army) {
  const F = ARMY_FORWARD[army];
  const L = rot90(F[0], F[1]);
  const Rdir = rot90(L[0], L[1]);
  const meta = state.pawnMeta[keyRC(r, c)];
  if (meta?.lock) {
    return [meta.lock];
  }
  if (ffaInMiddle(r, c)) {
    return [F, L, Rdir];
  }
  return [F];
}

function pawnCaptureDirs(state, r, c, army) {
  const F = ARMY_FORWARD[army];
  const L = rot90(F[0], F[1]);
  const Rdir = rot90(L[0], L[1]);
  const meta = state.pawnMeta[keyRC(r, c)];
  if (meta?.lock) {
    const d = meta.lock;
    return [
      [d[0] + L[0], d[1] + L[1]],
      [d[0] + Rdir[0], d[1] + Rdir[1]],
    ];
  }
  return [
    [F[0] + L[0], F[1] + L[1]],
    [F[0] + Rdir[0], F[1] + Rdir[1]],
  ];
}

function addRay(board, army, r, c, dr, dc, out, captureOnly) {
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
    if (t.a !== army) out.push([nr, nc]);
    break;
  }
}

function addKnight(board, army, r, c, out) {
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
    if (!t || t.a !== army) out.push([nr, nc]);
  }
}

function addKing(board, army, r, c, out) {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (!ffaInPlayablePlus(nr, nc)) continue;
      const t = cellAt(board, nr, nc);
      if (!t || t.a !== army) out.push([nr, nc]);
    }
  }
}

function collectPseudoMovesFull(state, r, c, p, out, attacksOnly) {
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
      addRay(board, army, r, c, dr, dc, out, attacksOnly);
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
      addRay(board, army, r, c, dr, dc, out, attacksOnly);
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
      addRay(board, army, r, c, dr, dc, out, attacksOnly);
    }
    return;
  }
  if (t === 'n') {
    addKnight(board, army, r, c, out);
    return;
  }
  if (t === 'k') {
    addKing(board, army, r, c, out);
    return;
  }
  if (t === 'p') {
    if (!attacksOnly) {
      const steps = pawnStepDirs(state, r, c, army);
      for (const [dr, dc] of steps) {
        const nr = r + dr;
        const nc = c + dc;
        if (!ffaInPlayablePlus(nr, nc)) continue;
        const occ = cellAt(board, nr, nc);
        if (!occ) out.push([nr, nc]);
      }
    }
    const caps = pawnCaptureDirs(state, r, c, army);
    for (const [dr, dc] of caps) {
      const nr = r + dr;
      const nc = c + dc;
      if (!ffaInPlayablePlus(nr, nc)) continue;
      const occ = cellAt(board, nr, nc);
      if (occ && occ.a !== army) out.push([nr, nc]);
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

function squaresAttackedByArmy(state, army) {
  const attacked = new Set();
  const board = state.board;
  for (let r = 0; r < FFA_H; r++) {
    for (let c = 0; c < FFA_W; c++) {
      if (!ffaInPlayablePlus(r, c)) continue;
      const p = cellAt(board, r, c);
      if (!p || p.a !== army) continue;
      const raw = [];
      collectPseudoMovesFull(state, r, c, p, raw, p.t.toLowerCase() === 'p');
      for (const [tr, tc] of raw) attacked.add(keyRC(tr, tc));
    }
  }
  return attacked;
}

export function ffaLegalMoves(state, fr, fc) {
  const p = cellAt(state.board, fr, fc);
  if (!p) return [];
  const raw = [];
  collectPseudoMovesFull(state, fr, fc, p, raw, false);
  const out = [];
  const army = p.a;
  for (const [tr, tc] of raw) {
    const test = cloneFfaState(state);
    const i0 = idx(fr, fc);
    const i1 = idx(tr, tc);
    test.board[i1] = { ...p };
    test.board[i0] = null;
    if (p.t.toLowerCase() === 'p') {
      const pr = ffaPawnReachesPromotionEdge(army, tr, tc) ? 'q' : null;
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
      const atk = squaresAttackedByArmy(test, a);
      if (atk.has(keyRC(ks[0], ks[1]))) {
        safe = false;
        break;
      }
    }
    if (safe) out.push([tr, tc]);
  }
  return out;
}

export function ffaPawnReachesPromotionEdge(army, tr, tc) {
  if (army === 0) return tr === 0;
  if (army === 2) return tr === FFA_H - 1;
  if (army === 1) return tc === 0;
  if (army === 3) return tc === FFA_W - 1;
  return false;
}

/** Apply move; returns new state or null if illegal. */
export function ffaApplyMove(state, fr, fc, tr, tc, promotion) {
  const moves = ffaLegalMoves(state, fr, fc);
  if (!moves.some(([r2, c2]) => r2 === tr && c2 === tc)) return null;
  const next = cloneFfaState(state);
  const i0 = idx(fr, fc);
  const i1 = idx(tr, tc);
  const piece = next.board[i0];
  if (!piece) return null;
  next.board[i1] = { ...piece };
  next.board[i0] = null;

  if (piece.t.toLowerCase() === 'p' && ffaPawnReachesPromotionEdge(piece.a, tr, tc)) {
    const pr = (promotion || 'q').toLowerCase().slice(0, 1);
    if ('qrbn'.includes(pr)) next.board[i1].t = pr === 'n' ? 'N' : pr.toUpperCase();
  }

  const oldKey = keyRC(fr, fc);
  delete next.pawnMeta[oldKey];
  if (piece.t.toLowerCase() === 'p') {
    const wasMid = ffaInMiddle(fr, fc);
    const nowMid = ffaInMiddle(tr, tc);
    let lock = null;
    if (wasMid && !nowMid) {
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
