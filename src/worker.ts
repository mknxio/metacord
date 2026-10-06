import { app } from '../functions/api/[[route]]';
import type { Env } from '../functions/lib/types';

// Re-export DO class for wrangler to bundle
export { DiscordRateLimiter } from '../functions/lib/discord-rate-limiter';

interface WorkerEnv extends Env {
  ASSETS: Fetcher;
}

const API_PREFIX = '/api';

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "img-src 'self' https://cdn.discordapp.com data:",
  "connect-src 'self' https://discord.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP_DIRECTIVES,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function addSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    let response: Response;

    if (url.pathname.startsWith(API_PREFIX)) {
      response = await app.fetch(request, env, ctx);
    } else if (env.DEV_ASSETS_URL && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
      const devUrl = new URL(env.DEV_ASSETS_URL);
      devUrl.pathname = url.pathname;
      devUrl.search = url.search;
      response = await fetch(new Request(devUrl.toString(), request));
    } else {
      response = await env.ASSETS.fetch(request);
    }

    return addSecurityHeaders(response);
  },
};
