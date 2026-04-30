import './style.css';
import { analyzeDocument, analyzeImage, chatFollowUp, translateAnalysis } from './groq.js';
import { extractTextFromPDF } from './pdf.js';

// ===== LANGUAGE CONFIG =====
const LANGUAGES = [
  { code: 'en', lang: 'en-US', name: 'English', native: 'English' },
  { code: 'hi', lang: 'hi-IN', name: 'Hindi', native: 'हिन्दी' },
  { code: 'kn', lang: 'kn-IN', name: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'ta', lang: 'ta-IN', name: 'Tamil', native: 'தமிழ்' },
  { code: 'te', lang: 'te-IN', name: 'Telugu', native: 'తెలుగు' },
  { code: 'ml', lang: 'ml-IN', name: 'Malayalam', native: 'മലയാളം' },
  { code: 'mr', lang: 'mr-IN', name: 'Marathi', native: 'मराठी' },
  { code: 'bn', lang: 'bn-IN', name: 'Bengali', native: 'বাংলা' },
];

// ===== STATE =====
let state = {
  screen: 'upload', // upload | loading | analysis
  analysis: null,
  analysisOriginal: null, // English original for re-translating
  rawText: '',
  fileName: '',
  activeClause: null,
  chatHistory: [],
  chatOpen: false,
  chatLoading: false,
  currentLang: 'en',
  translating: false,
};

// ===== TEXT-TO-SPEECH ENGINE =====
// Voices cache
let voicesLoaded = false;
let cachedVoices = [];

function loadVoices() {
  return new Promise(resolve => {
    cachedVoices = window.speechSynthesis.getVoices();
    if (cachedVoices.length) { voicesLoaded = true; resolve(cachedVoices); return; }
    window.speechSynthesis.onvoiceschanged = () => {
      cachedVoices = window.speechSynthesis.getVoices();
      voicesLoaded = true;
      resolve(cachedVoices);
    };
    // Fallback timeout
    setTimeout(() => { cachedVoices = window.speechSynthesis.getVoices(); voicesLoaded = true; resolve(cachedVoices); }, 1000);
  });
}
loadVoices();

function pickVoice(langCode) {
  const voices = cachedVoices.length ? cachedVoices : window.speechSynthesis.getVoices();
  const langConfig = LANGUAGES.find(l => l.code === langCode);
  const langTag = langConfig ? langConfig.lang : 'en-US';
  // Try Google voice first (best quality), then any matching voice
  let voice = voices.find(v => v.lang === langTag && v.name.includes('Google'));
  if (!voice) voice = voices.find(v => v.lang === langTag);
  if (!voice) voice = voices.find(v => v.lang.startsWith(langCode));
  if (!voice) voice = voices.find(v => v.lang.startsWith('en'));
  return voice || null;
}

// Split text into chunks at sentence boundaries to avoid Chrome's 15s cutoff
function chunkText(text, maxLen = 180) {
  const sentences = text.replace(/([.!?।])/g, '$1|SPLIT|').split('|SPLIT|').filter(s => s.trim());
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > maxLen && current) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

const tts = {
  synth: window.speechSynthesis,
  current: null,
  paused: false,
  queue: [],
  queueIndex: 0,

  speak(text, id) {
    // Toggle pause/resume if same
    if (this.current === id && this.synth.speaking) {
      if (this.paused) {
        this.synth.resume();
        this.paused = false;
        updateTTSButton(id, 'playing');
      } else {
        this.synth.pause();
        this.paused = true;
        updateTTSButton(id, 'paused');
      }
      return;
    }

    this.stop();
    this.queue = chunkText(text);
    this.queueIndex = 0;
    this.current = id;
    this.paused = false;
    updateTTSButton(id, 'playing');
    this._speakNext();
  },

  _speakNext() {
    if (this.queueIndex >= this.queue.length) {
      const prevId = this.current;
      this.current = null;
      this.paused = false;
      this.queue = [];
      updateTTSButton(prevId, 'idle');
      return;
    }

    const utterance = new SpeechSynthesisUtterance(this.queue[this.queueIndex]);
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.volume = 1;

    const voice = pickVoice(state.currentLang);
    if (voice) utterance.voice = voice;

    utterance.onend = () => {
      this.queueIndex++;
      this._speakNext();
    };
    utterance.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      this.queueIndex++;
      this._speakNext();
    };

    this.synth.speak(utterance);
  },

  stop() {
    const prevId = this.current;
    this.synth.cancel();
    this.current = null;
    this.paused = false;
    this.queue = [];
    this.queueIndex = 0;
    if (prevId) updateTTSButton(prevId, 'idle');
  }
};

function updateTTSButton(id, st) {
  const btn = document.querySelector(`.tts-btn[data-tts-id="${id}"]`);
  if (!btn) return;
  btn.classList.remove('playing', 'paused');
  if (st === 'playing') {
    btn.classList.add('playing');
    btn.innerHTML = '<span class="tts-icon">⏸</span><span class="tts-label">Pause</span>';
  } else if (st === 'paused') {
    btn.classList.add('paused');
    btn.innerHTML = '<span class="tts-icon">▶</span><span class="tts-label">Resume</span>';
  } else {
    btn.innerHTML = '<span class="tts-icon">🔊</span><span class="tts-label">Listen</span>';
  }
}

// ===== RENDER ENGINE =====
function render() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="bg-glow">
      <div class="orb"></div><div class="orb"></div><div class="orb"></div>
    </div>
    ${renderHeader()}
    ${state.screen === 'upload' ? renderUpload() : ''}
    ${state.screen === 'loading' ? renderLoading() : ''}
    ${state.screen === 'analysis' ? renderAnalysis() : ''}
    ${renderChatWidget()}
  `;
  bindEvents();
}

// ===== HEADER =====
function renderHeader() {
  return `
    <header class="header">
      <div class="logo">
        <div class="logo-text">TruDoc</div>
      </div>
  
    </header>
  `;
}

// ===== UPLOAD SCREEN =====
function renderUpload() {
  return `
    <div class="upload-screen">
      <div class="upload-container">
        <h1>Understand Any Legal Document</h1>
        <p>Upload a contract, lease, or agreement. TruDoc breaks it down clause by clause with a safety score — no legal jargon.</p>
        
        <div class="dropzone" id="dropzone">
          <div class="dropzone-icon">📄</div>
          <div class="dropzone-text">Drop your document here</div>
          <div class="dropzone-sub">or click to browse • PDF, TXT, or photo of a document</div>
          <input type="file" id="fileInput" accept=".pdf,.txt,.jpg,.jpeg,.png,.webp" style="display:none" />
        </div>

        <div class="upload-or">— or paste text below —</div>

        <textarea class="paste-area" id="pasteArea" placeholder="Paste your legal document text here..." rows="6"></textarea>
        <button class="btn-analyze" id="btnAnalyze">🔍 Analyze Document</button>
      </div>
    </div>
  `;
}

// ===== LOADING =====
function renderLoading() {
  return `
    <div class="loading-screen">
      <div class="spinner"></div>
      <div class="loading-text">TruDoc is analyzing your document...</div>
    </div>
  `;
}

// ===== ANALYSIS VIEW =====
function renderAnalysis() {
  const a = state.analysis;
  if (!a) return '';

  const risky = a.clauses.filter(c => c.risk === 'risky').length;
  const caution = a.clauses.filter(c => c.risk === 'caution').length;
  const safe = a.clauses.filter(c => c.risk === 'safe').length;

  const scoreColor = a.safetyScore >= 80 ? 'var(--green)' : a.safetyScore >= 50 ? 'var(--yellow)' : 'var(--red)';
  const verdict = a.safetyScore >= 80 ? 'Low Risk' : a.safetyScore >= 50 ? 'Moderate Risk' : 'High Risk';
  const verdictDesc = a.safetyScore >= 80
    ? 'This document appears generally fair and standard.'
    : a.safetyScore >= 50
    ? 'Some clauses need attention before signing.'
    : 'Significant risks detected. Review carefully.';

  const circumference = 2 * Math.PI * 40;
  const offset = circumference - (a.safetyScore / 100) * circumference;

  const langOpts = LANGUAGES.map(l => `<option value="${l.code}" ${state.currentLang === l.code ? 'selected' : ''}>${l.native} (${l.name})</option>`).join('');

  return `
    <div class="analysis-view">
      <div class="analysis-topbar">
        <div class="doc-name">📄 ${a.documentTitle || state.fileName || 'Document'} <span style="color:var(--text-muted);font-weight:400;font-size:12px">• ${a.documentType || 'Legal Document'}</span></div>
        <div class="topbar-actions">
          <div class="lang-selector">
            <label class="lang-label">🌐</label>
            <select class="lang-dropdown" id="langSelect">${langOpts}</select>
          </div>
          ${state.translating ? '<span class="translating-badge">Translating...</span>' : ''}
          <button class="btn-tts-all" id="btnReadAll" title="Read entire analysis aloud">🔊 Read All</button>
          <button class="btn-tts-stop" id="btnStopAll" title="Stop reading">⏹ Stop</button>
          <button class="btn-new" id="btnNew">← New Document</button>
        </div>
      </div>

      <div class="score-panel">
        <div class="score-circle-wrap">
          <div class="score-circle">
            <svg viewBox="0 0 100 100">
              <circle class="bg" cx="50" cy="50" r="40" />
              <circle class="fg" cx="50" cy="50" r="40"
                stroke="${scoreColor}"
                stroke-dasharray="${circumference}"
                stroke-dashoffset="${offset}" />
            </svg>
            <div class="score-value" style="color:${scoreColor}">${a.safetyScore}</div>
          </div>
          <div>
            <div class="score-label">Safety Score</div>
            <div class="score-verdict" style="color:${scoreColor}">${verdict}</div>
            <div class="score-desc">${verdictDesc}</div>
          </div>
        </div>
        <div class="stat-cards">
          <div class="stat-card total"><div class="stat-num">${a.clauses.length}</div><div class="stat-name">Total Clauses</div></div>
          <div class="stat-card safe"><div class="stat-num">${safe}</div><div class="stat-name">✅ Safe</div></div>
          <div class="stat-card caution"><div class="stat-num">${caution}</div><div class="stat-name">⚠️ Caution</div></div>
          <div class="stat-card risky"><div class="stat-num">${risky}</div><div class="stat-name">🚨 Risky</div></div>
        </div>
      </div>

      <div class="split-pane">
        <div class="pane pane-left" id="paneLeft">
          <div class="pane-header">Original Document</div>
          <div class="original-text" id="originalText">${renderOriginalWithHighlights()}</div>
        </div>
        <div class="resize-handle" id="resizeHandle"></div>
        <div class="pane pane-right" id="paneRight">
          <div class="pane-header">Plain English Breakdown</div>
          ${a.clauses.map((c, i) => renderClauseCard(c, i)).join('')}

          ${a.missingProtections && a.missingProtections.length > 0 ? `
            <div class="missing-section">
              <div class="missing-header">
                <h3>🚨 Missing Protections</h3>
                <button class="tts-btn" data-tts-id="missing" data-tts-text="${escapeAttr(a.missingProtections.join('. '))}">
                  <span class="tts-icon">🔊</span><span class="tts-label">Listen</span>
                </button>
              </div>
              ${a.missingProtections.map(m => `<div class="missing-item">• ${m}</div>`).join('')}
            </div>
          ` : ''}

          <div class="summary-section">
            <div class="summary-header">
              <h3>📋 Final Summary</h3>
              <button class="tts-btn" data-tts-id="summary" data-tts-text="${escapeAttr(a.summary)}">
                <span class="tts-icon">🔊</span><span class="tts-label">Listen</span>
              </button>
            </div>
            <div class="summary-text">${a.summary}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderOriginalWithHighlights() {
  const a = state.analysis;
  if (!a || !state.rawText) return escapeHtml(state.rawText);

  let text = escapeHtml(state.rawText);
  // Try to highlight clause original texts in the document
  a.clauses.forEach((c, i) => {
    if (c.originalText) {
      const escaped = escapeHtml(c.originalText.substring(0, 80));
      const idx = text.indexOf(escaped);
      if (idx !== -1) {
        const end = text.indexOf(escapeHtml(c.originalText.substring(c.originalText.length - 20)), idx);
        const actualEnd = end !== -1 ? end + escapeHtml(c.originalText.substring(c.originalText.length - 20)).length : idx + escaped.length;
        const snippet = text.substring(idx, actualEnd);
        text = text.substring(0, idx) +
          `<span class="clause-highlight ${state.activeClause === i ? 'active' : ''}" data-clause="${i}">${snippet}</span>` +
          text.substring(actualEnd);
      }
    }
  });

  return text;
}

function renderClauseCard(clause, index) {
  const ttsText = `${clause.title}. ${clause.explanation}. What this means for you: ${clause.userImpact}. ${clause.warning ? 'Warning: ' + clause.warning : ''}`;
  return `
    <div class="clause-card ${clause.risk} ${state.activeClause === index ? 'active' : ''}" data-clause="${index}">
      <div class="clause-top">
        <div class="clause-title">${clause.title}</div>
        <div class="clause-top-right">
          <button class="tts-btn" data-tts-id="clause-${index}" data-tts-text="${escapeAttr(ttsText)}" onclick="event.stopPropagation()">
            <span class="tts-icon">🔊</span><span class="tts-label">Listen</span>
          </button>
          <div class="clause-badge ${clause.risk}">${clause.risk === 'safe' ? '✅ Safe' : clause.risk === 'caution' ? '⚠️ Caution' : '🚨 Risky'}</div>
        </div>
      </div>
      <div class="clause-explain">${clause.explanation}</div>
      <div class="clause-impact"><strong>What this means for you: </strong>${clause.userImpact}</div>
      ${clause.warning ? `<div class="clause-warning ${clause.risk}">${clause.warning}</div>` : ''}
    </div>
  `;
}

// ===== FLOATING CHAT WIDGET =====
function renderChatWidget() {
  // Only show if we have an analysis (otherwise nothing to chat about)
  const hasAnalysis = state.analysis !== null;
  
  return `
    <div class="chat-fab ${state.chatOpen ? 'open' : ''}" id="chatFab">
      <button class="chat-fab-btn" id="chatFabBtn" title="${hasAnalysis ? 'Chat with DocGuard AI' : 'Upload a document first'}">
        ${state.chatOpen ? '✕' : '💬'}
        ${!state.chatOpen && state.chatHistory.length > 0 ? `<span class="chat-badge">${state.chatHistory.filter(m => m.role === 'ai').length}</span>` : ''}
      </button>
      ${state.chatOpen ? `
        <div class="chat-panel" id="chatPanel">
          <div class="chat-panel-header">
            <div class="chat-panel-title">
              <span class="chat-panel-dot"></span>
              DocGuard AI
            </div>
            <div class="chat-panel-subtitle">${hasAnalysis ? 'Ask about your document' : 'Upload a document to start chatting'}</div>
          </div>
          <div class="chat-panel-messages" id="chatPanelMessages">
            ${!hasAnalysis ? `
              <div class="chat-empty">
                <div class="chat-empty-icon">📄</div>
                <div class="chat-empty-text">Upload and analyze a document first, then come back to ask questions!</div>
              </div>
            ` : state.chatHistory.length === 0 ? `
              <div class="chat-empty">
                <div class="chat-empty-icon">💬</div>
                <div class="chat-empty-text">Ask anything about your document — clause meanings, risks, what to negotiate, etc.</div>
              </div>
            ` : ''}
            ${state.chatHistory.map(m => `
              <div class="chat-bubble ${m.role}">
                <div class="chat-bubble-content">${m.role === 'ai' ? formatChatResponse(m.text) : escapeHtml(m.text)}</div>
              </div>
            `).join('')}
            ${state.chatLoading ? `
              <div class="chat-bubble ai">
                <div class="chat-bubble-content"><span class="chat-typing"><span></span><span></span><span></span></span></div>
              </div>
            ` : ''}
          </div>
          <div class="chat-panel-input">
            <input class="chat-panel-field" id="chatPanelInput" placeholder="${hasAnalysis ? 'Ask a question...' : 'Upload a document first'}" ${!hasAnalysis ? 'disabled' : ''} />
            <button class="chat-panel-send" id="chatPanelSend" ${!hasAnalysis ? 'disabled' : ''}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>
            </button>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function formatChatResponse(text) {
  // Simple formatting for AI responses
  try {
    // If it's JSON, extract the content
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return escapeHtml(parsed);
    if (parsed.response) return escapeHtml(parsed.response);
    if (parsed.answer) return escapeHtml(parsed.answer);
    if (parsed.message) return escapeHtml(parsed.message);
    return escapeHtml(JSON.stringify(parsed));
  } catch {
    return escapeHtml(text);
  }
}

// ===== EVENTS =====
function bindEvents() {
  // Dropzone
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  if (dropzone) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', e => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    });
    fileInput.addEventListener('change', e => {
      if (e.target.files[0]) handleFile(e.target.files[0]);
    });
  }

  // Analyze button (for pasted text)
  const btnAnalyze = document.getElementById('btnAnalyze');
  if (btnAnalyze) {
    btnAnalyze.addEventListener('click', () => {
      const text = document.getElementById('pasteArea').value.trim();
      if (text) {
        state.rawText = text;
        state.fileName = 'Pasted Text';
        startAnalysis(text);
      }
    });
  }

  // Language selector
  const langSelect = document.getElementById('langSelect');
  if (langSelect) {
    langSelect.addEventListener('change', async (e) => {
      const newLang = e.target.value;
      tts.stop();
      if (newLang === 'en') {
        // Switch back to English original
        state.currentLang = 'en';
        if (state.analysisOriginal) state.analysis = state.analysisOriginal;
        render();
        return;
      }
      state.currentLang = newLang;
      state.translating = true;
      render();
      try {
        const langConfig = LANGUAGES.find(l => l.code === newLang);
        const translated = await translateAnalysis(state.analysisOriginal || state.analysis, langConfig.name);
        // Preserve original scores
        translated.safetyScore = (state.analysisOriginal || state.analysis).safetyScore;
        translated.clauses.forEach((c, i) => {
          const orig = (state.analysisOriginal || state.analysis).clauses[i];
          if (orig) c.risk = orig.risk;
        });
        state.analysis = translated;
      } catch (err) {
        alert('Translation error: ' + err.message);
      }
      state.translating = false;
      render();
    });
  }

  // New document
  const btnNew = document.getElementById('btnNew');
  if (btnNew) {
    btnNew.addEventListener('click', () => {
      tts.stop();
      state = { screen: 'upload', analysis: null, analysisOriginal: null, rawText: '', fileName: '', activeClause: null, chatHistory: [], chatOpen: false, chatLoading: false, currentLang: 'en', translating: false };
      render();
    });
  }

  // Clause card clicks
  document.querySelectorAll('.clause-card').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset.clause);
      state.activeClause = state.activeClause === idx ? null : idx;
      render();
      // Scroll to highlighted text
      if (state.activeClause !== null) {
        const hl = document.querySelector(`.clause-highlight[data-clause="${idx}"]`);
        if (hl) hl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });

  // Clause highlight clicks
  document.querySelectorAll('.clause-highlight').forEach(span => {
    span.addEventListener('click', () => {
      const idx = parseInt(span.dataset.clause);
      state.activeClause = state.activeClause === idx ? null : idx;
      render();
      if (state.activeClause !== null) {
        const card = document.querySelector(`.clause-card[data-clause="${idx}"]`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });

  // TTS buttons
  document.querySelectorAll('.tts-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.ttsId;
      const text = btn.dataset.ttsText;
      if (id && text) tts.speak(text, id);
    });
  });

  // Read All button
  const btnReadAll = document.getElementById('btnReadAll');
  if (btnReadAll) {
    btnReadAll.addEventListener('click', () => {
      if (!state.analysis) return;
      const a = state.analysis;
      let fullText = `Document: ${a.documentTitle}. Type: ${a.documentType}. Safety Score: ${a.safetyScore} out of 100. `;
      a.clauses.forEach(c => {
        fullText += `Clause: ${c.title}. ${c.explanation}. What this means for you: ${c.userImpact}. `;
        if (c.warning) fullText += `Warning: ${c.warning}. `;
      });
      if (a.missingProtections && a.missingProtections.length > 0) {
        fullText += 'Missing Protections: ' + a.missingProtections.join('. ') + '. ';
      }
      fullText += 'Summary: ' + a.summary;
      tts.speak(fullText, 'read-all');
    });
  }

  // Stop All button
  const btnStopAll = document.getElementById('btnStopAll');
  if (btnStopAll) {
    btnStopAll.addEventListener('click', () => tts.stop());
  }

  // Chat FAB
  const chatFabBtn = document.getElementById('chatFabBtn');
  if (chatFabBtn) {
    chatFabBtn.addEventListener('click', () => {
      state.chatOpen = !state.chatOpen;
      render();
      if (state.chatOpen) {
        const input = document.getElementById('chatPanelInput');
        if (input && !input.disabled) input.focus();
        // Scroll to bottom
        const msgs = document.getElementById('chatPanelMessages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
      }
    });
  }

  // Chat panel send
  const chatPanelSend = document.getElementById('chatPanelSend');
  const chatPanelInput = document.getElementById('chatPanelInput');
  if (chatPanelSend && chatPanelInput) {
    const sendChat = async () => {
      const q = chatPanelInput.value.trim();
      if (!q || !state.analysis || state.chatLoading) return;
      state.chatHistory.push({ role: 'user', text: q });
      state.chatLoading = true;
      render();
      // Scroll to bottom
      const msgs = document.getElementById('chatPanelMessages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      try {
        const reply = await chatFollowUp(state.analysis, state.chatHistory, q);
        state.chatHistory.push({ role: 'ai', text: reply });
      } catch (err) {
        state.chatHistory.push({ role: 'ai', text: '❌ Error: ' + err.message });
      }
      state.chatLoading = false;
      render();
      const msgs2 = document.getElementById('chatPanelMessages');
      if (msgs2) msgs2.scrollTop = msgs2.scrollHeight;
      const newInput = document.getElementById('chatPanelInput');
      if (newInput) newInput.focus();
    };
    chatPanelSend.addEventListener('click', sendChat);
    chatPanelInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  }

  // Resize handle
  const handle = document.getElementById('resizeHandle');
  if (handle) {
    let dragging = false;
    handle.addEventListener('mousedown', e => {
      dragging = true;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const splitPane = document.querySelector('.split-pane');
      const rect = splitPane.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      const left = document.getElementById('paneLeft');
      const right = document.getElementById('paneRight');
      if (pct > 20 && pct < 80) {
        left.style.flex = `0 0 ${pct}%`;
        right.style.flex = `0 0 ${100 - pct}%`;
      }
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }
}

// ===== FILE HANDLING =====
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function isImageFile(file) {
  return file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp)$/i.test(file.name);
}

async function handleFile(file) {
  state.fileName = file.name;
  try {
    if (isImageFile(file)) {
      // Image upload — send directly to Groq vision
      const base64 = await fileToBase64(file);
      state.rawText = '[Image document: ' + file.name + ']';
      state.screen = 'loading';
      state.chatHistory = [];
      state.activeClause = null;
      render();
      try {
        state.analysis = await analyzeImage(base64);
        state.analysisOriginal = JSON.parse(JSON.stringify(state.analysis));
        state.screen = 'analysis';
      } catch (err) {
        alert('Analysis error: ' + err.message);
        state.screen = 'upload';
      }
      render();
      return;
    } else if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
      state.rawText = await extractTextFromPDF(file);
    } else {
      state.rawText = await file.text();
    }
    startAnalysis(state.rawText);
  } catch (err) {
    alert('Error reading file: ' + err.message);
  }
}

async function startAnalysis(text) {
  state.screen = 'loading';
  state.chatHistory = [];
  state.activeClause = null;
  state.currentLang = 'en';
  render();

  try {
    state.analysis = await analyzeDocument(text);
    state.analysisOriginal = JSON.parse(JSON.stringify(state.analysis)); // deep copy
    state.screen = 'analysis';
  } catch (err) {
    alert('Analysis error: ' + err.message);
    state.screen = 'upload';
  }
  render();
}

// ===== UTILS =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== INIT =====
render();
