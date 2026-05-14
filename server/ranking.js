/** Point rules use rating at match start. At/above 10k: ±5. Below: first two ladder bands differ; then flat. */

/** Inclusive max rating on the ladder before Top 500 (0 … LADDER_MAX). Split evenly across 8 ranks. */
const LADDER_MAX_RATING = 9999;

const RANK_LADDER = [
  { key: 'rookie', label: 'Rookie' },
  { key: 'bronze', label: 'Bronze' },
  { key: 'silver', label: 'Silver' },
  { key: 'gold', label: 'Gold' },
  { key: 'platinum', label: 'Platinum' },
  { key: 'diamond', label: 'Diamond' },
  { key: 'master', label: 'Master' },
  { key: 'grand_master', label: 'Grand Master' },
];

const RANK_COUNT = RANK_LADDER.length;
/** Integer ratings from 0 through LADDER_MAX_RATING inclusive → (max+1) values, split evenly. */
const VALUES_ON_LADDER = LADDER_MAX_RATING + 1;
const POINTS_PER_RANK = VALUES_ON_LADDER / RANK_COUNT;

const BANDS = RANK_LADDER.map((r, i) => ({
  ...r,
  max: Math.floor((i + 1) * POINTS_PER_RANK) - 1,
}));

/**
 * @param {number} rating
 * @returns {{ win: number, loss: number }}
 */
export function getSnapshotWinLossDeltas(rating) {
  const r = Number(rating) || 0;
  if (r >= 10000) return { win: 5, loss: 5 };
  if (r <= BANDS[0].max) return { win: 50, loss: 0 };
  if (r <= BANDS[1].max) return { win: 40, loss: 20 };
  return { win: 30, loss: 30 };
}

/** 0–9999 ladder label (before Top 500 / One above all display rules). */
export function ladderLabelFromRating(rating) {
  const r = Math.max(0, Math.min(LADDER_MAX_RATING, Math.floor(Number(rating) || 0)));
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
    return {
      tier: 'one_above_all',
      label: 'One above all',
      points: r,
      ladder: ladderLabelFromRating(Math.min(r, LADDER_MAX_RATING)),
    };
  }
  if (r >= 10000) {
    return {
      tier: 'top_500',
      label: 'Top 500',
      points: r,
      ladder: ladderLabelFromRating(LADDER_MAX_RATING),
    };
  }
  const ladder = ladderLabelFromRating(r);
  return { tier: ladder.tier, label: ladder.label, points: r, ladder };
}
