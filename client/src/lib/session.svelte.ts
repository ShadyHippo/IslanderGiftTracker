import {
  login as apiLogin,
  logout as apiLogout,
  me as apiMe,
  type SessionUser,
} from './api';

const SESSION_KEY = 'acnh_session_user';

function cacheUser(user: SessionUser | null) {
  try {
    if (user) localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* private browsing */ }
}

function cachedUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

const session = $state<{ user: SessionUser | null; checking: boolean }>({
  user: cachedUser(),
  checking: true,
});

export function getSession() {
  return session;
}

export async function checkSession(): Promise<void> {
  session.checking = true;
  try {
    // Don't block the UI on a cold proxy — fall back to cached user after
    // 2s so impatient family sees the app instantly. The real check still
    // completes in the background and corrects the session if needed.
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('session timeout')), 2000),
    );
    session.user = await Promise.race([apiMe(), timeout]);
    cacheUser(session.user);
  } catch {
    // Server unreachable / timed out — trust the cached user so the app
    // works offline and across container restarts without forcing re-login.
    const cached = cachedUser();
    // If we raced, the real request may still succeed — correct in background
    if (cached) session.user = cached;
    else {
      try {
        session.user = await apiMe();
        cacheUser(session.user);
      } catch {
        session.user = cached;
      }
    }
  } finally {
    session.checking = false;
  }
}

export async function login(username: string, password: string): Promise<void> {
  session.user = await apiLogin(username, password);
  cacheUser(session.user);
}

export async function logout(): Promise<void> {
  try {
    await apiLogout();
  } catch {
    // server unreachable: still clear the local session
  }
  session.user = null;
  cacheUser(null);
}
