import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

const SESSION_COOKIE_NAME = 'wacrm_session';
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function request(path: string, session?: string) {
  return new NextRequest(`https://app.test${path}`, {
    headers: session ? { cookie: `${SESSION_COOKIE_NAME}=${session}` } : {},
  });
}

function mockMe(user: { id: string; email: string } | null) {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ user }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
}

describe('middleware — cookie session auth', () => {
  it('redirects a protected route without a session to /login', async () => {
    const res = await middleware(request('/dashboard'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://app.test/login');
  });

  it('passes through on a protected route with a valid session', async () => {
    mockMe({ id: 'user-1', email: 'user@example.com' });

    const res = await middleware(request('/dashboard', 'session-token'));

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('/api/auth/me', 'https://app.test/dashboard'),
      {
        headers: { cookie: `${SESSION_COOKIE_NAME}=session-token` },
        cache: 'no-store',
      }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('redirects /login with a valid session to /dashboard', async () => {
    mockMe({ id: 'user-1', email: 'user@example.com' });

    const res = await middleware(request('/login', 'session-token'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://app.test/dashboard');
  });
});
