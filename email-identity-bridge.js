import { EmailIdentityError, gmailMailboxPath, resolveEmailIdentity } from './email-identity.js';

const PORT_NAME = 'threadly-email-identity';

export async function requestEmailIdentity(mailbox, messageId, { signal, sessionKey } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: PORT_NAME });
    let settled = false;
    function finish(error, key) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      port.disconnect();
      if (error) reject(error);
      else resolve(key);
    }
    function onAbort() { finish(signal.reason); }
    function onDisconnect() {
      // Reading lastError also acknowledges Chrome's disconnected-port error.
      void chrome.runtime.lastError;
      finish(new EmailIdentityError('Extension background disconnected. Reload the extension and Gmail'));
    }
    function onMessage(message) {
      if (/^[a-f0-9]{64}$/.test(message?.key ?? '')) finish(null, message.key);
      else finish(new EmailIdentityError(message?.error || 'Gmail did not provide its shared email identity'));
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    signal?.addEventListener('abort', onAbort, { once: true });
    try { port.postMessage({ mailbox, messageId, sessionKey }); }
    catch (error) { finish(error); }
  });
}

export function installEmailIdentityBridge() {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    const controller = new AbortController();
    let started = false;
    port.onDisconnect.addListener(() => controller.abort());
    port.onMessage.addListener(async (message) => {
      if (started) return;
      started = true;
      let senderUrl;
      try { senderUrl = new URL(port.sender?.url); }
      catch { port.disconnect(); return; }
      // Do not expose authenticated Gmail downloads to extension pages, other
      // sites, subframes, or a different signed-in mailbox.
      if (senderUrl.origin !== 'https://mail.google.com' || port.sender.frameId !== 0
          || !Number.isInteger(port.sender.tab?.id)
          || !message?.mailbox || gmailMailboxPath(senderUrl.pathname) !== message.mailbox) {
        port.disconnect();
        return;
      }
      let result;
      try {
        const key = await resolveEmailIdentity(message.mailbox, message.messageId, {
          sessionKey: message.sessionKey, signal: controller.signal,
        });
        result = { key };
      } catch (error) {
        result = { error: error instanceof EmailIdentityError ? error.message
          : error?.name === 'TimeoutError' ? 'Gmail original-message request timed out'
          : 'Gmail original-message request failed (network or browser restriction)' };
      }
      if (controller.signal.aborted) return;
      // A tab can close before its disconnect event reaches the background.
      try { port.postMessage(result); } catch { /* The requesting tab is gone. */ }
    });
  });
}
