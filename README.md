# Chess-Uno

**Luck of the Draw** — a browser game that mixes Uno-style card draws with chess. Each turn you draw from the deck; the card sets how many chess moves you get and can trigger skips, reverses, wild board flips, and +2/+4 hostage drops.

## Stack

- **Client**: React 18, Vite, Socket.IO client, chess.js  
- **Server**: Node (ESM), Express, Socket.IO, chess.js, optional PostgreSQL for auth  
- **FFA board**: Shared logic in `server/ffaEngine.js` (aliased as `@ffa-engine` in the client for move generation and hole geometry)

## Prerequisites

- Node.js 18+ recommended  
- For sign-in / ranked / matchmaking accounts: PostgreSQL and env vars (see below)

## Setup

1. Clone the repo and install dependencies:

   ```bash
   npm install
   npm install --prefix server
   npm install --prefix client
   ```

2. Server environment (copy from `server/.env.example` to `server/.env`):

   - `DATABASE_URL` — PostgreSQL connection string (omit if you only want local play without accounts)  
   - `JWT_SECRET` — long random string used to sign auth tokens  

3. Run client + server together:

   ```bash
   npm run dev
   ```

   - Client (Vite): `http://localhost:5173` (proxies `/api` and `/socket.io` to the server)  
   - Server: `http://localhost:3001` by default (`PORT` in env overrides this)

Other useful commands:

```bash
npm run build          # production client build → client/dist
npm start              # run server only (serve API + sockets; point a static host at client/dist for the UI)
cd server && npm run db:migrate   # apply auth DB migrations when DATABASE_URL is set
```

## Game modes

| Mode | Players | Notes |
|------|---------|--------|
| **Classic** | 2 | Standard 8×8 chess + card loop |
| **Wild** | 2 | Same as Classic for rules; Wild **card** flips the board (FEN) and swaps seats in the turn order |
| **2v2** | 4 | Team colors; turn ring around four seats; chess is still one shared 8×8 board, shown inside a 16×16 “plus” frame in the UI |
| **FFA** | 4 | Four armies on a **16×16** lattice with the four **4×4 corners removed** (plus / cross shape); separate FFA move rules in `server/ffaEngine.js` |

Casual matchmaking supports Classic, 2v2, and FFA (sign in required). Ranked is Classic 1v1 only. **WILD** is available in **private rooms** when signed in, not in the casual queue.

## Private room lobby

When you generate a room code (signed in or out), you stay in a **lobby** until the match starts.

- **Classic / Wild**: two seats. Host fills the second seat with a friend or a **bot**.  
- **2v2 / FFA**: four seats; host can add bots to empty seats.  
- **Bot difficulty** (host): easy, medium, hard, extreme — used for chess and FFA bot moves.  
- **Ready**: every human must mark ready; bots are always ready. The game starts only when **all seats are filled** and **every human is ready** (private rooms). Queue/matchmade games still start as soon as the roster is full.

Socket events (private lobby): `lobbySetReady`, `lobbyAddBot`, `lobbyRemoveBot`.

## Project layout

- `client/` — React app (`src/App.jsx`, Vite config, styles)  
- `server/` — HTTP + Socket.IO (`index.js`), game rules (`gameEngine.js`), FFA engine (`ffaEngine.js`), bot helpers (`botAi.js`), auth routes, optional DB  

## License

Private / personal project unless otherwise noted in the repository.
