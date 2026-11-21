export async function gmailPermission(interactive = false) {
  if (!chrome.runtime.getManifest().oauth2) return '';
  const { token } = await chrome.identity.getAuthToken({ interactive });
  return token ?? '';
}

export async function messageMatchKey(threadId) {
  if (!/^[a-f0-9]{16,32}$/i.test(threadId ?? '')) return null;
  try {
    const token = await gmailPermission();
    if (!token) return null;
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=Message-ID`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const { messages } = await response.json();
    const first = messages?.reduce((earliest, message) => Number(message.internalDate) < Number(earliest.internalDate) ? message : earliest);
    const messageId = first?.payload?.headers?.find(({ name }) => name.toLowerCase() === 'message-id')?.value.trim();
    if (!/^<[^<>\s]+@[^<>\s]+>$/.test(messageId ?? '')) return null;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(messageId));
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
