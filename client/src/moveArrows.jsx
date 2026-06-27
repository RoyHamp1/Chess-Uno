/** @typedef {{ from: string, to: string, piece?: string }} MoveArrow */

function sqToGrid(sq, myColor, isPlus) {
  if (isPlus) {
    const [ri, fi] = sq.split(',').map(Number);
    if (!Number.isFinite(ri) || !Number.isFinite(fi)) return null;
    return { fi, ri };
  }
  if (!sq || sq.length < 2) return null;
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq[1]);
  if (!Number.isFinite(rank) || file < 0 || file > 7 || rank < 1 || rank > 8) return null;
  if (myColor === 'w') {
    return { fi: file, ri: 8 - rank };
  }
  return { fi: 7 - file, ri: rank - 1 };
}

function cellCenterPct(fi, ri, cols, rows) {
  return { x: ((fi + 0.5) / cols) * 100, y: ((ri + 0.5) / rows) * 100 };
}

/**
 * @param {MoveArrow} move
 * @param {number} cols
 * @param {number} rows
 * @param {'w'|'b'|null|undefined} myColor
 * @param {boolean} isPlus
 */
export function buildMoveArrowPath(move, cols, rows, myColor, isPlus) {
  const from = move.from;
  const to = move.to;
  if (!from || !to) return null;

  const a = sqToGrid(from, myColor, isPlus);
  const b = sqToGrid(to, myColor, isPlus);
  if (!a || !b) return null;

  const start = cellCenterPct(a.fi, a.ri, cols, rows);
  const end = cellCenterPct(b.fi, b.ri, cols, rows);
  const dfi = b.fi - a.fi;
  const dri = b.ri - a.ri;
  const piece = String(move.piece || '').toLowerCase();

  if (piece === 'n') {
    let corner;
    if (Math.abs(dri) === 2) {
      corner = cellCenterPct(a.fi, a.ri + Math.sign(dri) * 2, cols, rows);
    } else if (Math.abs(dfi) === 2) {
      corner = cellCenterPct(a.fi + Math.sign(dfi) * 2, a.ri, cols, rows);
    } else {
      return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
    }
    return `M ${start.x} ${start.y} L ${corner.x} ${corner.y} L ${end.x} ${end.y}`;
  }

  return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
}

/**
 * @param {MoveArrow[] | null | undefined} moves
 * @param {number} cols
 * @param {number} rows
 * @param {'w'|'b'|null|undefined} myColor
 * @param {boolean} isPlus
 */
export function MoveArrowsOverlay({ moves, cols, rows, myColor, isPlus }) {
  if (!moves?.length) return null;

  const paths = moves
    .map((move, i) => {
      const d = buildMoveArrowPath(move, cols, rows, myColor, isPlus);
      return d ? { key: i, d } : null;
    })
    .filter(Boolean);

  if (!paths.length) return null;

  return (
    <svg
      className="move-arrows-layer"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      {paths.map(({ key, d }) => (
        <path key={key} d={d} className="move-arrow-path" />
      ))}
    </svg>
  );
}
