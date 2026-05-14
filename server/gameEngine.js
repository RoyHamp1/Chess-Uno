import { randomUUID } from 'node:crypto';
import { Chess, WHITE, BLACK, PAWN, KING, SQUARES } from 'chess.js';
import {
  createFfaState,
  ffaApplyMove,
  ffaWinnerArmy,
  serializeFfaBoard,
  ffaIsHole,
  FFA_W,
  FFA_H,
} from './ffaEngine.js';

const PIECE_TYPES = new Set(['p', 'n', 'b', 'r', 'q', 'k']);

export function isBotPlayerId(pid) {
  return typeof pid === 'string' && pid.startsWith('bot:');
}

function isTwoPlayerChess(room) {
  return room.gameMode === 'classic' || room.gameMode === 'wild';
}

export function maxPlayers(room) {
  return room.gameMode === '2v2' || room.gameMode === 'ffa' ? 4 : 2;
}

function expandRank(rankStr) {
  let s = '';
  for (const ch of rankStr) {
    if (ch >= '1' && ch <= '8') s += '.'.repeat(Number(ch));
    else s += ch;
  }
  return s;
}

function compressRank(expanded) {
  let out = '';
  let empty = 0;
  for (const ch of expanded) {
    if (ch === '.') {
      empty++;
    } else {
      if (empty) {
        out += String(empty);
        empty = 0;
      }
      out += ch;
    }
  }
  if (empty) out += String(empty);
  return out;
}

function swapPieceCase(ch) {
  if (ch === '.' || (ch >= '1' && ch <= '8')) return ch;
  return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
}

/** 180° rotation + swap piece colors + toggle side to move (Wild card). */
export function flipFen(fen) {
  const parts = fen.split(' ');
  const rows = parts[0].split('/');
  const grid = rows.map((row) => expandRank(row).split(''));
  const out = [];
  for (let r = 0; r < 8; r++) {
    let s = '';
    for (let f = 0; f < 8; f++) {
      const ch = grid[7 - r][7 - f];
      if (ch === '.') s += '.';
      else s += swapPieceCase(ch);
    }
    out.push(compressRank(s));
  }
  parts[0] = out.join('/');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[2] = '-';
  parts[3] = '-';
  const c = new Chess();
  if (!c.load(parts.join(' '))) {
    parts[2] = '-';
    c.load(parts.join(' '));
  }
  return c.fen();
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeCard(type, extra = {}) {
  return { id: `${type}-${Math.random().toString(36).slice(2, 11)}`, type, ...extra };
}

export function buildDeck() {
  const deck = [];
  const colors = ['red', 'blue', 'green', 'yellow'];
  for (const color of colors) {
    deck.push(makeCard('number', { value: 0, color }));
    for (let v = 1; v <= 9; v++) {
      deck.push(makeCard('number', { value: v, color }));
      deck.push(makeCard('number', { value: v, color }));
    }
    deck.push(makeCard('skip', { color }));
    deck.push(makeCard('skip', { color }));
    deck.push(makeCard('reverse', { color }));
    deck.push(makeCard('reverse', { color }));
  }
  for (let i = 0; i < 4; i++) deck.push(makeCard('wild', { color: 'wild' }));
  for (let i = 0; i < 4; i++) deck.push(makeCard('draw2', { color: 'special' }));
  for (let i = 0; i < 4; i++) deck.push(makeCard('draw4', { color: 'special' }));
  shuffleInPlace(deck);
  return deck;
}

function drawFromDeck(room) {
  if (room.deck.length === 0) return null;
  const card = room.deck.shift();
  return card;
}

function returnCardToBottom(room, card) {
  room.deck.push(card);
}

function colorOfSeat(room, socketId) {
  const idx = room.playerOrder.indexOf(socketId);
  if (idx === -1) return null;
  if (isTwoPlayerChess(room)) return idx === 0 ? 'w' : 'b';
  if (room.gameMode === '2v2') return idx % 2 === 0 ? 'b' : 'w';
  if (room.gameMode === 'ffa') return ['w', 'u', 'b', 'r'][idx] ?? null;
  return idx === 0 ? 'w' : 'b';
}

function opponentId(room, socketId) {
  const idx = room.playerOrder.indexOf(socketId);
  if (idx === -1) return null;
  return room.playerOrder[1 - idx];
}

/** Next active seat in turn ring (skips FFA eliminated). */
function socketAfter(room, fromSocketId, steps) {
  const order = room.playerOrder;
  const n = order.length;
  const fromIdx = order.indexOf(fromSocketId);
  if (fromIdx === -1) return null;
  let cur = fromIdx;
  for (let walked = 0, guard = 0; walked < steps && guard < n * n; guard++) {
    cur = (cur + room.turnDirection + n * 10) % n;
    if (room.eliminated?.has(order[cur])) continue;
    walked++;
  }
  return order[cur];
}

function rotateWildMulti(room) {
  if (room.turnDirection === 1) {
    room.playerOrder.unshift(room.playerOrder.pop());
  } else {
    room.playerOrder.push(room.playerOrder.shift());
  }
}

function socketIdForChessColor(room, colorChar) {
  const idx = colorChar === 'w' ? 0 : 1;
  return room.playerOrder[idx] ?? null;
}

function socketIdsForTeamColor(room, colorChar) {
  if (room.gameMode === '2v2') {
    return room.playerOrder.filter((_, i) => (i % 2 === 0 ? 'b' : 'w') === colorChar);
  }
  const one = socketIdForChessColor(room, colorChar);
  return one ? [one] : [];
}

function chessColor(room, socketId) {
  return colorOfSeat(room, socketId) === 'w' ? WHITE : BLACK;
}

/** After a move, keep the same side to move for multi-move turns. */
function fenSameSideToMove(fen, sideChar) {
  const p = fen.split(' ');
  p[1] = sideChar;
  return p.join(' ');
}

/** At end of a player's chess sub-phase, hand turn to opponent in FEN. */
function fenOpponentToMove(fen, moverWasWhite) {
  const p = fen.split(' ');
  p[1] = moverWasWhite ? 'b' : 'w';
  return p.join(' ');
}

function parseSquare(sq) {
  if (!sq || typeof sq !== 'string' || sq.length !== 2) return null;
  const file = sq.charCodeAt(0) - 'a'.charCodeAt(0);
  const rank = Number(sq[1]) - 1;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return { file, rank };
}

function rankOfSquare(sq) {
  const p = parseSquare(sq);
  return p ? p.rank + 1 : null;
}

function isLegalDropSquare(room, socketId, square) {
  const color = colorOfSeat(room, socketId);
  const r = rankOfSquare(square);
  if (color === 'w') return r === 1 || r === 2;
  return r === 7 || r === 8;
}

/** True if every square on the drawer's home two ranks has a piece (no empty drop cell for +2/+4 home drops). */
function allHomeRanksOccupied(room, socketId) {
  const color = colorOfSeat(room, socketId);
  const ranks = color === 'w' ? [1, 2] : [7, 8];
  for (const rank of ranks) {
    for (let file = 0; file < 8; file++) {
      const sq = `${String.fromCharCode(97 + file)}${rank}`;
      if (!room.chess.get(sq)) return false;
    }
  }
  return true;
}

function kingAttackedAfterPut(test, kingColor) {
  const by = kingColor === WHITE ? BLACK : WHITE;
  for (const sq of SQUARES) {
    const p = test.get(sq);
    if (p && p.type === KING && p.color === kingColor && test.isAttacked(sq, by)) return true;
  }
  return false;
}

function validateDropDoesNotLeaveOwnKingInCheck(chess, pieceType, pieceColor, square) {
  const test = new Chess(chess.fen());
  const existing = test.remove(square);
  if (existing && existing.type === KING) return false;
  const ok = test.put({ type: pieceType, color: pieceColor }, square);
  if (!ok) return false;
  return !kingAttackedAfterPut(test, pieceColor);
}

function pieceFromCapturedEntry(entry) {
  return { type: entry.type, color: entry.color === 'w' ? WHITE : BLACK };
}

export function createRoom(hostId, opts = {}) {
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const gm = opts.gameMode || 'classic';
  const chess = new Chess();
  const deck = buildDeck();
  const room = {
    code,
    playerOrder: [hostId],
    chess,
    deck,
    shuffles: { [hostId]: 0 },
    phase: 'lobby',
    activeSeat: null,
    movesRemaining: 0,
    activeCard: null,
    lastCompletedChessTurn: null,
    skipNextFor: null,
    bonus: null,
    hostages: { w: [], b: [] },
    chessMoveOwners: [],
    pendingReveal: null,
    revealSeq: 0,
    lastPulled: null,
    gameResult: null,
    playAgainVotes: {},
    matchType: 'private',
    matchAccounts: null,
    rankedSettled: false,
    gameMode: gm,
    turnDirection: 1,
    ffa: null,
    eliminated: null,
    lobbyReady: Object.create(null),
    botProfile: Object.create(null),
  };
  if (!isBotPlayerId(hostId)) room.lobbyReady[hostId] = false;
  return room;
}

function ensureShuffleSlot(room, pid) {
  if (room.shuffles[pid] === undefined) room.shuffles[pid] = 0;
}

export function startMatchFromLobby(room, opts = {}) {
  const max = maxPlayers(room);
  if (room.playerOrder.length < max) return { ok: false, error: 'Room is not full' };
  if (!opts.force) {
    for (const pid of room.playerOrder) {
      if (isBotPlayerId(pid)) continue;
      if (!room.lobbyReady?.[pid]) return { ok: false, error: 'Players are not all ready' };
    }
  }
  for (const pid of room.playerOrder) ensureShuffleSlot(room, pid);
  room.phase = 'playCard';
  room.activeSeat = room.playerOrder[0];
  room.chessMoveOwners = [];
  room.lastCompletedChessTurn = { playerId: null, sanMoves: [], uciMoves: [] };
  if (room.gameMode === 'ffa') {
    room.ffa = createFfaState();
    room.eliminated = new Set();
  } else {
    room.eliminated = null;
  }
  return { ok: true };
}

function tryAutoStartLobby(room) {
  if (room.phase !== 'lobby' || room.matchType !== 'private') return;
  const max = maxPlayers(room);
  if (room.playerOrder.length < max) return;
  for (const pid of room.playerOrder) {
    if (isBotPlayerId(pid)) continue;
    if (!room.lobbyReady?.[pid]) return;
  }
  startMatchFromLobby(room, { force: false });
}

export function joinRoom(room, socketId, opts = {}) {
  const autoStartIfFull = !!opts.autoStartIfFull;
  if (room.playerOrder.includes(socketId)) return { ok: true, seat: room.playerOrder.indexOf(socketId) };
  const max = maxPlayers(room);
  if (room.playerOrder.length >= max) return { ok: false, error: 'Room is full' };
  room.playerOrder.push(socketId);
  ensureShuffleSlot(room, socketId);
  if (!room.lobbyReady) room.lobbyReady = Object.create(null);
  if (!room.botProfile) room.botProfile = Object.create(null);
  if (!isBotPlayerId(socketId)) room.lobbyReady[socketId] = false;
  if (autoStartIfFull && room.playerOrder.length === max) {
    startMatchFromLobby(room, { force: true });
  } else {
    tryAutoStartLobby(room);
  }
  return { ok: true, seat: room.playerOrder.length - 1 };
}

export function addLobbyBot(room, requesterId, payload = {}) {
  if (room.phase !== 'lobby') return { ok: false, error: 'Not in lobby' };
  if (room.playerOrder[0] !== requesterId) return { ok: false, error: 'Only the host can add bots' };
  const max = maxPlayers(room);
  if (room.playerOrder.length >= max) return { ok: false, error: 'Room is full' };
  const diffRaw = String(payload?.difficulty || 'medium').toLowerCase();
  const difficulty = ['easy', 'medium', 'hard', 'extreme'].includes(diffRaw) ? diffRaw : 'medium';
  const id = `bot:${randomUUID()}`;
  room.botProfile[id] = { difficulty, name: `Bot (${difficulty})` };
  room.playerOrder.push(id);
  ensureShuffleSlot(room, id);
  tryAutoStartLobby(room);
  return { ok: true, botId: id };
}

export function removeLobbyBot(room, requesterId, botId) {
  if (room.phase !== 'lobby') return { ok: false, error: 'Not in lobby' };
  if (room.playerOrder[0] !== requesterId) return { ok: false, error: 'Only the host can remove bots' };
  const idx = room.playerOrder.indexOf(botId);
  if (idx === -1) return { ok: false, error: 'Not in room' };
  if (!isBotPlayerId(botId)) return { ok: false, error: 'Not a bot' };
  room.playerOrder.splice(idx, 1);
  delete room.botProfile[botId];
  delete room.shuffles[botId];
  tryAutoStartLobby(room);
  return { ok: true };
}

export function setLobbyReady(room, socketId, ready) {
  if (room.phase !== 'lobby') return { ok: false, error: 'Not in lobby' };
  if (!room.playerOrder.includes(socketId)) return { ok: false, error: 'Not in room' };
  if (isBotPlayerId(socketId)) return { ok: false, error: 'Bots are always ready' };
  if (!room.lobbyReady) room.lobbyReady = Object.create(null);
  room.lobbyReady[socketId] = !!ready;
  tryAutoStartLobby(room);
  return { ok: true };
}

export function leaveRoom(room, socketId) {
  room.playerOrder = room.playerOrder.filter((id) => id !== socketId);
  delete room.shuffles[socketId];
  if (room.lobbyReady) delete room.lobbyReady[socketId];
}

export function tryShuffleDeck(room, socketId) {
  ensureShuffleSlot(room, socketId);
  if (room.phase === 'lobby') return { ok: false, error: 'Game has not started' };
  if (room.phase === 'revealing') return { ok: false, error: 'Wait for the card reveal to finish' };
  if (room.shuffles[socketId] >= 2) return { ok: false, error: 'No shuffles left' };
  shuffleInPlace(room.deck);
  room.shuffles[socketId]++;
  return { ok: true };
}

function undoOpponentChessMoves(room, socketId) {
  if (!isTwoPlayerChess(room)) return;
  const opp = opponentId(room, socketId);
  if (!opp) return;
  while (
    room.chessMoveOwners.length > 0 &&
    room.chessMoveOwners[room.chessMoveOwners.length - 1] === opp
  ) {
    room.chessMoveOwners.pop();
    const u = room.chess.undo();
    if (u && u.captured) {
      const victimColor = u.color === WHITE || u.color === 'w' ? 'b' : 'w';
      const arr = room.hostages[victimColor];
      const t = u.captured;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].type === t) {
          arr.splice(i, 1);
          break;
        }
      }
    }
  }
}

/** Pull top card for reveal animation; card leaves deck until commit. */
export function beginReveal(room, socketId) {
  if (room.phase !== 'playCard') return { ok: false, error: 'Not time to draw' };
  if (room.pendingReveal) return { ok: false, error: 'Reveal already in progress' };
  if (room.activeSeat !== socketId) return { ok: false, error: 'Not your turn' };
  const card = drawFromDeck(room);
  if (!card) return { ok: false, error: 'Deck is empty' };
  room.revealSeq = (room.revealSeq || 0) + 1;
  room.pendingReveal = { playerId: socketId, card, seq: room.revealSeq };
  room.phase = 'revealing';
  room.lastPulled = { playerId: socketId, card: serializeCard(card) };
  return { ok: true, card };
}

/** Apply the card after reveal animation (server timer). */
export function commitPendingReveal(room) {
  const p = room.pendingReveal;
  if (!p) return { ok: false, error: 'Nothing to commit' };
  const { playerId, card } = p;
  room.pendingReveal = null;
  const r = activateDrawnCard(room, playerId, card);
  return r;
}

/** Return the pending card to top of deck if the drawer leaves mid-reveal. */
export function abortRevealIfDrawerLeft(room, socketId) {
  const p = room.pendingReveal;
  if (!p || p.playerId !== socketId) return;
  room.deck.unshift(p.card);
  room.pendingReveal = null;
  room.phase = 'playCard';
  room.lastPulled = null;
}

function activateDrawnCard(room, socketId, card) {
  if (room.activeSeat !== socketId) return { ok: false, error: 'Not your turn' };
  room.activeCard = card;

  if (card.type === 'number') {
    room.movesRemaining = card.value;
    room.phase = 'makingMoves';
    if (room.gameMode === 'ffa') {
      if (room.movesRemaining === 0) {
        return finishTurnAfterCardEffects(room, socketId, card);
      }
      return { ok: true };
    }
    const need = chessColor(room, socketId);
    if (room.chess.turn() !== need) {
      const p = room.chess.fen().split(' ');
      p[1] = need === WHITE ? 'w' : 'b';
      room.chess.load(p.join(' '));
    }
    if (room.movesRemaining === 0) {
      return finishTurnAfterCardEffects(room, socketId, card);
    }
    return { ok: true };
  }

  if (card.type === 'skip') {
    room.skipNextFor =
      room.playerOrder.length >= 4 && (room.gameMode === '2v2' || room.gameMode === 'ffa')
        ? socketAfter(room, socketId, 1)
        : opponentId(room, socketId);
    return finishTurnAfterCardEffects(room, socketId, card);
  }

  if (card.type === 'reverse') {
    if (room.playerOrder.length >= 4 && (room.gameMode === '2v2' || room.gameMode === 'ffa')) {
      room.turnDirection *= -1;
    } else {
      undoOpponentChessMoves(room, socketId);
    }
    return finishTurnAfterCardEffects(room, socketId, card);
  }

  if (card.type === 'wild') {
    if (room.playerOrder.length >= 4 && (room.gameMode === '2v2' || room.gameMode === 'ffa')) {
      rotateWildMulti(room);
    } else {
      const newFen = flipFen(room.chess.fen());
      room.chess.load(newFen);
      room.chessMoveOwners = [];
      if (room.playerOrder.length === 2) {
        [room.playerOrder[0], room.playerOrder[1]] = [room.playerOrder[1], room.playerOrder[0]];
      }
      [room.hostages.w, room.hostages.b] = [
        [...room.hostages.b],
        [...room.hostages.w],
      ];
    }
    return finishTurnAfterCardEffects(room, socketId, card);
  }

  if (card.type === 'draw2' || card.type === 'draw4') {
    if (room.gameMode === 'ffa') {
      return finishTurnAfterCardEffects(room, socketId, card);
    }
    if (allHomeRanksOccupied(room, socketId)) {
      const r = finishTurnAfterCardEffects(room, socketId, card);
      return { ...r, bonusSkippedFor: socketId };
    }
    const n = card.type === 'draw2' ? 2 : 4;
    room.bonus = { playerId: socketId, total: n, done: 0, choices: [] };
    room.phase = 'bonus';
    return { ok: true };
  }

  return { ok: false, error: 'Unknown card' };
}

function finishTurnAfterCardEffects(room, socketId, playedCard) {
  if (!playedCard) return { ok: false, error: 'No active card' };
  returnCardToBottom(room, playedCard);
  room.activeCard = null;
  room.movesRemaining = 0;

  let next;
  if (room.playerOrder.length === 2 && isTwoPlayerChess(room)) {
    next = opponentId(room, socketId);
    if (room.skipNextFor && room.skipNextFor === next) {
      room.skipNextFor = null;
      next = socketId;
    }
  } else if (room.playerOrder.length === 4 && (room.gameMode === '2v2' || room.gameMode === 'ffa')) {
    let step = 1;
    const cand = socketAfter(room, socketId, step);
    if (room.skipNextFor && cand && room.skipNextFor === cand) {
      room.skipNextFor = null;
      step = 2;
    }
    next = socketAfter(room, socketId, step);
  } else {
    next = opponentId(room, socketId);
    if (room.skipNextFor && room.skipNextFor === next) {
      room.skipNextFor = null;
      next = socketId;
    }
  }

  room.phase = 'playCard';
  room.activeSeat = next;

  if (room.gameMode === 'ffa') {
    const wArmy = ffaWinnerArmy(room.ffa.board);
    if (wArmy != null) {
      const wid = room.playerOrder[wArmy];
      room.phase = 'gameover';
      room.gameResult = { kind: 'ffa_last_king', winnerId: wid, winnerArmy: wArmy };
      room.playAgainVotes = {};
      return { ok: true, gameover: true };
    }
  } else if (chessGameShouldEnd(room)) {
    room.phase = 'gameover';
    room.gameResult = computeGameResult(room);
    room.playAgainVotes = {};
    return { ok: true, gameover: true };
  }

  if (room.gameMode !== 'ffa' && room.activeSeat) {
    const need = chessColor(room, room.activeSeat);
    if (room.chess.turn() !== need) {
      const p = room.chess.fen().split(' ');
      p[1] = need === WHITE ? 'w' : 'b';
      room.chess.load(p.join(' '));
    }
  }

  return { ok: true };
}

function kingSquareMissingSide(chess) {
  let wKing = false;
  let bKing = false;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === KING) {
        if (cell.color === WHITE || cell.color === 'w') wKing = true;
        else bKing = true;
      }
    }
  }
  if (!wKing && !bKing) return 'both';
  if (!wKing) return 'w';
  if (!bKing) return 'b';
  return null;
}

function chessGameShouldEnd(room) {
  if (room.gameMode === 'ffa') return false;
  return Boolean(kingSquareMissingSide(room.chess) || room.chess.isGameOver());
}

/** After a finished game, FEN is authoritative. */
function computeGameResult(room) {
  const c = room.chess;
  const miss = kingSquareMissingSide(c);
  if (miss === 'both') {
    return { kind: 'draw', reason: 'no-kings' };
  }
  if (miss === 'w') {
    const ids = socketIdsForTeamColor(room, 'b');
    return {
      kind: 'king_captured',
      winnerId: ids[0] ?? null,
      winnerIds: room.gameMode === '2v2' ? ids : undefined,
      capturedColor: 'w',
    };
  }
  if (miss === 'b') {
    const ids = socketIdsForTeamColor(room, 'w');
    return {
      kind: 'king_captured',
      winnerId: ids[0] ?? null,
      winnerIds: room.gameMode === '2v2' ? ids : undefined,
      capturedColor: 'b',
    };
  }

  if (!c.isGameOver()) return null;
  const noMoves = c.moves().length === 0;
  if (c.isCheckmate() || (c.isCheck() && noMoves)) {
    const mated = c.turn();
    const winnerColor = mated === 'w' ? 'b' : 'w';
    const ids = socketIdsForTeamColor(room, winnerColor);
    return {
      kind: 'checkmate',
      winnerId: ids[0] ?? null,
      winnerIds: room.gameMode === '2v2' ? ids : undefined,
      matedColor: mated,
    };
  }
  if (c.isStalemate()) return { kind: 'stalemate' };
  if (c.isInsufficientMaterial()) return { kind: 'draw', reason: 'insufficient' };
  if (c.isThreefoldRepetition()) return { kind: 'draw', reason: 'threefold' };
  if (c.isDrawByFiftyMoves()) return { kind: 'draw', reason: 'fifty-move' };
  return { kind: 'draw', reason: 'draw' };
}

export function votePlayAgain(room, socketId) {
  if (room.phase !== 'gameover') return { ok: false, error: 'Game is not over' };
  if (!room.playerOrder.includes(socketId)) return { ok: false, error: 'Not in room' };
  room.playAgainVotes[socketId] = true;
  const votes = room.playerOrder.filter((id) => isBotPlayerId(id) || room.playAgainVotes[id]).length;
  if (votes < room.playerOrder.length) {
    return { ok: true, restarted: false, votes, needed: room.playerOrder.length };
  }
  resetMatch(room);
  return { ok: true, restarted: true };
}

function clearRevealForAbandon(room) {
  const p = room.pendingReveal;
  if (!p) return;
  room.deck.unshift(p.card);
  room.pendingReveal = null;
  room.lastPulled = null;
}

/** End the match immediately: abandoning player / their team loses (2v2); FFA others win. */
export function abandonMatch(room, socketId) {
  if (room.phase === 'lobby') return { ok: false, error: 'Not in a match' };
  if (room.phase === 'gameover') return { ok: false, error: 'Game already over' };
  if (!room.playerOrder.includes(socketId)) return { ok: false, error: 'Not in room' };

  clearRevealForAbandon(room);
  room.playAgainVotes = {};
  room.phase = 'gameover';
  room.bonus = null;
  room.activeCard = null;
  room.movesRemaining = 0;
  room.skipNextFor = null;

  const n = room.playerOrder.length;
  const gm = room.gameMode;

  if (isTwoPlayerChess(room) && n === 2) {
    const opp = opponentId(room, socketId);
    room.gameResult = { kind: 'forfeit', winnerId: opp, forfeitingId: socketId };
    return { ok: true, gameover: true };
  }

  if (gm === '2v2' && n === 4) {
    const myColor = colorOfSeat(room, socketId);
    if (myColor !== 'w' && myColor !== 'b') return { ok: false, error: 'Cannot abandon this seat' };
    const winColor = myColor === 'w' ? 'b' : 'w';
    const ids = socketIdsForTeamColor(room, winColor);
    room.gameResult = {
      kind: 'forfeit',
      winnerId: ids[0] ?? null,
      winnerIds: ids,
      forfeitingId: socketId,
    };
    return { ok: true, gameover: true };
  }

  if (gm === 'ffa' && n === 4) {
    const survivors = room.playerOrder.filter((id) => id !== socketId);
    const winnerId = survivors[0] ?? null;
    room.gameResult = {
      kind: 'forfeit',
      winnerId,
      forfeitingId: socketId,
      survivorIds: survivors,
    };
    return { ok: true, gameover: true };
  }

  return { ok: false, error: 'Cannot abandon this match type' };
}

function resetMatch(room) {
  room.turnDirection = 1;
  if (room.gameMode === 'ffa') {
    room.ffa = createFfaState();
    room.eliminated = new Set();
  } else {
    room.chess = new Chess();
    room.eliminated = null;
  }
  room.deck = buildDeck();
  room.hostages = { w: [], b: [] };
  room.chessMoveOwners = [];
  room.pendingReveal = null;
  room.revealSeq = 0;
  room.lastPulled = null;
  room.activeCard = null;
  room.movesRemaining = 0;
  room.bonus = null;
  room.rankedSettled = false;
  room.skipNextFor = null;
  room.gameResult = null;
  room.playAgainVotes = {};
  room.phase = 'playCard';
  room.activeSeat = room.playerOrder[0] || null;
  room.shuffles = {};
  for (const pid of room.playerOrder) room.shuffles[pid] = 0;
}

export function resolveBonus(room, socketId, payload) {
  if (room.gameMode === 'ffa') return { ok: false, error: 'No bonus in FFA' };
  if (room.phase !== 'bonus' || !room.bonus) return { ok: false, error: 'No bonus to resolve' };
  if (room.bonus.playerId !== socketId) return { ok: false, error: 'Not your bonus' };

  const colorChar = colorOfSeat(room, socketId);
  const myColor = colorChar === 'w' ? WHITE : BLACK;
  const poolKey = colorChar === 'w' || colorChar === 'b' ? colorChar : 'w';
  const pool = room.hostages[poolKey];

  if (payload.action === 'pawn') {
    const sq = payload.square;
    if (!sq) return { ok: false, error: 'Missing square' };
    if (!isLegalDropSquare(room, socketId, sq)) return { ok: false, error: 'Pawn must be placed on your side (ranks 1–2 or 7–8)' };
    if (room.chess.get(sq)) return { ok: false, error: 'Square occupied' };
    const r = rankOfSquare(sq);
    if (r === 1 || r === 8) return { ok: false, error: 'Cannot place pawn on back rank' };
    if (!validateDropDoesNotLeaveOwnKingInCheck(room.chess, PAWN, myColor, sq))
      return { ok: false, error: 'Illegal placement (king in check)' };
    room.chess.put({ type: PAWN, color: myColor }, sq);
  } else if (payload.action === 'recover') {
    const pieceType = (payload.pieceType || '').toLowerCase();
    if (!PIECE_TYPES.has(pieceType) || pieceType === 'k') return { ok: false, error: 'Invalid piece' };
    const idx = pool.findIndex((e) => e.type === pieceType);
    if (idx === -1) return { ok: false, error: 'That piece is not in your captured pool' };
    const sq = payload.square;
    if (!sq) return { ok: false, error: 'Missing square' };
    if (room.chess.get(sq)) return { ok: false, error: 'Square occupied' };
    const [entry] = pool.splice(idx, 1);
    const pc = pieceFromCapturedEntry(entry);
    if (!validateDropDoesNotLeaveOwnKingInCheck(room.chess, pc.type, pc.color, sq))
      return { ok: false, error: 'Illegal placement (king in check)' };
    room.chess.put(pc, sq);
  } else {
    return { ok: false, error: 'Unknown action' };
  }

  room.bonus.done++;
  if (room.bonus.done >= room.bonus.total) {
    const played = room.activeCard;
    room.bonus = null;
    return finishTurnAfterCardEffects(room, socketId, played);
  }
  return { ok: true };
}

/** Legal empty squares for +2/+4 pawn drops (same rules as resolveBonus pawn branch). */
export function listBonusPawnSquares(room, socketId) {
  if (room.gameMode === 'ffa') return [];
  const colorChar = colorOfSeat(room, socketId);
  const ranks = colorChar === 'w' ? [1, 2] : [7, 8];
  const squares = [];
  for (const rank of ranks) {
    for (let file = 0; file < 8; file++) {
      const sq = `${String.fromCharCode(97 + file)}${rank}`;
      if (room.chess.get(sq)) continue;
      const r = rankOfSquare(sq);
      if (r === 1 || r === 8) continue;
      squares.push(sq);
    }
  }
  return squares;
}

/** If recover pool is short, client should send pawn placements for the remainder. */
export function bonusHint(room, socketId) {
  if (room.gameMode === 'ffa') return null;
  if (!room.bonus || room.bonus.playerId !== socketId) return null;
  const colorChar = colorOfSeat(room, socketId);
  const poolKey = colorChar === 'w' || colorChar === 'b' ? colorChar : 'w';
  const pool = room.hostages[poolKey];
  const left = room.bonus.total - room.bonus.done;
  return { recoverableTypes: [...new Set(pool.map((p) => p.type))], poolSize: pool.length, left };
}

function parseRc(s) {
  const parts = String(s || '').split(',');
  if (parts.length !== 2) return null;
  const r = Number(parts[0]);
  const c = Number(parts[1]);
  if (!Number.isFinite(r) || !Number.isFinite(c)) return null;
  if (r < 0 || r >= FFA_H || c < 0 || c >= FFA_W) return null;
  if (ffaIsHole(r, c)) return null;
  return { r, c };
}

function makeFfaMove(room, socketId, { from, to, promotion }) {
  if (room.phase !== 'makingMoves') return { ok: false, error: 'Not in move phase' };
  if (room.activeSeat !== socketId) return { ok: false, error: 'Not your turn' };
  if (room.movesRemaining <= 0) return { ok: false, error: 'No moves remaining' };
  const army = room.playerOrder.indexOf(socketId);
  if (army === -1 || room.eliminated?.has(socketId)) return { ok: false, error: 'Not in game' };
  const fr = parseRc(from);
  const tc = parseRc(to);
  if (!fr || !tc) return { ok: false, error: 'Bad square' };
  const p = room.ffa.board[fr.r * FFA_W + fr.c];
  if (!p || p.a !== army) return { ok: false, error: 'Not your piece' };
  const target = room.ffa.board[tc.r * FFA_W + tc.c];
  const capKing = target && target.t.toLowerCase() === 'k';
  const victimArmy = capKing ? target.a : null;
  const next = ffaApplyMove(room.ffa, fr.r, fr.c, tc.r, tc.c, promotion);
  if (!next) return { ok: false, error: 'Illegal move' };
  room.ffa = next;
  if (capKing && victimArmy != null) {
    const vid = room.playerOrder[victimArmy];
    if (vid) room.eliminated.add(vid);
  }
  room.chessMoveOwners.push(socketId);
  room.movesRemaining--;
  const wArmy = ffaWinnerArmy(room.ffa.board);
  if (wArmy != null) {
    const wid = room.playerOrder[wArmy];
    room.phase = 'gameover';
    room.gameResult = { kind: 'ffa_last_king', winnerId: wid, winnerArmy: wArmy };
    room.playAgainVotes = {};
    const played = room.activeCard;
    if (played) returnCardToBottom(room, played);
    room.activeCard = null;
    return { ok: true, gameover: true };
  }
  if (room.movesRemaining > 0) return { ok: true };
  room.lastCompletedChessTurn = { playerId: socketId, sanMoves: [], uciMoves: [] };
  return finishTurnAfterCardEffects(room, socketId, room.activeCard);
}

export function makeChessMove(room, socketId, payload) {
  if (room.gameMode === 'ffa') {
    return makeFfaMove(room, socketId, payload);
  }
  const { from, to, promotion } = payload;
  if (room.phase !== 'makingMoves') return { ok: false, error: 'Not in move phase' };
  if (room.activeSeat !== socketId) return { ok: false, error: 'Not your turn' };
  if (room.movesRemaining <= 0) return { ok: false, error: 'No moves remaining' };

  const need = chessColor(room, socketId);
  if (room.chess.turn() !== need) {
    const p = room.chess.fen().split(' ');
    p[1] = need === WHITE ? 'w' : 'b';
    room.chess.load(p.join(' '));
  }

  const moveObj = { from, to };
  if (promotion) moveObj.promotion = promotion.toLowerCase().slice(0, 1);
  let m;
  try {
    m = room.chess.move(moveObj);
  } catch {
    return { ok: false, error: 'Illegal chess move' };
  }
  if (!m) {
    return { ok: false, error: 'Illegal chess move' };
  }

  if (m.captured && m.captured !== 'k') {
    const cap = m.captured;
    const lostColor = m.color === WHITE || m.color === 'w' ? 'b' : 'w';
    room.hostages[lostColor].push({ type: cap, color: lostColor });
  }

  room.chessMoveOwners.push(socketId);

  const moverIsWhite = m.color === WHITE || m.color === 'w';

  room.movesRemaining--;

  if (m.captured === 'k') {
    room.phase = 'gameover';
    const winCol = moverIsWhite ? 'w' : 'b';
    const ids = socketIdsForTeamColor(room, winCol);
    room.gameResult = {
      kind: 'king_captured',
      winnerId: socketId,
      winnerIds: room.gameMode === '2v2' ? ids : undefined,
      capturedColor: moverIsWhite ? 'b' : 'w',
    };
    room.playAgainVotes = {};
    room.lastCompletedChessTurn = {
      playerId: socketId,
      sanMoves: [],
      uciMoves: [],
    };
    const played = room.activeCard;
    if (played) returnCardToBottom(room, played);
    room.activeCard = null;
    return { ok: true, gameover: true };
  }

  if (chessGameShouldEnd(room)) {
    room.phase = 'gameover';
    room.gameResult = computeGameResult(room);
    room.playAgainVotes = {};
    room.lastCompletedChessTurn = {
      playerId: socketId,
      sanMoves: [],
      uciMoves: [],
    };
    const played = room.activeCard;
    if (played) returnCardToBottom(room, played);
    room.activeCard = null;
    return { ok: true, gameover: true };
  }

  if (room.movesRemaining > 0) {
    const sideChar = moverIsWhite ? 'w' : 'b';
    room.chess.load(fenSameSideToMove(room.chess.fen(), sideChar));
    return { ok: true };
  }

  room.lastCompletedChessTurn = { playerId: socketId, sanMoves: [m.san], uciMoves: [] };
  return finishTurnAfterCardEffects(room, socketId, room.activeCard);
}

export function endChessMovesEarly(room, socketId) {
  if (room.phase !== 'makingMoves') return { ok: false, error: 'Not in move phase' };
  if (room.activeSeat !== socketId) return { ok: false, error: 'Not your turn' };
  if (room.gameMode === 'ffa') {
    room.movesRemaining = 0;
    return finishTurnAfterCardEffects(room, socketId, room.activeCard);
  }
  const moverWasWhite = colorOfSeat(room, socketId) === 'w';
  room.chess.load(fenOpponentToMove(room.chess.fen(), moverWasWhite));
  room.movesRemaining = 0;
  return finishTurnAfterCardEffects(room, socketId, room.activeCard);
}

function serializeCard(c) {
  return { id: c.id, type: c.type, value: c.value, color: c.color };
}

function hostagesForPublic(room, viewerId) {
  if (room.gameMode === '2v2') {
    const mc = colorOfSeat(room, viewerId);
    const team = mc === 'w' || mc === 'b' ? mc : 'w';
    const opp = team === 'w' ? 'b' : 'w';
    return { mine: room.hostages[team] || [], theirs: room.hostages[opp] || [] };
  }
  if (room.gameMode === 'ffa') {
    return { mine: [], theirs: [] };
  }
  const opponent = opponentId(room, viewerId);
  return {
    mine: room.hostages[colorOfSeat(room, viewerId) || 'w'] || [],
    theirs: opponent ? room.hostages[colorOfSeat(room, opponent) || 'b'] || [] : [],
  };
}

export function publicState(room, viewerId) {
  const revealing = room.pendingReveal
    ? {
        playerId: room.pendingReveal.playerId,
        card: serializeCard(room.pendingReveal.card),
        seq: room.pendingReveal.seq,
      }
    : null;
  const isFfa = room.gameMode === 'ffa';
  const maxP = maxPlayers(room);
  let lobby = null;
  if (room.phase === 'lobby') {
    const slots = [];
    for (let i = 0; i < maxP; i++) {
      const pid = room.playerOrder[i];
      if (!pid) {
        slots.push({ kind: 'open', seat: i });
        continue;
      }
      if (isBotPlayerId(pid)) {
        const meta = room.botProfile?.[pid] || {};
        slots.push({
          kind: 'bot',
          seat: i,
          id: pid,
          label: meta.name || 'Bot',
          difficulty: meta.difficulty || 'medium',
          ready: true,
        });
      } else {
        slots.push({
          kind: 'human',
          seat: i,
          id: pid,
          isYou: pid === viewerId,
          ready: !!room.lobbyReady?.[pid],
        });
      }
    }
    lobby = {
      maxPlayers: maxP,
      slots,
      iAmHost: room.playerOrder[0] === viewerId,
      allFilled: room.playerOrder.length >= maxP,
      myReady: isBotPlayerId(viewerId) ? true : !!room.lobbyReady?.[viewerId],
    };
  }
  const base = {
    code: room.code,
    phase: room.phase,
    revealing,
    lobby,
    fen: isFfa ? null : room.chess.fen(),
    ffa: isFfa && room.ffa ? serializeFfaBoard(room.ffa) : null,
    activeSeat: room.activeSeat,
    movesRemaining: room.movesRemaining,
    playerOrder: [...room.playerOrder],
    deckSize: room.deck.length,
    turnDirection: room.turnDirection ?? 1,
    eliminatedIds: room.eliminated ? [...room.eliminated] : [],
    turnColor: isFfa ? null : room.chess.turn(),
    isCheck: isFfa ? false : room.chess.isCheck(),
    isCheckmate: isFfa ? false : room.chess.isCheckmate(),
    isDraw: isFfa ? false : room.chess.isDraw(),
    gameOver: room.phase === 'gameover' || (!isFfa && chessGameShouldEnd(room)),
    bonus: room.bonus
      ? {
          forPlayer: room.bonus.playerId,
          total: room.bonus.total,
          done: room.bonus.done,
        }
      : null,
    shuffles: Object.fromEntries(room.playerOrder.map((pid) => [pid, room.shuffles[pid] ?? 0])),
    skipNotice: room.skipNextFor,
    lastPulled: room.lastPulled || null,
    gameResult: room.gameResult || null,
    playAgain: {
      voted: room.playerOrder.filter((id) => isBotPlayerId(id) || room.playAgainVotes[id]).length,
      needed: room.playerOrder.length,
      iVoted: isBotPlayerId(viewerId) ? true : !!room.playAgainVotes[viewerId],
    },
    matchKind: room.matchType || 'private',
    gameMode: room.gameMode || 'classic',
    mySeat: room.playerOrder.indexOf(viewerId),
  };
  return {
    ...base,
    myColor: colorOfSeat(room, viewerId),
    hostages: hostagesForPublic(room, viewerId),
  };
}
