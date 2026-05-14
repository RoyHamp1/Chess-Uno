import './env.js';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import authRouter from './authRoutes.js';
import { warmAuthDb } from './db.js';
import { verifyAccessToken } from './jwtAuth.js';
import { leaveQueues, tryEnqueue } from './matchmaking.js';
import { applyRankedIfGameover } from './rankedSettlement.js';
import { getRankedRating } from './authStore.js';
import {
  createRoom,
  joinRoom,
  leaveRoom,
  beginReveal,
  commitPendingReveal,
  abortRevealIfDrawerLeft,
  makeChessMove,
  endChessMovesEarly,
  resolveBonus,
  tryShuffleDeck,
  publicState,
  bonusHint,
  votePlayAgain,
  abandonMatch,
  addLobbyBot,
  removeLobbyBot,
  setLobbyReady,
  isBotPlayerId,
  listBonusPawnSquares,
} from './gameEngine.js';
import { pickChessMove, pickFfaMove, pickBonusPayload } from './botAi.js';
import { ffaLegalMoves, ffaPawnReachesPromotionEdge, FFA_W, FFA_H } from './ffaEngine.js';

const PORT = process.env.PORT || 3001;
const REVEAL_MS = 1100;

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api/auth', authRouter);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true },
});

/** @type {Map<string, ReturnType<typeof createRoom>>} */
const rooms = new Map();

/** @type {Map<string, string>} socketId -> roomCode */
const socketRoom = new Map();

io.use((socket, next) => {
  const raw = socket.handshake.auth?.token;
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) {
    socket.data.userId = null;
    socket.data.username = null;
    return next();
  }
  const p = verifyAccessToken(token);
  if (!p?.sub) {
    socket.data.userId = null;
    socket.data.username = null;
    return next();
  }
  socket.data.userId = p.sub;
  socket.data.username = typeof p.u === 'string' ? p.u : null;
  next();
});

function broadcastRoom(room) {
  for (const pid of room.playerOrder) {
    if (isBotPlayerId(pid)) continue;
    io.to(pid).emit('state', publicState(room, pid));
  }
}

function broadcastRoomWithRankedNoBot(room) {
  broadcastRoom(room);
  void applyRankedIfGameover(io, room).catch((err) => console.error('ranked settle', err));
}

function broadcastRoomWithRanked(room) {
  broadcastRoomWithRankedNoBot(room);
  queueBotTurn(room.code);
}

function abandonKickMessage(room, pid) {
  const gr = room.gameResult;
  const fi = gr?.forfeitingId;
  if (gr?.kind !== 'forfeit' || !fi) {
    return 'Match ended — returned to lobby.';
  }
  if (pid === fi) return 'You abandoned the match — returned to lobby.';
  if (
    gr.winnerIds?.includes(pid) ||
    gr.survivorIds?.includes(pid) ||
    (room.playerOrder?.length === 2 && pid !== fi)
  ) {
    return 'Opponent abandoned — you win.';
  }
  return 'A teammate abandoned — returned to lobby.';
}

/** @returns {'win' | 'loss'} */
function abandonKickOutcome(room, pid) {
  const gr = room.gameResult;
  const fi = gr?.forfeitingId;
  if (gr?.kind !== 'forfeit' || !fi) return 'loss';
  if (pid === fi) return 'loss';
  if (
    gr.winnerIds?.includes(pid) ||
    gr.survivorIds?.includes(pid) ||
    (room.playerOrder?.length === 2 && pid !== fi)
  ) {
    return 'win';
  }
  return 'loss';
}

/** After casual/private abandon with closeRoom: remove everyone from the room and return humans to lobby. */
function disbandRoomAfterAbandon(io, room) {
  if (!room || !rooms.has(room.code)) return;
  const code = room.code;
  const humans = room.playerOrder.filter((id) => !isBotPlayerId(id));
  for (const pid of humans) {
    const sk = io.sockets.sockets.get(pid);
    if (!sk) continue;
    sk.emit('kickedToLobby', {
      reason: 'abandon',
      outcome: abandonKickOutcome(room, pid),
      message: abandonKickMessage(room, pid),
    });
    sk.leave(code);
    socketRoom.delete(pid);
  }
  while (room.playerOrder.length) {
    leaveRoom(room, room.playerOrder[0]);
  }
  clearRevealTimeout(room);
  rooms.delete(code);
}

function queueBotTurn(code) {
  setTimeout(() => {
    try {
      drainBotTurns(code);
    } catch (err) {
      console.error('drainBotTurns', err);
    }
  }, 320);
}

function drainBotTurns(code) {
  const room = rooms.get(code);
  if (!room) return;
  const head = room.activeSeat;
  if (!head || !isBotPlayerId(head)) return;
  if (room.phase === 'revealing' || room.pendingReveal) return;

  let spins = 0;
  while (spins++ < 36) {
    const cur = room.activeSeat;
    if (!cur || !isBotPlayerId(cur)) break;
    if (room.phase === 'revealing' || room.pendingReveal) break;

    if (room.phase === 'playCard') {
      const r = beginReveal(room, cur);
      if (!r.ok) break;
      io.to(room.code).emit('cardReveal', {
        card: { id: r.card.id, type: r.card.type, value: r.card.value, color: r.card.color },
        playerId: cur,
      });
      broadcastRoomWithRankedNoBot(room);
      scheduleRevealCommit(room);
      return;
    }

    if (room.phase === 'makingMoves') {
      const diff = room.botProfile[cur]?.difficulty || 'medium';
      if (room.gameMode === 'ffa') {
        const st = { board: [...room.ffa.board], pawnMeta: { ...room.ffa.pawnMeta } };
        const army = room.playerOrder.indexOf(cur);
        const mv = pickFfaMove(ffaLegalMoves, st, army, FFA_W, FFA_H, diff);
        if (!mv) break;
        const [tr, tc] = mv.to.split(',').map(Number);
        const [fr, fc] = mv.from.split(',').map(Number);
        const p = room.ffa.board[fr * FFA_W + fc];
        let promotion;
        if (p?.t?.toLowerCase() === 'p' && ffaPawnReachesPromotionEdge(army, tr, tc)) promotion = 'q';
        const mr = makeChessMove(room, cur, { ...mv, promotion });
        if (!mr.ok) break;
      } else {
        const need = room.chess.turn();
        const mv = pickChessMove(room.chess.fen(), need, diff);
        if (!mv) break;
        const mr = makeChessMove(room, cur, mv);
        if (!mr.ok) break;
      }
      broadcastRoomWithRankedNoBot(room);
      if (room.phase === 'gameover') {
        broadcastRoomWithRanked(room);
        return;
      }
      continue;
    }

    if (room.phase === 'bonus' && room.bonus?.playerId === cur) {
      const hint = bonusHint(room, cur);
      const sqs = listBonusPawnSquares(room, cur);
      if (!sqs.length) break;
      const payload = pickBonusPayload(sqs, hint?.recoverableTypes);
      let br = resolveBonus(room, cur, payload);
      if (!br.ok) {
        br = resolveBonus(room, cur, { action: 'pawn', square: sqs[0] });
      }
      if (!br.ok) break;
      broadcastRoomWithRankedNoBot(room);
      continue;
    }

    break;
  }
  const r2 = rooms.get(code);
  if (
    r2 &&
    r2.activeSeat &&
    isBotPlayerId(r2.activeSeat) &&
    !r2.pendingReveal &&
    r2.phase !== 'revealing'
  ) {
    queueBotTurn(code);
  }
}

function clearRevealTimeout(room) {
  if (room._revealTimeout) {
    clearTimeout(room._revealTimeout);
    room._revealTimeout = null;
  }
}

function scheduleRevealCommit(room) {
  clearRevealTimeout(room);
  room._revealTimeout = setTimeout(() => {
    room._revealTimeout = null;
    if (!rooms.has(room.code)) return;
    const roomRef = rooms.get(room.code);
    if (!roomRef) return;
    const r = commitPendingReveal(roomRef);
    if (r?.bonusSkippedFor && roomRef.playerOrder?.length) {
      for (const pid of roomRef.playerOrder) {
        if (isBotPlayerId(pid)) continue;
        io.to(pid).emit('toast', {
          type: 'ok',
          message:
            pid === r.bonusSkippedFor
              ? 'Your home ranks (1–2 or 7–8) are full — +2/+4 skipped; your turn ends.'
              : 'Opponent had no empty home-rank squares — their +2/+4 was skipped.',
        });
      }
    }
    broadcastRoomWithRanked(roomRef);
  }, REVEAL_MS);
}

function destroyIfEmpty(room) {
  if (room.playerOrder.length === 0) {
    clearRevealTimeout(room);
    rooms.delete(room.code);
  }
}

/** Remove this socket from its current game room (if any). */
function removeSocketFromRoom(socket) {
  const code = socketRoom.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  if (room?.pendingReveal) {
    clearRevealTimeout(room);
    if (room.pendingReveal.playerId === socket.id) {
      abortRevealIfDrawerLeft(room, socket.id);
    } else {
      commitPendingReveal(room);
    }
  }
  if (room) {
    leaveRoom(room, socket.id);
    destroyIfEmpty(room);
  }
  socket.leave(code);
  socketRoom.delete(socket.id);
}

async function pairMatchedRoom(peer, meSocket, matchType, gameMode) {
  const peerSock = io.sockets.sockets.get(peer.socketId);
  const meSock = io.sockets.sockets.get(meSocket.id);
  if (!peerSock?.connected || !meSock?.connected) return;

  removeSocketFromRoom(peerSock);
  removeSocketFromRoom(meSock);
  leaveQueues(peer.socketId);
  leaveQueues(meSocket.id);

  const room = createRoom(peer.socketId, { gameMode: gameMode || 'classic' });
  room.matchType = matchType;
  room.gameMode = gameMode || 'classic';
  const r1 = await getRankedRating(peer.userId);
  const r2 = await getRankedRating(meSocket.data.userId);
  room.matchAccounts = {
    [peer.socketId]: { userId: peer.userId, username: peer.username, rankedRating: r1 },
    [meSocket.id]: {
      userId: meSocket.data.userId,
      username: meSocket.data.username || 'Player',
      rankedRating: r2,
    },
  };
  room.rankedSettled = false;

  rooms.set(room.code, room);
  peerSock.join(room.code);
  socketRoom.set(peer.socketId, room.code);

  const res = joinRoom(room, meSocket.id, { autoStartIfFull: true });
  if (!res.ok) {
    rooms.delete(room.code);
    socketRoom.delete(peer.socketId);
    peerSock.leave(room.code);
    peerSock.emit('toast', { type: 'error', message: 'Matchmaking failed — try again.' });
    meSock.emit('toast', { type: 'error', message: 'Matchmaking failed — try again.' });
    return;
  }

  meSock.join(room.code);
  socketRoom.set(meSocket.id, room.code);

  peerSock.emit('state', publicState(room, peer.socketId));
  peerSock.emit('roomCode', room.code);
  meSock.emit('state', publicState(room, meSocket.id));
  meSock.emit('roomCode', room.code);
  peerSock.emit('queueMatched', { code: room.code, matchType });
  meSock.emit('queueMatched', { code: room.code, matchType });
  peerSock.emit('queueStatus', { type: null, waiting: false });
  meSock.emit('queueStatus', { type: null, waiting: false });

  broadcastRoomWithRanked(room);
}

async function pairMatchedFour(peers, matchType, gameMode) {
  if (!peers || peers.length !== 4) return;
  const socks = peers.map((p) => io.sockets.sockets.get(p.socketId));
  if (socks.some((s) => !s?.connected)) return;

  for (let i = 0; i < 4; i++) {
    removeSocketFromRoom(socks[i]);
    leaveQueues(peers[i].socketId);
  }

  const host = peers[0];
  const room = createRoom(host.socketId, { gameMode });
  room.matchType = matchType;
  room.gameMode = gameMode;
  room.matchAccounts = {};
  for (const p of peers) {
    room.matchAccounts[p.socketId] = {
      userId: p.userId,
      username: p.username || 'Player',
      rankedRating: p.rankedRating ?? 0,
    };
  }
  room.rankedSettled = false;

  rooms.set(room.code, room);
  socks[0].join(room.code);
  socketRoom.set(peers[0].socketId, room.code);

  for (let i = 1; i < 4; i++) {
    const res = joinRoom(room, peers[i].socketId, { autoStartIfFull: true });
    if (!res.ok) {
      rooms.delete(room.code);
      for (const p of peers) {
        const sk = io.sockets.sockets.get(p.socketId);
        socketRoom.delete(p.socketId);
        sk?.leave(room.code);
      }
      for (const p of peers) {
        io.sockets.sockets
          .get(p.socketId)
          ?.emit('toast', { type: 'error', message: 'Matchmaking failed — try again.' });
      }
      return;
    }
    socks[i].join(room.code);
    socketRoom.set(peers[i].socketId, room.code);
  }

  for (let i = 0; i < 4; i++) {
    socks[i].emit('queueMatched', { code: room.code, matchType });
    socks[i].emit('queueStatus', { type: null, waiting: false, gameMode: null });
  }
  broadcastRoomWithRanked(room);
}

io.on('connection', (socket) => {
  socket.on('createRoom', (payload) => {
    leaveQueues(socket.id);
    removeSocketFromRoom(socket);
    const rawGm = String(payload?.gameMode || 'classic').toLowerCase();
    const pick = ['classic', '2v2', 'ffa', 'wild'].includes(rawGm) ? rawGm : 'classic';
    const room = createRoom(socket.id, { gameMode: pick });
    rooms.set(room.code, room);
    socket.join(room.code);
    socketRoom.set(socket.id, room.code);
    socket.emit('state', publicState(room, socket.id));
    socket.emit('roomCode', room.code);
  });

  socket.on('joinRoom', (rawCode) => {
    leaveQueues(socket.id);
    const code = String(rawCode || '')
      .trim()
      .toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      socket.emit('toast', { type: 'error', message: 'Room not found' });
      return;
    }
    const existing = socketRoom.get(socket.id);
    if (existing && existing !== code) {
      removeSocketFromRoom(socket);
    }
    const res = joinRoom(room, socket.id);
    if (!res.ok) {
      socket.emit('toast', { type: 'error', message: res.error });
      return;
    }
    socket.join(room.code);
    socketRoom.set(socket.id, room.code);
    broadcastRoomWithRanked(room);
  });

  socket.on('leaveMatch', () => {
    const code = socketRoom.get(socket.id);
    if (!code) {
      socket.emit('state', null);
      socket.emit('roomCode', '');
      return;
    }
    removeSocketFromRoom(socket);
    const remaining = rooms.get(code);
    if (remaining) {
      broadcastRoomWithRanked(remaining);
    }
    socket.emit('state', null);
    socket.emit('roomCode', '');
  });

  socket.on('lobbySetReady', (payload) => {
    const code = socketRoom.get(socket.id);
    const room = code ? rooms.get(code) : null;
    if (!room) return;
    const r = setLobbyReady(room, socket.id, !!payload?.ready);
    if (!r.ok) socket.emit('toast', { type: 'error', message: r.error });
    broadcastRoomWithRanked(room);
  });

  socket.on('lobbyAddBot', (payload) => {
    const code = socketRoom.get(socket.id);
    const room = code ? rooms.get(code) : null;
    if (!room) return;
    const r = addLobbyBot(room, socket.id, payload || {});
    if (!r.ok) socket.emit('toast', { type: 'error', message: r.error });
    broadcastRoomWithRanked(room);
  });

  socket.on('lobbyRemoveBot', (payload) => {
    const code = socketRoom.get(socket.id);
    const room = code ? rooms.get(code) : null;
    if (!room) return;
    const botId = String(payload?.botId || '');
    const r = removeLobbyBot(room, socket.id, botId);
    if (!r.ok) socket.emit('toast', { type: 'error', message: r.error });
    broadcastRoomWithRanked(room);
  });

  socket.on('queueJoin', async (payload) => {
    try {
      if (!socket.data.userId) {
        socket.emit('toast', { type: 'error', message: 'Sign in to use matchmaking.' });
        return;
      }
      const type = payload?.type === 'ranked' ? 'ranked' : 'casual';
      const rawMode = String(payload?.gameMode || 'classic').toLowerCase();
      const allowed = new Set(['classic', '2v2', 'ffa', 'wild']);
      const gameMode = allowed.has(rawMode) ? rawMode : 'classic';
      if (type === 'ranked' && gameMode !== 'classic') {
        socket.emit('toast', { type: 'error', message: 'Ranked is Classic 1v1 only.' });
        return;
      }
      if (type === 'casual' && !['classic', '2v2', 'ffa', 'wild'].includes(gameMode)) {
        socket.emit('toast', { type: 'error', message: 'Unknown queue mode.' });
        return;
      }
      const rating = type === 'ranked' ? await getRankedRating(socket.data.userId) : 0;
      const entry = {
        socketId: socket.id,
        userId: socket.data.userId,
        username: socket.data.username || 'Player',
        rankedRating: rating,
        gameMode,
      };
      const result = tryEnqueue(type, entry, (id) => io.sockets.sockets.get(id));
      if (!result.matched) {
        socket.emit('queueStatus', { type, waiting: true, gameMode });
        return;
      }
      if (result.peers) {
        await pairMatchedFour(result.peers, type, gameMode);
      } else {
        await pairMatchedRoom(result.peer, socket, type, gameMode);
      }
    } catch (err) {
      console.error('queueJoin', err);
      socket.emit('toast', { type: 'error', message: 'Queue error — try again.' });
    }
  });

  socket.on('queueLeave', () => {
    leaveQueues(socket.id);
    socket.emit('queueStatus', { type: null, waiting: false, gameMode: null });
  });

  socket.on('drawFromDeck', () => {
    const code = socketRoom.get(socket.id);
    const room = code ? rooms.get(code) : null;
    if (!room) return;
    const r = beginReveal(room, socket.id);
    if (!r.ok) {
      socket.emit('toast', { type: 'error', message: r.error });
      return;
    }
    io.to(room.code).emit('cardReveal', {
      card: { id: r.card.id, type: r.card.type, value: r.card.value, color: r.card.color },
      playerId: socket.id,
    });
    broadcastRoomWithRanked(room);
    scheduleRevealCommit(room);
  });

  socket.on('chessMove', (payload) => {
    try {
      const code = socketRoom.get(socket.id);
      const room = code ? rooms.get(code) : null;
      if (!room) return;
      const r = makeChessMove(room, socket.id, payload || {});
      if (!r.ok) socket.emit('toast', { type: 'error', message: r.error });
      broadcastRoomWithRanked(room);
    } catch (err) {
      console.error('chessMove', err);
      socket.emit('toast', { type: 'error', message: 'Server error — please try again.' });
    }
  });

  socket.on('endChessMoves', () => {
    const code = socketRoom.get(socket.id);
    const room = code ? rooms.get(code) : null;
    if (!room) return;
    const r = endChessMovesEarly(room, socket.id);
    if (!r.ok) socket.emit('toast', { type: 'error', message: r.error });
    broadcastRoomWithRanked(room);
  });

  socket.on('bonus', (payload) => {
    const code = socketRoom.get(socket.id);
    const room = code ? rooms.get(code) : null;
    if (!room) return;
    const r = resolveBonus(room, socket.id, payload || {});
    if (!r.ok) socket.emit('toast', { type: 'error', message: r.error });
    broadcastRoomWithRanked(room);
  });

  socket.on('bonusHint', () => {
    const code = socketRoom.get(socket.id);
    const room = code ? rooms.get(code) : null;
    if (!room) return;
    const h = bonusHint(room, socket.id);
    socket.emit('bonusHint', h);
  });

  socket.on('shuffleDeck', () => {
    const code = socketRoom.get(socket.id);
    const room = code ? rooms.get(code) : null;
    if (!room) return;
    const r = tryShuffleDeck(room, socket.id);
    if (!r.ok) socket.emit('toast', { type: 'error', message: r.error });
    else socket.emit('toast', { type: 'ok', message: 'Deck shuffled' });
    broadcastRoomWithRanked(room);
  });

  socket.on('abandonMatch', (payload) => {
    const code = socketRoom.get(socket.id);
    const room = code ? rooms.get(code) : null;
    if (!room) return;
    clearRevealTimeout(room);
    const r = abandonMatch(room, socket.id);
    if (!r.ok) socket.emit('toast', { type: 'error', message: r.error });
      else {
        const closeRoom = !!payload?.closeRoom && room.matchType !== 'ranked';
        if (closeRoom) {
          disbandRoomAfterAbandon(io, room);
        } else {
          broadcastRoomWithRanked(room);
        }
      }
  });

  socket.on('playAgain', async () => {
    const code = socketRoom.get(socket.id);
    const room = code ? rooms.get(code) : null;
    if (!room) return;
    clearRevealTimeout(room);
    const r = votePlayAgain(room, socket.id);
    if (!r.ok) socket.emit('toast', { type: 'error', message: r.error });
    else if (r.restarted) socket.emit('toast', { type: 'ok', message: 'New game started' });
    if (r.restarted && room.matchType === 'ranked' && room.matchAccounts) {
      try {
        for (const pid of room.playerOrder) {
          const acc = room.matchAccounts[pid];
          if (acc?.userId) acc.rankedRating = await getRankedRating(acc.userId);
        }
      } catch (e) {
        console.error('refresh ranked snapshot', e);
      }
    }
    broadcastRoomWithRanked(room);
  });

  socket.on('disconnect', () => {
    leaveQueues(socket.id);
    const code = socketRoom.get(socket.id);
    removeSocketFromRoom(socket);
    if (code) {
      const r = rooms.get(code);
      if (r) broadcastRoomWithRanked(r);
    }
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

server.listen(PORT, () => {
  console.log(`Luck of the Draw server on http://localhost:${PORT}`);
  warmAuthDb()
    .then(() => {
      if (process.env.DATABASE_URL?.trim()) {
        console.log('PostgreSQL auth: OK');
      }
    })
    .catch((e) => {
      console.warn('PostgreSQL auth:', e.message);
    });
});
