export function googleAvatarUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    return url.hostname.endsWith('.googleusercontent.com') ? url.href : '';
  } catch {
    return '';
  }
}

export function profileDetails(user) {
  const metadata = user?.user_metadata ?? {};
  const name = metadata.full_name || metadata.name || 'Google user';
  return {
    name,
    avatar: googleAvatarUrl(metadata.avatar_url) || googleAvatarUrl(metadata.picture),
  };
}

export function avatarElement(name, url) {
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = String(name || '?').trim().split(/\s+/u)
    .slice(0, 2).map((part) => Array.from(part)[0] || '').join('').toLocaleUpperCase();
  const source = googleAvatarUrl(url);
  if (source) {
    const image = document.createElement('img');
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = source;
    avatar.append(image);
  }
  return avatar;
}
