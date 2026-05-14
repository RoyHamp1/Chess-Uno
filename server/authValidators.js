const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** At least 8 chars, one uppercase Latin letter, one "special" punctuation/symbol. */
const PASSWORD_RE =
  /^(?=.{8,})(?=.*[A-Z])(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]).*$/;

export function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

export function validatePasswordRules(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return { ok: false, message: 'Password must be at least 8 characters.' };
  }
  if (!PASSWORD_RE.test(password)) {
    return {
      ok: false,
      message:
        'Password needs at least one capital letter and one special character (!@#$%^&* etc.).',
    };
  }
  return { ok: true };
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function normalizeUsername(username) {
  return String(username || '').trim();
}

export function usernameKey(username) {
  return normalizeUsername(username).toLowerCase();
}
