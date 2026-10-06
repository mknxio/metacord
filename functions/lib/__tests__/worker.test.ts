import { describe, it, expect, vi, afterEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../../src/worker';

const EXPECTED_CSP = [
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

const callWorker = async (path: string): Promise<Response> => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://metacord.test${path}`),
    env as Parameters<typeof worker.fetch>[1],
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
};

describe('worker security headers', () => {
  it('sets the Content-Security-Policy with connect-src limited to self and discord.com', async () => {
    const response = await callWorker('/api/health');

    expect(response.status).toBe(200);
    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).toBe(EXPECTED_CSP);
    const connectSrc = csp?.split('; ').find((directive) => directive.startsWith('connect-src '));
    expect(connectSrc).toBe("connect-src 'self' https://discord.com");
  });
});
