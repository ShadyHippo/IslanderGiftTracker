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
    // Hard timeout so the app can never sit on "Loading…" forever (a hung
    // fetch or a stale service worker would otherwise block the login form).
    session.user = await withTimeout(apiMe(), 8000);
    cacheUser(session.user);
  } catch {
    // Server unreachable — trust the cached user so the app works offline
    // and across container restarts without forcing re-login.
    session.user = cachedUser();
  } finally {
    session.checking = false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
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
