"use strict";

const WS_URL = "wss://test12.fireai.agency/ws";

const statusDot          = document.getElementById("statusDot");
const statusText         = document.getElementById("statusText");
const phaseBadge         = document.getElementById("phaseBadge");
const waveformCanvas     = document.getElementById("waveformCanvas");
const transcriptBox      = document.getElementById("transcriptBox");
const responsesBox       = document.getElementById("responsesBox");
const contextStrip       = document.getElementById("contextStrip");
const topicsVal          = document.getElementById("topicsVal");
const decisionsVal       = document.getElementById("decisionsVal");
const actionsVal         = document.getElementById("actionsVal");
const startBtn           = document.getElementById("startBtn");
const stopBtn            = document.getElementById("stopBtn");
const downloadBtn        = document.getElementById("downloadBtn");        // footer export btn
const summaryBtn         = document.getElementById("summaryBtn");
const historyBtn         = document.getElementById("historyBtn");
const clearTranscriptBtn = document.getElementById("clearTranscriptBtn");
const clearResponsesBtn  = document.getElementById("clearResponsesBtn");
const modalOverlay       = document.getElementById("modalOverlay");
const closeModalBtn      = document.getElementById("closeModalBtn");
const summaryBody        = document.getElementById("summaryBody");
const historyOverlay     = document.getElementById("historyOverlay");
const closeHistoryBtn    = document.getElementById("closeHistoryBtn");
const historyListView    = document.getElementById("historyListView");
const historyDetailView  = document.getElementById("historyDetailView");
const historyList        = document.getElementById("historyList");
const historyModalTitle  = document.getElementById("historyModalTitle");
const historyUserBar     = document.getElementById("historyUserBar");
const backToListBtn      = document.getElementById("backToListBtn");
const detailSessionDate  = document.getElementById("detailSessionDate");
const historyDetailBody  = document.getElementById("historyDetailBody");

let audioCtx    = null;
let workletNode = null;
let mediaStream = null;
let ws          = null;
let animFrameId = null;
let analyser    = null;
let dataArray   = null;
let interimEl   = null;

// ── Session state ─────────────────────────────────────────────────────────────
let userId       = null;
let sessionId    = null;
let sessionStart = null;

let sessionTranscript = [];
let sessionResponses  = [];
let sessionSummary    = null;

// Holds the session currently open in the history detail view
let _detailSession = null;

// ── Waveform ──────────────────────────────────────────────────────────────────
const ctx2d = waveformCanvas.getContext("2d");

function drawWaveform() {
  animFrameId = requestAnimationFrame(drawWaveform);
  if (!analyser) return;
  analyser.getByteTimeDomainData(dataArray);

  const W = waveformCanvas.width;
  const H = waveformCanvas.height;
  ctx2d.clearRect(0, 0, W, H);
  ctx2d.strokeStyle = "#6366f1";
  ctx2d.lineWidth   = 1.5;
  ctx2d.beginPath();

  const slice = W / dataArray.length;
  let x = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = dataArray[i] / 128.0;
    const y = (v * H) / 2;
    if (i === 0) ctx2d.moveTo(x, y);
    else         ctx2d.lineTo(x, y);
    x += slice;
  }
  ctx2d.stroke();
}

function stopWaveform() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  ctx2d.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(state, text) {
  statusDot.className    = "logo-icon " + (state || "");
  statusText.textContent = text;
}

// ── UserId ────────────────────────────────────────────────────────────────────
async function getOrCreateUserId() {
  return new Promise((res) =>
    chrome.runtime.sendMessage({ action: "getUserId" }, (r) => res(r.userId))
  );
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function startSession() {
  startBtn.disabled    = true;
  if (downloadBtn) downloadBtn.disabled = true;
  setStatus("connecting", "Connecting…");

  sessionTranscript = [];
  sessionResponses  = [];
  sessionSummary    = null;
  sessionStart      = Date.now();
  sessionId         = "session_" + sessionStart;

  try {
    userId = await getOrCreateUserId();

    const { streamId, error: bgErr } = await new Promise((res) =>
      chrome.runtime.sendMessage({ action: "getStreamId" }, res)
    );
    if (bgErr) throw new Error("Background error: " + bgErr);

    audioCtx    = new AudioContext({ sampleRate: 16000 });
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource:   "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    const workletURL = chrome.runtime.getURL("worklet/audio-processor.js");
    await audioCtx.audioWorklet.addModule(workletURL);

    const source = audioCtx.createMediaStreamSource(mediaStream);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);

    workletNode = new AudioWorkletNode(audioCtx, "meeting-audio-processor");
    source.connect(workletNode);

    // Route tab audio back to speakers so user can still hear the client
    source.connect(audioCtx.destination);

    ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      ws.send(JSON.stringify({
        action: "init",
        userId,
        sessionId,
      }));

      setStatus("listening", "Listening to client…");
      stopBtn.disabled = false;
      waveformCanvas.width = waveformCanvas.offsetWidth || 360;
      drawWaveform();
    };

    ws.onmessage  = (evt) => handleServerMessage(JSON.parse(evt.data));
    ws.onerror    = ()    => setStatus("error", "WebSocket error");
    ws.onclose    = ()    => {
      if (statusDot.classList.contains("listening")) setStatus("", "Disconnected");
    };

    workletNode.port.onmessage = (evt) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(evt.data);
    };

    workletNode.connect(audioCtx.destination);

  } catch (err) {
    console.error("[popup] Start error:", err);
    setStatus("error", "Error: " + err.message);
    startBtn.disabled = false;
  }
}

// ── Stop ──────────────────────────────────────────────────────────────────────
async function stopSession() {
  stopBtn.disabled  = true;
  startBtn.disabled = false;
  setStatus("", "Stopped");
  stopWaveform();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "summary" }));
    await waitForSummary(1500);
    ws.send(JSON.stringify({ action: "stop" }));
    ws.close();
  }
  ws = null;

  await persistSession();

  // Enable the footer Export button if we have data to export
  if (downloadBtn && sessionTranscript.length > 0) {
    downloadBtn.disabled = false;
  }

  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (analyser)    { analyser.disconnect();    analyser    = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (audioCtx)    { await audioCtx.close(); audioCtx = null; }
}

// Wait until sessionSummary is populated by handleServerMessage, or timeout
function waitForSummary(timeoutMs) {
  return new Promise((resolve) => {
    if (sessionSummary) return resolve();
    const start = Date.now();
    const tick = () => {
      if (sessionSummary)                return resolve();
      if (Date.now() - start > timeoutMs) return resolve();
      setTimeout(tick, 50);
    };
    tick();
  });
}

// ── Persist session to chrome.storage ────────────────────────────────────────
async function persistSession() {
  if (!sessionId || sessionTranscript.length === 0) return;

  const durationSec = Math.round((Date.now() - sessionStart) / 1000);

  const session = {
    id:         sessionId,
    userId,
    date:       new Date(sessionStart).toISOString(),
    duration:   durationSec,
    transcript: sessionTranscript,
    responses:  sessionResponses,
    summary:    sessionSummary || {},
  };

  await new Promise((res) =>
    chrome.runtime.sendMessage({ action: "saveSession", session }, res)
  );

  console.log("[popup] Session saved:", sessionId);
}

// ── Message handler ───────────────────────────────────────────────────────────
function handleServerMessage(msg) {
  switch (msg.type) {
    case "status":
      setStatus("listening", msg.message);
      break;
    case "transcript":
      updateTranscript(msg.text, msg.is_final);
      if (msg.is_final && msg.text.trim()) {
        sessionTranscript.push({ text: msg.text, ts: Date.now() });
      }
      break;
    case "agent_response":
      addResponseCard(msg.data);
      updateContextStrip(msg.data);
      sessionResponses.push({
        response_type: msg.data.response_type,
        response:      msg.data.response,
        confidence:    msg.data.confidence,
        ts:            Date.now(),
      });
      break;
    case "summary":
      renderSummary(msg.data);
      sessionSummary = msg.data;
      break;
    case "error":
      setStatus("error", "Error: " + msg.message);
      break;
  }
}

// ── Transcript ────────────────────────────────────────────────────────────────
function updateTranscript(text, isFinal) {
  const ph = transcriptBox.querySelector(".placeholder");
  if (ph) ph.remove();

  if (!isFinal) {
    if (!interimEl) {
      interimEl = document.createElement("p");
      interimEl.className = "utterance interim";
      transcriptBox.appendChild(interimEl);
    }
    interimEl.textContent = text;
  } else {
    if (interimEl) {
      interimEl.classList.remove("interim");
      interimEl.textContent = text;
      interimEl = null;
    } else {
      const p = document.createElement("p");
      p.className   = "utterance";
      p.textContent = text;
      transcriptBox.appendChild(p);
    }
  }
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

// ── Response cards ────────────────────────────────────────────────────────────
const RTYPE_LABELS = {
  suggested_reply:     "💬 Say this",
  clarifying_question: "❓ Ask back",
  recommendation:      "🛠 Recommend",
  flag:                "⚠ Heads-up",
  answer:              "💬 Say this",
  insight:             "💡 Insight",
  decision_ack:        "✅ Decision",
  action_item:         "📋 Action",
  error:               "⚠ Error",
};

function addResponseCard(data) {
  const ph = responsesBox.querySelector(".placeholder");
  if (ph) ph.remove();

  const rtype      = data.response_type || "suggested_reply";
  const label      = RTYPE_LABELS[rtype] || rtype;
  const confidence = Math.round((data.confidence || 0) * 100);

  const card = document.createElement("div");
  card.className = `response-card ${rtype}`;
  card.innerHTML = `
    <div class="response-meta">
      <span class="response-type-badge">${label}</span>
      <span class="response-confidence">${confidence}% confidence</span>
    </div>
    <div class="response-text">${escHtml(data.response)}</div>
  `;
  responsesBox.appendChild(card);
  responsesBox.scrollTop = responsesBox.scrollHeight;
}

// ── Context strip ─────────────────────────────────────────────────────────────
function updateContextStrip(data) {
  contextStrip.style.display = "flex";
  if (data.topics?.length)       topicsVal.textContent    = data.topics.slice(-2).join(", ");
  if (data.decisions?.length)    decisionsVal.textContent = data.decisions.length + " made";
  if (data.action_items?.length) actionsVal.textContent   = data.action_items.length + " logged";
  if (data.phase)                phaseBadge.textContent   = data.phase.replace("_", " ");
}

// ── Summary modal ─────────────────────────────────────────────────────────────
function requestSummary() {
  modalOverlay.style.display = "flex";

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "summary" }));
    summaryBody.textContent = "Loading…";
    return;
  }

  if (sessionSummary) {
    renderSummary(sessionSummary);
    return;
  }

  summaryBody.textContent = "No summary available yet. Start a session and let the call run for a few utterances.";
}

function renderSummary(data) {
  const lines = [
    `📌  Phase: ${data.phase}`,
    `💬  Utterances: ${data.utterances}`,
    "",
    `🔹  Topics (${data.topics?.length || 0}):`,
    ...(data.topics || []).map(t => `   • ${t}`),
    "",
    `✅  Decisions (${data.decisions?.length || 0}):`,
    ...(data.decisions || []).map(d => `   • ${d}`),
    "",
    `📋  Action items (${data.action_items?.length || 0}):`,
    ...(data.action_items || []).map(a => `   • ${a}`),
    "",
    `❓  Open questions (${data.questions?.length || 0}):`,
    ...(data.questions || []).map(q => `   • ${q}`),
  ];
  summaryBody.textContent = lines.join("\n");
}

// ── History modal ─────────────────────────────────────────────────────────────
async function openHistory() {
  historyOverlay.style.display = "flex";
  showListView();

  const uid = userId || await getOrCreateUserId();
  historyUserBar.textContent = `User ID: ${uid}`;

  const { sessions } = await new Promise((res) =>
    chrome.runtime.sendMessage({ action: "getSessions" }, res)
  );

  renderSessionList(sessions || {});
}

function showListView() {
  historyListView.style.display   = "block";
  historyDetailView.style.display = "none";
  historyModalTitle.textContent   = "Meeting History";
  _detailSession = null;
}

function showDetailView() {
  historyListView.style.display   = "none";
  historyDetailView.style.display = "block";
  historyModalTitle.textContent   = "Session Detail";
}

function renderSessionList(sessions) {
  historyList.innerHTML = "";

  const list = Object.values(sessions).sort((a, b) => b.date.localeCompare(a.date));

  if (list.length === 0) {
    historyList.innerHTML = `
      <div class="history-empty">
        No sessions saved yet.<br>Start a meeting to record your first session.
      </div>`;
    return;
  }

  for (const session of list) {
    historyList.appendChild(buildSessionCard(session));
  }
}

function buildSessionCard(session) {
  const date      = new Date(session.date);
  const dateStr   = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const timeStr   = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const duration  = formatDuration(session.duration || 0);
  const phase     = session.summary?.phase || "—";
  const topics    = session.summary?.topics?.slice(0, 3).join(", ") || "No topics";
  const uttCount  = session.summary?.utterances || session.transcript?.length || 0;
  const respCount = session.responses?.length || 0;

  const card = document.createElement("div");
  card.className = "history-card";
  card.innerHTML = `
    <div class="history-card-header">
      <span class="history-card-date">${dateStr} · ${timeStr}</span>
      <span class="history-card-phase">${phase.replace("_", " ")}</span>
    </div>
    <div class="history-card-meta">
      <span>⏱ ${duration}</span>
      <span>💬 ${uttCount} utterances</span>
      <span>🤖 ${respCount} responses</span>
    </div>
    <div class="history-card-topics" title="${escHtml(topics)}">${escHtml(topics)}</div>
    <div class="history-card-actions">
      <button class="ghost-btn export-card-btn">⬇ Export</button>
      <button class="delete-btn" data-id="${escHtml(session.id)}">🗑 Delete</button>
    </div>
  `;

  // Open detail view on card click (not on action buttons)
  card.addEventListener("click", (e) => {
    if (e.target.closest(".delete-btn") || e.target.closest(".export-card-btn")) return;
    renderSessionDetail(session);
    showDetailView();
  });

  // Export from the list card directly
  card.querySelector(".export-card-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    downloadSessionText(session);
  });

  card.querySelector(".delete-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    await new Promise((res) =>
      chrome.runtime.sendMessage({ action: "deleteSession", sessionId: session.id }, res)
    );
    const { sessions } = await new Promise((res) =>
      chrome.runtime.sendMessage({ action: "getSessions" }, res)
    );
    renderSessionList(sessions || {});
  });

  return card;
}

function renderSessionDetail(session) {
  _detailSession = session;

  const date    = new Date(session.date);
  const dateStr = date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  const timeStr = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  detailSessionDate.textContent = `${dateStr} at ${timeStr}`;

  const s   = session.summary || {};
  const dur = formatDuration(session.duration || 0);

  let html = "";

  html += `<div class="detail-stats">
    <div class="detail-stat">
      <span class="detail-stat-label">Duration</span>
      <span class="detail-stat-val">${dur}</span>
    </div>
    <div class="detail-stat">
      <span class="detail-stat-label">Phase</span>
      <span class="detail-stat-val">${(s.phase || "—").replace("_", " ")}</span>
    </div>
    <div class="detail-stat">
      <span class="detail-stat-label">Utterances</span>
      <span class="detail-stat-val">${s.utterances || session.transcript?.length || 0}</span>
    </div>
  </div>`;

  if (s.topics?.length) {
    html += `<div class="detail-section-title">Topics</div>`;
    html += s.topics.map(t => `<div class="detail-list-item">${escHtml(t)}</div>`).join("");
  }

  if (s.decisions?.length) {
    html += `<div class="detail-section-title">Decisions</div>`;
    html += s.decisions.map(d => `<div class="detail-list-item">${escHtml(d)}</div>`).join("");
  }

  if (s.action_items?.length) {
    html += `<div class="detail-section-title">Action Items</div>`;
    html += s.action_items.map(a => `<div class="detail-list-item">${escHtml(a)}</div>`).join("");
  }

  if (s.questions?.length) {
    html += `<div class="detail-section-title">Open Questions</div>`;
    html += s.questions.map(q => `<div class="detail-list-item">${escHtml(q)}</div>`).join("");
  }

  // ── Interleaved conversation log ──────────────────────────────────────────
  // Merge transcript + AI responses by timestamp so the .txt reads like a
  // real conversation: CLIENT said X → AURORA suggested Y → CLIENT said Z…
  const transcript = session.transcript || [];
  const responses  = session.responses  || [];

  if (transcript.length || responses.length) {
    html += `<div class="detail-section-title">Conversation Log</div>`;

    const events = [
      ...transcript.map(u => ({ kind: "client", ts: u.ts || 0, text: u.text })),
      ...responses .map(r => ({ kind: "ai",     ts: r.ts || 0, text: r.response, rtype: r.response_type })),
    ].sort((a, b) => a.ts - b.ts);

    for (const ev of events) {
      if (ev.kind === "client") {
        html += `<div class="detail-transcript-item">
          <span class="conv-role client-role">CLIENT</span>
          ${escHtml(ev.text)}
        </div>`;
      } else {
        const label = RTYPE_LABELS[ev.rtype] || ev.rtype || "AI";
        html += `<div class="detail-response-card ${escHtml(ev.rtype || '')}">
          <div class="detail-badge">${label}</div>
          <div>${escHtml(ev.text)}</div>
        </div>`;
      }
    }
  }

  // Download button at bottom of detail body
  html += `<div style="margin-top:12px;text-align:center">
    <button class="ghost-btn" id="detailExportBtn">⬇ Download as .txt</button>
  </div>`;

  historyDetailBody.innerHTML = html;
  historyDetailBody.scrollTop = 0;

  // Wire the download button AFTER it's in the DOM
  document.getElementById("detailExportBtn").addEventListener("click", () => {
    downloadSessionText(session);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDuration(sec) {
  if (!sec) return "0m";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Text export ───────────────────────────────────────────────────────────────
function buildSessionText(session) {
  const date    = new Date(session.date);
  const dateStr = date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  const timeStr = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const dur     = formatDuration(session.duration || 0);
  const s       = session.summary || {};
  const DIV     = "─".repeat(60);

  const lines = [];
  lines.push("AURORA — MEETING SESSION EXPORT");
  lines.push(DIV);
  lines.push(`Date      : ${dateStr} at ${timeStr}`);
  lines.push(`Duration  : ${dur}`);
  lines.push(`Phase     : ${(s.phase || "—").replace("_", " ")}`);
  lines.push(`Utterances: ${s.utterances || session.transcript?.length || 0}`);
  lines.push(`Session ID: ${session.id}`);
  lines.push("");

  if (s.topics?.length) {
    lines.push("TOPICS");
    lines.push(DIV);
    s.topics.forEach(t => lines.push(`  • ${t}`));
    lines.push("");
  }

  if (s.decisions?.length) {
    lines.push("DECISIONS");
    lines.push(DIV);
    s.decisions.forEach(d => lines.push(`  • ${d}`));
    lines.push("");
  }

  if (s.action_items?.length) {
    lines.push("ACTION ITEMS");
    lines.push(DIV);
    s.action_items.forEach(a => lines.push(`  • ${a}`));
    lines.push("");
  }

  if (s.questions?.length) {
    lines.push("OPEN QUESTIONS");
    lines.push(DIV);
    s.questions.forEach(q => lines.push(`  • ${q}`));
    lines.push("");
  }

  // Interleaved conversation log
  const transcript = session.transcript || [];
  const responses  = session.responses  || [];

  lines.push("CONVERSATION LOG");
  lines.push(DIV);

  const events = [
    ...transcript.map(u => ({ kind: "client", ts: u.ts || 0, text: u.text })),
    ...responses .map(r => ({ kind: "ai",     ts: r.ts || 0, text: r.response, rtype: r.response_type })),
  ].sort((a, b) => a.ts - b.ts);

  if (events.length === 0) {
    lines.push("  (no conversation recorded)");
  } else {
    for (const ev of events) {
      const time = ev.ts
        ? new Date(ev.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " "
        : "";
      if (ev.kind === "client") {
        lines.push(`[${time}CLIENT]`);
        lines.push(`  ${ev.text}`);
      } else {
        const label = (RTYPE_LABELS[ev.rtype] || ev.rtype || "AI").replace(/[^\w\s]/g, "").trim();
        lines.push(`[${time}AURORA — ${label}]`);
        lines.push(`  ${ev.text}`);
      }
      lines.push("");
    }
  }

  lines.push(DIV);
  lines.push("END OF SESSION");
  return lines.join("\n");
}

function downloadSessionText(session) {
  const text    = buildSessionText(session);
  const date    = new Date(session.date);
  const dateTag = date.toISOString().slice(0, 10);
  const timeTag = date.toTimeString().slice(0, 8).replace(/:/g, "-");
  const filename = `aurora-session-${dateTag}-${timeTag}.txt`;

  // chrome.downloads.create() requires a URL — convert the text to a
  // data: URI so no blob lifetime issues arise across the popup lifecycle.
  const dataUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(text);

  chrome.downloads.download(
    { url: dataUrl, filename, saveAs: false },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("[Aurora] Download failed:", chrome.runtime.lastError.message);
      } else {
        console.log("[Aurora] Download started, id:", downloadId);
      }
    }
  );
}

// ── Events ────────────────────────────────────────────────────────────────────
startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click",  stopSession);

// Footer Export button — downloads the most recently completed session
if (downloadBtn) {
  downloadBtn.addEventListener("click", () => {
    if (!sessionId || sessionTranscript.length === 0) return;
    downloadSessionText({
      id:         sessionId,
      userId,
      date:       new Date(sessionStart).toISOString(),
      duration:   Math.round((Date.now() - sessionStart) / 1000),
      transcript: sessionTranscript,
      responses:  sessionResponses,
      summary:    sessionSummary || {},
    });
  });
}

summaryBtn.addEventListener("click",    requestSummary);
closeModalBtn.addEventListener("click", () => { modalOverlay.style.display = "none"; });
modalOverlay.addEventListener("click",  (e) => { if (e.target === modalOverlay) modalOverlay.style.display = "none"; });

historyBtn.addEventListener("click",    openHistory);
closeHistoryBtn.addEventListener("click", () => { historyOverlay.style.display = "none"; });
historyOverlay.addEventListener("click",  (e) => { if (e.target === historyOverlay) historyOverlay.style.display = "none"; });
backToListBtn.addEventListener("click",   showListView);

clearTranscriptBtn.addEventListener("click", () => {
  transcriptBox.innerHTML = '<p class="placeholder">Transcript will appear here…</p>';
  interimEl = null;
});
clearResponsesBtn.addEventListener("click", () => {
  responsesBox.innerHTML = '<p class="placeholder">Relevant responses will appear here…</p>';
});