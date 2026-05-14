import { getPool } from './db.js';

/** @typedef {{ id: string, email: string, username: string, passwordHash: string, rankedRating?: number }} User */

/** @param {import('pg').QueryResultRow | undefined} row */
function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    passwordHash: row.password_hash,
    rankedRating: row.ranked_rating != null ? Number(row.ranked_rating) : 0,
  };
}

/**
 * @param {string} lower Username already lowercased (see usernameKey).
 * @returns {Promise<User | null>}
 */
export async function findUserByUsernameLower(lower) {
  const { rows } = await getPool().query(
    `SELECT id, email, username, password_hash, ranked_rating FROM users WHERE lower(username) = $1 LIMIT 1`,
    [lower],
  );
  return mapUser(rows[0]);
}

/**
 * @param {string} emailLower Normalized email (lowercase).
 * @returns {Promise<User | null>}
 */
export async function findUserByEmailLower(emailLower) {
  const { rows } = await getPool().query(
    `SELECT id, email, username, password_hash, ranked_rating FROM users WHERE email = $1 LIMIT 1`,
    [emailLower],
  );
  return mapUser(rows[0]);
}

/**
 * @param {string} id
 * @returns {Promise<User | null>}
 */
export async function findUserById(id) {
  const { rows } = await getPool().query(
    `SELECT id, email, username, password_hash, ranked_rating FROM users WHERE id = $1 LIMIT 1`,
    [id],
  );
  return mapUser(rows[0]);
}

/**
 * @param {{ id: string, email: string, username: string, passwordHash: string }} user
 */
export async function insertUser(user) {
  await getPool().query(
    `INSERT INTO users (id, email, username, password_hash) VALUES ($1, $2, $3, $4)`,
    [user.id, user.email, user.username, user.passwordHash],
  );
}

/**
 * @param {string} emailLower
 * @param {{ codeHash: string, expires: number }} payload `expires` is epoch ms
 */
export async function setRecovery(emailLower, payload) {
  const expiresAt = new Date(payload.expires).toISOString();
  await getPool().query(
    `INSERT INTO password_resets (email, code_hash, expires_at)
     VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (email) DO UPDATE SET
       code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at`,
    [emailLower, payload.codeHash, expiresAt],
  );
}

/**
 * @param {string} emailLower
 * @returns {Promise<{ codeHash: string, expires: number } | null>}
 */
export async function getRecovery(emailLower) {
  const { rows } = await getPool().query(
    `SELECT code_hash, expires_at FROM password_resets WHERE email = $1`,
    [emailLower],
  );
  const row = rows[0];
  if (!row) return null;
  const exp = row.expires_at instanceof Date ? row.expires_at.getTime() : new Date(row.expires_at).getTime();
  return { codeHash: row.code_hash, expires: exp };
}

/**
 * @param {string} emailLower
 */
export async function clearRecovery(emailLower) {
  await getPool().query(`DELETE FROM password_resets WHERE email = $1`, [emailLower]);
}

/**
 * @param {string} emailLower
 * @param {string} passwordHash
 * @returns {Promise<boolean>}
 */
export async function updateUserPasswordByEmail(emailLower, passwordHash) {
  const { rowCount } = await getPool().query(`UPDATE users SET password_hash = $2 WHERE email = $1`, [
    emailLower,
    passwordHash,
  ]);
  return rowCount > 0;
}

/** @returns {Promise<{ userId: string, rating: number } | null>} */
export async function getRankedLeader() {
  const { rows } = await getPool().query(
    `SELECT id, ranked_rating FROM users ORDER BY ranked_rating DESC, id ASC LIMIT 1`,
  );
  if (!rows[0]) return null;
  return { userId: rows[0].id, rating: Number(rows[0].ranked_rating) };
}

/**
 * @param {string} userId
 * @param {number} delta
 */
export async function incrementRankedRating(userId, delta) {
  await getPool().query(
    `UPDATE users SET ranked_rating = GREATEST(0, ranked_rating + $2::int) WHERE id = $1`,
    [userId, delta],
  );
}

/**
 * @param {string} userId
 * @returns {Promise<number>}
 */
export async function getRankedRating(userId) {
  const { rows } = await getPool().query(`SELECT ranked_rating FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return 0;
  return Number(rows[0].ranked_rating);
}

/**
 * @param {number} [limit]
 * @returns {Promise<{ id: string, username: string, rankedRating: number }[]>}
 */
export async function getLeaderboardRows(limit = 30) {
  const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 30)));
  const { rows } = await getPool().query(
    `SELECT id::text AS id, username, ranked_rating FROM users ORDER BY ranked_rating DESC, id ASC LIMIT $1`,
    [n],
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    rankedRating: Number(r.ranked_rating),
  }));
}
