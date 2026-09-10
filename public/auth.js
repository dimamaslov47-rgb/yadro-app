(function () {
  // theme init (до логина нет аккаунта для хранения темы — исходим из системных настроек; после входа тема берётся из аккаунта)
  const root = document.documentElement;
  const theme = (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  root.setAttribute('data-theme', theme);

  const scriptTag = document.currentScript;
  const mode = scriptTag.dataset.mode;

  // Адрес backend: локально пусто (один порт с фронтом), в превью-бандле deploy_website заменяет на прокси-путь
  const API_BASE = '__PORT_4141__'.startsWith('__') ? '' : '__PORT_4141__';

  async function api(path, opts) {
    const res = await fetch(API_BASE + path, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts,
    });
    let json = {};
    try {
      json = await res.json();
    } catch (e) {
      /* ignore */
    }
    if (!res.ok) throw new Error(json.message || json.error || 'Ошибка запроса');
    return json;
  }

  function showError(el, message) {
    el.textContent = message;
    el.hidden = false;
  }

  // Redirect guard: если статус не совпадает с текущей страницей — перенаправить
  api('/api/auth/status').then((status) => {
    if (mode === 'setup' && !status.needsSetup) {
      window.location.href = status.authenticated ? 'index.html' : 'login.html';
    }
    if (mode === 'login' && status.needsSetup) {
      window.location.href = 'setup.html';
    }
    if (mode === 'login' && status.authenticated) {
      window.location.href = 'index.html';
    }
  }).catch(() => {});

  if (mode === 'setup') {
    const form = document.getElementById('setupForm');
    const errorEl = document.getElementById('setupError');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const data = new FormData(form);
      const username = data.get('username').trim();
      const password = data.get('password');
      const password2 = data.get('password2');
      if (password !== password2) {
        return showError(errorEl, 'Пароли не совпадают');
      }
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ username, password }) });
        window.location.href = 'index.html';
      } catch (err) {
        showError(errorEl, err.message);
        btn.disabled = false;
      }
    });
  }

  if (mode === 'login') {
    const form = document.getElementById('loginForm');
    const errorEl = document.getElementById('loginError');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const data = new FormData(form);
      const username = data.get('username').trim();
      const password = data.get('password');
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
        window.location.href = 'index.html';
      } catch (err) {
        showError(errorEl, err.message);
        btn.disabled = false;
      }
    });
  }
})();
