let currentEnabled = false;

function updateUI(enabled, processedCount) {
  currentEnabled = enabled;
  document.getElementById('statusDot').className = 'dot ' + (enabled ? 'on' : 'off');
  document.getElementById('statusText').textContent = enabled ? 'Bot Active' : 'Bot Paused';
  const btn = document.getElementById('toggleBtn');
  btn.textContent = enabled ? 'Pause Bot' : 'Enable Bot';
  btn.className = 'toggle-btn ' + (enabled ? 'disable' : 'enable');
  if (processedCount !== undefined) {
    document.getElementById('stats').textContent = 'Messages processed: ' + processedCount;
  }
}

function showWaiting(msg) {
  document.getElementById('statusDot').className = 'dot waiting';
  document.getElementById('statusText').textContent = msg;
  document.getElementById('toggleBtn').textContent = msg;
  document.getElementById('toggleBtn').className = 'toggle-btn waiting';
}

function toggleBot() {
  chrome.tabs.query({}, (tabs) => {
    const waTab = tabs.find(t => t.url && t.url.includes('web.whatsapp.com'));
    if (!waTab) {
      document.getElementById('helpText').innerHTML = 'Open web.whatsapp.com in a tab first, then come back here.';
      return;
    }
    chrome.tabs.sendMessage(waTab.id, { type: 'SET_ENABLED', enabled: !currentEnabled }, (resp) => {
      if (chrome.runtime.lastError) {
        document.getElementById('helpText').innerHTML = 'Reload the WhatsApp Web tab (Ctrl+R) so the extension can inject into it.';
        return;
      }
      if (resp) updateUI(!currentEnabled);
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('toggleBtn').addEventListener('click', toggleBot);

  chrome.tabs.query({}, (tabs) => {
    const waTab = tabs.find(t => t.url && t.url.includes('web.whatsapp.com'));
    if (waTab) {
      chrome.tabs.sendMessage(waTab.id, { type: 'GET_STATUS' }, (resp) => {
        if (chrome.runtime.lastError) {
          showWaiting('Extension not loaded');
          document.getElementById('helpText').innerHTML = 'Reload the WhatsApp Web tab (Ctrl+R) so the extension can inject into it.';
          return;
        }
        if (resp) {
          updateUI(resp.enabled, resp.processedCount);
        } else {
          showWaiting('Connecting...');
        }
      });
    } else {
      showWaiting('WhatsApp Web not open');
      document.getElementById('helpText').innerHTML = 'Open web.whatsapp.com in a tab, then come back here.';
    }
  });
});
