export const mentionToken = /@\{([a-f0-9-]{36})\}/gi;

export function mentionQuery(text, cursor) {
  const match = /(?:^|[^\p{L}\p{N}_.@+-])(@([\p{L}\p{M}\p{N} ’'._()-]*))$/u.exec(text.slice(0, cursor));
  if (!match) return null;
  return { start: cursor - match[1].length, query: match[2].toLowerCase() };
}

export function encodeMentions(text, members, authorId) {
  const fullNames = new Map();
  const firstNames = new Map();
  for (const [id, displayName] of members) {
    const name = displayName.trim().toLowerCase();
    if (!name) continue;
    const first = name.split(/\s/, 1)[0];
    fullNames.set(name, fullNames.has(name) ? null : id);
    firstNames.set(first, firstNames.has(first) ? null : id);
  }

  const names = new Map([...firstNames, ...fullNames]);
  if (!names.size) return text;
  const alternatives = [...names.keys()].sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_.@+-])@(${alternatives})(?![\\p{L}\\p{N}_@-])`, 'giu');
  return text.replace(pattern, (original, name) => {
    const id = names.get(name.toLowerCase());
    return id && id !== authorId ? `@{${id}}` : original;
  });
}
