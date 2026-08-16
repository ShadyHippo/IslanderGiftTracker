export interface SessionUser {
  username: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'Cannot reach server. Check your connection.');
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') msg = body.error;
    } catch {
      // non-JSON error body; keep generic message
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export function login(username: string, password: string): Promise<SessionUser> {
  return request<SessionUser>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function me(): Promise<SessionUser> {
  return request<SessionUser>('/api/me');
}

export function logout(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/logout', { method: 'POST' });
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // non-JSON error body; keep generic message
  }
  return `Request failed (${res.status})`;
}

/** Download the current user's progress db (raw sqlite bytes — their single backup file). */
export async function progressDownload(): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch('/api/progress', { headers: { Accept: 'application/octet-stream' } });
  } catch {
    throw new ApiError(0, 'Cannot reach server. Check your connection.');
  }
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  return await res.arrayBuffer();
}

/** Upload the user's progress db (raw sqlite bytes). Server keeps versioned backups. */
export async function progressUpload(bytes: Uint8Array): Promise<{ ok: string; username: string }> {
  let res: Response;
  try {
    res = await fetch('/api/progress', { method: 'PUT', body: new Blob([bytes as unknown as BlobPart]) });
  } catch {
    throw new ApiError(0, 'Cannot reach server. Check your connection.');
  }
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  return (await res.json()) as { ok: string; username: string };
}
