import './style.css';
import { analyzeDocument, analyzeImage, chatFollowUp } from './gemini.js';
import { extractTextFromPDF } from './pdf.js';

// ===== STATE =====
let state = {
  screen: 'upload', // upload | loading | analysis
  analysis: null,
  rawText: '',
  fileName: '',
  activeClause: null,
  chatHistory: [],
};

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

  return `
    <div class="analysis-view">
      <div class="analysis-topbar">
        <div class="doc-name">📄 ${a.documentTitle || state.fileName || 'Document'} <span style="color:var(--text-muted);font-weight:400;font-size:12px">• ${a.documentType || 'Legal Document'}</span></div>
        <button class="btn-new" id="btnNew">← New Document</button>
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
              <h3>🚨 Missing Protections</h3>
              ${a.missingProtections.map(m => `<div class="missing-item">• ${m}</div>`).join('')}
            </div>
          ` : ''}

          <div class="summary-section">
            <h3>📋 Final Summary</h3>
            <div class="summary-text">${a.summary}</div>
          </div>

          <div class="chat-messages" id="chatMessages">
            ${state.chatHistory.map(m => `<div class="chat-msg ${m.role}">${m.text}</div>`).join('')}
          </div>
        </div>
      </div>

      <div class="chat-bar">
        <input class="chat-input" id="chatInput" placeholder="Ask a follow-up question about this document..." />
        <button class="btn-chat" id="btnChat">Ask</button>
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
  return `
    <div class="clause-card ${clause.risk} ${state.activeClause === index ? 'active' : ''}" data-clause="${index}">
      <div class="clause-top">
        <div class="clause-title">${clause.title}</div>
        <div class="clause-badge ${clause.risk}">${clause.risk === 'safe' ? '✅ Safe' : clause.risk === 'caution' ? '⚠️ Caution' : '🚨 Risky'}</div>
      </div>
      <div class="clause-explain">${clause.explanation}</div>
      <div class="clause-impact"><strong>What this means for you: </strong>${clause.userImpact}</div>
      ${clause.warning ? `<div class="clause-warning ${clause.risk}">${clause.warning}</div>` : ''}
    </div>
  `;
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

  // New document
  const btnNew = document.getElementById('btnNew');
  if (btnNew) {
    btnNew.addEventListener('click', () => {
      state = { screen: 'upload', analysis: null, rawText: '', fileName: '', activeClause: null, chatHistory: [] };
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

  // Chat
  const btnChat = document.getElementById('btnChat');
  const chatInput = document.getElementById('chatInput');
  if (btnChat && chatInput) {
    const sendChat = async () => {
      const q = chatInput.value.trim();
      if (!q || !state.analysis) return;
      state.chatHistory.push({ role: 'user', text: q });
      render();
      try {
        const reply = await chatFollowUp(state.analysis, state.chatHistory, q);
        state.chatHistory.push({ role: 'ai', text: reply });
      } catch (err) {
        state.chatHistory.push({ role: 'ai', text: '❌ Error: ' + err.message });
      }
      render();
      const msgs = document.getElementById('chatMessages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    };
    btnChat.addEventListener('click', sendChat);
    chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
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
      // Image upload — send directly to Gemini vision
      const base64 = await fileToBase64(file);
      state.rawText = '[Image document: ' + file.name + ']';
      state.screen = 'loading';
      state.chatHistory = [];
      state.activeClause = null;
      render();
      try {
        state.analysis = await analyzeImage(base64);
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
  render();

  try {
    state.analysis = await analyzeDocument(text);
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

// ===== INIT =====
render();
