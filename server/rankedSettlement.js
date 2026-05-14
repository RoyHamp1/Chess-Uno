import { getSnapshotWinLossDeltas } from './ranking.js';
import { incrementRankedRating } from './authStore.js';

/**
 * @param {import('socket.io').Server} io
 * @param {any} room
 */
export async function applyRankedIfGameover(io, room) {
  if (!room || room.matchType !== 'ranked' || room.phase !== 'gameover' || room.rankedSettled) return;
  const gr = room.gameResult;
  if (!gr?.winnerId) return;
  if (gr.kind !== 'checkmate' && gr.kind !== 'king_captured') return;
  if (!room.matchAccounts) return;

  const loserPid = room.playerOrder.find((id) => id !== gr.winnerId);
  if (!loserPid) return;

  const wAcc = room.matchAccounts[gr.winnerId];
  const lAcc = room.matchAccounts[loserPid];
  if (!wAcc?.userId || !lAcc?.userId) return;

  room.rankedSettled = true;

  const winPts = getSnapshotWinLossDeltas(wAcc.rankedRating).win;
  const lossPts = getSnapshotWinLossDeltas(lAcc.rankedRating).loss;

  await incrementRankedRating(wAcc.userId, winPts);
  await incrementRankedRating(lAcc.userId, -lossPts);

  io.to(gr.winnerId).emit('toast', {
    type: 'ok',
    message: `Ranked win: +${winPts} points`,
  });
  io.to(loserPid).emit('toast', {
    type: 'ok',
    message: lossPts === 0 ? 'Ranked loss: no point loss (Rookie).' : `Ranked loss: −${lossPts} points`,
  });
}
