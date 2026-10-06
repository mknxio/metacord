import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWidget, RateLimitError } from '../api';

const GUILD_ID = '123456789012345678';
const WIDGET_URL = `https://discord.com/api/v10/guilds/${GUILD_ID}/widget.json`;

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

describe('fetchWidget', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const lastRequest = (): { url: string; init: RequestInit } => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, init };
  };

  it('requests the public Discord widget endpoint without credentials or an Authorization header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ instant_invite: null, presence_count: 0 }));

    await fetchWidget(GUILD_ID);

    const { url, init } = lastRequest();
    expect(url).toBe(WIDGET_URL);
    expect(init.credentials).toBe('omit');
    expect(init.method ?? 'GET').toBe('GET');
    const headers = new Headers(init.headers);
    expect(headers.has('Authorization')).toBe(false);
    // Only CORS-safelisted headers (here: none), so the browser sends no preflight.
    expect([...headers.keys()]).toEqual([]);
  });

  it('maps a 200 response to instant_invite and presence_count', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: GUILD_ID,
        name: 'Test Guild',
        instant_invite: 'https://discord.com/invite/abc123',
        presence_count: 42,
        channels: [],
        members: [],
      })
    );

    await expect(fetchWidget(GUILD_ID)).resolves.toEqual({
      instant_invite: 'https://discord.com/invite/abc123',
      presence_count: 42,
    });
  });

  it('maps missing or malformed widget fields to null', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ name: 'Test Guild', presence_count: 'many' }));

    await expect(fetchWidget(GUILD_ID)).resolves.toEqual({
      instant_invite: null,
      presence_count: null,
    });
  });

  it('maps 403 (widget disabled) to nulls', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Widget Disabled', code: 50004 }, 403));

    await expect(fetchWidget(GUILD_ID)).resolves.toEqual({
      instant_invite: null,
      presence_count: null,
    });
  });

  it('maps 404 (unknown guild) to nulls', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Unknown Guild', code: 10004 }, 404));

    await expect(fetchWidget(GUILD_ID)).resolves.toEqual({
      instant_invite: null,
      presence_count: null,
    });
  });

  it('throws RateLimitError with retry_after from the 429 body, rounded up', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: 'You are being rate limited.', retry_after: 12.34, global: false }, 429, {
        'Retry-After': '99',
      })
    );

    const error = await fetchWidget(GUILD_ID).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(13);
  });

  it('falls back to the Retry-After header when the 429 body has no retry_after', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '7' } }));

    const error = await fetchWidget(GUILD_ID).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(7);
  });

  it('throws RateLimitError with null retryAfter when no hint is available', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 429 }));

    const error = await fetchWidget(GUILD_ID).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBeNull();
  });

  it('throws a generic error for other non-OK responses', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Internal' }, 500));

    const error = await fetchWidget(GUILD_ID).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RateLimitError);
    expect((error as Error).message).toContain('500');
  });

  it('propagates network errors', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(fetchWidget(GUILD_ID)).rejects.toThrow(TypeError);
  });

  it('rejects an invalid guild ID without fetching', async () => {
    await expect(fetchWidget('../users/@me')).rejects.toThrow('Invalid guild ID format');
    await expect(fetchWidget('123')).rejects.toThrow('Invalid guild ID format');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
