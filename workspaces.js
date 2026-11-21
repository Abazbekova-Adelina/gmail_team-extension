import { supabase } from './backend.js';

export function workspaceStorageKey(userId) {
  return `workspace:${userId}`;
}


export async function fetchWorkspaces() {
  const { data, error } = await supabase.from('workspaces').select('id,name,owner_id').order('created_at');
  if (error) throw error;
  return data;
}

export function preferredWorkspace(workspaces, userId) {
  const saved = localStorage.getItem(workspaceStorageKey(userId));
  return workspaces.find((workspace) => workspace.id === saved)?.id ?? workspaces[0]?.id ?? '';
}
