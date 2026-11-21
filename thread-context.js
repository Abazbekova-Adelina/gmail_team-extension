// Gmail's route token locates the local mailbox copy; it is not a shared email ID.
export function gmailThreadKey(hash, legacyId, threadId) {
  const tail = hash.replace(/^#/, '').split('?')[0].split('/').at(-1);
  if (/^(?:[A-Za-z]{6,}[A-Za-z0-9_-]{8,}|[a-f0-9]{16,})$/.test(tail || '')) {
    return `gmail:${tail}`;
  }
  if (/^[a-f0-9]{16,}$/i.test(legacyId || '')) return `gmail:${legacyId.toLowerCase()}`;
  const match = /^(?:#?thread-[af]:)?(\d{10,})$/.exec(threadId || '');
  return match ? `gmail:${BigInt(match[1]).toString(16)}` : null;
}

export function validDiscussionCode(value) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

