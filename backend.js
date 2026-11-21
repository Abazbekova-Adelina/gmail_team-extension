import { createClient } from '@supabase/supabase-js';

// Extension storage is shared by settings tabs and chat frames embedded in Gmail.
export const sessionStorageKey = SUPABASE_URL
  ? `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`
  : '';
const authStorage = {
  async getItem(key) {
    return (await chrome.storage.local.get(key))[key] ?? null;
  },
  async setItem(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key) {
    await chrome.storage.local.remove(key);
  },
};

export const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    flowType: 'pkce',
    detectSessionInUrl: false,
    storage: authStorage,
    storageKey: sessionStorageKey,
  },
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
