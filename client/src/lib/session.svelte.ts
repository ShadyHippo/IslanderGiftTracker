import {
  login as apiLogin,
  logout as apiLogout,
  me as apiMe,
  ApiError,
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
    // Short hard timeout: with a cached user the app must render instantly
    // (offline cold start included), so revalidation may only pause briefly.
    session.user = await withTimeout(apiMe(), 3000);
    cacheUser(session.user);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      // Server explicitly rejected our session cookie: the cached user is
      // stale — forget it. (Network failures keep the cached user instead.)
      session.user = null;
      cacheUser(null);
      return;
    }
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
