import jwt from 'jsonwebtoken';

export const JWT_SECRET = process.env.JWT_SECRET || 'chess-uno-dev-secret-change-in-production';

export function signAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

/** @returns {import('jsonwebtoken').JwtPayload & { sub?: string, u?: string }} | null */
export function verifyAccessToken(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (typeof p === 'string' || !p) return null;
    return p;
  } catch {
    return null;
  }
}
