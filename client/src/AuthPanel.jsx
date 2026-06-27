import { useCallback, useEffect, useState } from 'react';
import { rankBadgeClassName } from './rankBadgeClass.js';

const AUTH_TOKEN_KEY = 'chess-uno-auth-token';
const AUTH_CHANGED = 'chess-uno-auth-changed';

function emitAuthProfile(user) {
  window.dispatchEvent(new CustomEvent(AUTH_CHANGED, { detail: { user } }));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_RE =
  /^(?=.{8,})(?=.*[A-Z])(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]).*$/;

function validatePasswordClient(p) {
  if (typeof p !== 'string' || p.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (!PASSWORD_RE.test(p)) {
    return 'Password needs at least one capital letter and one special character (!@#$%^&* etc.).';
  }
  return null;
}

async function authFetch(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api/auth${path}`, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export function AuthPanel() {
  const [view, setView] = useState('signin');
  const [me, setMe] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [recoverEmail, setRecoverEmail] = useState('');
  const [recoverCode, setRecoverCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [leaderboard, setLeaderboard] = useState([]);
  const [lbError, setLbError] = useState(null);
  const [lbLoading, setLbLoading] = useState(true);

  const loadMe = useCallback(async () => {
    const t = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!t) {
      setMe(null);
      emitAuthProfile(null);
      return;
    }
    try {
      const data = await authFetch('/me');
      setMe(data.user);
      emitAuthProfile(data.user);
    } catch {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      setMe(null);
      emitAuthProfile(null);
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  useEffect(() => {
    const h = (e) => {
      const u = e.detail?.user;
      try {
        if (!localStorage.getItem(AUTH_TOKEN_KEY)) {
          setMe(null);
          return;
        }
      } catch {
        setMe(null);
        return;
      }
      if (u) setMe(u);
      else setMe(null);
    };
    window.addEventListener(AUTH_CHANGED, h);
    return () => window.removeEventListener(AUTH_CHANGED, h);
  }, []);

  const loadLeaderboard = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/leaderboard');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not load leaderboard');
      setLeaderboard(Array.isArray(data.leaderboard) ? data.leaderboard : []);
      setLbError(null);
    } catch (e) {
      setLbError(e instanceof Error ? e.message : 'Leaderboard error');
    } finally {
      setLbLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!me) {
      setLeaderboard([]);
      setLbError(null);
      setLbLoading(false);
      return;
    }
    setLbLoading(true);
    void loadLeaderboard();
    const id = setInterval(() => void loadLeaderboard(), 8000);
    return () => clearInterval(id);
  }, [me, loadLeaderboard]);

  useEffect(() => {
    if (!me) return;
    const onRefresh = () => void loadLeaderboard();
    window.addEventListener(AUTH_CHANGED, onRefresh);
    return () => window.removeEventListener(AUTH_CHANGED, onRefresh);
  }, [me, loadLeaderboard]);

  function resetMessages() {
    setErr('');
    setInfo('');
  }

  async function onLogin(e) {
    e.preventDefault();
    resetMessages();
    setBusy(true);
    try {
      const data = await authFetch('/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      setMe(data.user);
      emitAuthProfile(data.user);
      setPassword('');
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onRegister(e) {
    e.preventDefault();
    resetMessages();
    if (!EMAIL_RE.test(email.trim())) {
      setErr('Enter a valid email address.');
      return;
    }
    const pwErr = validatePasswordClient(regPassword);
    if (pwErr) {
      setErr(pwErr);
      return;
    }
    setBusy(true);
    try {
      const data = await authFetch('/register', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim(),
          username: regUsername.trim(),
          password: regPassword,
        }),
      });
      localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      setMe(data.user);
      emitAuthProfile(data.user);
      setInfo('Account created.');
      setRegPassword('');
      setView('signin');
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Registration failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onRecoverSend(e) {
    e.preventDefault();
    resetMessages();
    if (!EMAIL_RE.test(recoverEmail.trim())) {
      setErr('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      await authFetch('/recover/send', {
        method: 'POST',
        body: JSON.stringify({ email: recoverEmail.trim() }),
      });
      setInfo('If an account exists for that email, a 6-digit code was sent. Check your inbox (and server logs in dev).');
      setView('recoverCode');
      setRecoverCode('');
      setNewPassword('');
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not send code.');
    } finally {
      setBusy(false);
    }
  }

  async function onRecoverReset(e) {
    e.preventDefault();
    resetMessages();
    if (!/^\d{6}$/.test(recoverCode.trim())) {
      setErr('Enter the 6-digit code from your email.');
      return;
    }
    const pwErr = validatePasswordClient(newPassword);
    if (pwErr) {
      setErr(pwErr);
      return;
    }
    setBusy(true);
    try {
      const data = await authFetch('/recover/reset', {
        method: 'POST',
        body: JSON.stringify({
          email: recoverEmail.trim(),
          code: recoverCode.trim(),
          newPassword,
        }),
      });
      localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      setMe(data.user);
      emitAuthProfile(data.user);
      setInfo(data.message || 'Password updated.');
      setNewPassword('');
      setRecoverCode('');
      setView('signin');
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Reset failed.');
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    setMe(null);
    emitAuthProfile(null);
    setView('signin');
    resetMessages();
    setInfo('Signed out.');
  }

  return (
    <aside className="auth-panel" aria-label="Account">
      <h2 className="auth-panel-title">Account</h2>

      {me && (
        <div className="auth-signed">
          <p className="auth-signed-line">
            Signed in as <strong>{me.username}</strong>
          </p>
          <p className="muted auth-email">{me.email}</p>
          {me.rankLabel != null && (
            <p className="auth-rank">
              <span className={rankBadgeClassName(me.rankTier)}>{me.rankLabel}</span>
              <span className="muted"> · {me.rankedRating ?? 0} pts</span>
            </p>
          )}
          <button type="button" className="btn small ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      )}

      {err && <p className="auth-msg auth-err">{err}</p>}
      {info && !me && <p className="auth-msg auth-info">{info}</p>}

      {me ? null : view === 'signin' && (
        <form className="auth-form" onSubmit={onLogin}>
          <label className="signin-label" htmlFor="auth-username">
            Username
          </label>
          <input
            id="auth-username"
            className="inp auth-inp"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
          <label className="signin-label" htmlFor="auth-password">
            Password
          </label>
          <input
            id="auth-password"
            type="password"
            className="inp auth-inp"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          <div className="auth-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              Sign in
            </button>
          </div>
          <p className="auth-links">
            <button type="button" className="link-btn" onClick={() => { resetMessages(); setView('register'); }}>
              Create account
            </button>
            <span className="auth-links-sep">·</span>
            <button type="button" className="link-btn" onClick={() => { resetMessages(); setView('recoverEmail'); }}>
              Recover account
            </button>
          </p>
        </form>
      )}

      {me ? null : view === 'register' && (
        <form className="auth-form" onSubmit={onRegister}>
          <label className="signin-label" htmlFor="reg-email">
            Email
          </label>
          <input
            id="reg-email"
            type="email"
            className="inp auth-inp"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
          <label className="signin-label" htmlFor="reg-username">
            Username
          </label>
          <input
            id="reg-username"
            className="inp auth-inp"
            autoComplete="username"
            value={regUsername}
            onChange={(e) => setRegUsername(e.target.value)}
            disabled={busy}
          />
          <label className="signin-label" htmlFor="reg-password">
            Password
          </label>
          <input
            id="reg-password"
            type="password"
            className="inp auth-inp"
            autoComplete="new-password"
            value={regPassword}
            onChange={(e) => setRegPassword(e.target.value)}
            disabled={busy}
          />
          <p className="muted auth-hint">
            At least 8 characters, one capital letter, one special character (!@#$%^&* etc.).
          </p>
          <div className="auth-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              Create account
            </button>
          </div>
          <p className="auth-links">
            <button type="button" className="link-btn" onClick={() => { resetMessages(); setView('signin'); }}>
              Back to sign in
            </button>
          </p>
        </form>
      )}

      {me ? null : view === 'recoverEmail' && (
        <form className="auth-form" onSubmit={onRecoverSend}>
          <p className="muted auth-lead">
            Enter the email on your account. We will send a 6-digit code you can use on the next step to set a new
            password.
          </p>
          <label className="signin-label" htmlFor="recover-email">
            Email
          </label>
          <input
            id="recover-email"
            type="email"
            className="inp auth-inp"
            autoComplete="email"
            value={recoverEmail}
            onChange={(e) => setRecoverEmail(e.target.value)}
            disabled={busy}
          />
          <div className="auth-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              Send recovery code
            </button>
          </div>
          <p className="auth-links">
            <button type="button" className="link-btn" onClick={() => { resetMessages(); setView('signin'); }}>
              Back to sign in
            </button>
          </p>
        </form>
      )}

      {me ? null : view === 'recoverCode' && (
        <form className="auth-form" onSubmit={onRecoverReset}>
          <p className="muted auth-lead">
            Code sent to <strong>{recoverEmail.trim() || '—'}</strong>. Enter the code and a new password.
          </p>
          <label className="signin-label" htmlFor="recover-code">
            Recovery code
          </label>
          <input
            id="recover-code"
            className="inp auth-inp"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            placeholder="000000"
            autoComplete="one-time-code"
            value={recoverCode}
            onChange={(e) => setRecoverCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            disabled={busy}
          />
          <label className="signin-label" htmlFor="recover-new-pw">
            New password
          </label>
          <input
            id="recover-new-pw"
            type="password"
            className="inp auth-inp"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={busy}
          />
          <p className="muted auth-hint">
            At least 8 characters, one capital letter, one special character.
          </p>
          <div className="auth-actions row-tight">
            <button type="submit" className="btn primary" disabled={busy}>
              Reset password
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                resetMessages();
                setView('recoverEmail');
              }}
            >
              Resend code
            </button>
          </div>
          <p className="auth-links">
            <button type="button" className="link-btn" onClick={() => { resetMessages(); setView('signin'); }}>
              Back to sign in
            </button>
          </p>
        </form>
      )}

      {me && (
      <section className="auth-leaderboard" aria-label="Leaderboard">
        <h3 className="auth-leaderboard-title">Live leaderboard</h3>
        <p className="auth-leaderboard-live">Top players by ranked points · refreshes every 8s</p>
        {lbError && <p className="auth-msg auth-err">{lbError}</p>}
        {lbLoading && !lbError && leaderboard.length === 0 && (
          <p className="muted auth-lb-placeholder">Loading…</p>
        )}
        {!lbLoading && !lbError && leaderboard.length === 0 && (
          <p className="muted auth-lb-placeholder">No players yet.</p>
        )}
        {leaderboard.length > 0 && (
          <div className="leaderboard-scroll">
            <table className="lb-table">
              <thead>
                <tr>
                  <th scope="col" className="lb-col-num">
                    #
                  </th>
                  <th scope="col">Player</th>
                  <th scope="col">Rank</th>
                  <th scope="col" className="lb-col-pts">
                    Points
                  </th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((row) => (
                  <tr
                    key={row.userId}
                    className={me?.id === row.userId ? 'lb-row lb-row-me' : 'lb-row'}
                  >
                    <td className="lb-col-num">{row.position}</td>
                    <td className="lb-cell-user" title={row.username}>
                      {row.username}
                    </td>
                    <td>
                      <span className={rankBadgeClassName(row.rankTier, 'lb-rank-badge')}>{row.rankLabel}</span>
                    </td>
                    <td className="lb-col-pts">{row.rankedRating}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}
    </aside>
  );
}
