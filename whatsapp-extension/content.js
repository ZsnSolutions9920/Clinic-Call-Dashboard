// Content script - runs on web.whatsapp.com
// Scans unread chats, reads messages, gets GPT replies, types and sends them

(function () {
  'use strict';

  const SCAN_INTERVAL = 5000; // scan for unread chats every 5s
  const processedChats = new Set(); // track chats we've already replied to (by name/phone)
  let enabled = true;
  let busy = false; // prevent overlapping operations
  let processedCount = 0;

  console.log('[WA Bot] Content script loaded, waiting for WhatsApp to initialize...');

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Wait for WhatsApp Web to fully load
  function waitForLoad(callback) {
    const check = setInterval(() => {
      const side = document.querySelector('#side');
      if (side) {
        clearInterval(check);
        console.log('[WA Bot] WhatsApp Web ready');
        callback();
      }
    }, 1000);
  }

  // Find all unread chat elements in the sidebar
  function findUnreadChats() {
    const unread = [];
    // Get all chat list items
    const chatRows = document.querySelectorAll('#pane-side [role="listitem"], #pane-side [data-testid="cell-frame-container"]');

    chatRows.forEach(row => {
      // Look for unread count badge - WhatsApp uses various selectors
      const badge = row.querySelector('[data-testid="icon-unread-count"]') ||
                    row.querySelector('span.x1rg5ohu.x1eqbgkl') || // unread count span
                    row.querySelector('[aria-label*="unread message"]');

      if (!badge) return;

      // Check if it has actual unread count text (number)
      const badgeText = badge.textContent.trim();
      if (!badgeText || badgeText === '0') return;

      // Get chat name
      const nameEl = row.querySelector('span[title]');
      const name = nameEl ? (nameEl.getAttribute('title') || nameEl.textContent.trim()) : null;
      if (!name) return;

      // Skip groups (they often have special characters or multiple participants listed)
      // We'll still include them for now - user can filter later

      unread.push({
        name: name,
        element: row,
        unreadCount: parseInt(badgeText) || 1
      });
    });

    return unread;
  }

  // Click on a chat in the sidebar to open it
  async function openChatByElement(element) {
    // Find the clickable area
    const clickTarget = element.querySelector('[data-testid="cell-frame-container"]') || element;
    clickTarget.click();
    await sleep(1500); // wait for chat to load

    // Verify chat opened
    const header = document.querySelector('#main header');
    return !!header;
  }

  // Get the last few incoming messages from the currently open chat
  function getLastIncomingMessages() {
    const messages = [];
    // WhatsApp message containers
    const msgContainer = document.querySelector('#main [role="application"]') ||
                         document.querySelector('#main .copyable-area');
    if (!msgContainer) return messages;

    // Get all message rows - try multiple selectors
    const rows = msgContainer.querySelectorAll('[data-id], .message-in, [class*="message-in"]');

    rows.forEach(row => {
      const dataId = row.getAttribute('data-id') || '';

      // Check if it's an incoming message
      // Incoming: data-id starts with "false_" OR has class message-in
      const isIncoming = dataId.startsWith('false_') ||
                         row.classList.contains('message-in') ||
                         row.querySelector('.message-in');
      if (!isIncoming) return;

      // Get text content - try multiple selectors
      const textEl = row.querySelector('.selectable-text span') ||
                     row.querySelector('[data-testid="msg-container"] span.selectable-text') ||
                     row.querySelector('.copyable-text span');
      if (!textEl) return;

      const text = textEl.textContent.trim();
      if (!text) return;

      messages.push({ text, id: dataId });
    });

    return messages;
  }

  // Get chat name and phone from the header of currently open chat
  function getCurrentChatInfo() {
    const header = document.querySelector('#main header');
    if (!header) return { name: null, phone: null };

    const nameEl = header.querySelector('span[title]') || header.querySelector('span[data-testid="conversation-info-header-chat-title"]');
    const name = nameEl ? (nameEl.getAttribute('title') || nameEl.textContent.trim()) : null;

    // Check if name looks like a phone number
    let phone = null;
    if (name && /^\+?\d[\d\s\-]{7,}/.test(name)) {
      phone = name.replace(/[\s\-]/g, '');
    }

    return { name, phone };
  }

  // Type into the message input and send
  async function typeAndSend(text) {
    // Find the compose box - try multiple selectors
    const inputBox = document.querySelector('#main footer [contenteditable="true"]') ||
                     document.querySelector('#main [data-testid="conversation-compose-box-input"]') ||
                     document.querySelector('[data-tab="10"]') ||
                     document.querySelector('#main footer div[contenteditable]');

    if (!inputBox) {
      console.error('[WA Bot] Cannot find message input box');
      return false;
    }

    // Focus
    inputBox.focus();
    inputBox.click();
    await sleep(300);

    // Clear existing text
    inputBox.textContent = '';
    inputBox.innerHTML = '';
    await sleep(100);

    // Use execCommand to simulate real typing
    document.execCommand('insertText', false, text);
    await sleep(300);

    // Dispatch events to trigger WhatsApp's handlers
    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
    inputBox.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(500);

    // Find send button
    const sendBtn = document.querySelector('#main footer [data-testid="send"]') ||
                    document.querySelector('#main footer span[data-icon="send"]') ||
                    document.querySelector('#main footer button[aria-label="Send"]');

    if (sendBtn) {
      // Click the send button or its parent
      const clickable = sendBtn.closest('button') || sendBtn.closest('[role="button"]') || sendBtn;
      clickable.click();
      console.log('[WA Bot] Clicked send button');
      await sleep(500);
      return true;
    }

    // Fallback: press Enter
    console.log('[WA Bot] No send button found, trying Enter key');
    inputBox.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
    }));
    await sleep(500);
    return true;
  }

  // Send message to server and get GPT reply
  function getReply(text, phone, chatName) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'INCOMING_MESSAGE',
        data: {
          messageId: 'msg_' + Date.now(),
          text: text,
          phone: phone || chatName,
          chatName: chatName,
          timestamp: Date.now()
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[WA Bot] Server error:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response);
      });
    });
  }

  // Main scan: find unread chats, open each, read last message, reply
  async function scanAndReply() {
    if (!enabled || busy) return;
    busy = true;

    try {
      const unreadChats = findUnreadChats();

      if (unreadChats.length > 0) {
        console.log('[WA Bot] Found', unreadChats.length, 'unread chats:', unreadChats.map(c => c.name));
      }

      for (const chat of unreadChats) {
        if (!enabled) break;

        // Skip if we recently replied to this chat (within last 2 minutes)
        const chatKey = chat.name;
        if (processedChats.has(chatKey)) continue;

        console.log('[WA Bot] Opening chat:', chat.name);

        // Click to open the chat
        const opened = await openChatByElement(chat.element);
        if (!opened) {
          console.log('[WA Bot] Failed to open chat:', chat.name);
          continue;
        }

        await sleep(1000);

        // Get chat info
        const chatInfo = getCurrentChatInfo();
        console.log('[WA Bot] Chat info:', chatInfo);

        // Get last incoming messages
        const messages = getLastIncomingMessages();
        if (messages.length === 0) {
          console.log('[WA Bot] No readable messages in:', chat.name);
          continue;
        }

        // Take the last incoming message
        const lastMsg = messages[messages.length - 1];
        console.log('[WA Bot] Last message from', chat.name, ':', lastMsg.text);
        processedCount++;

        // Get GPT reply from server
        const response = await getReply(lastMsg.text, chatInfo.phone, chatInfo.name || chat.name);

        if (response && response.reply && response.reply.trim()) {
          console.log('[WA Bot] GPT reply:', response.reply);

          // Type and send
          await sleep(1000 + Math.random() * 2000); // random delay for natural feel
          const sent = await typeAndSend(response.reply);

          if (sent) {
            console.log('[WA Bot] Reply sent to', chat.name);
            // Mark this chat as processed for 2 minutes
            processedChats.add(chatKey);
            setTimeout(() => processedChats.delete(chatKey), 2 * 60 * 1000);
          }
        } else {
          console.log('[WA Bot] No reply from server for', chat.name);
        }

        await sleep(1500); // pause between chats
      }
    } catch (err) {
      console.error('[WA Bot] Scan error:', err);
    }

    busy = false;
  }

  // Also handle messages in the currently open chat (real-time)
  let lastSeenMsgId = null;

  function checkCurrentChat() {
    if (!enabled || busy) return;

    const chatInfo = getCurrentChatInfo();
    if (!chatInfo.name) return;

    const messages = getLastIncomingMessages();
    if (messages.length === 0) return;

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg.id || lastMsg.id === lastSeenMsgId) return;

    // This is a new message in the current chat
    lastSeenMsgId = lastMsg.id;
    processedCount++;

    // Don't auto-reply if we're already in a processed chat
    const chatKey = chatInfo.name;
    if (processedChats.has(chatKey)) return;

    console.log('[WA Bot] New message in current chat from', chatInfo.name, ':', lastMsg.text);

    // Mark as processing
    processedChats.add(chatKey);
    setTimeout(() => processedChats.delete(chatKey), 2 * 60 * 1000);

    // Get reply async
    busy = true;
    getReply(lastMsg.text, chatInfo.phone, chatInfo.name).then(async (response) => {
      if (response && response.reply && response.reply.trim()) {
        await sleep(1000 + Math.random() * 2000);
        await typeAndSend(response.reply);
        console.log('[WA Bot] Replied in current chat to', chatInfo.name);
      }
      busy = false;
    }).catch(() => { busy = false; });
  }

  // Listen for commands from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SET_ENABLED') {
      enabled = msg.enabled;
      console.log('[WA Bot]', enabled ? 'ENABLED' : 'DISABLED');
      sendResponse({ ok: true });
    }
    if (msg.type === 'GET_STATUS') {
      sendResponse({ enabled, processedCount });
    }
    if (msg.type === 'SEND_MESSAGE') {
      // Manual send from dashboard - search and open chat
      (async () => {
        const searchBox = document.querySelector('#side [data-testid="chat-list-search"]') ||
                          document.querySelector('#side div[contenteditable="true"]');
        if (searchBox) {
          searchBox.focus();
          searchBox.click();
          await sleep(300);
          searchBox.textContent = '';
          document.execCommand('insertText', false, msg.phone);
          searchBox.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(2000);
          const firstResult = document.querySelector('#pane-side [role="listitem"]');
          if (firstResult) {
            firstResult.click();
            await sleep(1500);
            const success = await typeAndSend(msg.text);
            sendResponse({ success });
          } else {
            sendResponse({ success: false });
          }
        } else {
          sendResponse({ success: false });
        }
      })();
      return true;
    }
  });

  // Boot
  waitForLoad(() => {
    // Mark initial state
    const initMsgs = getLastIncomingMessages();
    if (initMsgs.length > 0) {
      lastSeenMsgId = initMsgs[initMsgs.length - 1].id;
    }
    processedCount = 0;

    console.log('[WA Bot] Starting scanners');

    // Scan unread chats every 5 seconds
    setInterval(scanAndReply, SCAN_INTERVAL);

    // Check current chat for new messages every 3 seconds
    setInterval(checkCurrentChat, 3000);

    // Also poll for server-queued outgoing messages
    setInterval(() => {
      if (!enabled || busy) return;
      chrome.runtime.sendMessage({ type: 'CHECK_OUTGOING' }, async (response) => {
        if (chrome.runtime.lastError) return;
        if (response && response.messages && response.messages.length > 0) {
          busy = true;
          for (const msg of response.messages) {
            console.log('[WA Bot] Sending queued message to', msg.phone);
            // Search for the contact
            const searchBox = document.querySelector('#side [data-testid="chat-list-search"]') ||
                              document.querySelector('#side div[contenteditable="true"]');
            if (!searchBox) break;

            searchBox.focus();
            searchBox.click();
            await sleep(300);
            searchBox.textContent = '';
            document.execCommand('insertText', false, msg.phone);
            searchBox.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(2000);

            const firstResult = document.querySelector('#pane-side [role="listitem"]');
            if (firstResult) {
              firstResult.click();
              await sleep(1500);
              const success = await typeAndSend(msg.text);
              chrome.runtime.sendMessage({
                type: 'MESSAGE_SENT',
                data: { id: msg.id, phone: msg.phone, success }
              });
            } else {
              chrome.runtime.sendMessage({
                type: 'MESSAGE_SENT',
                data: { id: msg.id, phone: msg.phone, success: false }
              });
            }
            await sleep(2000);
          }
          // Clear search
          const clearBtn = document.querySelector('[data-testid="x-alt"]');
          if (clearBtn) clearBtn.click();
          busy = false;
        }
      });
    }, 5000);

    console.log('[WA Bot] All systems running - scanning unread chats');
  });

})();
