// Background service worker - relays messages between content script and server
let serverUrl = '';

// Load saved URL on startup
chrome.storage.local.get(['serverUrl'], (result) => {
  if (result.serverUrl) serverUrl = result.serverUrl;
  console.log('[WA Bot BG] Server URL:', serverUrl || '(not set)');
});

// Also listen for storage changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.serverUrl) {
    serverUrl = changes.serverUrl.newValue || '';
    console.log('[WA Bot BG] Server URL updated:', serverUrl);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SET_SERVER_URL') {
    serverUrl = msg.url;
    chrome.storage.local.set({ serverUrl: msg.url });
    console.log('[WA Bot BG] Server URL set to:', serverUrl);
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
      headers: { 'Content-Type': 'application/json' },
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
    fetch(`${serverUrl}/api/whatsapp/outgoing`)
      .then(r => r.json())
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ error: err.message, messages: [] }));
    return true;
  }

  if (msg.type === 'MESSAGE_SENT') {
    fetch(`${serverUrl}/api/whatsapp/sent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.data)
    })
      .then(r => r.json())
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});
