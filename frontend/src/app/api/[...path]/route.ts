import { forwardToBackend } from '@/lib/proxy';

/**
 * Same-origin proxy from the browser to the backend API. The browser only
 * ever talks to the dashboard origin, so the session cookie is first-party,
 * HttpOnly and SameSite=Lax; the backend still performs all authorization
 * and CSRF (Origin) checks itself.
 */
export const dynamic = 'force-dynamic';

export const GET = forwardToBackend;
export const POST = forwardToBackend;
