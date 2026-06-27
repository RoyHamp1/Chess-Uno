const TIERS = new Set([
  'rookie',
  'bronze',
  'silver',
  'gold',
  'platinum',
  'diamond',
  'master',
  'grand_master',
  'top_500',
  'one_above_all',
]);

/** CSS-safe class list for rank pill (e.g. `rank-badge rank-gold lb-rank-badge`). */
export function rankBadgeClassName(tier, extraClass) {
  const t = TIERS.has(tier) ? tier : 'rookie';
  const extra = extraClass ? ` ${extraClass}` : '';
  return `rank-badge rank-${t}${extra}`;
}
