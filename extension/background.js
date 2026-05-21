/**
 * background.js — Service Worker
 * Provides tab capture stream ID to popup.js on request.
 * Also manages userId and meeting session storage.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "getStreamId") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        sendResponse({ error: "No active tab found" });
        return;
      }
      const tabId = tabs[0].id;
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ streamId, tabId });
        }
      });
    });
    return true;
  }

  if (msg.action === "getTabId") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ tabId: tabs[0]?.id ?? null });
    });
    return true;
  }

  // Return or create a persistent userId
  if (msg.action === "getUserId") {
    chrome.storage.local.get("userId", (result) => {
      if (result.userId) {
        sendResponse({ userId: result.userId });
      } else {
        const userId = "user_" + crypto.randomUUID();
        chrome.storage.local.set({ userId }, () => {
          sendResponse({ userId });
        });
      }
    });
    return true;
  }

  // Save a completed session
  if (msg.action === "saveSession") {
    const session = msg.session;
    chrome.storage.local.get("sessions", (result) => {
      const sessions = result.sessions || {};
      sessions[session.id] = session;
      chrome.storage.local.set({ sessions }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  // Load all sessions
  if (msg.action === "getSessions") {
    chrome.storage.local.get("sessions", (result) => {
      sendResponse({ sessions: result.sessions || {} });
    });
    return true;
  }

  // Delete a session by id
  if (msg.action === "deleteSession") {
    chrome.storage.local.get("sessions", (result) => {
      const sessions = result.sessions || {};
      delete sessions[msg.sessionId];
      chrome.storage.local.set({ sessions }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }
});