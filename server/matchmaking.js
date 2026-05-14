/** Casual queues keyed by gameMode; ranked is Classic 2-player only. */

const ranked = [];
/** @type {Map<string, Array<{ socketId: string, userId: string, username: string, rankedRating: number, gameMode?: string }>>} */
const casualByMode = new Map();

function casualQueue(gameMode) {
  const gm = gameMode || 'classic';
  if (!casualByMode.has(gm)) casualByMode.set(gm, []);
  return casualByMode.get(gm);
}

function playersNeeded(gameMode) {
  if (gameMode === '2v2' || gameMode === 'ffa') return 4;
  return 2;
}

/** Remove this socket from all queues. */
export function leaveQueues(socketId) {
  for (const q of casualByMode.values()) {
    const i = q.findIndex((e) => e.socketId === socketId);
    if (i !== -1) q.splice(i, 1);
  }
  const ri = ranked.findIndex((e) => e.socketId === socketId);
  if (ri !== -1) ranked.splice(ri, 1);
}

/**
 * @param {'casual' | 'ranked'} type
 * @param {{ socketId: string, userId: string, username: string, rankedRating: number, gameMode?: string }} entry
 * @param {(id: string) => import('socket.io').Socket | undefined} getSocket
 * @returns {{ matched: false } | { matched: true, peer: object } | { matched: true, peers: object[] }}
 */
export function tryEnqueue(type, entry, getSocket) {
  leaveQueues(entry.socketId);
  const gm = entry.gameMode || 'classic';

  if (type === 'ranked') {
    const q = ranked;
    while (true) {
      const idx = q.findIndex((e) => e.userId !== entry.userId && (e.gameMode || 'classic') === 'classic');
      if (idx === -1) {
        q.push({ ...entry, gameMode: 'classic' });
        return { matched: false };
      }
      const peer = q[idx];
      if (!getSocket(peer.socketId)?.connected) {
        q.splice(idx, 1);
        continue;
      }
      q.splice(idx, 1);
      const myI = q.findIndex((e) => e.socketId === entry.socketId);
      if (myI !== -1) q.splice(myI, 1);
      return { matched: true, peer };
    }
  }

  const q = casualQueue(gm);
  const need = playersNeeded(gm);
  q.push(entry);

  while (true) {
    for (let i = q.length - 1; i >= 0; i--) {
      if (!getSocket(q[i].socketId)?.connected) q.splice(i, 1);
    }

    if (need === 4) {
      const picked = [];
      const used = new Set();
      for (const e of q) {
        if (used.has(e.userId)) continue;
        if (!getSocket(e.socketId)?.connected) continue;
        used.add(e.userId);
        picked.push(e);
        if (picked.length === 4) break;
      }
      if (picked.length < 4) return { matched: false };
      for (const e of picked) {
        const j = q.findIndex((x) => x.socketId === e.socketId);
        if (j !== -1) q.splice(j, 1);
      }
      return { matched: true, peers: picked };
    }

    const idx = q.findIndex((e) => e.userId !== entry.userId);
    if (idx === -1) return { matched: false };
    const peer = q[idx];
    if (!getSocket(peer.socketId)?.connected) {
      q.splice(idx, 1);
      continue;
    }
    q.splice(idx, 1);
    const myI = q.findIndex((e) => e.socketId === entry.socketId);
    if (myI !== -1) q.splice(myI, 1);
    return { matched: true, peer };
  }
}
