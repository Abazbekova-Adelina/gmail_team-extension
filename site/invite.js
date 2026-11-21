const id = new URLSearchParams(location.hash.slice(1)).get('invite');
const section = document.querySelector('#accept-invitation');
const button = section.querySelector('button');
const status = section.querySelector('[role="status"]');

if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id ?? '')) {
  section.hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const opened = await chrome.runtime.sendMessage('ehlcjjpfplfhiaefiljbfehibbialjeh', { type: 'open-invite', id });
      if (!opened) throw new Error('Extension unavailable');
      status.textContent = 'Continue in the extension tab.';
    } catch {
      status.textContent = 'Install or update the extension below, then try again.';
    } finally {
      button.disabled = false;
    }
  });
}
