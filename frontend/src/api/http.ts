/** The single fetch choke point. EVERY backend call goes through apiFetch/jfetch:
 *  - sends the session cookie (credentials: 'include');
 *  - names the active org on each request (X-Org-Id header, from the auth store);
 *  - in print mode forwards the short-lived print token instead (X-Print-Token);
 *  - maps 401 → the auth store's "session gone" handler (login screen) and
 *    403 → a typed PermissionError the UI can surface without crashing.
 *
 *  The auth store registers its callbacks via setAuthHandlers (a registration,
 *  not an import, so http.ts stays dependency-free of the store module). */

export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8001/api';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}
export class PermissionError extends ApiError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'PermissionError';
  }
}

interface AuthHandlers {
  /** The active org to stamp on requests (null = none yet, e.g. before login). */
  getOrgId: () => number | null;
  /** A request bounced with 401: the session is gone — show the login screen. */
  onUnauthorized: () => void;
  /** A request bounced with 403: lacking permission — surface, don't crash. */
  onForbidden: (detail: string) => void;
}

let handlers: AuthHandlers | null = null;
export function setAuthHandlers(h: AuthHandlers) {
  handlers = h;
}

/** ?print_token= from the URL — present only on the headless ?print= route. */
export function printToken(): string | null {
  return new URLSearchParams(window.location.search).get('print_token');
}

/** Appends the print token to a URL consumed WITHOUT fetch (img src, @font-face)
 *  so those subresources authenticate too in headless print mode. */
export function withPrintToken(url: string): string {
  const tok = printToken();
  if (!tok) return url;
  return `${url}${url.includes('?') ? '&' : '?'}print_token=${encodeURIComponent(tok)}`;
}

export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const ptoken = printToken();
  if (ptoken) {
    headers.set('X-Print-Token', ptoken);
  } else {
    const orgId = handlers?.getOrgId();
    if (orgId != null && !headers.has('X-Org-Id')) headers.set('X-Org-Id', String(orgId));
  }
  const res = await fetch(url, { ...init, headers, credentials: 'include' });
  if (res.ok) return res;
  const detail = await res.text();
  // /auth endpoints speak 401 as part of their contract (bad password, no session
  // yet) — only a 401 on a DATA request means the session died under us.
  if (res.status === 401 && !url.includes('/auth/')) handlers?.onUnauthorized();
  if (res.status === 403) {
    handlers?.onForbidden(detail);
    throw new PermissionError(403, detail);
  }
  throw new ApiError(res.status, detail);
}

export async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  return res.json() as Promise<T>;
}

/** JSON headers shorthand shared by call sites. */
export const J = { 'Content-Type': 'application/json' };
