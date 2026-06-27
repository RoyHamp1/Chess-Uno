import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { io } from 'socket.io-client';
import {
  ffaLegalMoves,
  ffaInMiddle,
  ffaIsHole,
  ffaPawnReachesPromotionEdge,
  FFA_W,
} from '@ffa-engine';
import { AuthPanel } from './AuthPanel.jsx';
import { rankBadgeClassName } from './rankBadgeClass.js';
import { MoveArrowsOverlay } from './moveArrows.jsx';

const DISPLAY_NAME_KEY = 'chess-uno-display-name';
const AUTH_TOKEN_KEY = 'chess-uno-auth-token';
const AUTH_CHANGED = 'chess-uno-auth-changed';
const REJOIN_STORAGE_KEY = 'chess-uno-rejoin';

function readStoredRejoin() {
  try {
    const raw = sessionStorage.getItem(REJOIN_STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p?.code && p?.token) return { code: p.code, token: p.token };
  } catch {
    /* ignore */
  }
  return null;
}

function writeStoredRejoin(code, token) {
  try {
    if (code && token) {
      sessionStorage.setItem(REJOIN_STORAGE_KEY, JSON.stringify({ code, token }));
    } else {
      sessionStorage.removeItem(REJOIN_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

function disconnectPlayerLabel(state, playerId, myId) {
  if (!playerId) return 'A player';
  if (playerId === myId) return 'You';
  const seat = state?.plusSeats?.find((s) => s.playerId === playerId);
  if (seat?.name) return seat.name;
  return actorLabel(playerId, myId, state?.playerOrder);
}

const MATCH_MODES = [
  { id: 'classic', label: 'Classic' },
  { id: '2v2', label: '2v2' },
  { id: 'ffa', label: 'FFA' },
  { id: 'wild', label: 'WILD' },
];

function matchModeLabel(id) {
  const m = MATCH_MODES.find((x) => x.id === id);
  return m?.label ?? id;
}

function ModeSelector({ selectedGameMode, setSelectedGameMode, labelledById, modes = MATCH_MODES }) {
  return (
    <div
      className="lobby-mode-strip"
      role="tablist"
      aria-label={labelledById ? undefined : 'Match mode'}
      aria-labelledby={labelledById || undefined}
    >
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          role="tab"
          aria-selected={selectedGameMode === m.id}
          className={`lobby-mode-btn${selectedGameMode === m.id ? ' selected' : ''}`}
          onClick={() => setSelectedGameMode(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function readAuthToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

const PIECE = {
  P: '♙',
  N: '♘',
  B: '♗',
  R: '♖',
  Q: '♕',
  K: '♔',
  p: '♟',
  n: '♞',
  b: '♝',
  r: '♜',
  q: '♛',
  k: '♚',
};

function parseFenBoard(fen) {
  const placement = fen.split(' ')[0];
  const ranks = placement.split('/');
  return ranks.map((row) => {
    const cells = [];
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < Number(ch); i++) cells.push(null);
      } else cells.push(ch);
    }
    return cells;
  });
}

const FFA_ARMY_NAMES = ['South / White', 'East / Blue', 'North / Black', 'West / Red'];

/** Seat/army 0=south black, 1=north grey, 2=west white, 3=east beige — matches `create2v2State`. */
const TEAM2V2_ARMY_NAMES = ['Black', 'Dark grey', 'White', 'Beige'];
const TEAM2V2_TEAM_LABEL = ['Black & Grey (South ↔ North)', 'White & Beige (West ↔ East)'];

function armyTeam2v2(army) {
  return army < 2 ? 0 : 1;
}

function isPlusBoardMode(gameMode) {
  return gameMode === 'ffa' || gameMode === '2v2';
}

function PlusSeatLabel({ seat, gameMode, isActive }) {
  const swatchPrefix = gameMode === '2v2' ? 'team2v2' : 'ffa';
  return (
    <div
      className={`plus-seat-label plus-seat-label--${seat.side}${seat.isYou ? ' plus-seat-you' : ''}${
        isActive ? ' plus-seat-active' : ''
      }${seat.eliminated ? ' plus-seat-out' : ''}`}
      title={`${seat.name} · ${seat.colorName}`}
    >
      <span
        className={`plus-seat-swatch plus-seat-swatch--${swatchPrefix}-a${seat.army}`}
        aria-hidden
      />
      <span className="plus-seat-name">{seat.name}</span>
      <span className="plus-seat-color">{seat.colorName}</span>
    </div>
  );
}

function PlusBoardFrame({ state, children }) {
  const seats = state.plusSeats;
  if (!seats?.length) return children;
  const bySide = Object.fromEntries(seats.map((s) => [s.side, s]));
  const activeId = state.activeSeat;
  const render = (side) => {
    const s = bySide[side];
    if (!s) return null;
    return (
      <PlusSeatLabel seat={s} gameMode={state.gameMode} isActive={s.playerId && activeId === s.playerId} />
    );
  };
  return (
    <div className="plus-board-frame">
      <div className="plus-seat-edge plus-seat-edge--north">{render('north')}</div>
      <div className="plus-seat-edge plus-seat-edge--west">{render('west')}</div>
      <div className="plus-board-core">{children}</div>
      <div className="plus-seat-edge plus-seat-edge--east">{render('east')}</div>
      <div className="plus-seat-edge plus-seat-edge--south">{render('south')}</div>
    </div>
  );
}

function buildFfaGrid(ffa) {
  if (!ffa?.cells) return null;
  const w = ffa.w;
  const h = ffa.h;
  const rows = [];
  for (let r = 0; r < h; r++) {
    const row = [];
    for (let c = 0; c < w; c++) {
      row.push(ffa.cells[r * w + c]);
    }
    rows.push(row);
  }
  return rows;
}

function labelCard(c) {
  if (c.type === 'skip') return 'Skip';
  if (c.type === 'reverse') return 'Rev';
  if (c.type === 'wild') return 'Wild';
  if (c.type === 'draw2') return '+2';
  if (c.type === 'draw4') return '+4';
  if (c.type === 'number' && c.value != null) return String(c.value);
  return '?';
}

function cardPullSummary(card) {
  if (!card) return 'Drew';
  if (card.type === 'number' && card.value != null) return `Pulled ${card.value}`;
  if (card.type === 'skip') return 'Pulled Skip';
  if (card.type === 'reverse') return 'Pulled Reverse';
  if (card.type === 'wild') return 'Pulled Wild';
  if (card.type === 'draw2') return 'Pulled +2';
  if (card.type === 'draw4') return 'Pulled +4';
  return 'Drew a card';
}

function actorLabel(playerId, myId, playerOrder) {
  if (!playerOrder?.length) return 'Player';
  if (playerId === myId) return 'You';
  const idx = playerOrder.indexOf(playerId);
  if (idx >= 0 && playerOrder.length > 2) return `Player ${idx + 1}`;
  return 'Opponent';
}

/** Display row 0 = top of screen. Returns { file 0–7, rank 1–8 } in standard orientation. */
function displayIndexToSquare(fi, ri, myColor) {
  if (myColor === 'w') {
    const rank = 8 - ri;
    const file = fi;
    return { file, rank, sq: `${String.fromCharCode(97 + file)}${rank}` };
  }
  const rank = ri + 1;
  const file = 7 - fi;
  return { file, rank, sq: `${String.fromCharCode(97 + file)}${rank}` };
}

/** Legal move targets from `from` (matches server: force side to move for multi-move turns). */
function legalTargetsFrom(fen, from, myColorChar) {
  const map = new Map();
  try {
    const chess = new Chess(fen);
    const need = myColorChar === 'w' ? 'w' : 'b';
    if (chess.turn() !== need) {
      const parts = chess.fen().split(' ');
      parts[1] = need;
      if (!chess.load(parts.join(' '))) return map;
    }
    const moves = chess.moves({ square: from, verbose: true });
    for (const m of moves) {
      const isCap =
        !!m.captured ||
        (typeof m.isCapture === 'function' && m.isCapture()) ||
        (typeof m.isEnPassant === 'function' && m.isEnPassant());
      map.set(m.to, isCap ? 'capture' : 'move');
    }
  } catch {
    /* ignore bad FEN */
  }
  return map;
}

function gameOverHeadline(state, myId) {
  const gr = state?.gameResult;
  if (!gr) return 'Game over';
  if (gr.kind === 'ffa_last_king') {
    if (gr.winnerId === myId) return 'You won — last king standing';
    return 'You lost — last king standing';
  }
  if (gr.kind === '2v2_team') {
    if (gr.winnerIds?.includes(myId)) return 'You won — enemy team eliminated';
    return 'You lost — your team was eliminated';
  }
  if (gr.kind === 'disconnect_forfeit') {
    if (gr.forfeitingId === myId) {
      return 'You lost — disconnected and did not return in time';
    }
    if (gr.noContestIds?.includes(myId)) {
      return 'No contest — your teammate abandoned the match';
    }
    if (gr.winnerIds?.includes(myId) || gr.winnerId === myId) {
      return 'You won — opponent disconnected';
    }
    return 'Match ended — player disconnected';
  }
  if (gr.kind === 'forfeit') {
    if (gr.forfeitingId === myId) return 'You lost — you abandoned this match';
    if (state.gameMode === '2v2' && gr.forfeitingId && state.playerOrder?.length === 4) {
      const fo = gr.forfeitingId;
      const myIdx = state.playerOrder.indexOf(myId);
      const foIdx = state.playerOrder.indexOf(fo);
      if (myIdx >= 0 && foIdx >= 0 && armyTeam2v2(myIdx) === armyTeam2v2(foIdx)) {
        return 'You lost — a teammate abandoned';
      }
    }
    if (
      (gr.winnerIds && gr.winnerIds.includes(myId)) ||
      (gr.survivorIds && gr.survivorIds.includes(myId)) ||
      gr.winnerId === myId
    ) {
      return 'You won — an opponent abandoned';
    }
    return 'Game over';
  }
  if (gr.kind === 'checkmate') {
    if (gr.winnerIds?.length) {
      if (gr.winnerIds.includes(myId)) return 'You won — checkmate (team)';
      return 'You lost — checkmate';
    }
    if (gr.winnerId === myId) return 'You won — checkmate';
    return 'You lost — checkmate';
  }
  if (gr.kind === 'king_captured') {
    if (gr.winnerIds?.length) {
      if (gr.winnerIds.includes(myId)) return 'You won — king captured (team)';
      return 'You lost — king captured';
    }
    if (gr.winnerId === myId) return 'You won — king captured';
    return 'You lost — king captured';
  }
  if (gr.kind === 'stalemate') return 'Draw — stalemate';
  if (gr.kind === 'draw') {
    const r = gr.reason || 'draw';
    const label =
      r === 'insufficient'
        ? 'insufficient material'
        : r === 'threefold'
          ? 'threefold repetition'
          : r === 'fifty-move'
            ? 'fifty-move rule'
            : 'agreement or draw';
    return `Draw — ${label}`;
  }
  return 'Game over';
}

/** Win / loss crown for decisive game-over screens; null for draws. */
function gameOverCrownVariant(state, myId) {
  if (!state || state.phase !== 'gameover') return null;
  const gr = state.gameResult;
  if (!gr) return null;
  if (gr.kind === 'stalemate' || gr.kind === 'draw') return null;
  if (gr.kind === 'disconnect_forfeit') {
    if (gr.forfeitingId === myId) return 'loss';
    if (gr.noContestIds?.includes(myId)) return 'noContest';
    if (gr.winnerIds?.includes(myId) || gr.winnerId === myId) return 'win';
    return null;
  }
  if (gr.kind === 'forfeit') {
    if (gr.forfeitingId === myId) return 'loss';
    if (gr.winnerIds?.includes(myId) || gr.survivorIds?.includes(myId) || gr.winnerId === myId) return 'win';
    return 'loss';
  }
  if (gr.kind === 'ffa_last_king') return gr.winnerId === myId ? 'win' : 'loss';
  if (gr.kind === '2v2_team') return gr.winnerIds?.includes(myId) ? 'win' : 'loss';
  if (gr.kind === 'checkmate' || gr.kind === 'king_captured') {
    if (gr.winnerIds?.length) return gr.winnerIds.includes(myId) ? 'win' : 'loss';
    return gr.winnerId === myId ? 'win' : 'loss';
  }
  return null;
}

const KICK_CROWN_MS = 2800;

function CrownOutcomeVisual({ variant, size = 'large' }) {
  if (variant === 'noContest') {
    return (
      <div
        className={`crown-outcome-icon crown-outcome-icon--no-contest crown-outcome-icon--${size}`}
        aria-hidden
      >
        <svg className="crown-outcome-svg crown-outcome-svg--line" viewBox="0 0 120 24" xmlns="http://www.w3.org/2000/svg">
          <line x1="8" y1="12" x2="112" y2="12" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
        </svg>
      </div>
    );
  }
  return (
    <div
      className={`crown-outcome-icon crown-outcome-icon--${variant} crown-outcome-icon--${size}`}
      aria-hidden
    >
      <svg className="crown-outcome-svg" viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg">
        <path
          fill="currentColor"
          d="M12 78 L22 32 L42 50 L60 14 L78 50 L98 32 L108 78 Z M26 78 L94 78 L82 48 L60 72 L38 48 Z"
        />
      </svg>
    </div>
  );
}

export default function App() {
  const [socket, setSocket] = useState(null);
  const [state, setState] = useState(null);
  const [roomCode, setRoomCode] = useState('');
  const [joinInput, setJoinInput] = useState('');
  const [toast, setToast] = useState(null);
  const [pickFrom, setPickFrom] = useState(null);
  const [promoPending, setPromoPending] = useState(null);
  const [bonusPick, setBonusPick] = useState(null);
  const [displayName, setDisplayName] = useState(() => {
    try {
      return localStorage.getItem(DISPLAY_NAME_KEY) || '';
    } catch {
      return '';
    }
  });
  const [authProfile, setAuthProfile] = useState(null);
  const [queueStatus, setQueueStatus] = useState({ type: null, waiting: false, gameMode: null });
  const [matchmakingMode, setMatchmakingMode] = useState('classic');
  const [privateRoomMode, setPrivateRoomMode] = useState('classic');
  const [lobbyBotDiff, setLobbyBotDiff] = useState('medium');
  const [abandonPrompt, setAbandonPrompt] = useState(null);
  const [deckShufflePlaying, setDeckShufflePlaying] = useState(false);
  const [crownOverlay, setCrownOverlay] = useState(null);
  const [rejoinOffer, setRejoinOffer] = useState(null);
  const crownKickTimeoutRef = useRef(null);

  useEffect(() => {
    try {
      const t = displayName.trim();
      if (t) localStorage.setItem(DISPLAY_NAME_KEY, t);
      else localStorage.removeItem(DISPLAY_NAME_KEY);
    } catch {
      /* ignore */
    }
  }, [displayName]);

  useEffect(() => {
    if (state?.phase === 'gameover') setAbandonPrompt(null);
  }, [state?.phase]);

  useEffect(() => {
    if (state?.rejoinToken && state?.code && state.phase !== 'lobby') {
      writeStoredRejoin(state.code, state.rejoinToken);
    }
    if (state?.phase === 'gameover' && state?.gameResult?.noRematch) {
      writeStoredRejoin(null, null);
    }
    if (!state || state.phase === 'lobby') {
      if (!rejoinOffer) writeStoredRejoin(null, null);
    }
  }, [state?.rejoinToken, state?.code, state?.phase, state?.gameResult?.noRematch, rejoinOffer]);

  const modeForTheme = useMemo(() => {
    if (!state || state.phase === 'lobby') {
      if (state?.gameMode) return state.gameMode;
      return 'classic';
    }
    return state.gameMode || 'classic';
  }, [state]);

  useEffect(() => {
    document.documentElement.dataset.matchMode = modeForTheme;
  }, [modeForTheme]);

  useEffect(() => {
    if (!state || state.phase !== 'gameover' || state.matchKind !== 'ranked') return;
    const t = readAuthToken();
    if (!t) return;
    void fetch('/api/auth/me', { headers: { Authorization: `Bearer ${t}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.user) {
          setAuthProfile(d.user);
          window.dispatchEvent(new CustomEvent(AUTH_CHANGED, { detail: { user: d.user } }));
        }
      });
  }, [state?.phase, state?.matchKind, state?.code]);

  useEffect(() => {
    let s;
    let lastToken = readAuthToken();
    const wire = (socket) => {
      socket.on('state', setState);
      socket.on('roomCode', setRoomCode);
      socket.on('queueStatus', (q) => {
        setQueueStatus({
          type: q?.waiting ? q?.type ?? null : null,
          waiting: !!q?.waiting,
          gameMode: q?.waiting ? q?.gameMode ?? 'classic' : null,
        });
      });
      socket.on('queueMatched', () => {
        setToast('Matched — starting game');
        setTimeout(() => setToast(null), 2800);
      });
      socket.on('kickedToLobby', (p) => {
        if (crownKickTimeoutRef.current) {
          clearTimeout(crownKickTimeoutRef.current);
          crownKickTimeoutRef.current = null;
        }
        const variant = p?.outcome === 'win' ? 'win' : 'loss';
        setCrownOverlay({ variant, message: p?.message || '' });
        crownKickTimeoutRef.current = window.setTimeout(() => {
          crownKickTimeoutRef.current = null;
          setCrownOverlay(null);
          setState(null);
          setRoomCode('');
          setAbandonPrompt(null);
          setPickFrom(null);
          setPromoPending(null);
          setBonusPick(null);
          if (p?.message) {
            setToast(p.message);
            setTimeout(() => setToast(null), 3800);
          }
        }, KICK_CROWN_MS);
      });
      socket.on('toast', (t) => {
        setToast(t.message);
        setTimeout(() => setToast(null), 3200);
      });
      socket.on('rejoinOffer', (offer) => {
        if (offer?.code && offer?.token) setRejoinOffer(offer);
      });
      socket.on('connect', () => {
        const pending = readStoredRejoin();
        if (pending) socket.emit('checkRejoin', pending);
      });
    };
    const connect = () => {
      if (crownKickTimeoutRef.current) {
        clearTimeout(crownKickTimeoutRef.current);
        crownKickTimeoutRef.current = null;
      }
      setCrownOverlay(null);
      if (s) {
        s.removeAllListeners();
        s.disconnect();
      }
      lastToken = readAuthToken();
      s = io({ path: '/socket.io', auth: { token: lastToken } });
      wire(s);
      setSocket(s);
      const pending = readStoredRejoin();
      if (pending) s.emit('checkRejoin', pending);
    };
    connect();
    const onAuth = (e) => {
      setAuthProfile(e.detail?.user ?? null);
      const nt = readAuthToken();
      if (nt !== lastToken) connect();
    };
    window.addEventListener(AUTH_CHANGED, onAuth);
    return () => {
      if (crownKickTimeoutRef.current) {
        clearTimeout(crownKickTimeoutRef.current);
        crownKickTimeoutRef.current = null;
      }
      window.removeEventListener(AUTH_CHANGED, onAuth);
      if (s) {
        s.removeAllListeners();
        s.disconnect();
      }
    };
  }, []);

  const myId = socket?.id;
  const gameoverCrown = useMemo(() => gameOverCrownVariant(state, myId), [state, myId]);
  const isMyTurn = state && state.activeSeat === myId;
  const shuffleDisabled =
    !state ||
    !myId ||
    state.phase === 'lobby' ||
    state.phase === 'revealing' ||
    state.phase === 'gameover' ||
    (state.shuffles?.[myId] ?? 0) >= 2;

  const handleShuffleDeck = () => {
    if (!socket || shuffleDisabled) return;
    setDeckShufflePlaying(true);
    socket.emit('shuffleDeck');
    window.setTimeout(() => setDeckShufflePlaying(false), 680);
  };
  const canQueueCasual =
    matchmakingMode === 'classic' ||
    matchmakingMode === '2v2' ||
    matchmakingMode === 'ffa' ||
    matchmakingMode === 'wild';
  const canQueueRanked = matchmakingMode === 'classic';

  useEffect(() => {
    if (!state || state.phase !== 'makingMoves' || state.activeSeat !== myId) {
      setPickFrom(null);
      setPromoPending(null);
    }
  }, [state?.phase, state?.activeSeat, myId]);

  const classicGrid = useMemo(() => {
    if (!state?.fen) return null;
    const raw = parseFenBoard(state.fen);
    if (state.myColor === 'b') {
      return [...raw].reverse().map((row) => [...row].reverse());
    }
    return raw;
  }, [state?.fen, state?.myColor]);

  const ffaGrid = useMemo(() => {
    if (!isPlusBoardMode(state?.gameMode) || !state?.ffa) return null;
    return buildFfaGrid(state.ffa);
  }, [state?.ffa, state?.gameMode]);

  const iterGrid = useMemo(() => {
    if (isPlusBoardMode(state?.gameMode)) return ffaGrid;
    return classicGrid;
  }, [state?.gameMode, ffaGrid, classicGrid]);

  const legalTo = useMemo(() => {
    if (!state?.fen || !pickFrom || state.phase !== 'makingMoves' || !isMyTurn || !state.myColor) {
      return new Map();
    }
    return legalTargetsFrom(state.fen, pickFrom, state.myColor);
  }, [state?.fen, state?.phase, state?.myColor, pickFrom, isMyTurn]);

  const ffaLeg = useMemo(() => {
    if (
      !state?.ffa ||
      !isPlusBoardMode(state.gameMode) ||
      !pickFrom ||
      state.phase !== 'makingMoves' ||
      !isMyTurn
    ) {
      return new Map();
    }
    const st = {
      board: state.ffa.cells.map((c) => (c ? { ...c } : null)),
      pawnMeta: { ...(state.ffa.pawnMeta || {}) },
    };
    const parts = pickFrom.split(',');
    const fr = Number(parts[0]);
    const fc = Number(parts[1]);
    if (!Number.isFinite(fr) || !Number.isFinite(fc)) return new Map();
    const teamMode =
      state.gameMode === '2v2' ? '2v2' : state.gameMode === 'ffa' ? 'ffa' : false;
    const moves = ffaLegalMoves(st, fr, fc, teamMode);
    const m = new Map();
    const army = state.mySeat;
    for (const [tr, tc] of moves) {
      const t = st.board[tr * FFA_W + tc];
      const cap = t && (teamMode ? armyTeam2v2(t.a) !== armyTeam2v2(army) : t.a !== army);
      m.set(`${tr},${tc}`, cap ? 'capture' : 'move');
    }
    return m;
  }, [state?.ffa, state?.gameMode, state?.phase, pickFrom, isMyTurn, state?.mySeat]);

  const activeLeg = isPlusBoardMode(state?.gameMode) ? ffaLeg : legalTo;

  const getBoardPiece = useCallback(
    (sq) => {
      if (!state?.fen) return null;
      const raw = parseFenBoard(state.fen);
      const file = sq.charCodeAt(0) - 97;
      const rank = Number(sq[1]);
      return raw[8 - rank][file];
    },
    [state?.fen],
  );

  const sendMove = (from, to, promotion) => {
    socket?.emit('chessMove', { from, to, promotion });
    setPickFrom(null);
    setPromoPending(null);
  };

  const onCellClick = (fi, ri) => {
    if (!state || state.phase !== 'makingMoves' || !isMyTurn) return;
    if (isPlusBoardMode(state.gameMode)) {
      const sq = `${ri},${fi}`;
      const ch = ffaGrid?.[ri]?.[fi];
      const myArmy = state.mySeat;
      if (!pickFrom) {
        if (ch && ch.a === myArmy) setPickFrom(sq);
        return;
      }
      if (pickFrom === sq) {
        setPickFrom(null);
        return;
      }
      if (ch?.a === myArmy) {
        setPickFrom(sq);
        return;
      }
      const parts = pickFrom.split(',');
      const fr = Number(parts[0]);
      const fc = Number(parts[1]);
      const piece = ffaGrid?.[fr]?.[fc];
      const needsPromo =
        piece &&
        piece.t.toLowerCase() === 'p' &&
        ffaPawnReachesPromotionEdge(piece.a, ri, fi);
      if (needsPromo) {
        setPromoPending({ from: pickFrom, to: sq, ffa: true });
        return;
      }
      sendMove(pickFrom, sq);
      return;
    }
    const { sq } = displayIndexToSquare(fi, ri, state.myColor);
    const ch = classicGrid?.[ri]?.[fi];
    if (!pickFrom) {
      if (
        ch &&
        ((state.myColor === 'w' && ch === ch.toUpperCase()) || (state.myColor === 'b' && ch === ch.toLowerCase()))
      ) {
        setPickFrom(sq);
      }
      return;
    }
    if (pickFrom === sq) {
      setPickFrom(null);
      return;
    }
    if (
      ch &&
      ((state.myColor === 'w' && ch === ch.toUpperCase()) || (state.myColor === 'b' && ch === ch.toLowerCase()))
    ) {
      setPickFrom(sq);
      return;
    }
    const piece = getBoardPiece(pickFrom);
    const toRank = Number(sq[1]);
    const needsPromo =
      piece &&
      piece.toLowerCase() === 'p' &&
      ((state.myColor === 'w' && toRank === 8) || (state.myColor === 'b' && toRank === 1));
    if (needsPromo) {
      setPromoPending({ from: pickFrom, to: sq });
      return;
    }
    sendMove(pickFrom, sq);
  };

  const onBonusCell = (fi, ri) => {
    if (!bonusPick || !socket || !state) return;
    let cfi = fi;
    let cri = ri;
    if (state.gameMode === '2v2') {
      if (ffaIsHole(ri, fi)) return;
      if (fi < 4 || fi > 11 || ri < 4 || ri > 11) return;
      cfi = fi - 4;
      cri = ri - 4;
    }
    const { sq } = displayIndexToSquare(cfi, cri, state.myColor);
    socket.emit('bonus', { ...bonusPick, square: sq });
    setBonusPick(null);
  };

  const activeRoomCode = state?.code || roomCode;
  const hasGeneratedCode = !!activeRoomCode && (!state || state.phase === 'lobby');
  const showAbandonMatch =
    state &&
    state.phase !== 'lobby' &&
    state.phase !== 'gameover' &&
    ['classic', '2v2', 'ffa'].includes(state.gameMode);
  const showAccountSidebar = !state || state.phase === 'lobby';

  const copyRoomCode = useCallback(async () => {
    const code = activeRoomCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setToast('Room code copied');
      setTimeout(() => setToast(null), 2000);
    } catch {
      setToast('Could not copy — select the code and copy manually');
      setTimeout(() => setToast(null), 4000);
    }
  }, [activeRoomCode]);

  const boardClick = (fi, ri) => {
    if (state?.phase === 'bonus' && state.bonus?.forPlayer === myId && bonusPick) {
      onBonusCell(fi, ri);
      return;
    }
    onCellClick(fi, ri);
  };

  if (!socket) return <div className="shell">Connecting…</div>;

  return (
    <div className="shell">
      <header className="head">
        <h1>Luck of the Draw</h1>
        <p className="tag">1v1 · Draw from the deck each turn — the card sets your chess moves and specials</p>
      </header>

      {toast && <div className="toast">{toast}</div>}

      {rejoinOffer && (
        <div className="confirm-overlay" role="presentation">
          <div className="confirm-modal rejoin-modal" role="dialog" aria-modal="true" aria-labelledby="rejoin-title">
            <h2 className="confirm-title" id="rejoin-title">
              Rejoin match?
            </h2>
            <p className="confirm-body">
              You were disconnected from room <strong>{rejoinOffer.code}</strong>. You have about{' '}
              <strong>{rejoinOffer.secondsLeft}s</strong> left to return.
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  socket?.emit('declineRejoin', { code: rejoinOffer.code, token: rejoinOffer.token });
                  writeStoredRejoin(null, null);
                  setRejoinOffer(null);
                }}
              >
                Decline
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  socket?.emit('rejoinMatch', { code: rejoinOffer.code, token: rejoinOffer.token });
                  setRejoinOffer(null);
                }}
              >
                Rejoin
              </button>
            </div>
          </div>
        </div>
      )}

      {crownOverlay && (
        <div className="crown-outcome-overlay crown-outcome-overlay--fullscreen" role="status" aria-live="polite">
          <div className="crown-outcome-float">
            <div className="crown-outcome-card">
              <CrownOutcomeVisual variant={crownOverlay.variant} size="large" />
              {crownOverlay.message ? <p className="crown-outcome-msg">{crownOverlay.message}</p> : null}
            </div>
          </div>
        </div>
      )}

      <div className={`shell-layout${showAccountSidebar ? '' : ' shell-layout--in-game'}`}>
        {!state || state.phase === 'lobby' ? (
          <div className="lobby-main-column">
            {authProfile && (
              <div
                className="panel lobby-tone lobby-panel--matchmaking"
                data-match-mode={matchmakingMode}
              >
                <section className="lobby-online">
                  <h2 className="lobby-heading" id="matchmaking-heading">
                    Matchmaking
                  </h2>
                  <p className="muted lobby-lead">
                    Choose a mode for the casual queue. Ranked is always Classic 1v1.
                  </p>
                  <ModeSelector
                    labelledById="matchmaking-heading"
                    selectedGameMode={matchmakingMode}
                    setSelectedGameMode={setMatchmakingMode}
                  />
                  <div className="lobby-rank-strip">
                    <span className={rankBadgeClassName(authProfile.rankTier)}>{authProfile.rankLabel}</span>
                    <span className="muted lobby-points">{authProfile.rankedRating ?? 0} points</span>
                  </div>
                  <p className="muted lobby-lead">
                    Queue for a random opponent. Ranked awards points after a decisive win — checkmate or king
                    captured (draws do not change points).
                  </p>
                  <div className="lobby-queue-row">
                    <button
                      type="button"
                      className="btn primary"
                      disabled={queueStatus.waiting || !canQueueCasual}
                      title={
                        !canQueueCasual
                          ? 'Pick a play mode to queue casual.'
                          : undefined
                      }
                      onClick={() => socket.emit('queueJoin', { type: 'casual', gameMode: matchmakingMode })}
                    >
                      Online
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={queueStatus.waiting || !canQueueRanked}
                      title={
                        !canQueueRanked
                          ? 'Ranked is Classic 1v1 only — pick Classic.'
                          : undefined
                      }
                      onClick={() => socket.emit('queueJoin', { type: 'ranked', gameMode: 'classic' })}
                    >
                      Ranked
                    </button>
                  </div>
                  {queueStatus.waiting && (
                    <div className="lobby-queue-footer">
                      <p className="muted queue-waiting">
                        Searching <strong>{queueStatus.type === 'ranked' ? 'ranked' : 'casual'}</strong>
                        {queueStatus.gameMode ? (
                          <>
                            {' '}
                            · <strong>{matchModeLabel(queueStatus.gameMode)}</strong>
                          </>
                        ) : null}
                        …
                      </p>
                      <button type="button" className="btn small" onClick={() => socket.emit('queueLeave')}>
                        Leave queue
                      </button>
                    </div>
                  )}
                </section>
              </div>
            )}

            <div
              className="panel lobby-tone lobby-panel--private"
              data-match-mode={privateRoomMode}
            >
              <section className="lobby-host">
                <h2 className="lobby-heading" id="private-room-heading">
                  Private room
                </h2>
                {authProfile && (
                  <>
                    <p className="muted lobby-lead">
                      Choose a mode for rooms you create here. It does not change matchmaking or the rest of the page.
                    </p>
                    <ModeSelector
                      labelledById="private-room-heading"
                      selectedGameMode={privateRoomMode}
                      setSelectedGameMode={setPrivateRoomMode}
                    />
                  </>
                )}
                <p className="muted lobby-lead">
                  {authProfile
                    ? 'Generate a code for friends, add bots to fill seats, then ready up. The match starts when every human is ready.'
                    : 'Optional display name and your room code. Sign in on the right for online queues, ranked play, and room modes.'}
                </p>
                {!authProfile && (
                  <>
                    <label className="signin-label" htmlFor="display-name">
                      Display name <span className="optional">(optional)</span>
                    </label>
                    <input
                      id="display-name"
                      className="inp signin-inp"
                      placeholder="e.g. Alex"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      maxLength={24}
                      autoComplete="nickname"
                    />
                  </>
                )}
                <div className="row lobby-actions">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() =>
                      socket.emit('createRoom', { gameMode: authProfile ? privateRoomMode : 'classic' })
                    }
                  >
                    {hasGeneratedCode ? 'Refresh code' : 'Generate code'}
                  </button>
                </div>
                {hasGeneratedCode && (
                  <div className="codebox codebox-row">
                    <div className="codebox-main">
                      <span className="codebox-label">Room code</span>
                      <strong className="codebox-code" title="Share this with your opponent">
                        {activeRoomCode}
                      </strong>
                    </div>
                    <button type="button" className="btn copy-btn" onClick={() => void copyRoomCode()}>
                      Copy
                    </button>
                  </div>
                )}
                {state?.lobby && (
                  <div className="private-lobby">
                <h3 className="lobby-subhead">Lobby</h3>
                <p className="muted small">
                  Fill every seat. Bots are always ready. The match begins when each human has marked ready.
                </p>
                {state.lobby.iAmHost && state.lobby.slots.some((s) => s.kind === 'open') && (
                  <div className="lobby-bot-toolbar">
                    <label className="lobby-bot-toolbar-label" htmlFor="lobby-bot-d">
                      Bot difficulty (for empty seats)
                    </label>
                    <select
                      id="lobby-bot-d"
                      className="inp lobby-select"
                      value={lobbyBotDiff}
                      onChange={(e) => setLobbyBotDiff(e.target.value)}
                    >
                      <option value="easy">Easy</option>
                      <option value="medium">Medium</option>
                      <option value="hard">Hard</option>
                      <option value="extreme">Extreme</option>
                    </select>
                  </div>
                )}
                <ul className="lobby-slot-list">
                  {state.lobby.slots.map((slot) => (
                    <li key={`slot-${slot.seat}-${slot.kind}-${slot.id ?? 'open'}`} className="lobby-slot-card">
                      <div className="lobby-slot-head">
                        <span className="lobby-seat-label">Seat {slot.seat + 1}</span>
                        {slot.kind === 'human' && (
                          <span className={`lobby-ready-pill${slot.ready ? ' on' : ''}`}>
                            {slot.ready ? 'Ready' : 'Not ready'}
                          </span>
                        )}
                        {slot.kind === 'bot' && <span className="lobby-ready-pill on">Bot</span>}
                      </div>
                      {slot.kind === 'open' && (
                        <div className="lobby-slot-body">
                          <span className="muted">Empty</span>
                          {state.lobby.iAmHost && (
                            <button
                              type="button"
                              className="btn small primary"
                              onClick={() => socket.emit('lobbyAddBot', { difficulty: lobbyBotDiff })}
                            >
                              Add bot
                            </button>
                          )}
                        </div>
                      )}
                      {slot.kind === 'bot' && (
                        <div className="lobby-slot-body">
                          <strong>{slot.label}</strong>
                          <span className="muted"> · {slot.difficulty}</span>
                          {state.lobby.iAmHost && (
                            <button
                              type="button"
                              className="btn small ghost lobby-remove-bot"
                              onClick={() => socket.emit('lobbyRemoveBot', { botId: slot.id })}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      )}
                      {slot.kind === 'human' && (
                        <div className="lobby-slot-body">
                          {slot.isYou ? (
                            <>
                              <strong>You</strong>
                              <button
                                type="button"
                                className={`btn small${slot.ready ? '' : ' primary'}`}
                                onClick={() => socket.emit('lobbySetReady', { ready: !slot.ready })}
                              >
                                {slot.ready ? 'Unready' : 'Ready'}
                              </button>
                            </>
                          ) : (
                            <span className="muted">Guest / friend</span>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="muted lobby-hint">
              Share the code with a friend (another tab or device). Refresh replaces the code if nobody has joined
              yet.
            </p>
          </section>

          <section className="lobby-join">
            <h2 className="lobby-heading">Join with code</h2>
            <div className="joinrow">
            <input
              className="inp"
              placeholder="Join code"
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              onClick={() => {
                socket.emit('joinRoom', joinInput);
              }}
            >
              Join
            </button>
          </div>
          </section>
        </div>
        </div>
        ) : (
        <div className="game">
          {abandonPrompt === 'casualConfirm' && (
                <div
                  className="confirm-overlay"
                  role="presentation"
                  onClick={() => setAbandonPrompt(null)}
                >
                  <div
                    className="confirm-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="abandon-casual-title"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <h2 className="confirm-title" id="abandon-casual-title">
                      Abandon match?
                    </h2>
                    <p className="confirm-body muted">
                      Are you sure? You will lose, other players will win, and everyone will return to the lobby.
                    </p>
                    <div className="confirm-actions">
                      <button type="button" className="btn" onClick={() => setAbandonPrompt(null)}>
                        No
                      </button>
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => {
                          socket.emit('abandonMatch', { closeRoom: true });
                          setAbandonPrompt(null);
                        }}
                      >
                        Yes
                      </button>
                    </div>
                  </div>
                </div>
              )}
          {abandonPrompt === 'rankedWarn' && (
                <div
                  className="confirm-overlay"
                  role="presentation"
                  onClick={() => setAbandonPrompt(null)}
                >
                  <div
                    className="confirm-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="abandon-ranked-title"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <h2 className="confirm-title" id="abandon-ranked-title">
                      Ranked — abandon match
                    </h2>
                    <p className="confirm-body warn">
                      If you abandon this match, it will count as a <strong>loss</strong> and you will{' '}
                      <strong>lose ranked points</strong> (same as losing by checkmate or king capture).
                    </p>
                    <div className="confirm-actions">
                      <button type="button" className="btn" onClick={() => setAbandonPrompt(null)}>
                        Stay in match
                      </button>
                      <button
                        type="button"
                        className="btn primary abandon-confirm-btn"
                        onClick={() => {
                          socket.emit('abandonMatch');
                          setAbandonPrompt(null);
                        }}
                      >
                        Abandon & take loss
                      </button>
                    </div>
                  </div>
                </div>
              )}
          <aside className="side">
            <div className="stat">
              Room <strong>{state.code}</strong>
            </div>
            {state.disconnect && state.disconnect.secondsLeft > 0 && (
              <div className="stat disconnect-wait-stat warn" role="status" aria-live="polite">
                <strong>{disconnectPlayerLabel(state, state.disconnect.playerId, myId)}</strong>{' '}
                disconnected — waiting{' '}
                <strong>{state.disconnect.secondsLeft}s</strong> to return
              </div>
            )}
            {showAbandonMatch && (
              <div className="stat abandon-match-stat">
                <button
                  type="button"
                  className="btn small btn-abandon-match"
                  onClick={() => {
                    if (state.matchKind === 'ranked') setAbandonPrompt('rankedWarn');
                    else setAbandonPrompt('casualConfirm');
                  }}
                >
                  Abandon match
                </button>
              </div>
            )}
            {(authProfile?.username?.trim() || displayName.trim()) && (
              <div className="stat muted">
                Playing as{' '}
                <strong>{authProfile?.username?.trim() || displayName.trim()}</strong>
              </div>
            )}
            {state.matchKind === 'ranked' && (
              <div className="stat warn">Ranked — ladder points update on checkmate or king capture only.</div>
            )}
            <div className="stat">
              You play{' '}
              <strong>
                {state.gameMode === 'ffa'
                  ? FFA_ARMY_NAMES[state.mySeat] ?? `Army ${state.mySeat}`
                  : state.gameMode === '2v2'
                    ? `${TEAM2V2_ARMY_NAMES[state.mySeat] ?? 'Army'} · Team ${TEAM2V2_TEAM_LABEL[armyTeam2v2(state.mySeat)] ?? ''}`
                    : state.gameMode === 'wild'
                      ? 'Wild (chess)'
                      : state.myColor === 'w'
                        ? 'White'
                        : 'Black'}
              </strong>
            </div>
            {state.playerOrder?.length === 4 && (
              <div className="stat muted">
                Turn ring: {(state.turnDirection ?? 1) === 1 ? 'clockwise' : 'counter-clockwise'}
              </div>
            )}
            <div className="stat">
              Deck <strong>{state.deckSize}</strong> cards
            </div>
            {state.phase === 'makingMoves' && (
              <div className="stat warn">
                Moves left this card: <strong>{state.movesRemaining}</strong>
              </div>
            )}
            {state.bonus && state.bonus.forPlayer === myId && (
              <div className="stat warn">
                +2/+4: place or recover ({state.bonus.done}/{state.bonus.total})
              </div>
            )}
            {state.skipNotice === myId && (
              <div className="stat warn">Your next card turn will be skipped.</div>
            )}
            {state.phase === 'makingMoves' && isMyTurn && state.movesRemaining > 0 && (
              <button type="button" className="btn small ghost" onClick={() => socket.emit('endChessMoves')}>
                End moves early
              </button>
            )}
            <details className="help-cards-details">
              <summary className="help-cards-summary">Cards</summary>
              <div className="help-cards-body">
                <ul>
                  <li>
                    <strong>Draw</strong>: on your turn, click the deck to flip the top card for both players, then
                    its effect runs.
                  </li>
                  <li>
                    <strong>0–9</strong>: make that many legal moves with your pieces (same turn).
                  </li>
                  <li>
                    <strong>Skip</strong>:{' '}
                    {state.playerOrder?.length === 4
                      ? 'skips the next player in the turn ring.'
                      : 'opponent misses their next turn.'}
                  </li>
                  <li>
                    <strong>Reverse</strong>:{' '}
                    {state.playerOrder?.length === 4
                      ? 'flips turn direction (clockwise ↔ counter-clockwise).'
                      : 'undo all chess moves your opponent made since your last turn.'}
                  </li>
                  <li>
                    <strong>Wild</strong>:{' '}
                    {state.playerOrder?.length === 4
                      ? 'rotates everyone one seat along the current turn direction (no board flip).'
                      : 'flip the board 180° and swap who plays White/Black.'}
                  </li>
                  <li>
                    <strong>+2 / +4</strong>: recover your captured pieces from the pool or drop extra pawns on your
                    side; if you cannot recover, use pawns instead.
                  </li>
                </ul>
              </div>
            </details>

            <section className="moves-played" aria-label="Moves played">
              <h3 className="moves-played-title">Moves played</h3>
              {!state.actionLog?.length && !state.liveRound && (
                <p className="muted moves-played-empty">No actions yet.</p>
              )}
              <ol className="moves-played-rounds">
                {(state.actionLog || []).map((entry) => (
                  <li key={entry.id} className="moves-played-round">
                    <div className="moves-played-head">
                      <strong>{actorLabel(entry.playerId, myId, state.playerOrder)}</strong>{' '}
                      <span className="muted">— {cardPullSummary(entry.card)}</span>
                    </div>
                    {entry.chessMoves?.length ? (
                      <ul className="moves-played-moves">
                        {entry.chessMoves.map((cm, i) => (
                          <li key={i}>{cm.line}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
                {state.liveRound && (
                  <li className="moves-played-round moves-played-round--live">
                    <div className="moves-played-head">
                      <strong>{actorLabel(state.liveRound.playerId, myId, state.playerOrder)}</strong>{' '}
                      <span className="muted">— {cardPullSummary(state.liveRound.card)}</span>
                      <span className="moves-played-live-tag"> · In progress</span>
                    </div>
                    {state.liveRound.chessMoves?.length ? (
                      <ul className="moves-played-moves">
                        {state.liveRound.chessMoves.map((cm, i) => (
                          <li key={`live-${i}`}>{cm.line}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                )}
              </ol>
            </section>
          </aside>

          <main className="main">
            {state.phase === 'gameover' && (
              <div className="gameover-overlay">
                <div className="gameover-modal">
                  {gameoverCrown && (
                    <div className="gameover-crown-wrap">
                      <CrownOutcomeVisual variant={gameoverCrown} size="small" />
                    </div>
                  )}
                  <h2 className="gameover-title">{gameOverHeadline(state, myId)}</h2>
                  {state.gameResult?.kind === 'checkmate' && (
                    <p className="gameover-sub muted">Checkmate</p>
                  )}
                  {state.gameResult?.kind === 'king_captured' && (
                    <p className="gameover-sub muted">King captured</p>
                  )}
                  {state.gameResult?.kind === 'ffa_last_king' && (
                    <p className="gameover-sub muted">Last king standing</p>
                  )}
                  {state.gameResult?.kind === '2v2_team' && (
                    <p className="gameover-sub muted">Team victory</p>
                  )}
                  {state.gameResult?.kind === 'forfeit' && (
                    <p className="gameover-sub muted">Match abandoned</p>
                  )}
                  {state.gameResult?.kind === 'disconnect_forfeit' &&
                    state.gameResult?.noContestIds?.includes(myId) && (
                      <p className="gameover-sub muted">Your teammate abandoned the match</p>
                    )}
                  {state.gameResult?.kind === 'disconnect_forfeit' &&
                    !state.gameResult?.noContestIds?.includes(myId) && (
                      <p className="gameover-sub muted">Disconnected player</p>
                    )}
                  {state.playAgain?.allowed !== false && !state.gameResult?.noRematch && (
                    <p className="gameover-hint muted">
                      When all players press Play again, a new game starts
                      {state.gameMode === 'ffa' ? ' on a fresh four-way board.' : ' from the standard position.'}
                    </p>
                  )}
                  {state.gameResult?.noRematch && (
                    <p className="gameover-hint muted">Rematch is not available for this match.</p>
                  )}
                  {state.playAgain?.allowed !== false && !state.gameResult?.noRematch && (
                    <button
                      type="button"
                      className="btn primary gameover-btn"
                      disabled={state.playAgain?.iVoted}
                      onClick={() => socket.emit('playAgain')}
                    >
                      {state.playAgain?.iVoted ? 'Waiting for opponent…' : 'Play again'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn gameover-btn-home"
                    onClick={() => socket.emit('leaveMatch')}
                  >
                    Return home
                  </button>
                  {state.playAgain?.allowed !== false && !state.gameResult?.noRematch && (
                    <p className="gameover-votes muted">
                      Ready: {state.playAgain?.voted ?? 0} /{' '}
                      {state.playAgain?.needed ?? state.playerOrder?.length ?? 2}
                    </p>
                  )}
                </div>
              </div>
            )}

            {state.revealing && (
              <div className="reveal-overlay" key={state.revealing.seq} aria-live="polite">
                <div className="reveal-card-shell">
                  <div className={`reveal-card ${state.revealing.card.color || ''}`}>
                    <span className="reveal-label">{labelCard(state.revealing.card)}</span>
                  </div>
                  <p className="reveal-caption">
                    {state.revealing.playerId === myId
                      ? 'You drew'
                      : state.playerOrder?.length > 2
                        ? 'Another player drew'
                        : 'Opponent drew'}
                  </p>
                </div>
              </div>
            )}

            <div className="playfield">
              {iterGrid && (
                <div
                  className={`boardwrap${
                    isPlusBoardMode(state.gameMode) ? ' boardwrap--plus' : ''
                  }`}
                >
                  <PlusBoardFrame state={state}>
                    <div
                      className={`board${
                        isPlusBoardMode(state.gameMode) ? ' ffa-board' : ''
                      }`}
                    >
                    <MoveArrowsOverlay
                      moves={
                        state.liveRound?.chessMoves?.length
                          ? [state.liveRound.chessMoves[state.liveRound.chessMoves.length - 1]]
                          : null
                      }
                      cols={isPlusBoardMode(state.gameMode) ? 16 : 8}
                      rows={isPlusBoardMode(state.gameMode) ? 16 : 8}
                      myColor={state.myColor}
                      isPlus={isPlusBoardMode(state.gameMode)}
                    />
                    {iterGrid.map((row, ri) =>
                      row.map((slot, fi) => {
                        const isPlus16 = state.gameMode === 'ffa' || state.gameMode === '2v2';
                        const hole = isPlus16 && ffaIsHole(ri, fi);
                        if (hole) {
                          return (
                            <div key={`${ri}-${fi}`} className="sq sq-hole" aria-hidden />
                          );
                        }
                        const cfi = fi;
                        const cri = ri;
                        const isPlusCell = isPlusBoardMode(state.gameMode);
                        const pieceCell = isPlusCell ? slot : classicGrid?.[cri]?.[cfi];
                        const sq = isPlusCell ? `${ri},${fi}` : displayIndexToSquare(cfi, cri, state.myColor).sq;
                        const dark = (ri + fi) % 2 === 1;
                        const { rank, file } = displayIndexToSquare(cfi, cri, state.myColor);
                        const isSel = pickFrom === sq;
                        const leg = activeLeg.get(sq);
                        const legClass = leg === 'capture' ? 'hint-cap' : leg === 'move' ? 'hint-move' : '';
                        const midClass = isPlusCell && ffaInMiddle(ri, fi) ? ' ffa-mid' : '';
                        let pcLabel = null;
                        if (pieceCell) {
                          if (isPlusCell && typeof pieceCell === 'object' && pieceCell.t) {
                            const sym = PIECE[pieceCell.t] || PIECE[pieceCell.t.toLowerCase()] || pieceCell.t;
                            const armyClass =
                              state.gameMode === '2v2'
                                ? `team2v2-a${pieceCell.a}`
                                : `ffa-a${pieceCell.a}`;
                            const title =
                              state.gameMode === '2v2'
                                ? TEAM2V2_ARMY_NAMES[pieceCell.a]
                                : FFA_ARMY_NAMES[pieceCell.a];
                            pcLabel = (
                              <span className={`pc ${armyClass}`} title={title}>
                                {sym}
                              </span>
                            );
                          } else {
                            pcLabel = <span className="pc">{PIECE[pieceCell] || pieceCell}</span>;
                          }
                        }
                        return (
                          <button
                            type="button"
                            key={`${ri}-${fi}`}
                            className={`sq ${dark ? 'd' : 'l'} ${isSel ? 'sel' : ''} ${legClass}${midClass}`}
                            onClick={() => boardClick(fi, ri)}
                          >
                            {pcLabel}
                            {!isPlusCell && cfi === 0 && <span className="coord r">{rank}</span>}
                            {!isPlusCell && cri === 7 && (
                              <span className="coord f">{String.fromCharCode(97 + file)}</span>
                            )}
                          </button>
                        );
                      }),
                    )}
                  </div>
                  </PlusBoardFrame>
                </div>
              )}

              <div className="deckCol">
                <div className="deck-label">Deck</div>
                <button
                  type="button"
                  className={`deck-stack ${state.phase === 'playCard' && isMyTurn ? 'deck-active' : ''}${
                    deckShufflePlaying ? ' is-shuffling' : ''
                  }`}
                  disabled={state.phase !== 'playCard' || !isMyTurn}
                  onClick={() => socket.emit('drawFromDeck')}
                  title={
                    state.phase === 'playCard' && isMyTurn ? 'Draw the top card' : 'Wait for your turn to draw'
                  }
                >
                  <span className="deck-layer d3" />
                  <span className="deck-layer d2" />
                  <span className="deck-layer d1" />
                  <span className="deck-face">
                    <span className="deck-icon">?</span>
                    <span className="deck-count">{state.deckSize}</span>
                  </span>
                </button>
                <p className="deck-hint muted">
                  {state.phase === 'revealing'
                    ? 'Card revealed…'
                    : state.phase === 'playCard' && isMyTurn
                      ? 'Your turn — click to draw.'
                      : state.phase === 'playCard'
                        ? state.playerOrder?.length > 2
                          ? 'Waiting for another player to draw.'
                          : 'Waiting for opponent to draw.'
                        : ''}
                </p>

                <button
                  type="button"
                  className="btn small deck-shuffle-btn"
                  disabled={shuffleDisabled || deckShufflePlaying}
                  onClick={handleShuffleDeck}
                >
                  Shuffle deck
                </button>
                <p className="deck-shuffle-hint muted">{2 - (state.shuffles?.[myId] ?? 0)} Shuffles left</p>

                <div className="last-pulled" aria-live="polite">
                  <div className="last-pulled-label">Recently pulled</div>
                  {state.lastPulled ? (
                    <>
                      <div className={`last-pulled-card ${state.lastPulled.card.color || ''}`}>
                        <span className="last-pulled-value">{labelCard(state.lastPulled.card)}</span>
                      </div>
                      <p className="last-pulled-by muted">
                        {state.lastPulled.playerId === myId
                          ? 'You'
                          : state.playerOrder?.length > 2
                            ? 'Another player'
                            : 'Opponent'}
                      </p>
                    </>
                  ) : (
                    <p className="last-pulled-empty muted">No card yet</p>
                  )}
                </div>
              </div>
            </div>

            {promoPending && (
              <div className="promo">
                <span>Promotion</span>
                {['q', 'r', 'b', 'n'].map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="btn small"
                    onClick={() => sendMove(promoPending.from, promoPending.to, p)}
                  >
                    {p.toUpperCase()}
                  </button>
                ))}
                <button type="button" className="btn small ghost" onClick={() => setPromoPending(null)}>
                  Cancel
                </button>
              </div>
            )}

            {state.phase === 'bonus' && state.bonus?.forPlayer === myId && (
              <section className="bonus">
                <h2>+2 / +4 placement</h2>
                <p className="muted">
                  Your captured pool (recover):{' '}
                  <strong>
                    {(state.hostages?.mine || [])
                      .map((p) => p.type.toUpperCase())
                      .join(', ') || '—'}
                  </strong>
                </p>
                <p className="muted">Choose an action, then click a square on your side of the board.</p>
                <div className="row">
                  <button type="button" className="btn" onClick={() => setBonusPick({ action: 'pawn' })}>
                    Drop pawn next
                  </button>
                </div>
                <div className="recover">
                  <span>Recover piece type:</span>
                  {['p', 'n', 'b', 'r', 'q'].map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="btn small"
                      onClick={() => setBonusPick({ action: 'recover', pieceType: t })}
                    >
                      {t.toUpperCase()}
                    </button>
                  ))}
                </div>
                {bonusPick && (
                  <p className="hint">
                    Selected: <strong>{bonusPick.action}</strong>
                    {bonusPick.pieceType ? ` (${bonusPick.pieceType})` : ''} — click a square.
                  </p>
                )}
              </section>
            )}
          </main>
        </div>
      )}
      {showAccountSidebar && <AuthPanel />}
      </div>
    </div>
  );
}

