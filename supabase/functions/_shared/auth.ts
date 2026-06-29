// Authenticate the request and provide both a user-scoped client (for RLS-
// gated reads) and an admin client (for inserting ai_usage rows that the
// user themselves can't write to).

// deno-lint-ignore-file no-explicit-any
import {
  createClient,
  type SupabaseClient,
} from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export type Authed = {
  user_id: string;
  /** Anon key client with the request's JWT — respects RLS as the user. */
  client: SupabaseClient;
  /** Service-role client — bypasses RLS, use only for server-only writes. */
  admin: SupabaseClient;
  /**
   * True for sessions started via supabase.auth.signInAnonymously(). Use
   * to gate features that aren't available to guests (AI calls, public
   * recipe publishing, display-name updates).
   */
  is_anonymous: boolean;
};

export async function authenticate(req: Request): Promise<Authed | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRole) return null;

  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user) return null;

  const admin = createClient(supabaseUrl, serviceRole);

  // is_anonymous lives on the user object for sessions started via
  // signInAnonymously. Older Supabase versions don't set it; default to
  // false so we don't accidentally lock out real users.
  const is_anonymous =
    (user as unknown as { is_anonymous?: boolean }).is_anonymous === true;

  return { user_id: user.id, client, admin, is_anonymous };
}
