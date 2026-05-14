/** Point rules use rating at match start. At/above 10k: ±5. Below: rookie / bronze / silver–GM bands. */

const BANDS = [
  { max: 1249, key: 'rookie', label: 'Rookie' },
  { max: 2499, key: 'bronze', label: 'Bronze' },
  { max: 3749, key: 'silver', label: 'Silver' },
  { max: 4999, key: 'gold', label: 'Gold' },
  { max: 6249, key: 'platinum', label: 'Platinum' },
  { max: 7499, key: 'diamond', label: 'Diamond' },
  { max: 8749, key: 'master', label: 'Master' },
  { max: 9999, key: 'grand_master', label: 'Grand Master' },
];

/**
 * @param {number} rating
 * @returns {{ win: number, loss: number }}
 */
export function getSnapshotWinLossDeltas(rating) {
  const r = Number(rating) || 0;
  if (r >= 10000) return { win: 5, loss: 5 };
  if (r <= 1249) return { win: 50, loss: 0 };
  if (r <= 2499) return { win: 40, loss: 20 };
  return { win: 30, loss: 30 };
}

/** 0–9999 ladder label (before Top 500 / One above all display rules). */
export function ladderLabelFromRating(rating) {
  const r = Math.max(0, Math.min(9999, Math.floor(Number(rating) || 0)));
  for (const b of BANDS) {
    if (r <= b.max) return { tier: b.key, label: b.label };
  }
  return { tier: 'grand_master', label: 'Grand Master' };
}

/**
 * @param {string} userId
 * @param {number} rating
 * @param {{ userId: string, rating: number } | null} leader
 */
export function resolveDisplayRank(userId, rating, leader) {
  const r = Math.max(0, Math.floor(Number(rating) || 0));
  const maxR = leader ? Math.max(0, Math.floor(Number(leader.rating) || 0)) : 0;

  if (leader && leader.userId === userId && maxR > 0) {
    return { tier: 'one_above_all', label: 'One above all', points: r, ladder: ladderLabelFromRating(Math.min(r, 9999)) };
  }
  if (r >= 10000) {
    return { tier: 'top_500', label: 'Top 500', points: r, ladder: ladderLabelFromRating(9999) };
  }
  const ladder = ladderLabelFromRating(r);
  return { tier: ladder.tier, label: ladder.label, points: r, ladder };
}
