import { randomUUID } from 'node:crypto';
import { armyTeam } from './ffaEngine.js';

function isBotPlayerId(pid) {
  return typeof pid === 'string' && pid.startsWith('bot:');
}

export const DISCONNECT_GRACE_MS = 30_000;

function isTwoPlayerChess(room) {
  return room.gameMode === 'classic' || room.gameMode === 'wild';
}

function opponentId(room, socketId) {
  const idx = room.playerOrder.indexOf(socketId);
  if (idx === -1) return null;
  return room.playerOrder[1 - idx] ?? null;
}

export function initDisconnectFields(room) {
  if (!room.rejoinByToken) room.rejoinByToken = Object.create(null);
  if (!room.socketToRejoinToken) room.socketToRejoinToken = Object.create(null);
  if (room.disconnectGrace === undefined) room.disconnectGrace = null;
  if (room.playAgainDisabled === undefined) room.playAgainDisabled = false;
}

export function ensureRejoinToken(room, socketId) {
  if (isBotPlayerId(socketId)) return null;
  initDisconnectFields(room);
  if (room.socketToRejoinToken[socketId]) return room.socketToRejoinToken[socketId];
  const token = randomUUID();
  const seat = room.playerOrder.indexOf(socketId);
  room.rejoinByToken[token] = {
    socketId,
    seat,
    userId: room.matchAccounts?.[socketId]?.userId ?? null,
  };
  room.socketToRejoinToken[socketId] = token;
  return token;
}

export function rejoinTokenForViewer(room, viewerId) {
  if (isBotPlayerId(viewerId)) return null;
  return ensureRejoinToken(room, viewerId);
}

export function isMatchInProgress(room) {
  return !!room && room.phase !== 'lobby' && room.phase !== 'gameover';
}

function clearDisconnectTimers(room) {
  if (room._disconnectTick) {
    clearInterval(room._disconnectTick);
    room._disconnectTick = null;
  }
  if (room._disconnectTimeout) {
    clearTimeout(room._disconnectTimeout);
    room._disconnectTimeout = null;
  }
}

export function clearDisconnectGrace(room) {
  clearDisconnectTimers(room);
  room.disconnectGrace = null;
}

export function replaceSocketId(room, oldId, newId) {
  const idx = room.playerOrder.indexOf(oldId);
  if (idx === -1) return false;
  room.playerOrder[idx] = newId;
  if (room.shuffles[oldId] !== undefined) {
    room.shuffles[newId] = room.shuffles[oldId];
    delete room.shuffles[oldId];
  }
  if (room.lobbyReady?.[oldId] !== undefined) {
    room.lobbyReady[newId] = room.lobbyReady[oldId];
    delete room.lobbyReady[oldId];
  }
  if (room.playAgainVotes?.[oldId]) {
    room.playAgainVotes[newId] = room.playAgainVotes[oldId];
    delete room.playAgainVotes[oldId];
  }
  if (room.matchAccounts?.[oldId]) {
    room.matchAccounts[newId] = room.matchAccounts[oldId];
    delete room.matchAccounts[oldId];
  }
  if (room.displayNames?.[oldId]) {
    room.displayNames[newId] = room.displayNames[oldId];
    delete room.displayNames[oldId];
  }
  if (room.activeSeat === oldId) room.activeSeat = newId;
  if (room.bonus?.playerId === oldId) room.bonus.playerId = newId;
  if (room.skipNextFor === oldId) room.skipNextFor = newId;
  if (room.pendingReveal?.playerId === oldId) room.pendingReveal.playerId = newId;
  if (room.lastPulled?.playerId === oldId) room.lastPulled.playerId = newId;
  if (room.currentTurnLog?.playerId === oldId) room.currentTurnLog.playerId = newId;
  for (const entry of room.actionLog || []) {
    if (entry.playerId === oldId) entry.playerId = newId;
  }
  const tok = room.socketToRejoinToken?.[oldId];
  if (tok) {
    room.socketToRejoinToken[newId] = tok;
    delete room.socketToRejoinToken[oldId];
    if (room.rejoinByToken[tok]) room.rejoinByToken[tok].socketId = newId;
  }
  if (room.eliminated?.has(oldId)) {
    room.eliminated.delete(oldId);
    room.eliminated.add(newId);
  }
  return true;
}

export function buildDisconnectPublic(room) {
  if (!room.disconnectGrace) return null;
  const g = room.disconnectGrace;
  return {
    playerId: g.forfeitingId,
    seat: g.seat,
    secondsLeft: Math.max(0, Math.ceil((g.deadline - Date.now()) / 1000)),
  };
}

export function findRejoinEntry(room, code, token) {
  if (!room || room.code !== code || !token) return null;
  return room.rejoinByToken?.[token] ?? null;
}

export function graceMatchesToken(room, token) {
  return !!room.disconnectGrace && room.disconnectGrace.token === token;
}

/** @returns {{ ok: boolean, error?: string, oldSocketId?: string }} */
export function resolveDisconnectForfeit(room, leaverId) {
  clearDisconnectGrace(room);
  clearRevealForAbandon(room);
  finalizeTurnLog(room);
  room.playAgainVotes = {};
  room.playAgainDisabled = true;
  room.phase = 'gameover';
  room.bonus = null;
  room.activeCard = null;
  room.movesRemaining = 0;
  room.skipNextFor = null;

  const n = room.playerOrder.length;
  const gm = room.gameMode;
  const leaverSeat = room.playerOrder.indexOf(leaverId);
  if (leaverSeat === -1) return { ok: false, error: 'Player not in match' };

  if (isTwoPlayerChess(room) && n === 2) {
    const opp = opponentId(room, leaverId);
    room.gameResult = {
      kind: 'disconnect_forfeit',
      winnerId: opp,
      forfeitingId: leaverId,
      noRematch: true,
    };
    return { ok: true };
  }

  if ((gm === '2v2' || gm === 'ffa') && n === 4) {
    const teamMode = gm === '2v2' ? '2v2' : 'ffa';
    const leaverTeam = armyTeam(leaverSeat, teamMode);
    const winnerIds = [];
    const noContestIds = [];
    for (let i = 0; i < room.playerOrder.length; i++) {
      const pid = room.playerOrder[i];
      if (pid === leaverId) continue;
      if (armyTeam(i, teamMode) === leaverTeam) noContestIds.push(pid);
      else winnerIds.push(pid);
    }
    room.gameResult = {
      kind: 'disconnect_forfeit',
      winnerId: winnerIds.find((id) => !isBotPlayerId(id)) ?? winnerIds[0] ?? null,
      winnerIds,
      noContestIds,
      forfeitingId: leaverId,
      noRematch: true,
    };
    return { ok: true };
  }

  return { ok: false, error: 'Cannot resolve disconnect for this mode' };
}

function clearRevealForAbandon(room) {
  const p = room.pendingReveal;
  if (!p) return;
  room.deck.unshift(p.card);
  room.pendingReveal = null;
  room.lastPulled = null;
}

function finalizeTurnLog(room) {
  if (!room.currentTurnLog) return;
  room.actionLog = room.actionLog || [];
  room.actionLog.push(room.currentTurnLog);
  if (room.actionLog.length > 80) room.actionLog.shift();
  room.currentTurnLog = null;
}

/**
 * @param {any} room
 * @param {string} socketId
 * @param {(room: any) => void} onTick
 * @param {(room: any) => void} onTimeout
 */
export function beginDisconnectGrace(room, socketId, onTick, onTimeout) {
  if (!isMatchInProgress(room) || isBotPlayerId(socketId)) return false;
  if (room.disconnectGrace?.forfeitingId === socketId) return true;

  const token = ensureRejoinToken(room, socketId);
  const seat = room.playerOrder.indexOf(socketId);
  clearDisconnectTimers(room);
  room.disconnectGrace = {
    forfeitingId: socketId,
    seat,
    token,
    deadline: Date.now() + DISCONNECT_GRACE_MS,
  };
  room._disconnectTimeout = setTimeout(() => onTimeout(room), DISCONNECT_GRACE_MS);
  room._disconnectTick = setInterval(() => onTick(room), 1000);
  return true;
}

/** @returns {{ ok: boolean, error?: string, oldSocketId?: string }} */
export function acceptRejoin(room, newSocketId, code, token) {
  const entry = findRejoinEntry(room, code, token);
  if (!entry) return { ok: false, error: 'Rejoin link expired or invalid' };
  if (!graceMatchesToken(room, token)) {
    return { ok: false, error: 'Rejoin window has ended' };
  }
  const oldId = entry.socketId;
  if (!replaceSocketId(room, oldId, newSocketId)) {
    return { ok: false, error: 'Could not restore your seat' };
  }
  clearDisconnectGrace(room);
  ensureRejoinToken(room, newSocketId);
  return { ok: true, oldSocketId: oldId };
}

/** @returns {{ ok: boolean, error?: string }} */
export function declineRejoin(room, code, token) {
  const entry = findRejoinEntry(room, code, token);
  if (!entry) return { ok: false, error: 'Rejoin link expired or invalid' };
  if (!graceMatchesToken(room, token)) {
    return { ok: false, error: 'Rejoin window has ended' };
  }
  return resolveDisconnectForfeit(room, entry.socketId);
}

export function ensureAllRejoinTokens(room) {
  for (const pid of room.playerOrder) ensureRejoinToken(room, pid);
}
