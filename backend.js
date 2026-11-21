import { createClient } from '@supabase/supabase-js';

export const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: 'pkce', detectSessionInUrl: false },
}) : null;

export async function rpc(name, params = {}) {
  const {data, error} = await supabase.rpc(name, params);
  if (error) throw error;
  return data;
}
export function scopeError(error) {
  if (error?.code === 'P0001' && [
    'This person is already a member.',
    'Invitation is unavailable for this account or has expired.',
    'Discussion is not in this workspace.',
    'Enter a valid email address.',
    'Use a workspace name between 1 and 80 characters.',
  ].includes(error.message)) return error.message;
  return ['PGRST202', '42P01', '42703'].includes(error?.code)
    ? 'Private workspaces need the latest database migration. Ask the app owner to apply it.'
    : 'Could not update the workspace. Check your membership and try again.';
}
