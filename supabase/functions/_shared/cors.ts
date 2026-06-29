// Shared CORS + JSON response helpers for edge functions.
//
// Two flavors:
//   · CORS_HEADERS / jsonResponse / preflightResponse — wide-open '*' for
//     functions called from the iOS app (where there's no Origin header
//     anyway, so the * is harmless).
//   · adminCorsHeaders(origin) / *WithCors helpers — pinned to the admin
//     console's origin for admin-* functions. JWT auth is the actual
//     control, but tightening CORS removes one CSRF defense gap.

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export function preflightResponse(): Response {
  return new Response('ok', { headers: CORS_HEADERS });
}

/**
 * Origins the admin console may call admin-* edge functions from. Anything
 * else gets a CORS-blocked response. Adjust here if the admin moves to a
 * different domain (e.g. admin.ideagen.tech subdomain).
 */
const ADMIN_ALLOWED_ORIGINS = [
  'https://www.ideagen.tech',
  'https://ideagen.tech',
  'http://localhost:3000',
  'http://localhost:5173',
];

export function adminCorsHeaders(requestOrigin: string | null): Record<string, string> {
  // Echo the origin back if it's allowlisted; otherwise return a benign
  // origin that won't satisfy a same-origin browser check. The *response*
  // still arrives at the caller but the browser's CORS check will fail.
  const allowed =
    requestOrigin && ADMIN_ALLOWED_ORIGINS.includes(requestOrigin)
      ? requestOrigin
      : ADMIN_ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

export function jsonResponseWithCors(
  body: unknown,
  status: number,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

export function preflightResponseWithCors(cors: Record<string, string>): Response {
  return new Response('ok', { headers: cors });
}
