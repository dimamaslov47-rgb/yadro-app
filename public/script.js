(function () {
  'use strict';

  // ===================== THEME =====================
  // Тема хранится на backend (привязана к аккаунту), а не в браузерном хранилище —
  // это переживает перезапуск браузера и работает в песочнице предпросмотра.
  const root = document.documentElement;
  const toggle = document.querySelector('[data-theme-toggle]');
  let theme = (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'); // временное значение до ответа /api/auth/me
  root.setAttribute('data-theme', theme);
  const sunIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  const moonIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  function paintToggle() { if (toggle) toggle.innerHTML = theme === 'dark' ? sunIcon : moonIcon; }
  function applyTheme(next) {
    theme = next;
    root.setAttribute('data-theme', theme);
    paintToggle();
  }
  applyTheme(theme);
  if (toggle) {
    toggle.addEventListener('click', () => {
      applyTheme(theme === 'dark' ? 'light' : 'dark');
      fetch(API_BASE + '/api/auth/theme', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme }),
      }).catch(() => {});
    });
  }

  // ===================== API HELPERS =====================
  // Адрес backend: локально пусто, в превью-бандле deploy_website заменяет на прокси-путь
  const API_BASE = '__PORT_4141__'.startsWith('__') ? '' : '__PORT_4141__';
  async function api(path, opts = {}) {
    const res = await fetch(API_BASE + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (res.status === 401) {
      window.location.href = 'login.html';
      throw new Error('not_authenticated');
    }
    let json = {};
    try { json = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) throw new Error(json.message || json.error || `Ошибка запроса (${res.status})`);
    return json;
  }

  // ===================== TOASTS =====================
  let toastStack = document.querySelector('.toast-stack');
  if (!toastStack) {
    toastStack = document.createElement('div');
    toastStack.className = 'toast-stack';
    document.body.appendChild(toastStack);
  }
  function toast(message, kind = 'ok') {
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'err' ? ' err' : '');
    el.textContent = message;
    toastStack.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // ===================== STATE =====================
  const state = {
    user: null,
    connections: [],
    modeAssignments: { orchestrator: null, fast: null, code: null, complex: null, image: null, computer: null },
    threads: [],
    currentThreadId: null,
    mode: 'orchestrator',
    computerEnabled: false,
    sending: false,
    pendingAttachments: [],
    pendingMode: null,
    runnableLangs: [], // языки, для которых сервер подтвердил поддержку исполнителя кода (кнопка "Запустить")
  };

  const MODE_LABELS = {
    orchestrator: 'Оркестратор',
    fast: 'Быстрый',
    code: 'Код',
    complex: 'Сложный',
    image: 'Изображение',
    computer: 'Компьютер',
  };

  const MAX_ATTACHMENTS_CLIENT = 5; // дублирует серверный MAX_ATTACHMENTS для быстрой проверки на клиенте до отправки.

  // ===================== DOM refs =====================
  const emptyState = document.getElementById('emptyState');
  const chatView = document.getElementById('chatView');
  const chatInner = document.getElementById('chatInner');
  const threadList = document.getElementById('threadList');
  const threadEmpty = document.getElementById('threadEmpty');
  const userNameEl = document.getElementById('userName');
  const userAvatarEl = document.getElementById('userAvatar');
  const newThreadBtn = document.getElementById('newThreadBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  const composerInput = document.getElementById('composerInput');
  const followupInput = document.getElementById('followupInput');
  const sendBtn = document.getElementById('sendBtn');
  const followupSendBtn = document.getElementById('followupSendBtn');

  const modeBtn = document.getElementById('modeBtn');
  const modeMenu = document.getElementById('modeMenu');
  const modeBtnFollowup = document.getElementById('modeBtnFollowup');
  const computerBtn = document.getElementById('computerBtn');
  const computerBtnFollowup = document.getElementById('computerBtnFollowup');
  const navComputerBtn = document.getElementById('navComputerBtn');
  const attachBtn = document.getElementById('attachBtn');
  const attachBtnFollowup = document.getElementById('attachBtnFollowup');
  const attachInput = document.getElementById('attachInput');
  const attachInputFollowup = document.getElementById('attachInputFollowup');
  const attachmentChips = document.getElementById('attachmentChips');
  const attachmentChipsFollowup = document.getElementById('attachmentChipsFollowup');

  // ===================== INIT =====================
  async function init() {
    try {
      const me = await api('/api/auth/me');
      state.user = me.user;
    } catch (e) {
      return; // redirected already
    }
    if (state.user.theme) applyTheme(state.user.theme);
    userNameEl.textContent = state.user.username;
    userAvatarEl.textContent = state.user.username.slice(0, 1).toUpperCase();

    await Promise.all([loadConnections(), loadModeAssignments(), loadThreads(), loadRunnableLangs()]);
    updateModeMenuDescriptions();
    renderThreadList();
    showEmptyState();

    bindEvents();
    initSettingsUI();
  }

  // Список языков, для которых реально доступен исполнитель (Piston/мок) — если запрос не удался
  // или вернул пустой список, кнопка "Запустить" просто не будет показана на блоках кода.
  async function loadRunnableLangs() {
    try {
      const { languages } = await api('/api/code/languages');
      state.runnableLangs = languages || [];
    } catch (e) {
      state.runnableLangs = [];
    }
  }

  // ===================== THREADS =====================
  async function loadThreads() {
    const { threads } = await api('/api/threads');
    state.threads = threads;
  }

  function renderThreadList() {
    threadList.innerHTML = '';
    if (!state.threads.length) {
      threadList.appendChild(threadEmpty);
      return;
    }
    state.threads.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'thread-item-row' + (t.id === state.currentThreadId ? ' active' : '');
      const btn = document.createElement('button');
      btn.className = 'thread-item';
      btn.type = 'button';
      btn.textContent = t.title || 'Без названия';
      btn.addEventListener('click', () => openThread(t.id));
      const del = document.createElement('button');
      del.className = 'thread-delete-btn';
      del.type = 'button';
      del.setAttribute('aria-label', 'Удалить диалог');
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Удалить диалог?')) return;
        await api(`/api/threads/${t.id}`, { method: 'DELETE' });
        state.threads = state.threads.filter((x) => x.id !== t.id);
        if (state.currentThreadId === t.id) {
          state.currentThreadId = null;
          showEmptyState();
        }
        renderThreadList();
      });
      row.appendChild(btn);
      row.appendChild(del);
      threadList.appendChild(row);
    });
  }

  async function openThread(threadId) {
    const { thread, messages } = await api(`/api/threads/${threadId}`);
    state.currentThreadId = thread.id;
    renderThreadList();
    showChatView();
    chatInner.innerHTML = '';
    messages.forEach((m) => renderStoredMessage(m));
    updateTopbarUsage(messages);
    scrollChatToBottom();
  }

  function showEmptyState() {
    emptyState.style.display = 'flex';
    chatView.classList.remove('active');
    composerInput.value = '';
    composerInput.focus();
    updateTopbarUsage([]);
  }

  function showChatView() {
    emptyState.style.display = 'none';
    chatView.classList.add('active');
  }

  function scrollChatToBottom() {
    requestAnimationFrame(() => { chatView.scrollTop = chatView.scrollHeight; });
  }

  // ===================== RENDER STORED (non-streaming) MESSAGES =====================
  function renderStoredMessage(m) {
    if (m.role === 'user') {
      const block = renderUserBlock(m.content, m.mode, m.attachments);
      chatInner.appendChild(block);
    } else {
      const block = renderAssistantBlock({
        text: m.content,
        mode: m.mode,
        effectiveMode: m.effectiveMode,
        connectionName: m.connectionName,
        model: m.model,
        citations: m.citations,
        usage: m.usage,
        images: m.images,
        revisedPrompt: m.revisedPrompt,
        taskFiles: m.taskFiles,
        taskFilesUrl: m.taskFilesUrl,
        streaming: false,
      });
      chatInner.appendChild(block);
    }
  }

  // Подсчёт честного суммарного расхода токенов по треду: только из сообщений, где usage реально пришёл от провайдера.
  // Если ни у одного сообщения нет usage — блок просто скрывается, никаких выдуманных чисел.
  function usageTotal(u) {
    if (!u) return null;
    if (typeof u.total_tokens === 'number') return u.total_tokens;
    const p = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
    const c = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
    return p + c > 0 ? p + c : null;
  }

  function updateTopbarUsage(messages) {
    const topbarUsage = document.getElementById('topbarUsage');
    if (!topbarUsage) return;
    let sum = 0;
    let any = false;
    (messages || []).forEach((m) => {
      const t = usageTotal(m.usage);
      if (t !== null) { sum += t; any = true; }
    });
    if (!any) {
      topbarUsage.hidden = true;
      topbarUsage.textContent = '';
      return;
    }
    topbarUsage.hidden = false;
    topbarUsage.textContent = `≈ ${sum.toLocaleString('ru-RU')} токенов суммарно`;
  }

  function renderUserBlock(content, mode, attachments) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-block user q-block';
    const h2 = document.createElement('h2');
    h2.textContent = content;
    wrap.appendChild(h2);
    if (attachments && attachments.length) {
      const list = document.createElement('div');
      list.className = 'attachment-chips attachment-chips-static';
      attachments.forEach((a) => {
        const chip = document.createElement('span');
        chip.className = 'attachment-chip';
        chip.innerHTML = `${a.type === 'image' ? '🖼️' : '📄'} ${escapeHtml(a.name || '')}`;
        list.appendChild(chip);
      });
      wrap.appendChild(list);
    }
    return wrap;
  }

  function routeBadgeHTML({ mode, effectiveMode, connectionName, model, pending }) {
    const modeLabel = MODE_LABELS[effectiveMode || mode] || mode;
    if (pending) {
      return `<div class="route-badge pending"><span class="spin"></span> Оркестратор определяет маршрут…</div>`;
    }
    if (mode === 'orchestrator' && effectiveMode) {
      return `<div class="route-badge"><span class="dot"></span> Оркестратор выбрал: <strong>${escapeHtml(modeLabel)}${model ? ' · ' + escapeHtml(model) : ''}</strong></div>`;
    }
    return `<div class="route-badge"><span class="dot"></span> Режим: <strong>${escapeHtml(modeLabel)}${model ? ' · ' + escapeHtml(model) : ''}</strong></div>`;
  }

  function escapeHtml(s) {
    if (s === undefined || s === null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ===================== MARKDOWN + СКАЧИВАНИЕ ФАЙЛОВ/КОДА =====================
  if (typeof marked !== 'undefined') {
    marked.setOptions({ breaks: true, gfm: true });
  }

  // Расширения файлов по языку блока кода — для кнопки "Скачать".
  const LANG_EXT = {
    javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', jsx: 'jsx', tsx: 'tsx',
    python: 'py', py: 'py', powershell: 'ps1', ps1: 'ps1', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh',
    json: 'json', yaml: 'yaml', yml: 'yml', html: 'html', css: 'css', csharp: 'cs', 'c#': 'cs', cpp: 'cpp', 'c++': 'cpp',
    c: 'c', java: 'java', go: 'go', rust: 'rs', sql: 'sql', xml: 'xml', markdown: 'md', md: 'md', dockerfile: 'dockerfile',
  };

  function downloadTextAsFile(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Превращает markdown-текст ответа ИИ в безопасный HTML (санитизация через DOMPurify).
  function renderMarkdownHtml(text) {
    if (typeof marked === 'undefined') return escapeHtml(text).replace(/\n/g, '<br>');
    const raw = marked.parse(text || '');
    if (typeof DOMPurify !== 'undefined') return DOMPurify.sanitize(raw);
    return raw;
  }

  // Добавляет тулбар "Копировать/Скачать" к каждому блоку кода внутри контейнера.
  function enhanceCodeBlocks(container) {
    container.querySelectorAll('pre > code').forEach((codeEl) => {
      const pre = codeEl.parentElement;
      if (pre.dataset.enhanced) return;
      pre.dataset.enhanced = '1';
      const langMatch = (codeEl.className || '').match(/language-([\w+#-]+)/);
      const lang = langMatch ? langMatch[1].toLowerCase() : '';
      const ext = LANG_EXT[lang] || (lang || 'txt');

      const runnable = lang && state.runnableLangs.includes(lang);

      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrap';
      const toolbar = document.createElement('div');
      toolbar.className = 'code-block-toolbar';
      toolbar.innerHTML = `
        <span class="code-lang">${escapeHtml(lang || 'код')}</span>
        <span class="code-block-actions">
          ${runnable ? '<button type="button" class="code-action-btn run-btn" data-action="run">▶ Запустить</button>' : ''}
          <button type="button" class="code-action-btn" data-action="copy">Копировать</button>
          <button type="button" class="code-action-btn" data-action="download">Скачать</button>
        </span>
      `;
      pre.parentElement.insertBefore(wrapper, pre);
      wrapper.appendChild(toolbar);
      wrapper.appendChild(pre);

      toolbar.querySelector('[data-action="copy"]').addEventListener('click', (e) => {
        navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
          const btn = e.currentTarget;
          const old = btn.textContent;
          btn.textContent = 'Скопировано';
          setTimeout(() => { btn.textContent = old; }, 1400);
        });
      });
      toolbar.querySelector('[data-action="download"]').addEventListener('click', () => {
        downloadTextAsFile(codeEl.textContent || '', `code.${ext}`);
      });

      const runBtn = toolbar.querySelector('[data-action="run"]');
      if (runBtn) {
        runBtn.addEventListener('click', () => runCodeBlock(lang, codeEl.textContent || '', wrapper, runBtn));
      }
    });
  }

  // Вызывает выполнение кода на сервере (Piston/мок) и показывает результат под блоком кода.
  async function runCodeBlock(lang, code, wrapper, runBtn) {
    let resultEl = wrapper.querySelector('.code-run-result');
    if (!resultEl) {
      resultEl = document.createElement('div');
      resultEl.className = 'code-run-result';
      wrapper.appendChild(resultEl);
    }
    runBtn.disabled = true;
    resultEl.className = 'code-run-result';
    resultEl.innerHTML = `<div class="run-status"><span class="spin"></span> Выполняется…</div>`;

    try {
      const result = await api('/api/code/run', { method: 'POST', body: JSON.stringify({ language: lang, code }) });
      const ok = result.exitCode === 0;
      resultEl.className = 'code-run-result ' + (ok ? 'ok' : 'err');
      let html = `<div class="run-status">${ok ? '✓ Выполнено' : '✗ Завершилось с ошибкой'}</div>`;
      if (result.stdout) html += `<pre>${escapeHtml(result.stdout)}</pre>`;
      if (result.stderr) html += `<pre class="run-stderr">${escapeHtml(result.stderr)}</pre>`;
      if (!result.stdout && !result.stderr) html += `<pre>(пустой вывод)</pre>`;
      html += `<div class="run-meta">Код выхода: ${result.exitCode ?? '—'} · ${result.durationMs} мс${result.truncated ? ' · вывод обрезан' : ''}</div>`;
      resultEl.innerHTML = html;
    } catch (e) {
      resultEl.className = 'code-run-result err';
      resultEl.innerHTML = `<div class="run-status">✗ Ошибка</div><pre class="run-stderr">${escapeHtml(e.message)}</pre>`;
    } finally {
      runBtn.disabled = false;
    }
  }

  // Рендерит текст ответа как markdown внутри переданного контейнера + подключает кнопки к коду.
  function renderAnswerInto(el, text) {
    el.innerHTML = renderMarkdownHtml(text);
    enhanceCodeBlocks(el);
  }

  // Скачивает документ, сгенерированный на сервере (.docx / .pdf), через fetch + Blob.
  async function downloadServerFile(kind, text, title) {
    const res = await fetch(`/api/export/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, title }),
    });
    if (!res.ok) throw new Error('export_failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title || 'yadro-answer'}.${kind}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Кнопка "Скачать ответ" с выпадающим меню форматов: .md / .docx / .pdf.
  function createDownloadMessageButton(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-download-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-download-btn';
    btn.title = 'Скачать ответ как файл';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 19h16"/></svg>';

    const menu = document.createElement('div');
    menu.className = 'msg-download-menu';
    menu.hidden = true;
    menu.innerHTML = `
      <button type="button" data-fmt="md">Markdown (.md)</button>
      <button type="button" data-fmt="docx">Word (.docx)</button>
      <button type="button" data-fmt="pdf">PDF (.pdf)</button>
    `;

    function closeMenu() { menu.hidden = true; document.removeEventListener('click', onOutside); }
    function onOutside(e) { if (!wrap.contains(e.target)) closeMenu(); }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      if (!menu.hidden) document.addEventListener('click', onOutside);
    });

    menu.addEventListener('click', async (e) => {
      const fmtBtn = e.target.closest('[data-fmt]');
      if (!fmtBtn) return;
      const fmt = fmtBtn.dataset.fmt;
      closeMenu();
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const title = `yadro-answer-${ts}`;
      if (fmt === 'md') {
        downloadTextAsFile(text || '', `${title}.md`);
        return;
      }
      const old = fmtBtn.textContent;
      fmtBtn.textContent = 'Готовим файл…';
      try {
        await downloadServerFile(fmt, text || '', title);
      } catch (err) {
        fmtBtn.textContent = 'Ошибка, повторите';
        setTimeout(() => { fmtBtn.textContent = old; }, 1600);
        return;
      }
      fmtBtn.textContent = old;
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    return wrap;
  }

  // Скачивает base64-строку как бинарный файл (изображение) через Blob.
  function downloadBase64AsFile(b64, filename, mime) {
    const byteChars = atob(b64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const blob = new Blob([new Uint8Array(byteNumbers)], { type: mime || 'image/png' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Стоимость генерации изображения в рублях — только если реально пришла от провайдера (никаких выдуванных чисел).
  function imageCostLabel(usage) {
    if (!usage) return null;
    const cost = typeof usage.cost_rub === 'number' ? usage.cost_rub : (typeof usage.cost === 'number' ? usage.cost : null);
    if (cost === null) return null;
    return `≈ ${cost.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
  }

  function renderAssistantBlock({ text, mode, effectiveMode, connectionName, model, citations, usage, images, revisedPrompt, streaming, taskFiles, taskFilesUrl }) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-block assistant';

    const routeWrap = document.createElement('div');
    routeWrap.innerHTML = routeBadgeHTML({ mode, effectiveMode, connectionName, model });
    wrap.appendChild(routeWrap.firstChild);

    const hasImages = Array.isArray(images) && images.length > 0;

    if (hasImages) {
      const block = document.createElement('div');
      block.className = 'assistant-image-block';
      images.forEach((img, idx) => {
        const el = document.createElement('img');
        el.alt = revisedPrompt || text || 'Сгенерированное изображение';
        if (img.b64Json) {
          el.src = `data:image/png;base64,${img.b64Json}`;
          block.appendChild(el);
          const dlBtn = document.createElement('button');
          dlBtn.type = 'button';
          dlBtn.className = 'assistant-image-download';
          dlBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 19h16"/></svg>Скачать изображение';
          dlBtn.addEventListener('click', () => {
            const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            downloadBase64AsFile(img.b64Json, `yadro-image-${ts}${images.length > 1 ? '-' + (idx + 1) : ''}.png`, 'image/png');
          });
          block.appendChild(dlBtn);
        } else if (img.url) {
          el.src = img.url;
          block.appendChild(el);
        }
      });
      if (revisedPrompt && revisedPrompt !== text) {
        const cap = document.createElement('div');
        cap.className = 'assistant-image-caption';
        cap.textContent = revisedPrompt;
        block.appendChild(cap);
      }
      wrap.appendChild(block);

      if (!streaming) {
        const cost = imageCostLabel(usage);
        const meta = document.createElement('div');
        meta.className = 'assistant-meta';
        meta.innerHTML = `<span class="meta-model">${escapeHtml(connectionName || '')}${model ? ' · ' + escapeHtml(model) : ''}</span>${cost ? `<span class="meta-cost">${cost}</span>` : ''}`;
        wrap.appendChild(meta);
      }
      return wrap;
    }

    const hasCitations = Array.isArray(citations) && citations.length > 0;

    if (hasCitations) {
      const tabRow = document.createElement('div');
      tabRow.className = 'tab-row';
      tabRow.innerHTML = `
        <button class="active" type="button" data-tab-target="answer">Ответ</button>
        <button type="button" data-tab-target="sources">Источники · ${citations.length}</button>
      `;
      wrap.appendChild(tabRow);

      const answerPanel = document.createElement('div');
      answerPanel.className = 'tab-panel active';
      answerPanel.dataset.panel = 'answer';
      const answerText = document.createElement('div');
      answerText.className = 'answer-text' + (streaming ? ' streaming' : '');
      renderAnswerInto(answerText, text || '');
      answerPanel.appendChild(answerText);
      wrap.appendChild(answerPanel);

      const sourcesPanel = document.createElement('div');
      sourcesPanel.className = 'tab-panel';
      sourcesPanel.dataset.panel = 'sources';
      const sourcesRow = document.createElement('div');
      sourcesRow.className = 'sources-row';
      citations.forEach((c, i) => {
        const url = typeof c === 'string' ? c : (c.url || c.link || '');
        const title = typeof c === 'string' ? c : (c.title || c.name || url);
        let domain = '';
        try { domain = new URL(url).hostname; } catch (e) { domain = url; }
        const card = document.createElement('a');
        card.className = 'source-card';
        card.href = url || '#';
        card.target = '_blank';
        card.rel = 'noopener noreferrer';
        card.innerHTML = `<span class="num">${i + 1}</span><span class="title">${escapeHtml(title)}</span><span class="domain">${escapeHtml(domain)}</span>`;
        sourcesRow.appendChild(card);
      });
      sourcesPanel.appendChild(sourcesRow);
      wrap.appendChild(sourcesPanel);

      tabRow.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          tabRow.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          const target = btn.dataset.tabTarget;
          wrap.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === target));
        });
      });
    } else {
      const answerText = document.createElement('div');
      answerText.className = 'answer-text' + (streaming ? ' streaming' : '');
      renderAnswerInto(answerText, text || '');
      wrap.appendChild(answerText);
    }

    if (Array.isArray(taskFiles) && taskFiles.length && taskFilesUrl) {
      wrap.appendChild(createTaskFilesCard(taskFiles, taskFilesUrl));
    }

    const usageTokens = usageTotal(usage);
    if (!streaming) {
      const meta = document.createElement('div');
      meta.className = 'assistant-meta';
      meta.innerHTML = `<span class="meta-model">${escapeHtml(connectionName || '')}${model ? ' · ' + escapeHtml(model) : ''}</span>${usageTokens !== null ? `<span class="meta-usage">≈ ${usageTokens.toLocaleString('ru-RU')} токенов</span>` : ''}`;
      meta.appendChild(createDownloadMessageButton(text || ''));
      wrap.appendChild(meta);
    }

    return wrap;
  }

  // Карточка скачивания итогового архива режима «Компьютер» — простая ссылка на /api/threads/:id/files.zip,
  // браузер сам скачает через Content-Disposition с сервера (куки сессии уже приложены браузером).
  function createTaskFilesCard(files, url) {
    const card = document.createElement('a');
    card.className = 'task-files-card';
    card.href = url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.innerHTML = `<span class="task-files-icon">📦</span><span class="task-files-text">Скачать итоговый файл (${files.length} файл${files.length === 1 ? '' : files.length < 5 ? 'а' : 'ов'})</span>`;
    return card;
  }

  // ===================== MODE / COMPUTER TOGGLE UI =====================
  function setMode(mode) {
    state.mode = mode;
    const label = MODE_LABELS[mode];
    [modeBtn, modeBtnFollowup].forEach((btn) => {
      const labelEl = btn.querySelector('.mode-label');
      if (labelEl) labelEl.textContent = label;
    });
    // Веб-поиск бессмыслен для генерации изображений — скрываем переключатель, чтобы не вводить в заблуждение.
    const hideSearch = mode === 'image';
    [computerBtn, computerBtnFollowup].forEach((btn) => { btn.style.display = hideSearch ? 'none' : ''; });
  }

  function updateModeMenuDescriptions() {
    const map = { fast: '.desc-fast', code: '.desc-code', complex: '.desc-complex', image: '.desc-image', computer: '.desc-computer' };
    Object.entries(map).forEach(([mode, sel]) => {
      const el = modeMenu.querySelector(sel);
      const assignment = state.modeAssignments[mode];
      if (el) {
        el.textContent = assignment ? `${assignment.model}` : 'Не настроено';
      }
    });
  }

  // Единственный #modeMenu в разметке используется обоими композерами (домашним и
  // followup). Поскольку эти композеры находятся в разных контейнерах и один из них
  // скрывается при переключении вида, меню при открытии переносится в <body> и
  // позиционируется fixed-координатами от кнопки, которая его вызвала.
  document.body.appendChild(modeMenu);
  modeMenu.style.position = 'fixed';

  function openModeMenu(anchorBtn) {
    const rect = anchorBtn.getBoundingClientRect();
    modeMenu.style.left = `${Math.round(rect.left)}px`;
    modeMenu.style.bottom = `${Math.round(window.innerHeight - rect.top + 8)}px`;
    modeMenu.style.top = 'auto';
    modeMenu.classList.add('open');
  }

  modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = modeMenu.classList.contains('open');
    modeMenu.classList.remove('open');
    if (!wasOpen) openModeMenu(modeBtn);
  });
  document.querySelectorAll('#modeMenu .dropdown-item').forEach((item) => {
    item.addEventListener('click', () => {
      setMode(item.dataset.mode);
      modeMenu.classList.remove('open');
    });
  });
  document.addEventListener('click', () => modeMenu.classList.remove('open'));
  window.addEventListener('resize', () => modeMenu.classList.remove('open'));

  modeBtnFollowup.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = modeMenu.classList.contains('open');
    modeMenu.classList.remove('open');
    if (!wasOpen) openModeMenu(modeBtnFollowup);
  });

  function toggleComputer() {
    state.computerEnabled = !state.computerEnabled;
    [computerBtn, computerBtnFollowup].forEach((btn) => btn.classList.toggle('computer-on', state.computerEnabled));
  }
  computerBtn.addEventListener('click', toggleComputer);
  computerBtnFollowup.addEventListener('click', toggleComputer);

  // ===================== ATTACHMENTS (изображения + документы + аудио/видео) =====================
  // Согласован с белым списком server/attachments.js PLAIN_TEXT_EXT + бинарные xlsx/pptx/rtf/odt (легаси .doc/.xls не поддерживаются).
  const DOC_EXT_RE = /\.(pdf|docx|txt|md|markdown|rtf|odt|xlsx|pptx|csv|json|yml|yaml|xml|log|py|js|mjs|cjs|ts|tsx|jsx|sh|bash|ps1|c|cpp|h|hpp|java|go|rs|rb|php|sql|html|htm|css|ini|conf|toml)$/i;
  // Аудио/видео идёт не на /api/uploads/extract, а на /api/uploads/transcribe (распознавание речи) —
  // результат возвращается в той же форме { filename, text, truncated }, чтобы дальше вести себя как обычное документ-вложение.
  const MEDIA_EXT_RE = /\.(mp3|wav|mp4|m4a|webm|ogg)$/i;

  function clearPendingAttachments() {
    state.pendingAttachments = [];
    renderAttachmentChips();
  }

  function renderAttachmentChips() {
    [attachmentChips, attachmentChipsFollowup].forEach((container) => {
      container.innerHTML = '';
      container.hidden = state.pendingAttachments.length === 0;
      state.pendingAttachments.forEach((a, idx) => {
        const chip = document.createElement('span');
        chip.className = 'attachment-chip';
        chip.innerHTML = `${a.type === 'image' ? '🖼️' : '📄'} ${escapeHtml(a.name)}${a.truncated ? ' <span class="chip-warn" title="Текст документа обрезан">⚠️</span>' : ''} <button type="button" class="chip-remove" aria-label="Убрать">×</button>`;
        chip.querySelector('.chip-remove').addEventListener('click', () => {
          state.pendingAttachments.splice(idx, 1);
          renderAttachmentChips();
        });
        container.appendChild(chip);
      });
    });
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (state.pendingAttachments.length >= MAX_ATTACHMENTS_CLIENT) {
        toast(`Максимум ${MAX_ATTACHMENTS_CLIENT} вложений за раз`, 'err');
        break;
      }
      if (file.type.startsWith('audio/') || file.type.startsWith('video/') || MEDIA_EXT_RE.test(file.name)) {
        try {
          toast(`Расшифровываем «${file.name}»…`);
          const form = new FormData();
          form.append('file', file);
          form.append('mode', state.mode || 'computer');
          const res = await fetch(API_BASE + '/api/uploads/transcribe', { method: 'POST', credentials: 'same-origin', body: form });
          const body = await res.json();
          if (!res.ok) throw new Error(body.message || 'Не удалось распознать аудио/видео');
          state.pendingAttachments.push({ type: 'document', name: body.filename, text: body.text, truncated: body.truncated });
          renderAttachmentChips();
        } catch (e) {
          toast(e.message || 'Ошибка распознавания аудио/видео', 'err');
        }
      } else if (file.type.startsWith('image/')) {
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Не удалось прочитать изображение'));
            reader.readAsDataURL(file);
          });
          state.pendingAttachments.push({ type: 'image', name: file.name, dataUrl });
          renderAttachmentChips();
        } catch (e) {
          toast(e.message || 'Ошибка чтения изображения', 'err');
        }
      } else if (DOC_EXT_RE.test(file.name)) {
        try {
          const form = new FormData();
          form.append('file', file);
          const res = await fetch(API_BASE + '/api/uploads/extract', { method: 'POST', credentials: 'same-origin', body: form });
          const body = await res.json();
          if (!res.ok) throw new Error(body.message || 'Не удалось распознать файл');
          state.pendingAttachments.push({ type: 'document', name: body.filename, text: body.text, truncated: body.truncated });
          renderAttachmentChips();
        } catch (e) {
          toast(e.message || 'Ошибка загрузки документа', 'err');
        }
      } else {
        toast(`Формат файла «${file.name}» не поддерживается`, 'err');
      }
    }
  }

  attachBtn.addEventListener('click', () => attachInput.click());
  attachBtnFollowup.addEventListener('click', () => attachInputFollowup.click());
  attachInput.addEventListener('change', () => { handleFiles(attachInput.files); attachInput.value = ''; });
  attachInputFollowup.addEventListener('change', () => { handleFiles(attachInputFollowup.files); attachInputFollowup.value = ''; });

  document.querySelectorAll('.composer').forEach((composer) => {
    composer.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('dropzone-active'); });
    composer.addEventListener('dragleave', () => composer.classList.remove('dropzone-active'));
    composer.addEventListener('drop', (e) => {
      e.preventDefault();
      composer.classList.remove('dropzone-active');
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });
  });

  [composerInput, followupInput].forEach((ta) => {
    ta.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) handleFiles(files);
    });
  });

  navComputerBtn.addEventListener('click', () => {
    state.currentThreadId = null;
    state.pendingMode = 'computer';
    renderThreadList();
    showEmptyState();
    setMode('computer');
  });

  // suggestion chips
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      composerInput.value = chip.textContent;
      composerInput.focus();
      composerInput.dispatchEvent(new Event('input'));
    });
  });

  // auto-grow textareas
  [composerInput, followupInput].forEach((ta) => {
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend(ta === composerInput ? composerInput : followupInput);
      }
    });
  });

  sendBtn.addEventListener('click', () => handleSend(composerInput));
  followupSendBtn.addEventListener('click', () => handleSend(followupInput));

  newThreadBtn.addEventListener('click', () => {
    state.currentThreadId = null;
    renderThreadList();
    showEmptyState();
  });

  logoutBtn.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = 'login.html';
  });

  // ===================== SEND MESSAGE (SSE) =====================
  async function handleSend(inputEl) {
    const content = inputEl.value.trim();
    if (!content || state.sending) return;
    state.sending = true;
    inputEl.value = '';
    inputEl.style.height = 'auto';

    showChatView();

    const attachmentsToSend = state.pendingAttachments.slice(); // копия до очистки — идёт в тело POST-запроса ниже
    const userBlock = renderUserBlock(content, state.mode, attachmentsToSend.map((a) => ({ type: a.type, name: a.name })));
    chatInner.appendChild(userBlock);
    clearPendingAttachments();
    scrollChatToBottom();

    const routeWrap = document.createElement('div');
    routeWrap.innerHTML = routeBadgeHTML({ mode: state.mode, pending: state.mode === 'orchestrator' });
    let routeBadgeEl = routeWrap.firstChild;
    chatInner.appendChild(routeBadgeEl);

    const answerText = document.createElement('div');
    answerText.className = 'answer-text streaming';
    if (state.mode === 'image') {
      answerText.innerHTML = '<span class="image-gen-loading"><span class="spin"></span>Генерация изображения…</span>';
    }
    chatInner.appendChild(answerText);
    scrollChatToBottom();

    let fullText = '';
    let citationsReceived = null;
    let usageReceived = null;
    let imagesReceived = null;
    let revisedPromptReceived = null;
    let effectiveModeReceived = null;
    let modelReceived = null;
    let connectionNameReceived = null;
    let taskFilesReceived = null;
    let taskFilesUrlReceived = null;
    let toolEventEl = null; // вставляется перед answerText при первом tool_event и обновляется при последующих
    // Живая карточка прогресса мультимодельного оркестратора режима «Компьютер» (server/orchestrator.js) —
    // план подзадач с моделями, статусы выполнения и результат смысловой проверки; рисуется только при
    // наличии события 'plan' (обычные режимы его не шлют, карточка просто не появится).
    let orchestrationEl = null;
    let orchestrationState = null;

    function renderOrchestrationCard() {
      if (!orchestrationState) return;
      if (!orchestrationEl) {
        orchestrationEl = document.createElement('div');
        orchestrationEl.className = 'orchestration-card';
        chatInner.insertBefore(orchestrationEl, answerText);
      }
      const capLabel = (c) => ({ reasoning: 'рассуждение', code: 'код', vision: 'зрение', audio: 'аудио', fast: 'быстрая', general: 'общая' }[c] || c);
      const rows = orchestrationState.subtasks.map((s) => {
        const st = orchestrationState.statuses[s.id] || { phase: 'pending' };
        const icon = st.phase === 'done' ? (st.ok ? '✅' : '❌') : st.phase === 'running' ? '⏳' : '•';
        return `<div class="orchestration-row">${icon} <strong>${escapeHtml(s.title)}</strong> — ${escapeHtml(s.model)} <span class="orchestration-cap">(${capLabel(s.capability)})</span></div>`;
      }).join('');
      let assemblyRow = '';
      if (orchestrationState.assemblyModel) {
        assemblyRow = `<div class="orchestration-row">🔧 Сборка итогового результата — ${escapeHtml(orchestrationState.assemblyModel)}</div>`;
      }
      let verifyRow = '';
      if (orchestrationState.verify) {
        const v = orchestrationState.verify;
        verifyRow = v.ok
          ? `<div class="orchestration-row ok">✅ Проверка результата пройдена</div>`
          : `<div class="orchestration-row err">⚠️ Найдены замечания: ${escapeHtml(v.issues || '')}${v.repaired ? ' (выполнена повторная сборка)' : ''}</div>`;
      }
      orchestrationEl.innerHTML = `<div class="orchestration-title">🤖 План агента (${orchestrationState.subtasks.length} подзадач${orchestrationState.source === 'fallback' ? ', без разбиения' : ''})</div>${rows}${assemblyRow}${verifyRow}`;
    }

    try {
      const res = await fetch(API_BASE + '/api/chat/send', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: state.currentThreadId,
          content,
          mode: state.mode,
          computerEnabled: state.computerEnabled,
          attachments: attachmentsToSend,
        }),
      });

      if (res.status === 401) { window.location.href = 'login.html'; return; }
      if (!res.body) throw new Error('Стриминг не поддерживается браузером');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop();
        for (const evt of events) {
          const lines = evt.split('\n');
          let eventName = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            if (line.startsWith('data:')) data = line.slice(5).trim();
          }
          if (!data) continue;
          let payload;
          try { payload = JSON.parse(data); } catch (e) { continue; }

          if (eventName === 'thread') {
            if (!state.currentThreadId) {
              state.currentThreadId = payload.thread.id;
              if (!state.threads.find((t) => t.id === payload.thread.id)) {
                state.threads.unshift(payload.thread);
              }
              renderThreadList();
            }
          } else if (eventName === 'route') {
            effectiveModeReceived = payload.effectiveMode;
            modelReceived = payload.model;
            connectionNameReceived = payload.connectionName;
            {
              const freshWrap = document.createElement('div');
              freshWrap.innerHTML = routeBadgeHTML({
                mode: payload.mode,
                effectiveMode: payload.effectiveMode,
                connectionName: payload.connectionName,
                model: payload.model,
              });
              const freshBadge = freshWrap.firstChild;
              routeBadgeEl.replaceWith(freshBadge);
              routeBadgeEl = freshBadge;
            }
          } else if (eventName === 'planning_start' || eventName === 'plan') {
            // Мультимодельный оркестратор режима «Компьютер»: события приходят только от оркестратора,
            // в остальных режимах эти ветки никогда не срабатывают.
            if (eventName === 'plan') {
              orchestrationState = {
                subtasks: payload.subtasks || [],
                source: payload.source,
                statuses: {},
                assemblyModel: null,
                verify: null,
              };
              renderOrchestrationCard();
            }
          } else if (eventName === 'subtask_start') {
            if (orchestrationState) {
              orchestrationState.statuses[payload.id] = { phase: 'running' };
              renderOrchestrationCard();
            }
          } else if (eventName === 'subtask_done') {
            if (orchestrationState) {
              orchestrationState.statuses[payload.id] = { phase: 'done', ok: payload.ok };
              renderOrchestrationCard();
            }
          } else if (eventName === 'assembly_start') {
            if (orchestrationState) {
              orchestrationState.assemblyModel = payload.model;
              orchestrationState.verify = null; // повторный assembly_start при ремонте — скрываем старый вердикт до новой проверки
              renderOrchestrationCard();
            }
          } else if (eventName === 'verify') {
            if (orchestrationState) {
              orchestrationState.verify = payload;
              renderOrchestrationCard();
            }
          } else if (eventName === 'token') {
            fullText += payload.token;
            renderAnswerInto(answerText, fullText);
            scrollChatToBottom();
          } else if (eventName === 'tool_event') {
            const toolLabel = payload.name === 'run_code' ? 'Код' : payload.name === 'write_file' ? 'Файл' : payload.name;
            if (!toolEventEl) {
              toolEventEl = document.createElement('div');
              toolEventEl.className = 'tool-event-note pending';
              chatInner.insertBefore(toolEventEl, answerText);
            }
            if (payload.phase === 'call') {
              toolEventEl.className = 'tool-event-note pending';
              const lang = payload.args && payload.args.language ? ` (${payload.args.language})` : ''; // textContent ниже уже безопасен, escapeHtml тут не нужен
              toolEventEl.textContent = `🔧 Агент выполняет инструмент «${toolLabel}»${lang}…`;
            } else if (payload.phase === 'result') {
              // Разные инструменты кодируют успех по-разному: run_code отдаёт JSON с exitCode,
              // write_file отдаёт JSON с ok:true/filename, а необработанное исключение из executeToolCall
              // приходит как обычная русская строка «Ошибка выполнения инструмента: ...» (не JSON).
              // Раньше здесь проверялся только exitCode === 0, из-за чего успешный write_file
              // (без поля exitCode) всегда показывался как ошибка — исправлено ниже.
              let ok = true;
              try {
                const parsed = JSON.parse(payload.result);
                if (typeof parsed.exitCode === 'number') ok = parsed.exitCode === 0;
                else if (typeof parsed.ok === 'boolean') ok = parsed.ok;
                else ok = true;
              } catch (e) {
                ok = !/^Ошибка/i.test(String(payload.result || ''));
              }
              toolEventEl.className = `tool-event-note ${ok ? 'ok' : 'err'}`;
              toolEventEl.textContent = ok ? `✅ Инструмент «${toolLabel}» выполнен` : `❌ Инструмент «${toolLabel}» завершился с ошибкой`;
            }
            scrollChatToBottom();
          } else if (eventName === 'files_ready') {
            taskFilesReceived = payload.files || null;
            taskFilesUrlReceived = payload.downloadUrl || null;
          } else if (eventName === 'error') {
            const errBanner = document.createElement('div');
            errBanner.className = 'error-banner';
            errBanner.textContent = payload.message;
            chatInner.appendChild(errBanner);
            answerText.classList.remove('streaming');
          } else if (eventName === 'assistant_message') {
            citationsReceived = payload.message.citations || null;
            usageReceived = payload.message.usage || null;
            imagesReceived = payload.message.images || null;
            revisedPromptReceived = payload.message.revisedPrompt || null;
          } else if (eventName === 'done') {
            answerText.classList.remove('streaming');
            if (imagesReceived && imagesReceived.length) {
              // Изображение не стримилось потокенно — полностью собираем блок взамен заглушки-индикатора.
              const rebuilt = renderAssistantBlock({
                text: content,
                mode: state.mode,
                effectiveMode: effectiveModeReceived,
                connectionName: connectionNameReceived,
                model: modelReceived,
                images: imagesReceived,
                revisedPrompt: revisedPromptReceived,
                usage: usageReceived,
                streaming: false,
              });
              routeBadgeEl.replaceWith(rebuilt);
              answerText.remove();
            } else if (citationsReceived && citationsReceived.length) {
              // Пересобираем блок ответа с вкладкой источников (полностью,
              // включая route-badge) и заменяем и badge, и текст ответа одним узлом,
              // чтобы не оставлять дублирующийся route-badge от стриминговой фазы.
              const rebuilt = renderAssistantBlock({
                text: fullText,
                mode: state.mode,
                effectiveMode: effectiveModeReceived,
                connectionName: connectionNameReceived,
                model: modelReceived,
                citations: citationsReceived,
                usage: usageReceived,
                streaming: false,
              });
              routeBadgeEl.replaceWith(rebuilt);
              answerText.remove();
            } else {
              let anchor = answerText;
              if (taskFilesReceived && taskFilesReceived.length && taskFilesUrlReceived) {
                const card = createTaskFilesCard(taskFilesReceived, taskFilesUrlReceived);
                anchor.after(card);
                anchor = card;
              }
              const usageTokens = usageTotal(usageReceived);
              const meta = document.createElement('div');
              meta.className = 'assistant-meta';
              meta.innerHTML = `<span class="meta-model">${escapeHtml(connectionNameReceived || '')}${modelReceived ? ' · ' + escapeHtml(modelReceived) : ''}</span>${usageTokens !== null ? `<span class="meta-usage">≈ ${usageTokens.toLocaleString('ru-RU')} токенов</span>` : ''}`;
              meta.appendChild(createDownloadMessageButton(fullText || ''));
              anchor.after(meta);
            }
          }
        }
      }
      // Обновим заголовок треда в списке (может измениться title у нового треда)
      await loadThreads();
      renderThreadList();
      // Обновляем суммарный счётчик токенов в шапке по всей истории треда
      if (state.currentThreadId) {
        try {
          const { messages: freshMessages } = await api(`/api/threads/${state.currentThreadId}`);
          updateTopbarUsage(freshMessages);
        } catch (e) { /* не критично, просто не обновится сейчас */ }
      }
    } catch (e) {
      const errBanner = document.createElement('div');
      errBanner.className = 'error-banner';
      errBanner.textContent = e.message || 'Ошибка соединения с сервером';
      chatInner.appendChild(errBanner);
    } finally {
      state.sending = false;
      scrollChatToBottom();
    }
  }

  // ===================== SETTINGS MODAL =====================
  const settingsOverlay = document.getElementById('settingsOverlay');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsCloseBtn = document.getElementById('settingsCloseBtn');
  const settingsTabs = document.querySelectorAll('.settings-tab');
  const settingsSections = document.querySelectorAll('.settings-section');

  const connectionsList = document.getElementById('connectionsList');
  const connectionForm = document.getElementById('connectionForm');
  const connectionFormTitle = document.getElementById('connectionFormTitle');
  const addConnectionBtn = document.getElementById('addConnectionBtn');
  const connName = document.getElementById('connName');
  const connBaseUrl = document.getElementById('connBaseUrl');
  const connApiKey = document.getElementById('connApiKey');
  const connDefaultModel = document.getElementById('connDefaultModel');
  const connSaveBtn = document.getElementById('connSaveBtn');
  const connCancelBtn = document.getElementById('connCancelBtn');
  const connFormFeedback = document.getElementById('connFormFeedback');
  const modeAssignmentsEl = document.getElementById('modeAssignments');
  const accountInfoEl = document.getElementById('accountInfo');
  const passwordForm = document.getElementById('passwordForm');
  const passwordFeedback = document.getElementById('passwordFeedback');
  const allowAutoCodeExecToggle = document.getElementById('allowAutoCodeExecToggle');
  const codeSettingsFeedback = document.getElementById('codeSettingsFeedback');

  const profileNoteInput = document.getElementById('profileNoteInput');
  const profileSaveBtn = document.getElementById('profileSaveBtn');
  const profileFeedback = document.getElementById('profileFeedback');

  const scheduledTasksList = document.getElementById('scheduledTasksList');
  const addScheduledTaskBtn = document.getElementById('addScheduledTaskBtn');
  const scheduledTaskForm = document.getElementById('scheduledTaskForm');
  const taskTitleInput = document.getElementById('taskTitle');
  const taskPromptInput = document.getElementById('taskPrompt');
  const taskModeSelect = document.getElementById('taskMode');
  const taskIntervalInput = document.getElementById('taskInterval');
  const taskSaveBtn = document.getElementById('taskSaveBtn');
  const taskCancelBtn = document.getElementById('taskCancelBtn');
  const taskFormFeedback = document.getElementById('taskFormFeedback');

  let editingConnectionId = null;

  function initSettingsUI() {
    settingsBtn.addEventListener('click', openSettings);
    settingsCloseBtn.addEventListener('click', closeSettings);
    settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });

    settingsTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        settingsTabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        settingsSections.forEach((s) => s.classList.toggle('active', s.dataset.section === tab.dataset.tab));
      });
    });

    addConnectionBtn.addEventListener('click', () => openConnectionForm(null));
    connCancelBtn.addEventListener('click', closeConnectionForm);
    connSaveBtn.addEventListener('click', saveConnection);

    passwordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      passwordFeedback.hidden = true;
      const currentPassword = document.getElementById('currentPassword').value;
      const newPassword = document.getElementById('newPassword').value;
      try {
        await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
        passwordFeedback.className = 'settings-feedback ok';
        passwordFeedback.textContent = 'Пароль изменён';
        passwordFeedback.hidden = false;
        passwordForm.reset();
      } catch (err) {
        passwordFeedback.className = 'settings-feedback err';
        passwordFeedback.textContent = err.message;
        passwordFeedback.hidden = false;
      }
    });

    allowAutoCodeExecToggle.addEventListener('change', async () => {
      const next = allowAutoCodeExecToggle.checked;
      codeSettingsFeedback.hidden = true;
      try {
        await api('/api/settings', { method: 'POST', body: JSON.stringify({ allowAutoCodeExec: next }) });
        codeSettingsFeedback.className = 'settings-feedback ok';
        codeSettingsFeedback.textContent = 'Сохранено';
        codeSettingsFeedback.hidden = false;
      } catch (err) {
        allowAutoCodeExecToggle.checked = !next; // откат при ошибке сохранения
        codeSettingsFeedback.className = 'settings-feedback err';
        codeSettingsFeedback.textContent = err.message;
        codeSettingsFeedback.hidden = false;
      }
    });

    profileSaveBtn.addEventListener('click', async () => {
      profileFeedback.hidden = true;
      try {
        await api('/api/profile', { method: 'PUT', body: JSON.stringify({ profileNote: profileNoteInput.value }) });
        profileFeedback.className = 'settings-feedback ok';
        profileFeedback.textContent = 'Сохранено';
        profileFeedback.hidden = false;
      } catch (err) {
        profileFeedback.className = 'settings-feedback err';
        profileFeedback.textContent = err.message;
        profileFeedback.hidden = false;
      }
    });

    addScheduledTaskBtn.addEventListener('click', () => openTaskForm());
    taskCancelBtn.addEventListener('click', closeTaskForm);
    taskSaveBtn.addEventListener('click', saveScheduledTask);
  }

  function openTaskForm() {
    taskFormFeedback.hidden = true;
    taskTitleInput.value = '';
    taskPromptInput.value = '';
    taskIntervalInput.value = '60';
    taskModeSelect.innerHTML = MODES_ORDER.filter((m) => m !== 'image' && m !== 'computer')
      .map((m) => `<option value="${m}">${MODE_LABELS[m]}</option>`).join('');
    scheduledTaskForm.hidden = false;
  }
  function closeTaskForm() { scheduledTaskForm.hidden = true; }

  async function saveScheduledTask() {
    taskFormFeedback.hidden = true;
    const title = taskTitleInput.value.trim();
    const prompt = taskPromptInput.value.trim();
    const mode = taskModeSelect.value;
    const intervalMinutes = Number(taskIntervalInput.value);
    if (!title || !prompt) {
      taskFormFeedback.className = 'settings-feedback err';
      taskFormFeedback.textContent = 'Заполните название и текст задачи';
      taskFormFeedback.hidden = false;
      return;
    }
    try {
      await api('/api/scheduled-tasks', { method: 'POST', body: JSON.stringify({ title, prompt, mode, intervalMinutes }) });
      closeTaskForm();
      renderSchedulerSettings();
    } catch (err) {
      taskFormFeedback.className = 'settings-feedback err';
      taskFormFeedback.textContent = err.message;
      taskFormFeedback.hidden = false;
    }
  }

  async function renderProfileSettings() {
    try {
      const { profileNote } = await api('/api/profile');
      profileNoteInput.value = profileNote || '';
    } catch (e) {
      // молча оставляет поле как есть, если заметка не загрузилась
    }
  }

  function formatTaskTime(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('ru-RU'); } catch (e) { return iso; }
  }

  async function renderSchedulerSettings() {
    try {
      const { tasks } = await api('/api/scheduled-tasks');
      scheduledTasksList.innerHTML = '';
      if (!tasks.length) {
        const empty = document.createElement('div');
        empty.className = 'connections-empty';
        empty.textContent = 'Задач пока нет. Создайте первую — например, периодический брифинг.';
        scheduledTasksList.appendChild(empty);
        return;
      }
      tasks.forEach((t) => {
        const card = document.createElement('div');
        card.className = 'scheduled-task-card';
        card.innerHTML = `
          <div class="scheduled-task-head">
            <span class="name">${escapeHtml(t.title)}</span>
            <label class="switch switch-sm">
              <input type="checkbox" data-action="toggle" ${t.enabled ? 'checked' : ''} />
              <span class="switch-track"><span class="switch-thumb"></span></span>
            </label>
          </div>
          <div class="scheduled-task-meta">${MODE_LABELS[t.mode] || t.mode} · каждые ${t.intervalMinutes} мин · след. запуск: ${formatTaskTime(t.nextRunAt)}</div>
          <div class="scheduled-task-prompt">${escapeHtml(t.prompt)}</div>
          ${t.lastError ? `<div class="scheduled-task-error">Ошибка: ${escapeHtml(t.lastError)}</div>` : ''}
          ${t.lastRunAt ? `<div class="scheduled-task-meta">Последний запуск: ${formatTaskTime(t.lastRunAt)}</div>` : ''}
          <div class="actions">
            <button type="button" class="btn-secondary-sm" data-action="run-now">Запустить сейчас</button>
            <button type="button" class="btn-danger-sm" data-action="delete">Удалить</button>
          </div>
        `;
        scheduledTasksList.appendChild(card);

        card.querySelector('[data-action="toggle"]').addEventListener('change', async (e) => {
          const enabled = e.target.checked;
          try {
            await api(`/api/scheduled-tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
          } catch (err) {
            e.target.checked = !enabled;
          }
        });
        card.querySelector('[data-action="run-now"]').addEventListener('click', async (btn) => {
          const button = btn.currentTarget;
          button.disabled = true;
          button.textContent = 'Выполняется…';
          try {
            await api(`/api/scheduled-tasks/${t.id}/run-now`, { method: 'POST' });
          } catch (err) {
            // ошибка будет видна в lastError после перерисовки
          } finally {
            renderSchedulerSettings();
          }
        });
        card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
          if (!confirm(`Удалить задачу «${t.title}»?`)) return;
          try {
            await api(`/api/scheduled-tasks/${t.id}`, { method: 'DELETE' });
            renderSchedulerSettings();
          } catch (err) {
            // игнорируется — список остаётся без изменений, если удаление не удалось
          }
        });
      });
    } catch (e) {
      scheduledTasksList.innerHTML = '<div class="connections-empty">Не удалось загрузить задачи</div>';
    }
  }

  async function renderCodeSettings() {
    try {
      const { settings } = await api('/api/settings');
      allowAutoCodeExecToggle.checked = !!(settings && settings.allowAutoCodeExec);
    } catch (e) {
      // молча оставляет переключатель в текущем состоянии, если настройки не загрузились
    }
  }

  function openSettings() {
    settingsOverlay.hidden = false;
    renderConnectionsList();
    renderModeAssignments();
    renderAccountInfo();
    renderCodeSettings();
    renderProfileSettings();
    renderSchedulerSettings();
  }
  function closeSettings() { settingsOverlay.hidden = true; closeConnectionForm(); }

  async function loadConnections() {
    const { connections } = await api('/api/connections');
    state.connections = connections;
  }
  async function loadModeAssignments() {
    const { assignments } = await api('/api/mode-assignments');
    state.modeAssignments = assignments;
  }

  function renderConnectionsList() {
    connectionsList.innerHTML = '';
    if (!state.connections.length) {
      const empty = document.createElement('div');
      empty.className = 'connections-empty';
      empty.textContent = 'Подключений пока нет. Добавьте первое, например Polza.ai или локальный мок-сервер.';
      connectionsList.appendChild(empty);
      return;
    }
    state.connections.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'connection-card';
      card.innerHTML = `
        <div class="connection-card-head">
          <span class="name">${escapeHtml(c.name)}</span>
          <div class="actions">
            <button type="button" class="btn-secondary-sm" data-action="test">Проверить</button>
            <button type="button" class="btn-secondary-sm" data-action="edit">Изменить</button>
            <button type="button" class="btn-danger-sm" data-action="delete">Удалить</button>
          </div>
        </div>
        <div class="base-url">${escapeHtml(c.baseUrl)}</div>
        <div class="connection-test-result" data-result></div>
      `;
      card.querySelector('[data-action="test"]').addEventListener('click', () => testConnection(c.id, card));
      card.querySelector('[data-action="edit"]').addEventListener('click', () => openConnectionForm(c));
      card.querySelector('[data-action="delete"]').addEventListener('click', () => deleteConnection(c.id));
      connectionsList.appendChild(card);
    });
  }

  async function testConnection(id, card) {
    const resultEl = card.querySelector('[data-result]');
    resultEl.textContent = 'Проверка…';
    resultEl.className = 'connection-test-result';
    try {
      const res = await api(`/api/connections/${id}/test`, { method: 'POST' });
      if (res.ok) {
        resultEl.className = 'connection-test-result ok';
        resultEl.innerHTML = `✓ Доступно, моделей: ${res.models.length}<div class="connection-test-models">${escapeHtml(res.models.slice(0, 12).join(', '))}${res.models.length > 12 ? '…' : ''}</div>`;
      } else {
        resultEl.className = 'connection-test-result err';
        resultEl.textContent = '✗ ' + res.error;
      }
    } catch (e) {
      resultEl.className = 'connection-test-result err';
      resultEl.textContent = '✗ ' + e.message;
    }
  }

  async function deleteConnection(id) {
    if (!confirm('Удалить подключение? Назначения режимов, использующие его, будут сброшены.')) return;
    await api(`/api/connections/${id}`, { method: 'DELETE' });
    await loadConnections();
    await loadModeAssignments();
    renderConnectionsList();
    renderModeAssignments();
    updateModeMenuDescriptions();
  }

  function openConnectionForm(conn) {
    editingConnectionId = conn ? conn.id : null;
    connectionFormTitle.textContent = conn ? `Изменить: ${conn.name}` : 'Новое подключение';
    connName.value = conn ? conn.name : '';
    connBaseUrl.value = conn ? conn.baseUrl : '';
    connApiKey.value = '';
    connApiKey.placeholder = conn && conn.hasKey ? '•••••••• (оставьте пустым, чтобы не менять)' : 'sk-…';
    connDefaultModel.value = (conn && conn.defaultModel) || '';
    connFormFeedback.hidden = true;
    connectionForm.hidden = false;
  }
  function closeConnectionForm() {
    connectionForm.hidden = true;
    editingConnectionId = null;
  }

  async function saveConnection() {
    const name = connName.value.trim();
    const baseUrl = connBaseUrl.value.trim();
    const apiKey = connApiKey.value;
    const defaultModel = connDefaultModel.value.trim() || null;
    if (!name || !baseUrl) {
      connFormFeedback.className = 'settings-feedback err';
      connFormFeedback.textContent = 'Название и Base URL обязательны';
      connFormFeedback.hidden = false;
      return;
    }
    try {
      if (editingConnectionId) {
        await api(`/api/connections/${editingConnectionId}`, {
          method: 'PUT',
          body: JSON.stringify({ name, baseUrl, apiKey, defaultModel }),
        });
      } else {
        await api('/api/connections', {
          method: 'POST',
          body: JSON.stringify({ name, baseUrl, apiKey, defaultModel }),
        });
      }
      await loadConnections();
      renderConnectionsList();
      renderModeAssignments();
      closeConnectionForm();
      toast('Подключение сохранено');
    } catch (e) {
      connFormFeedback.className = 'settings-feedback err';
      connFormFeedback.textContent = e.message;
      connFormFeedback.hidden = false;
    }
  }

  const MODES_ORDER = ['orchestrator', 'fast', 'code', 'complex', 'image', 'computer'];

  function renderModeAssignments() {
    modeAssignmentsEl.innerHTML = '';
    if (!state.connections.length) {
      const empty = document.createElement('div');
      empty.className = 'modes-empty';
      empty.textContent = 'Сначала добавьте хотя бы одно подключение на вкладке «Подключения».';
      modeAssignmentsEl.appendChild(empty);
      return;
    }
    MODES_ORDER.forEach((mode) => {
      const row = document.createElement('div');
      row.className = 'mode-assignment-row';
      const current = state.modeAssignments[mode];

      const connSelectId = `sel-conn-${mode}`;
      const modelSelectId = `sel-model-${mode}`;

      const isComputer = mode === 'computer';
      const autoOption = isComputer ? `<option value="" ${!current || !current.model ? 'selected' : ''}>— авто (агент сам подбирает) —</option>` : '<option value="">— модель —</option>';
      row.innerHTML = `
        <div class="mode-name">${MODE_LABELS[mode]}</div>
        <select id="${connSelectId}" data-mode="${mode}" data-role="connection">
          <option value="">— не выбрано —</option>
          ${state.connections.map((c) => `<option value="${c.id}" ${current && current.connectionId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
        <select id="${modelSelectId}" data-mode="${mode}" data-role="model">
          ${autoOption}
          ${current && current.model ? `<option value="${escapeHtml(current.model)}" selected>${escapeHtml(current.model)}</option>` : ''}
        </select>
      `;
      modeAssignmentsEl.appendChild(row);

      const connSelect = row.querySelector(`#${connSelectId}`);
      const modelSelect = row.querySelector(`#${modelSelectId}`);

      async function refreshModelOptions(connId, preselect) {
        modelSelect.innerHTML = '<option value="">— загрузка… —</option>';
        if (!connId) {
          modelSelect.innerHTML = autoOption;
          return;
        }
        const conn = state.connections.find((c) => c.id === connId);
        try {
          const res = await api(`/api/connections/${connId}/test`, { method: 'POST' });
          if (res.ok) {
            modelSelect.innerHTML = autoOption +
              res.models.map((m) => `<option value="${escapeHtml(m)}" ${m === preselect ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
            if (preselect && !res.models.includes(preselect)) {
              modelSelect.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(preselect)}" selected>${escapeHtml(preselect)} (текущее)</option>`);
            }
          } else {
            modelSelect.innerHTML = isComputer
              ? autoOption
              : `<option value="${preselect ? escapeHtml(preselect) : ''}">${preselect ? escapeHtml(preselect) + ' (введите вручную)' : 'нет моделей — введите вручную'}</option>`;
          }
        } catch (e) {
          modelSelect.innerHTML = isComputer ? autoOption : '<option value="">ошибка загрузки моделей</option>';
        }
        if (isComputer) renderComputerPoolPanel();
      }

      if (current && current.connectionId) {
        refreshModelOptions(current.connectionId, current.model);
      } else if (isComputer) {
        renderComputerPoolPanel();
      }

      connSelect.addEventListener('change', () => { refreshModelOptions(connSelect.value, null); if (isComputer) persist(); });

      async function persist() {
        const connectionId = connSelect.value;
        const model = modelSelect.value;
        const payload = {};
        // Для режима «Компьютер» пустая модель — валидный выбор («авто»): агент сам подберёт модель(и)
        // под задачу из пула подключения (см. server/orchestrator.js).
        payload[mode] = connectionId && (model || isComputer) ? { connectionId, model: model || '' } : null;
        try {
          const res = await api('/api/mode-assignments', { method: 'PUT', body: JSON.stringify(payload) });
          state.modeAssignments = res.assignments;
          updateModeMenuDescriptions();
          toast(`Режим «${MODE_LABELS[mode]}» обновлён`);
          if (isComputer) renderComputerPoolPanel();
        } catch (e) {
          toast(e.message, 'err');
        }
      }
      modelSelect.addEventListener('change', persist);
    });
  }

  const CAPABILITY_LABELS_FALLBACK = {
    reasoning: 'Сложное рассуждение', code: 'Код', vision: 'Изображения (зрение)',
    audio: 'Аудио', image_gen: 'Генерация изображений', fast: 'Быстрая/дешёвая', general: 'Общего назначения',
  };

  async function renderComputerPoolPanel() {
    const panel = document.getElementById('computerPoolPanel');
    const list = document.getElementById('computerPoolList');
    if (!panel || !list) return;
    const assignment = state.modeAssignments.computer;
    if (!assignment || !assignment.connectionId) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    list.innerHTML = '<div class="modes-empty">Загрузка пула моделей…</div>';
    try {
      const res = await api('/api/computer/model-pool');
      const labels = res.capabilityLabels || CAPABILITY_LABELS_FALLBACK;
      const tags = res.capabilityTags || Object.keys(CAPABILITY_LABELS_FALLBACK);
      if (!res.models.length) {
        list.innerHTML = `<div class="modes-empty">${res.error ? escapeHtml(res.error) : 'Не удалось получить список моделей у подключения «' + escapeHtml(res.connectionName || '') + '».'}</div>`;
        return;
      }
      list.innerHTML = res.models.map((m) => `
        <div class="computer-pool-row" data-model="${escapeHtml(m.id)}">
          <div class="computer-pool-model">${escapeHtml(m.id)}${m.overridden ? ' <span class="pool-override-badge">переопределено</span>' : ''}</div>
          <div class="computer-pool-tags">
            ${tags.map((tag) => `
              <label class="pool-tag-checkbox">
                <input type="checkbox" data-tag="${tag}" ${m.capabilities.includes(tag) ? 'checked' : ''} />
                ${escapeHtml(labels[tag] || tag)}
              </label>
            `).join('')}
          </div>
        </div>
      `).join('');
      list.querySelectorAll('.computer-pool-row').forEach((row) => {
        const modelId = row.getAttribute('data-model');
        row.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
          cb.addEventListener('change', async () => {
            const checked = Array.from(row.querySelectorAll('input[type="checkbox"]:checked')).map((el) => el.getAttribute('data-tag'));
            try {
              await api('/api/computer/model-pool', { method: 'PUT', body: JSON.stringify({ modelId, capabilities: checked }) });
              toast(`Возможности модели «${modelId}» обновлены`);
              renderComputerPoolPanel();
            } catch (e) {
              toast(e.message, 'err');
            }
          });
        });
      });
    } catch (e) {
      list.innerHTML = `<div class="modes-empty">${escapeHtml(e.message)}</div>`;
    }
  }

  function renderAccountInfo() {
    accountInfoEl.innerHTML = `<div>Логин: <strong>${escapeHtml(state.user.username)}</strong></div><div>Роль: <strong>${escapeHtml(state.user.role || 'admin')}</strong></div>`;
  }

  function bindEvents() {
    // reserved for future global bindings
  }

  init();
})();
