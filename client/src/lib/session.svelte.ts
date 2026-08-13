import {
  login as apiLogin,
  logout as apiLogout,
  me as apiMe,
  type SessionUser,
} from './api';

const session = $state<{ user: SessionUser | null; checking: boolean }>({
  user: null,
  checking: true,
});

export function getSession() {
  return session;
}

export async function checkSession(): Promise<void> {
  session.checking = true;
  try {
    session.user = await apiMe();
  } catch {
    session.user = null;
  } finally {
    session.checking = false;
  }
}

export async function login(username: string, password: string): Promise<void> {
  session.user = await apiLogin(username, password);
}

export async function logout(): Promise<void> {
  try {
    await apiLogout();
  } catch {
    // server unreachable: still clear the local session
  }
  session.user = null;
}
