import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomInt, randomUUID } from 'crypto';
import {
  findUserByUsernameLower,
  findUserByEmailLower,
  findUserById,
  insertUser,
  setRecovery,
  getRecovery,
  clearRecovery,
  updateUserPasswordByEmail,
  getRankedLeader,
  getLeaderboardRows,
} from './authStore.js';
import {
  isValidEmail,
  validatePasswordRules,
  normalizeEmail,
  normalizeUsername,
  usernameKey,
} from './authValidators.js';
import { sendRecoveryCode } from './mail.js';
import { signAccessToken, verifyAccessToken } from './jwtAuth.js';
import { resolveDisplayRank } from './ranking.js';

const SALT_ROUNDS = 10;
const CODE_ROUNDS = 8;
const RECOVERY_TTL_MS = 15 * 60 * 1000;

async function publicUserFromDb(user) {
  if (!user) return null;
  const leader = await getRankedLeader();
  const rating = user.rankedRating ?? 0;
  const rank = resolveDisplayRank(user.id, rating, leader);
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    rankedRating: rating,
    rankTier: rank.tier,
    rankLabel: rank.label,
  };
}

async function authUser(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const payload = verifyAccessToken(m[1]);
  if (!payload?.sub) return null;
  return findUserById(payload.sub);
}

function randomSixDigit() {
  return String(randomInt(100000, 1000000));
}

const router = Router();

router.post('/register', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password;

    if (!username || username.length < 2 || username.length > 32) {
      return res.status(400).json({ error: 'Username must be 2–32 characters.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    const pw = validatePasswordRules(password);
    if (!pw.ok) return res.status(400).json({ error: pw.message });

    const ukey = usernameKey(username);
    if (await findUserByUsernameLower(ukey)) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    if (await findUserByEmailLower(email)) {
      return res.status(409).json({ error: 'That email is already registered.' });
    }

    const id = randomUUID();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = { id, email, username, passwordHash };
    await insertUser(user);

    const token = signAccessToken({ sub: id, u: username });
    const fresh = await findUserById(id);
    return res.status(201).json({ token, user: await publicUserFromDb(fresh) });
  } catch (err) {
    console.error('POST /register', err);
    return res.status(500).json({ error: 'Registration failed (database).' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const user = await findUserByUsernameLower(usernameKey(username));
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });

    const token = signAccessToken({ sub: user.id, u: user.username });
    return res.json({
      token,
      user: await publicUserFromDb(user),
    });
  } catch (err) {
    console.error('POST /login', err);
    return res.status(500).json({ error: 'Sign-in failed (database).' });
  }
});

router.get('/leaderboard', async (_req, res) => {
  try {
    const rows = await getLeaderboardRows(30);
    const leader = rows[0] ? { userId: rows[0].id, rating: rows[0].rankedRating } : null;
    const leaderboard = rows.map((r, i) => {
      const rank = resolveDisplayRank(r.id, r.rankedRating, leader);
      return {
        position: i + 1,
        userId: r.id,
        username: r.username,
        rankTier: rank.tier,
        rankLabel: rank.label,
        rankedRating: r.rankedRating,
      };
    });
    return res.json({ leaderboard });
  } catch (err) {
    console.error('GET /leaderboard', err);
    return res.status(500).json({ error: 'Could not load leaderboard.' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const user = await authUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in.' });
    return res.json({ user: await publicUserFromDb(user) });
  } catch (err) {
    console.error('GET /me', err);
    return res.status(500).json({ error: 'Could not load account.' });
  }
});

router.post('/recover/send', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    const user = await findUserByEmailLower(email);
    if (!user) {
      return res.json({ ok: true, message: 'If an account exists for that email, a code was sent.' });
    }

    const code = randomSixDigit();
    const codeHash = await bcrypt.hash(code, CODE_ROUNDS);
    await setRecovery(email, { codeHash, expires: Date.now() + RECOVERY_TTL_MS });

    await sendRecoveryCode(user.email, code);

    return res.json({ ok: true, message: 'If an account exists for that email, a code was sent.' });
  } catch (err) {
    console.error('POST /recover/send', err);
    return res.status(500).json({ error: 'Could not start recovery (database).' });
  }
});

router.post('/recover/reset', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    const newPassword = req.body?.newPassword;

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
    }
    const pw = validatePasswordRules(newPassword);
    if (!pw.ok) return res.status(400).json({ error: pw.message });

    const user = await findUserByEmailLower(email);
    if (!user) return res.status(400).json({ error: 'Invalid or expired recovery.' });

    const rec = await getRecovery(email);
    if (!rec || Date.now() > rec.expires) {
      await clearRecovery(email);
      return res.status(400).json({ error: 'Invalid or expired recovery code. Request a new one.' });
    }

    const match = await bcrypt.compare(code, rec.codeHash);
    if (!match) {
      return res.status(400).json({ error: 'Incorrect code.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await updateUserPasswordByEmail(email, passwordHash);
    await clearRecovery(email);

    const fresh = await findUserByEmailLower(email);
    const token = signAccessToken({ sub: user.id, u: user.username });
    return res.json({
      token,
      user: await publicUserFromDb(fresh || user),
      message: 'Password updated. You are signed in.',
    });
  } catch (err) {
    console.error('POST /recover/reset', err);
    return res.status(500).json({ error: 'Password reset failed (database).' });
  }
});

export default router;
export { authUser };
