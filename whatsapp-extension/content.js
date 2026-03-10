// Content script - runs on web.whatsapp.com
// Scans unread chats, reads messages, gets GPT replies, types and sends them

(function () {
  'use strict';

  const SCAN_INTERVAL = 5000; // scan for unread chats every 5s
  const processedMessages = new Set(); // track message IDs we've already replied to
  const repliedChats = new Map(); // chatName -> { text, time } tracks last reply per chat to prevent double-replies
  const pausedChats = new Set(); // chats where bot is paused (user is manually chatting)
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
    const pane = document.querySelector('#pane-side');
    if (!pane) return unread;

    const allSpans = pane.querySelectorAll('span');
    const badgeSpans = [];

    allSpans.forEach(span => {
      const text = span.textContent.trim();
      if (!/^\d{1,4}$/.test(text)) return;
      const rect = span.getBoundingClientRect();
      if (rect.width > 50 || rect.height > 30 || rect.width < 5) return;
      const style = window.getComputedStyle(span);
      const bg = style.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        badgeSpans.push(span);
      }
    });

    badgeSpans.forEach(badge => {
      let row = badge.closest('[role="listitem"]') ||
                badge.closest('[data-testid="cell-frame-container"]')?.parentElement ||
                badge.closest('[tabindex="-1"]');

      if (!row) {
        let el = badge.parentElement;
        for (let i = 0; i < 15 && el && el !== pane; i++) {
          const rect = el.getBoundingClientRect();
          if (rect.height > 50 && rect.height < 120 && rect.width > 200) {
            row = el;
            break;
          }
          el = el.parentElement;
        }
      }

      if (!row) return;

      const nameEl = row.querySelector('span[title]');
      const name = nameEl ? (nameEl.getAttribute('title') || nameEl.textContent.trim()) : null;
      if (!name) return;

      const count = parseInt(badge.textContent.trim()) || 1;

      // Skip groups
      const isGroup = row.querySelector('[data-testid="default-group"]') ||
                      row.querySelector('[data-testid="group"]') ||
                      row.querySelector('[data-icon="default-group"]') ||
                      row.querySelector('[data-icon="group"]') ||
                      false;

      const skipPatterns = /community|group|boys|girls|fellowship|freelanc|wizards|developers|college|school|class|batch|xi[iv]?-|xii|whatsapp|build|techversity|jazz|clan|baithak|member chat|^meta ai$/i;
      if (isGroup || skipPatterns.test(name)) return;

      if (unread.some(u => u.name === name)) return;

      unread.push({ name, element: row, unreadCount: count });
    });

    return unread;
  }

  // Helper: clear the search box completely
  async function clearSearch() {
    const clearBtn = document.querySelector('[data-testid="x-alt"]') ||
                     document.querySelector('[data-testid="back-btn"]') ||
                     document.querySelector('#side [data-icon="x-alt"]')?.closest('button') ||
                     document.querySelector('#side [data-icon="back"]')?.closest('button');
    if (clearBtn) {
      clearBtn.click();
      await sleep(500);
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(300);
  }

  // Open a chat by clicking its sidebar row
  async function openChatByElement(element, chatName) {
    const prevInfo = getCurrentChatInfo();
    const prevName = prevInfo.name;

    const candidates = [];
    const nameSpan = element.querySelector('span[title]');
    if (nameSpan) candidates.push(nameSpan);
    candidates.push(element);
    element.querySelectorAll('div, span').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 50 && rect.height > 20 && rect.height < 120) {
        candidates.push(el);
      }
    });

    for (let i = 0; i < Math.min(candidates.length, 8); i++) {
      const target = candidates[i];
      const eventOpts = { bubbles: true, cancelable: true, view: window };
      target.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
      target.dispatchEvent(new MouseEvent('mousedown', eventOpts));
      await sleep(80);
      target.dispatchEvent(new PointerEvent('pointerup', eventOpts));
      target.dispatchEvent(new MouseEvent('mouseup', eventOpts));
      target.dispatchEvent(new MouseEvent('click', eventOpts));
      target.click();
      await sleep(1500);

      const nowInfo = getCurrentChatInfo();
      const composeBox = document.querySelector('#main footer [contenteditable="true"]');
      if ((nowInfo.name && nowInfo.name !== prevName) || (composeBox && !prevName)) {
        return true;
      }
    }

    // Fallback for phone numbers
    if (chatName.match(/^\+?\d[\d\s]{7,}/)) {
      const cleanPhone = chatName.replace(/[\s\-\+]/g, '');
      window.location.href = 'https://web.whatsapp.com/send?phone=' + cleanPhone;
      await sleep(4000);
      if (document.querySelector('#main header span[title]')) return true;
    }

    return false;
  }

  // Get the last few incoming messages from the currently open chat
  function getLastIncomingMessages() {
    const messages = [];
    const msgContainer = document.querySelector('#main [role="application"]') ||
                         document.querySelector('#main .copyable-area');
    if (!msgContainer) return messages;

    const rows = msgContainer.querySelectorAll('[data-id], .message-in, [class*="message-in"]');

    rows.forEach(row => {
      const dataId = row.getAttribute('data-id') || '';
      const isIncoming = dataId.startsWith('false_') ||
                         row.classList.contains('message-in') ||
                         row.querySelector('.message-in');
      if (!isIncoming) return;

      const textEl = row.querySelector('.selectable-text span') ||
                     row.querySelector('[data-testid="msg-container"] span.selectable-text') ||
                     row.querySelector('.copyable-text span');
      if (!textEl) return;

      const text = textEl.textContent.trim();
      if (!text) return;

      messages.push({ text, id: dataId || ('text_' + text.substring(0, 30) + '_' + messages.length) });
    });

    return messages;
  }

  // Get chat name and phone from the header
  function getCurrentChatInfo() {
    const header = document.querySelector('#main header');
    if (!header) return { name: null, phone: null };

    const skipPatterns = /click here|contact info|group info|search|last seen|online|typing|tap here/i;
    const spans = header.querySelectorAll('span[title]');
    let name = null;
    for (const span of spans) {
      const t = (span.getAttribute('title') || '').trim();
      if (!t || skipPatterns.test(t)) continue;
      name = t;
      break;
    }

    if (!name) {
      const allSpans = header.querySelectorAll('span');
      for (const span of allSpans) {
        const t = span.textContent.trim();
        if (!t || t.length < 2 || skipPatterns.test(t)) continue;
        const rect = span.getBoundingClientRect();
        if (rect.height < 10) continue;
        name = t;
        break;
      }
    }

    let phone = null;
    if (name && /^\+?\d[\d\s\-]{7,}/.test(name)) {
      phone = name.replace(/[\s\-]/g, '');
    }

    return { name, phone };
  }

  // Type into the message input and send
  async function typeAndSend(text) {
    const inputBox = document.querySelector('#main footer [contenteditable="true"]') ||
                     document.querySelector('#main [data-testid="conversation-compose-box-input"]') ||
                     document.querySelector('[data-tab="10"]');

    if (!inputBox) {
      console.error('[WA Bot] Cannot find message input box');
      return false;
    }

    inputBox.focus();
    inputBox.click();
    await sleep(300);
    inputBox.textContent = '';
    inputBox.innerHTML = '';
    await sleep(100);
    document.execCommand('insertText', false, text);
    await sleep(300);
    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);

    const sendBtn = document.querySelector('#main footer [data-testid="send"]') ||
                    document.querySelector('#main footer span[data-icon="send"]') ||
                    document.querySelector('#main footer button[aria-label="Send"]');

    if (sendBtn) {
      const clickable = sendBtn.closest('button') || sendBtn.closest('[role="button"]') || sendBtn;
      clickable.click();
      await sleep(500);
      return true;
    }

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
          console.error('[WA Bot] Chrome runtime error:', chrome.runtime.lastError.message);
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

      for (const chat of unreadChats) {
        if (!enabled) break;

        // Skip paused/blocked chats
        if (shouldSkipChat(chat.name)) {
          console.log('[WA Bot] Skipping chat:', chat.name);
          continue;
        }

        console.log('[WA Bot] Opening chat:', chat.name);
        const opened = await openChatByElement(chat.element, chat.name);
        if (!opened) {
          console.log('[WA Bot] Failed to open:', chat.name);
          await clearSearch();
          break;
        }

        await sleep(1000);

        const chatInfo = getCurrentChatInfo();
        const messages = getLastIncomingMessages();
        if (messages.length === 0) continue;

        // Take the latest incoming message
        const lastMsg = messages[messages.length - 1];

        // Check if we already replied to this exact message in this chat
        const lastReply = repliedChats.get(chat.name);
        if (lastReply && lastReply.text === lastMsg.text && (Date.now() - lastReply.time) < 120000) {
          console.log('[WA Bot] Already replied to this message in', chat.name, '- skipping');
          // Mark all messages as processed so DOM ID changes don't trip us up
          messages.forEach(m => processedMessages.add(m.id));
          continue;
        }

        // Also check by DOM ID as a secondary guard
        const newMessages = messages.filter(m => !processedMessages.has(m.id));
        if (newMessages.length === 0) continue;

        console.log('[WA Bot] New message from', chat.name, ':', lastMsg.text.substring(0, 80));

        // Mark ALL messages as processed
        messages.forEach(m => processedMessages.add(m.id));
        processedCount++;

        const contactName = chatInfo.name || chat.name;
        const contactPhone = chatInfo.phone || null;
        const response = await getReply(lastMsg.text, contactPhone, contactName);

        if (response && response.reply && response.reply.trim()) {
          console.log('[WA Bot] GPT reply:', response.reply.substring(0, 80));
          await sleep(1000 + Math.random() * 1000);
          const sent = await typeAndSend(response.reply);
          if (sent) {
            console.log('[WA Bot] Reply SENT to', chat.name);
            repliedChats.set(chat.name, { text: lastMsg.text, time: Date.now() });
          }
        } else {
          console.error('[WA Bot] No reply from server for', chat.name);
        }

        await sleep(1500);
      }
    } catch (err) {
      console.error('[WA Bot] Scan error:', err);
    }

    busy = false;
  }

  // Names to never reply to
  const SKIP_NAMES = /^meta ai$|community|group|boys|girls|fellowship|freelanc|wizards|developers|college|school|class|batch|xi[iv]?-|xii|whatsapp|build|techversity|jazz|clan|baithak|member chat/i;

  function shouldSkipChat(name) {
    return !name || SKIP_NAMES.test(name) || pausedChats.has(name);
  }

  // Listen for commands from popup / dashboard
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SET_ENABLED') {
      enabled = msg.enabled;
      console.log('[WA Bot]', enabled ? 'ENABLED' : 'DISABLED');
      sendResponse({ ok: true });
    }
    if (msg.type === 'GET_STATUS') {
      const chatInfo = getCurrentChatInfo();
      sendResponse({
        enabled,
        processedCount,
        pausedChats: Array.from(pausedChats),
        currentChat: chatInfo.name
      });
    }
    if (msg.type === 'PAUSE_CHAT') {
      pausedChats.add(msg.chatName);
      console.log('[WA Bot] Paused bot for:', msg.chatName);
      sendResponse({ ok: true, pausedChats: Array.from(pausedChats) });
    }
    if (msg.type === 'RESUME_CHAT') {
      pausedChats.delete(msg.chatName);
      console.log('[WA Bot] Resumed bot for:', msg.chatName);
      sendResponse({ ok: true, pausedChats: Array.from(pausedChats) });
    }
    if (msg.type === 'SEND_MESSAGE') {
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

  // Clean up old tracking data periodically (keep memory low)
  setInterval(() => {
    if (processedMessages.size > 500) {
      const arr = Array.from(processedMessages);
      arr.splice(0, arr.length - 200).forEach(id => processedMessages.delete(id));
    }
    // Clean up replied chats older than 5 minutes
    const now = Date.now();
    for (const [name, data] of repliedChats) {
      if (now - data.time > 300000) repliedChats.delete(name);
    }
  }, 60000);

  // Boot
  waitForLoad(() => {
    // Mark all current messages as already seen so we don't reply to old ones
    const initMsgs = getLastIncomingMessages();
    initMsgs.forEach(m => processedMessages.add(m.id));
    processedCount = 0;

    console.log('[WA Bot] Starting scanner, marked', initMsgs.length, 'existing messages as seen');

    setInterval(scanAndReply, SCAN_INTERVAL);

    // Poll for server-queued outgoing messages
    setInterval(() => {
      if (!enabled || busy) return;
      chrome.runtime.sendMessage({ type: 'CHECK_OUTGOING' }, async (response) => {
        if (chrome.runtime.lastError) return;
        if (response && response.messages && response.messages.length > 0) {
          busy = true;
          for (const msg of response.messages) {
            console.log('[WA Bot] Sending queued message to', msg.phone);
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
          const clearBtn = document.querySelector('[data-testid="x-alt"]');
          if (clearBtn) clearBtn.click();
          busy = false;
        }
      });
    }, 5000);

    console.log('[WA Bot] All systems running');
  });

})();
