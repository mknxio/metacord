export interface CacheOptions {
  ttlSeconds: number;
  swrSeconds: number;
  visibility: 'public' | 'private';
  sessionCookie?: string;
}

/** Minimal context type requiring only waitUntil (compatible with both Hono and Cloudflare ExecutionContext). */
interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export function buildUserCacheKey(request: Request, userId: string): Request {
  const url = new URL(request.url);
  url.searchParams.set('__cacheUser', userId);
  return new Request(url.toString(), { method: 'GET' });
}

export async function getCachedResponse(
  cacheKey: Request,
  sessionCookie?: string
): Promise<Response | null> {
  const cached = await caches.default.match(cacheKey);
  if (!cached) return null;
  return appendSessionCookie(cached, sessionCookie);
}

export async function cachedJsonResponse(
  executionCtx: WaitUntilContext,
  cacheKey: Request,
  data: unknown,
  options: CacheOptions,
  status = 200,
  headers: HeadersInit = {}
): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(cacheKey);

  if (cached) {
    return appendSessionCookie(cached, options.sessionCookie);
  }

  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json');
  responseHeaders.set(
    'Cache-Control',
    `${options.visibility}, max-age=${options.ttlSeconds}, stale-while-revalidate=${options.swrSeconds}`
  );
  if (options.sessionCookie) {
    responseHeaders.append('Set-Cookie', options.sessionCookie);
  }

  const body = JSON.stringify(data);
  const response = new Response(body, { status, headers: responseHeaders });

  const cacheHeaders = new Headers(responseHeaders);
  cacheHeaders.delete('Set-Cookie');
  const cacheResponse = new Response(body, { status, headers: cacheHeaders });
  executionCtx.waitUntil(cache.put(cacheKey, cacheResponse));

  return response;
}

function appendSessionCookie(response: Response, sessionCookie?: string): Response {
  if (!sessionCookie) return response;
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', sessionCookie);
  return new Response(response.body, { status: response.status, headers });
}
