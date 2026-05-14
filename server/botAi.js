import { Chess } from 'chess.js';

const PIECE_VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

function evaluateMaterial(chess) {
  let score = 0;
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) continue;
      const v = PIECE_VAL[p.type] ?? 0;
      score += p.color === 'w' ? v : -v;
    }
  }
  return score;
}

function negamax(chess, depth, alpha, beta, rootWhite) {
  if (depth === 0) {
    const ev = evaluateMaterial(chess);
    return chess.turn() === 'w' ? ev : -ev;
  }
  const moves = chess.moves({ verbose: true });
  if (!moves.length) {
    if (chess.isCheckmate()) return chess.turn() === rootWhite ? -1e6 : 1e6;
    return 0;
  }
  let best = -Infinity;
  for (const m of moves) {
    chess.move(m);
    const sc = -negamax(chess, depth - 1, -beta, -alpha, rootWhite);
    chess.undo();
    if (sc > best) best = sc;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * @param {string} fen
 * @param {'w'|'b'} sideToMove
 * @param {'easy'|'medium'|'hard'|'extreme'} difficulty
 * @returns {{ from: string, to: string, promotion?: string } | null}
 */
export function pickChessMove(fen, sideToMove, difficulty) {
  const chess = new Chess(fen);
  if (chess.turn() !== sideToMove) {
    const p = fen.split(' ');
    p[1] = sideToMove;
    if (!chess.load(p.join(' '))) return null;
  }
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;

  if (difficulty === 'easy') {
    const m = moves[Math.floor(Math.random() * moves.length)];
    return { from: m.from, to: m.to, promotion: m.promotion || undefined };
  }

  if (difficulty === 'medium') {
    const caps = moves.filter((m) => m.captured || m.san.includes('x'));
    const pool = caps.length ? caps : moves;
    const m = pool[Math.floor(Math.random() * pool.length)];
    return { from: m.from, to: m.to, promotion: m.promotion || undefined };
  }

  const depth = difficulty === 'hard' ? 2 : 3;
  let bestMove = moves[0];
  let bestSc = -Infinity;
  const rootWhite = sideToMove === 'w';
  for (const m of moves) {
    chess.move(m);
    const sc = -negamax(chess, depth - 1, -Infinity, Infinity, rootWhite);
    chess.undo();
    if (sc > bestSc) {
      bestSc = sc;
      bestMove = m;
    }
  }
  return {
    from: bestMove.from,
    to: bestMove.to,
    promotion: bestMove.promotion || undefined,
  };
}

/**
 * @param {(state: any, fr: number, fc: number) => [number, number][]} ffaLegalMovesFn
 * @param {any} state — FFA engine state { board, pawnMeta }
 * @param {number} army
 * @param {number} w
 * @param {number} h
 * @param {'easy'|'medium'|'hard'|'extreme'} difficulty
 */
export function pickFfaMove(ffaLegalMovesFn, state, army, w, h, difficulty) {
  const board = state.board;
  const all = [];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const p = board[i];
      if (!p || p.a !== army) continue;
      const moves = ffaLegalMovesFn(state, r, c);
      for (const [tr, tc] of moves) {
        const t = board[tr * w + tc];
        const cap = t && t.a !== army;
        all.push({ fr: r, fc: c, tr, tc, cap: !!cap });
      }
    }
  }
  if (!all.length) return null;
  if (difficulty === 'easy') {
    const pick = all[Math.floor(Math.random() * all.length)];
    return { from: `${pick.fr},${pick.fc}`, to: `${pick.tr},${pick.tc}` };
  }
  if (difficulty === 'medium') {
    const caps = all.filter((x) => x.cap);
    const pool = caps.length ? caps : all;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return { from: `${pick.fr},${pick.fc}`, to: `${pick.tr},${pick.tc}` };
  }
  const caps = all.filter((x) => x.cap);
  const pool = caps.length ? caps : all;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return { from: `${pick.fr},${pick.fc}`, to: `${pick.tr},${pick.tc}` };
}

export function pickBonusPayload(legalSquares, recoverableTypes) {
  const sq = legalSquares[Math.floor(Math.random() * legalSquares.length)];
  if (recoverableTypes?.length && Math.random() < 0.45) {
    const t = recoverableTypes[Math.floor(Math.random() * recoverableTypes.length)];
    return { action: 'recover', pieceType: t, square: sq };
  }
  return { action: 'pawn', square: sq };
}
