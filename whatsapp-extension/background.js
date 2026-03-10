// Background service worker - relays messages between content script and server
const DEFAULT_SERVER_URL = 'https://clinicea.scalamatic.com';
const DEFAULT_EXTENSION_KEY = '';
let serverUrl = DEFAULT_SERVER_URL;
let extensionKey = DEFAULT_EXTENSION_KEY;

// Load saved settings on startup
chrome.storage.local.get(['serverUrl', 'extensionKey'], (result) => {
  serverUrl = result.serverUrl || DEFAULT_SERVER_URL;
  extensionKey = result.extensionKey || DEFAULT_EXTENSION_KEY;
  console.log('[WA Bot BG] Server URL:', serverUrl, '| Key:', extensionKey ? 'set' : 'not set');
});

// Also listen for storage changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.serverUrl) {
    serverUrl = changes.serverUrl.newValue || '';
    console.log('[WA Bot BG] Server URL updated:', serverUrl);
  }
  if (changes.extensionKey) {
    extensionKey = changes.extensionKey.newValue || '';
    console.log('[WA Bot BG] Extension key updated');
  }
});

// Build headers with optional extension auth
function getHeaders(contentType) {
  const h = {};
  if (contentType) h['Content-Type'] = contentType;
  if (extensionKey) h['X-Extension-Key'] = extensionKey;
  return h;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SET_SERVER_URL') {
    serverUrl = msg.url;
    chrome.storage.local.set({ serverUrl: msg.url });
    console.log('[WA Bot BG] Server URL set to:', serverUrl);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'SET_EXTENSION_KEY') {
    extensionKey = msg.key;
    chrome.storage.local.set({ extensionKey: msg.key });
    console.log('[WA Bot BG] Extension key updated');
    sendResponse({ ok: true });
    return true;
  }

  if (!serverUrl) {
    console.warn('[WA Bot BG] No server URL configured');
    sendResponse({ error: 'No server URL configured', reply: null, messages: [] });
    return true;
  }

  if (msg.type === 'INCOMING_MESSAGE') {
    console.log('[WA Bot BG] Forwarding message to server:', msg.data.text?.substring(0, 50));
    fetch(`${serverUrl}/api/whatsapp/incoming`, {
      method: 'POST',
      headers: getHeaders('application/json'),
      body: JSON.stringify(msg.data)
    })
      .then(r => {
        console.log('[WA Bot BG] Server response status:', r.status);
        return r.json();
      })
      .then(data => {
        console.log('[WA Bot BG] Server reply:', data.reply?.substring(0, 50) || '(none)');
        sendResponse(data);
      })
      .catch(err => {
        console.error('[WA Bot BG] Server error:', err.message);
        sendResponse({ error: err.message, reply: null });
      });
    return true;
  }

  if (msg.type === 'CHECK_OUTGOING') {
    fetch(`${serverUrl}/api/whatsapp/outgoing`, { headers: getHeaders() })
      .then(r => r.json())
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ error: err.message, messages: [] }));
    return true;
  }

  if (msg.type === 'MESSAGE_SENT') {
    fetch(`${serverUrl}/api/whatsapp/sent`, {
      method: 'POST',
      headers: getHeaders('application/json'),
      body: JSON.stringify(msg.data)
    })
      .then(r => r.json())
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});
