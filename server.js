// Ядро — сервер приложения. Express + lowdb + express-session.
// Без нативных модулей (никаких better-sqlite3/bcrypt) для простой Docker-сборки.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');

const db = require('./server/db');
const { hashPassword, verifyPassword, requireAuth, requirePageAuth } = require('./server/auth');
const { fetchModels, streamChatCompletion, classifyRoute, generateImage, chatCompletionOnce, runToolLoop } = require('./server/llm');
const { buildDocx, buildPdf } = require('./server/export');
const { buildXlsx, buildPptx, buildCsv, buildRtf, buildOdt } = require('./server/documents');
const { runCode, getSupportedLanguages } = require('./server/codeExec');
const { RUN_CODE_TOOL, WRITE_FILE_TOOL, CREATE_DOCUMENT_TOOL } = require('./server/tools');
const { writeTaskFile, listTaskFiles, hasTaskFiles, buildTaskZip, clearTaskFiles } = require('./server/files');
const { extractText } = require('./server/attachments');
const { transcribeAudio } = require('./server/transcribe');
const { buildModelPool, CAPABILITY_TAGS, CAPABILITY_LABELS } = require('./server/modelCapabilities');
const { orchestrateComputerTask } = require('./server/orchestrator');
const multer = require('multer');
const { startScheduler } = require('./server/scheduler');
let schedulerHandle; // присваивается после app.listen (см. конец файла), а маршрут /run-now читает его в момент вызова

const PORT = parseInt(process.env.PORT || '4141', 10);
// 'image' — генерация изображений, 'computer' — автономный агент с инструментами
// (run_code + write_file, без нажатия кнопок, до 8 раундов). Важно: оркестратор
// (classifyRoute) никогда не возвращает ни 'image', ни 'computer' — оба режима
// доступны только при явном выборе пользователем, чтобы исключить неожиданные
// расходы на платный API и неожиданный автономный запуск инструментов.
const MODES = ['orchestrator', 'fast', 'code', 'complex', 'image', 'computer'];

// Загрузка вложений (изображения обрабатываются на клиенте, документы — здесь через pdf-parse/mammoth).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Секрет сессии: если не задан через переменную окружения — автоматически генерируется при первом запуске
// и сохраняется в файле внутри DATA_DIR (тот же volume, где живёт db.json) — переживает пересоздание контейнера.
// Никакого публичного/известного дефолтного значения в коде нет.
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim()) {
    return process.env.SESSION_SECRET.trim();
  }
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const secretFile = path.join(dataDir, '.session_secret');
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (existing) return existing;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    try { fs.chmodSync(secretFile, 0o600); } catch (e) { /* best effort, не критично */ }
    console.log('[ядро] SESSION_SECRET не задан через окружение — сгенерирован автоматически и сохранён в', secretFile);
    return generated;
  } catch (e) {
    console.error('[ядро] Не удалось сохранить/читать файл секрета сессии, используется временный секрет на время работы процесса (сессии не переживут рестарт):', e.message);
    return crypto.randomBytes(32).toString('hex');
  }
}
const SESSION_SECRET = resolveSessionSecret();

const app = express();
app.disable('x-powered-by');
// Лимит увеличен с 2mb до 15mb из-за вложений-изображений: клиент кодирует их в base64 и кладёт
// в JSON-тело /api/chat/send (base64 разбухает размер ≈в 1.33 раза). Домашний/малойсерверный сценарий —
// приемлемый трейдофф.
app.use(express.json({ limit: '15mb' }));
// COOKIE_SECURE=1 включается только при публикации на pplx.app — там прокси стригает любые cookie
// кроме имён, начинающихся с __Host- (требует secure:true и path:'/'). Для обычного
// дерплоя на домашнем сервере по HTTP эта переменная не задаётся — поведение не меняется.
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
app.use(
  session({
    secret: SESSION_SECRET,
    name: COOKIE_SECURE ? '__Host-yadro.sid' : 'yadro.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIE_SECURE,
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 дней
    },
  }),
);

// ---------- Вспомогательные функции ----------
function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, theme: u.theme || 'light' };
}

function getConnection(id) {
  return db.get('connections').find({ id }).value();
}

function publicConnection(c) {
  if (!c) return null;
  const { apiKey, ...rest } = c;
  return { ...rest, hasKey: !!apiKey };
}

// ============================================================
// AUTH ROUTES (без проверки сессии)
// ============================================================

// Есть ли хоть один пользователь? Если нет — нужен setup.
app.get('/api/auth/status', (req, res) => {
  const usersCount = db.get('users').size().value();
  res.json({
    needsSetup: usersCount === 0,
    authenticated: !!(req.session && req.session.userId),
    username: req.session && req.session.username,
  });
});

// Первичное создание admin-аккаунта (только если нет пользователей)
app.post('/api/auth/setup', (req, res) => {
  const usersCount = db.get('users').size().value();
  if (usersCount > 0) {
    return res.status(400).json({ error: 'already_initialized' });
  }
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: 'invalid_input', message: 'Логин и пароль (мин. 4 символа) обязательны' });
  }
  const user = {
    id: uuidv4(),
    username: username.trim(),
    passwordHash: hashPassword(password),
    role: 'admin',
    theme: 'light',
    createdAt: new Date().toISOString(),
  };
  db.get('users').push(user).write();
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.get('users').find({ username: (username || '').trim() }).value();
  if (!user || !verifyPassword(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('yadro.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.get('users').find({ id: req.session.userId }).value();
  if (!user) return res.status(401).json({ error: 'not_authenticated' });
  res.json({ user: publicUser(user) });
});

// Сохранение выбора темы (light/dark) — привязано к аккаунту, не к браузерному хранилищу
app.post('/api/auth/theme', requireAuth, (req, res) => {
  const { theme } = req.body || {};
  if (theme !== 'light' && theme !== 'dark') {
    return res.status(400).json({ error: 'invalid_input', message: 'theme должен быть light или dark' });
  }
  db.get('users').find({ id: req.session.userId }).assign({ theme }).write();
  res.json({ ok: true, theme });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.get('users').find({ id: req.session.userId }).value();
  if (!user || !verifyPassword(currentPassword || '', user.passwordHash)) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Текущий пароль неверен' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'invalid_input', message: 'Новый пароль слишком короткий' });
  }
  db.get('users')
    .find({ id: user.id })
    .assign({ passwordHash: hashPassword(newPassword) })
    .write();
  res.json({ ok: true });
});

// ============================================================
// Всё, что ниже — защищено сессией
// ============================================================
app.use('/api', requireAuth);

// ---------- Подключения (Connections) ----------
app.get('/api/connections', (req, res) => {
  const list = db.get('connections').value().map(publicConnection);
  res.json({ connections: list });
});

app.post('/api/connections', (req, res) => {
  const { name, baseUrl, apiKey, defaultModel } = req.body || {};
  if (!name || !baseUrl) {
    return res.status(400).json({ error: 'invalid_input', message: 'Имя и base_url обязательны' });
  }
  const conn = {
    id: uuidv4(),
    name: name.trim(),
    baseUrl: baseUrl.trim().replace(/\/+$/, ''),
    apiKey: apiKey || '',
    defaultModel: defaultModel || null,
    createdAt: new Date().toISOString(),
  };
  db.get('connections').push(conn).write();
  res.status(201).json({ connection: publicConnection(conn) });
});

app.put('/api/connections/:id', (req, res) => {
  const conn = getConnection(req.params.id);
  if (!conn) return res.status(404).json({ error: 'not_found' });
  const { name, baseUrl, apiKey, defaultModel } = req.body || {};
  const patch = {};
  if (name !== undefined) patch.name = name.trim();
  if (baseUrl !== undefined) patch.baseUrl = baseUrl.trim().replace(/\/+$/, '');
  if (apiKey !== undefined && apiKey !== '') patch.apiKey = apiKey;
  if (defaultModel !== undefined) patch.defaultModel = defaultModel;
  db.get('connections').find({ id: req.params.id }).assign(patch).write();
  res.json({ connection: publicConnection(getConnection(req.params.id)) });
});

app.delete('/api/connections/:id', (req, res) => {
  db.get('connections').remove({ id: req.params.id }).write();
  // Очистим ссылки на удалённое подключение в назначениях режимов
  const assignments = db.get('modeAssignments').value();
  let changed = false;
  for (const mode of MODES) {
    if (assignments[mode] && assignments[mode].connectionId === req.params.id) {
      assignments[mode] = null;
      changed = true;
    }
  }
  if (changed) db.set('modeAssignments', assignments).write();
  res.json({ ok: true });
});

// Проверка подключения: GET {base_url}/models
app.post('/api/connections/:id/test', async (req, res) => {
  const conn = getConnection(req.params.id);
  if (!conn) return res.status(404).json({ error: 'not_found' });
  try {
    const models = await fetchModels(conn.baseUrl, conn.apiKey);
    res.json({ ok: true, models });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message || 'Неизвестная ошибка' });
  }
});

// ---------- Пул моделей режима «Компьютер»: авто-разметка возможностей + ручные переопределения ----------
// Возвращает живой список моделей подключения, назначенного режиму «Компьютер», с их возможностями
// (авто-разметка по имени + пометка overridden, если администратор переопределил вручную).
app.get('/api/computer/model-pool', requireAuth, async (req, res) => {
  const assignment = db.get('modeAssignments.computer').value();
  if (!assignment || !assignment.connectionId) {
    return res.json({ connectionName: null, capabilityTags: CAPABILITY_TAGS, capabilityLabels: CAPABILITY_LABELS, models: [] });
  }
  const connection = getConnection(assignment.connectionId);
  if (!connection) {
    return res.json({ connectionName: null, capabilityTags: CAPABILITY_TAGS, capabilityLabels: CAPABILITY_LABELS, models: [] });
  }
  try {
    const overrides = db.get(`modelCapabilityOverrides.${assignment.connectionId}`).value() || {};
    const models = await buildModelPool(connection, overrides);
    res.json({ connectionName: connection.name, capabilityTags: CAPABILITY_TAGS, capabilityLabels: CAPABILITY_LABELS, models });
  } catch (e) {
    res.status(200).json({ connectionName: connection.name, capabilityTags: CAPABILITY_TAGS, capabilityLabels: CAPABILITY_LABELS, models: [], error: e.message || 'Не удалось получить список моделей' });
  }
});

// Ручное переопределение возможностей одной модели (или сброс на авто, если capabilities пустой/не передан).
app.put('/api/computer/model-pool', requireAuth, (req, res) => {
  const { modelId, capabilities } = req.body || {};
  const assignment = db.get('modeAssignments.computer').value();
  if (!assignment || !assignment.connectionId) {
    return res.status(400).json({ error: 'Для режима «Компьютер» сначала выберите подключение в Настройках.' });
  }
  if (!modelId) return res.status(400).json({ error: 'modelId обязателен' });
  const overridePath = `modelCapabilityOverrides.${assignment.connectionId}`;
  const current = db.get(overridePath).value() || {};
  const next = { ...current };
  if (Array.isArray(capabilities) && capabilities.length) {
    next[modelId] = capabilities.filter((c) => CAPABILITY_TAGS.includes(c));
  } else {
    delete next[modelId];
  }
  db.set(overridePath, next).write();
  res.json({ ok: true, overrides: next });
});

// ---------- Назначение моделей по режимам ----------
app.get('/api/mode-assignments', (req, res) => {
  res.json({ assignments: db.get('modeAssignments').value() });
});

app.put('/api/mode-assignments', (req, res) => {
  const body = req.body || {};
  const current = db.get('modeAssignments').value();
  const next = { ...current };
  for (const mode of MODES) {
    if (body[mode] !== undefined) {
      if (body[mode] === null) {
        next[mode] = null;
      } else {
        const { connectionId, model } = body[mode];
        // Для режима «Компьютер» модель может быть не указана («авто» — агент сам подбирает
        // модель под каждую задачу/подзадачу из пула моделей подключения).
        if (connectionId && (model || mode === 'computer')) {
          next[mode] = { connectionId, model: model || null };
        }
      }
    }
  }
  db.set('modeAssignments', next).write();
  res.json({ assignments: next });
});

// ---------- Общие настройки приложения (пока только выполнение кода) ----------
app.get('/api/settings', (req, res) => {
  res.json({ settings: db.get('settings').value() || { allowAutoCodeExec: false } });
});

app.post('/api/settings', (req, res) => {
  const body = req.body || {};
  const current = db.get('settings').value() || { allowAutoCodeExec: false };
  const next = { ...current };
  if (typeof body.allowAutoCodeExec === 'boolean') next.allowAutoCodeExec = body.allowAutoCodeExec;
  db.set('settings', next).write();
  res.json({ settings: next });
});

// ============================================================
// Память о пользователе — короткая свободная заметка («что знает модель»), которая
// подкладывается в каждый запрос как system-сообщение (см. /api/chat/send). Никакого векторного
// поиска/автоматического запоминания — осознанный MVP-минимум, а не полноценная долгосрочная память.
// ============================================================
app.get('/api/profile', requireAuth, (req, res) => {
  const user = db.get('users').find({ id: req.session.userId }).value();
  res.json({ profileNote: (user && user.profileNote) || '' });
});

app.put('/api/profile', requireAuth, (req, res) => {
  const { profileNote } = req.body || {};
  if (typeof profileNote !== 'string') {
    return res.status(400).json({ error: 'invalid_input', message: 'Заметка должна быть строкой' });
  }
  const trimmed = profileNote.slice(0, 4000); // разумный лимит — не раздувать контекст каждого запроса
  db.get('users').find({ id: req.session.userId }).assign({ profileNote: trimmed }).write();
  res.json({ profileNote: trimmed });
});

// ============================================================
// Планировщик периодических задач (сетап: каждые N минут, без cron-синтаксиса) —
// см. server/scheduler.js. Выполняет один и тот же промт через выбранный режим/модель,
// результат складывается в отдельный тред.
// ============================================================
const MIN_INTERVAL_MINUTES = 5; // нижний порог — чтобы не создавать случайный спам запросами к провайдеру

function publicScheduledTask(t) {
  return {
    id: t.id,
    title: t.title,
    prompt: t.prompt,
    mode: t.mode,
    intervalMinutes: t.intervalMinutes,
    enabled: t.enabled,
    threadId: t.threadId || null,
    lastRunAt: t.lastRunAt || null,
    lastError: t.lastError || null,
    nextRunAt: t.nextRunAt || null,
    createdAt: t.createdAt,
  };
}

app.get('/api/scheduled-tasks', requireAuth, (req, res) => {
  const tasks = db.get('scheduledTasks').filter({ userId: req.session.userId }).orderBy('createdAt', 'desc').value();
  res.json({ tasks: tasks.map(publicScheduledTask) });
});

app.post('/api/scheduled-tasks', requireAuth, (req, res) => {
  const { title, prompt, mode, intervalMinutes } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'invalid_input', message: 'Название задачи обязательно' });
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'invalid_input', message: 'Текст задачи (промпт) обязателен' });
  // 'image' и 'computer' исключены из расписания: автономный агент режима «Компьютер» не должен тишком
  // накапливать файлы по расписанию без присмотра пользователя.
  if (!MODES.filter((m) => m !== 'image' && m !== 'computer').includes(mode)) return res.status(400).json({ error: 'invalid_input', message: 'Некорректный режим' });
  const minutes = Number(intervalMinutes);
  if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES) {
    return res.status(400).json({ error: 'invalid_input', message: `Интервал — число минут, не меньше ${MIN_INTERVAL_MINUTES}` });
  }
  const task = {
    id: uuidv4(),
    userId: req.session.userId,
    title: String(title).trim().slice(0, 120),
    prompt: String(prompt).trim().slice(0, 4000),
    mode,
    intervalMinutes: Math.round(minutes),
    enabled: true,
    threadId: null,
    lastRunAt: null,
    lastError: null,
    nextRunAt: new Date(Date.now() + Math.round(minutes) * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };
  db.get('scheduledTasks').push(task).write();
  res.status(201).json({ task: publicScheduledTask(task) });
});

app.patch('/api/scheduled-tasks/:id', requireAuth, (req, res) => {
  const task = db.get('scheduledTasks').find({ id: req.params.id, userId: req.session.userId }).value();
  if (!task) return res.status(404).json({ error: 'not_found' });
  const patch = {};
  const body = req.body || {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 120);
  if (typeof body.prompt === 'string' && body.prompt.trim()) patch.prompt = body.prompt.trim().slice(0, 4000);
  if (typeof body.mode === 'string' && MODES.filter((m) => m !== 'image' && m !== 'computer').includes(body.mode)) patch.mode = body.mode;
  if (body.intervalMinutes !== undefined) {
    const minutes = Number(body.intervalMinutes);
    if (Number.isFinite(minutes) && minutes >= MIN_INTERVAL_MINUTES) patch.intervalMinutes = Math.round(minutes);
  }
  db.get('scheduledTasks').find({ id: req.params.id }).assign(patch).write();
  res.json({ task: publicScheduledTask(db.get('scheduledTasks').find({ id: req.params.id }).value()) });
});

app.delete('/api/scheduled-tasks/:id', requireAuth, (req, res) => {
  const task = db.get('scheduledTasks').find({ id: req.params.id, userId: req.session.userId }).value();
  if (!task) return res.status(404).json({ error: 'not_found' });
  db.get('scheduledTasks').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

app.post('/api/scheduled-tasks/:id/run-now', requireAuth, async (req, res) => {
  const task = db.get('scheduledTasks').find({ id: req.params.id, userId: req.session.userId }).value();
  if (!task) return res.status(404).json({ error: 'not_found' });
  try {
    await schedulerHandle.runTaskNow(task);
    res.json({ task: publicScheduledTask(db.get('scheduledTasks').find({ id: req.params.id }).value()) });
  } catch (e) {
    res.status(500).json({ error: 'run_failed', message: e.message || 'Ошибка выполнения' });
  }
});

// ============================================================
// ВЫПОЛНЕНИЕ КОДА (Piston или мок-сервер в разработке) — см. CODE_EXECUTION_DESIGN.md.
// Автономный вызов run_code моделью (без нажатия кнопки) теперь реализован через
// function calling — см. server/tools.js, runToolLoop в server/llm.js и его вызов в
// /api/chat/send. Включается настройкой allowAutoCodeExec ниже.
// ============================================================

// Простой лимит частоты ручных запусков кода (в памяти процесса, на пользователя) —
// см. таблицу лимитов в CODE_EXECUTION_DESIGN.md §6. При перезапуске сервера сбрасывается,
// что осознанно допустимо для этого MVP-уровня защиты.
const codeRunTimestamps = new Map(); // userId -> [timestamps ms]
const CODE_RUN_LIMIT = 30; // запусков в час на пользователя
const CODE_RUN_WINDOW_MS = 60 * 60 * 1000;
function checkCodeRunRate(userId) {
  const now = Date.now();
  const arr = (codeRunTimestamps.get(userId) || []).filter((t) => now - t < CODE_RUN_WINDOW_MS);
  if (arr.length >= CODE_RUN_LIMIT) return false;
  arr.push(now);
  codeRunTimestamps.set(userId, arr);
  return true;
}

// Исполнитель для инструментов, которые модель может вызвать сама (function calling) —
// см. runToolLoop в server/llm.js. Пока единственный зарегистрированный инструмент — run_code,
// он делит один и тот же лимит частоты и журнал codeRuns с ручной кнопкой «Запустить»
// (initiator: 'agent' вместо 'manual', чтобы отличать в аудите).
async function executeToolCall(name, args, { userId, threadId }) {
  if (name === 'write_file') {
    const result = writeTaskFile(threadId, args.filename, args.content);
    return JSON.stringify({ ok: true, filename: result.filename, bytes: result.bytes });
  }
  if (name === 'create_document') {
    const format = String(args.format || '').toLowerCase();
    const opts = { content: args.content, title: args.title, rows: args.rows, sheets: args.sheets, slides: args.slides };
    let buf;
    if (format === 'pdf') buf = await buildPdf(args.content || '', args.title || '');
    else if (format === 'docx') buf = await buildDocx(args.content || '', args.title || '');
    else if (format === 'xlsx') buf = await buildXlsx(opts);
    else if (format === 'pptx') buf = await buildPptx(opts);
    else if (format === 'csv') buf = buildCsv(opts);
    else if (format === 'rtf') buf = buildRtf(opts);
    else if (format === 'odt') buf = await buildOdt(opts);
    else throw new Error(`Неподдерживаемый формат документа: ${args.format}. Поддерживаются: pdf, docx, xlsx, pptx, csv, rtf, odt`);
    const result = writeTaskFile(threadId, args.filename, buf);
    return JSON.stringify({ ok: true, filename: result.filename, bytes: result.bytes, format });
  }
  if (name === 'run_code') {
    if (!checkCodeRunRate(userId)) {
      throw new Error(`Лимит запусков кода (${CODE_RUN_LIMIT}/час) исчерпан`);
    }
    const result = await runCode({ language: args.language, code: args.code, stdin: args.stdin });
    db.get('codeRuns').push({
      id: uuidv4(),
      userId,
      initiator: 'agent',
      language: result.language,
      codeHash: crypto.createHash('sha256').update(String(args.code || '')).digest('hex'),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      createdAt: new Date().toISOString(),
    }).write();
    return JSON.stringify({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
  }
  throw new Error(`Неизвестный инструмент: ${name}`);
}

app.get('/api/code/languages', async (req, res) => {
  try {
    const languages = await getSupportedLanguages();
    res.json({ languages });
  } catch (e) {
    res.json({ languages: [] });
  }
});

app.post('/api/code/run', async (req, res) => {
  const userId = req.session.userId;
  const { language, code, stdin } = req.body || {};
  if (!language || !code || !String(code).trim()) {
    return res.status(400).json({ error: 'invalid_input', message: 'Язык и код обязательны' });
  }
  if (!checkCodeRunRate(userId)) {
    return res.status(429).json({ error: 'rate_limited', message: `Лимит запусков кода (${CODE_RUN_LIMIT}/час) исчерпан. Попробуйте позже.` });
  }
  try {
    const result = await runCode({ language, code, stdin });
    db.get('codeRuns').push({
      id: uuidv4(),
      userId,
      initiator: 'manual', // единственный существующий путь запуска на этом этапе — ручная кнопка
      language: result.language,
      codeHash: crypto.createHash('sha256').update(String(code)).digest('hex'),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      createdAt: new Date().toISOString(),
    }).write();
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'execution_failed', message: err.message || 'Ошибка выполнения кода' });
  }
});

// ============================================================
// ЭКСПОРТ ОТВЕТА В ФАЙЛ (.docx / .pdf) — генерируется на сервере,
// без обращения к внешним API.
// ============================================================
function safeFilename(name) {
  return String(name || 'yadro-answer')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .trim()
    .slice(0, 80) || 'yadro-answer';
}

// Content-Disposition должен быть ASCII-безопасным заголовком;
// кириллическое/UTF-8 имя файла передаётся через filename* (RFC 5987).
function contentDisposition(baseName, ext) {
  const asciiSafe = (safeFilename(baseName).replace(/[^\x20-\x7E]/g, '_') || 'document') + '.' + ext;
  const utf8Name = encodeURIComponent(safeFilename(baseName) + '.' + ext);
  return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${utf8Name}`;
}

app.post('/api/export/docx', async (req, res) => {
  const text = (req.body && req.body.text) || '';
  const title = (req.body && req.body.title) || '';
  if (!text.trim()) return res.status(400).json({ error: 'empty_text' });
  try {
    const buffer = await buildDocx(text, title);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', contentDisposition(title, 'docx'));
    res.send(buffer);
  } catch (err) {
    console.error('[export/docx]', err);
    res.status(500).json({ error: 'export_failed' });
  }
});

app.post('/api/export/pdf', async (req, res) => {
  const text = (req.body && req.body.text) || '';
  const title = (req.body && req.body.title) || '';
  if (!text.trim()) return res.status(400).json({ error: 'empty_text' });
  try {
    const buffer = await buildPdf(text, title);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(title, 'pdf'));
    res.send(buffer);
  } catch (err) {
    console.error('[export/pdf]', err);
    res.status(500).json({ error: 'export_failed' });
  }
});

// ============================================================
// THREADS & MESSAGES
// ============================================================
function userThreads(userId) {
  return db.get('threads').filter({ userId }).orderBy('updatedAt', 'desc').value();
}

app.get('/api/threads', (req, res) => {
  res.json({ threads: userThreads(req.session.userId) });
});

app.post('/api/threads', (req, res) => {
  const thread = {
    id: uuidv4(),
    userId: req.session.userId,
    title: (req.body && req.body.title) || 'Новый диалог',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.get('threads').push(thread).write();
  res.status(201).json({ thread });
});

app.get('/api/threads/:id', (req, res) => {
  const thread = db.get('threads').find({ id: req.params.id, userId: req.session.userId }).value();
  if (!thread) return res.status(404).json({ error: 'not_found' });
  const messages = db.get('messages').filter({ threadId: thread.id }).orderBy('createdAt', 'asc').value();
  res.json({ thread, messages });
});

app.delete('/api/threads/:id', (req, res) => {
  const thread = db.get('threads').find({ id: req.params.id, userId: req.session.userId }).value();
  if (!thread) return res.status(404).json({ error: 'not_found' });
  db.get('threads').remove({ id: req.params.id }).write();
  db.get('messages').remove({ threadId: req.params.id }).write();
  clearTaskFiles(req.params.id); // режим «Компьютер»: убирает data/task-files/<threadId>, если они были
  res.json({ ok: true });
});

// Скачивание итогового архива с всеми файлами, созданными инструментом write_file в рамках одного треда
// (режим «Компьютер»). Собирает текущее состояние папки на момент запроса, а не снимок
// на момент конкретного сообщения — если агент добавит файлы позже, карточка скачивания из любого
// сообщения отдаст обновлённый архив.
app.get('/api/threads/:id/files.zip', async (req, res) => {
  const thread = db.get('threads').find({ id: req.params.id, userId: req.session.userId }).value();
  if (!thread) return res.status(404).json({ error: 'not_found' });
  try {
    const zipBuf = await buildTaskZip(thread.id);
    if (!zipBuf) return res.status(404).json({ error: 'no_files', message: 'Для этого диалога пока нет сохранённых файлов' });
    const safeTitle = (thread.title || 'yadro-task').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60) || 'yadro-task';
    // Content-Disposition допускает только ASCII в filename= — не-ASCII (кириллица) ломает заголовок
    // (Node бросает "Invalid character in header content"). Даём ASCII-фолбэк + RFC 5987 filename*
    // с полным UTF-8 именем, чтобы браузер показал оригинальный заголовок треда при скачивании.
    const asciiTitle = safeTitle.replace(/[^\x20-\x7E]/g, '') || 'yadro-task';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiTitle}.zip"; filename*=UTF-8''${encodeURIComponent(safeTitle)}.zip`
    );
    res.send(zipBuf);
  } catch (e) {
    res.status(500).json({ error: 'zip_failed', message: e.message || 'Ошибка сборки архива' });
  }
});

// Загрузка вложения-документа (PDF/DOCX/TXT/MD): извлекает текст и возвращает его клиенту —
// сам файл нигде не сохраняется на диске, только обрабатывается в памяти и сразу выбрасывается.
// Изображения сюда не ходят — они кодируются в base64 на клиенте и уходят прямо в /api/chat/send.
app.post('/api/uploads/extract', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'invalid_input', message: 'Файл не передан' });
  try {
    const { text, truncated } = await extractText(req.file.buffer, req.file.mimetype, req.file.originalname);
    res.json({ filename: req.file.originalname, text, truncated });
  } catch (e) {
    res.status(400).json({ error: 'extract_failed', message: e.message || 'Не удалось распознать файл' });
  }
});

// Транскрибация аудио/видео вложения (mp3/wav/mp4 и т.п.): пересылает файл на /audio/transcriptions
// провайдера, настроенного за режимом `mode` из тела запроса (тот же источник connectionId, что
// и обычная отправка сообщения) — своего распознавания речи в приложении нет, только прокси к
// внешнему Whisper-совместимому эндпоинту. Сам файл, как и в /api/uploads/extract, не сохраняется на диске.
app.post('/api/uploads/transcribe', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'invalid_input', message: 'Файл не передан' });
  const mode = String(req.body?.mode || 'computer');
  const assignments = db.get('modeAssignments').value();
  const assignment = assignments[mode] || assignments.computer || assignments.complex;
  if (!assignment) {
    return res.status(400).json({ error: 'no_connection', message: 'Для текущего режима не настроено подключение — откройте Настройки → Модели по режимам' });
  }
  const connection = getConnection(assignment.connectionId);
  if (!connection) {
    return res.status(400).json({ error: 'no_connection', message: 'Настроенное подключение не найдено (возможно, удалено) — проверьте Настройки' });
  }
  try {
    const text = await transcribeAudio(connection, req.file.buffer, req.file.originalname, req.file.mimetype);
    res.json({ filename: req.file.originalname, text, truncated: false });
  } catch (e) {
    res.status(400).json({ error: 'transcribe_failed', message: e.message || 'Не удалось распознать аудио/видео' });
  }
});

app.patch('/api/threads/:id', (req, res) => {
  const thread = db.get('threads').find({ id: req.params.id, userId: req.session.userId }).value();
  if (!thread) return res.status(404).json({ error: 'not_found' });
  const { title } = req.body || {};
  if (title) db.get('threads').find({ id: req.params.id }).assign({ title }).write();
  res.json({ thread: db.get('threads').find({ id: req.params.id }).value() });
});

// ---------- Отправка сообщения + SSE-стриминг ответа ----------
// Валидирует и обрезает вложения из тела запроса — защита от случайного разбухания db.json/запросов к модели.
const MAX_ATTACHMENTS = 5;
const MAX_IMAGE_DATA_URL_CHARS = 9 * 1024 * 1024; // ≈ 6.5Мб сырых данных до base64
const MAX_DOC_TEXT_CHARS = 12000;
function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, MAX_ATTACHMENTS)) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'image' && typeof a.dataUrl === 'string' && /^data:image\//.test(a.dataUrl) && a.dataUrl.length <= MAX_IMAGE_DATA_URL_CHARS) {
      out.push({ type: 'image', name: String(a.name || 'image').slice(0, 200), dataUrl: a.dataUrl });
    } else if (a.type === 'document' && typeof a.text === 'string' && a.text.trim()) {
      out.push({ type: 'document', name: String(a.filename || a.name || 'document').slice(0, 200), text: a.text.slice(0, MAX_DOC_TEXT_CHARS) });
    }
  }
  return out;
}

// Сборка исходящего content текущего сообщения и вложений в формат сообщения для модели: простая
// строка, если вложений нет, или multimodal-массив частей (OpenAI vision-схема), если есть картинки.
// Содержимое документов всегда добавляется как текст в чётко отмеченном блоке — это отдаётся только
// в текущий запрос; в истории треда для последующих сообщений оно повторно не подмешивается
// (иначе каждый следующий запрос в треде снова и снова таскал бы весь текст документа).
function buildOutgoingContent(baseText, attachments) {
  const docs = attachments.filter((a) => a.type === 'document');
  const images = attachments.filter((a) => a.type === 'image');
  let text = baseText;
  for (const d of docs) {
    text += `\n\n[Приложенный документ «${d.name}»]\n${d.text}\n[/Приложенный документ]`;
  }
  if (!images.length) return text;
  const parts = [{ type: 'text', text }];
  for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  return parts;
}

app.post('/api/chat/send', async (req, res) => {
  const userId = req.session.userId;
  const { threadId, content, mode, computerEnabled } = req.body || {};
  const attachments = sanitizeAttachments(req.body && req.body.attachments);

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'invalid_input', message: 'Пустое сообщение' });
  }
  if (!MODES.includes(mode)) {
    return res.status(400).json({ error: 'invalid_input', message: 'Некорректный режим' });
  }

  let thread = threadId && db.get('threads').find({ id: threadId, userId }).value();
  if (!thread) {
    thread = {
      id: uuidv4(),
      userId,
      title: content.trim().slice(0, 60),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.get('threads').push(thread).write();
  }

  // Сохраняем сообщение пользователя (текст-оригинал без приложенных данных — картинки/текст
  // документа подгрузится в модель отдельно, ниже; в UI вложения показываются как чипсы по attachments)
  const userMsg = {
    id: uuidv4(),
    threadId: thread.id,
    role: 'user',
    content: content.trim(),
    mode,
    computerEnabled: !!computerEnabled,
    attachments: attachments.length ? attachments.map((a) => ({ type: a.type, name: a.name })) : undefined,
    createdAt: new Date().toISOString(),
  };
  db.get('messages').push(userMsg).write();

  // История для контекста (последние 20 сообщений треда)
  const history = db.get('messages').filter({ threadId: thread.id }).orderBy('createdAt', 'asc').value();
  const chatMessages = history.map((m) => ({ role: m.role, content: m.content }));
  // Вложения примешиваются только к текущему (последнему) сообщению — chatMessages свежий массив, безобидна мутировать.
  if (attachments.length) {
    chatMessages[chatMessages.length - 1].content = buildOutgoingContent(content.trim(), attachments);
  }

  // Память о пользователе (короткая заметка в настройках → включается в каждый запрос
  // как system-сообщение, нигде не сохраняется в истории треда, поэтому перестраивается на каждый вызов).
  const currentUser = db.get('users').find({ id: userId }).value();
  const profileNote = (currentUser && currentUser.profileNote) || '';
  if (profileNote.trim()) {
    chatMessages.unshift({ role: 'system', content: `Память о пользователе (учитывай при ответе, но не ссылайся на неё явно, если это не к месту): ${profileNote.trim()}` });
  }

  const assignments = db.get('modeAssignments').value();

  // ---------- SSE setup ----------
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('thread', { thread });
  send('user_message', { message: userMsg });

  // ---------- Генерация изображения — отдельная ветка, не через streamChatCompletion ----------
  if (mode === 'image') {
    const assignment = assignments.image;
    if (!assignment) {
      send('error', { message: 'Для режима "Изображение" не настроено подключение/модель. Откройте Настройки → Модели по режимам.' });
      send('done', { aborted: true });
      return res.end();
    }
    const connection = getConnection(assignment.connectionId);
    if (!connection) {
      send('error', { message: 'Настроенное подключение для режима "Изображение" не найдено (возможно, удалено). Проверьте Настройки.' });
      send('done', { aborted: true });
      return res.end();
    }
    send('route', { mode, effectiveMode: 'image', connectionName: connection.name, model: assignment.model, orchestrator: false });
    try {
      const result = await generateImage(connection, assignment.model, { prompt: content.trim() });
      const assistantMsg = {
        id: uuidv4(),
        threadId: thread.id,
        role: 'assistant',
        content: result.revisedPrompt || content.trim(),
        mode,
        effectiveMode: 'image',
        routeInfo: null,
        connectionName: connection.name,
        model: assignment.model,
        images: result.images,
        revisedPrompt: result.revisedPrompt || undefined,
        usage: result.usage || undefined,
        createdAt: new Date().toISOString(),
      };
      db.get('messages').push(assistantMsg).write();
      db.get('threads').find({ id: thread.id }).assign({ updatedAt: new Date().toISOString() }).write();
      send('assistant_message', { message: assistantMsg });
      send('done', { aborted: false });
    } catch (e) {
      send('error', { message: e.message || 'Ошибка генерации изображения' });
      send('done', { aborted: true });
    }
    return res.end();
  }

  let effectiveMode = mode;
  let routeInfo = null;

  try {
    if (mode === 'orchestrator') {
      // Классификатор: используем подключение/модель режима "fast" как классификатор
      const classifierAssignment = assignments.fast;
      if (classifierAssignment) {
        const classifierConn = getConnection(classifierAssignment.connectionId);
        if (classifierConn) {
          send('routing', { status: 'classifying' });
          effectiveMode = await classifyRoute(classifierConn, classifierAssignment.model, content);
        } else {
          effectiveMode = 'fast';
        }
      } else {
        effectiveMode = 'fast';
      }
      routeInfo = { orchestrator: true, routedTo: effectiveMode };
    }

    const assignment = assignments[effectiveMode];
    if (!assignment) {
      send('error', {
        message: `Для режима "${effectiveMode}" не настроено подключение/модель. Откройте Настройки → Модели по режимам.`,
      });
      send('done', { aborted: true });
      res.end();
      return;
    }

    const connection = getConnection(assignment.connectionId);
    if (!connection) {
      send('error', { message: 'Настроенное подключение не найдено (возможно, удалено). Проверьте Настройки.' });
      send('done', { aborted: true });
      res.end();
      return;
    }

    send('route', {
      mode,
      effectiveMode,
      connectionName: connection.name,
      model: assignment.model,
      orchestrator: mode === 'orchestrator',
    });

    const assistantId = uuidv4();
    let fullText = '';
    let citations = null;
    let usage = null;

    // Автономный вызов инструментов — в режиме «Компьютер» всегда включены run_code + write_file и больше
    // раундов (это сам смысл режима — автономный агент без ручного тоггла); в остальных режимах
    // — только run_code и только если явно разрешено в настройках (allowAutoCodeExec). Промежуточные
    // раунды (assistant/tool) не сохраняются в истории треда — только в журнале codeRuns
    // и в отправляемых клиенту SSE-событиях tool_event (для прозрачности в UI).
    const settingsNow = db.get('settings').value() || {};
    let finalChatMessages = chatMessages;
    let toolsForThisTurn = null;
    let maxRounds = 3;
    let modelForFinalStream = assignment.model;
    let orchestration = null;
    if (effectiveMode === 'computer') {
      // Режим «Компьютер» не работает на одной зафиксированной модели: сам подбирает модель(и)
      // из пула подключения под конкретную задачу (см. server/orchestrator.js), при необходимости
      // параллельно раскладывает задачу на подзадачи для разных моделей, собирает единый результат
      // и дополнительно перепроверяет его (технически + смысловым вызовом модели) перед ответом.
      const overridesForConn = db.get(`modelCapabilityOverrides.${assignment.connectionId}`).value() || {};
      const pool = await buildModelPool(connection, overridesForConn);
      orchestration = await orchestrateComputerTask({
        connection,
        pool,
        chatMessages,
        tools: [RUN_CODE_TOOL, WRITE_FILE_TOOL, CREATE_DOCUMENT_TOOL],
        executeToolCall: (name, args) => executeToolCall(name, args, { userId, threadId: thread.id }),
        fallbackModel: assignment.model || null,
        onEvent: (event, data) => send(event, data),
        listTaskFilesFn: () => (hasTaskFiles(thread.id) ? listTaskFiles(thread.id) : []),
      });
      finalChatMessages = orchestration.finalMessages;
      modelForFinalStream = orchestration.finalModel;
      send('route', {
        mode,
        effectiveMode,
        connectionName: connection.name,
        model: modelForFinalStream,
        orchestrator: mode === 'orchestrator',
      });
    } else if (settingsNow.allowAutoCodeExec && effectiveMode !== 'image') {
      toolsForThisTurn = [RUN_CODE_TOOL];
    }
    if (toolsForThisTurn) {
      finalChatMessages = await runToolLoop(
        connection,
        assignment.model,
        chatMessages,
        toolsForThisTurn,
        (name, args) => executeToolCall(name, args, { userId, threadId: thread.id }),
        {
          maxRounds,
          onToolEvent: (evt) => send('tool_event', evt),
        },
      );
    }

    await streamChatCompletion(connection, modelForFinalStream, finalChatMessages, {
      webSearch: !!computerEnabled,
      onToken: (token) => {
        fullText += token;
        send('token', { id: assistantId, token });
      },
      onCitations: (c) => {
        citations = c;
      },
      onError: (message) => {
        send('error', { message });
      },
      onDone: (result) => {
        // Статистика токенов от провайдера (если он её отдал) — никаких выдуманных чисел, если провайдер молчит.
        if (result && result.usage) usage = result.usage;
      },
    });

    const assistantMsg = {
      id: assistantId,
      threadId: thread.id,
      role: 'assistant',
      content: fullText,
      mode,
      effectiveMode,
      routeInfo,
      connectionName: connection.name,
      model: modelForFinalStream,
      citations: citations || undefined,
      usage: usage || undefined,
      createdAt: new Date().toISOString(),
    };
    if (orchestration) {
      assistantMsg.orchestration = {
        subtasks: orchestration.plan.subtasks.map((s) => ({ id: s.id, title: s.title, capability: s.capability, model: s.model })),
        source: orchestration.plan.source,
        verification: orchestration.verification,
      };
    }

    // Режим «Компьютер»: если агент создал файлы инструментом write_file, прикрепляем их список
    // к сообщению (переживает перезагрузку страницы) и шлём отдельное SSE-событие, по которому
    // клиент сразу рисует карточку скачивания без ожидания follow-up запроса.
    if (effectiveMode === 'computer' && hasTaskFiles(thread.id)) {
      const files = listTaskFiles(thread.id);
      assistantMsg.taskFiles = files;
      assistantMsg.taskFilesUrl = `/api/threads/${thread.id}/files.zip`;
    }

    db.get('messages').push(assistantMsg).write();
    db.get('threads').find({ id: thread.id }).assign({ updatedAt: new Date().toISOString() }).write();

    send('assistant_message', { message: assistantMsg });
    if (assistantMsg.taskFiles) {
      send('files_ready', { threadId: thread.id, files: assistantMsg.taskFiles, downloadUrl: assistantMsg.taskFilesUrl });
    }
    send('done', { aborted: false });
    res.end();
  } catch (e) {
    send('error', { message: e.message || 'Внутренняя ошибка сервера' });
    send('done', { aborted: true });
    res.end();
  }
});

// ============================================================
// Статика и защита страниц
// ============================================================
const PUBLIC_DIR = path.join(__dirname, 'public');

// login.html и setup.html доступны без сессии
app.get('/login.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/setup.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'setup.html')));

// Все прочие HTML-страницы защищены
app.get('/', requirePageAuth, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/index.html', requirePageAuth, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use(express.static(PUBLIC_DIR));

// Обработчик ошибок multer (наиболее частая — превышен LIMIT_FILE_SIZE на /api/uploads/extract),
// без него Express вернёт голую HTML-страницу видо-деталей вместо JSON.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'upload_failed', message: err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой (максимум 15 Мб)' : err.message });
  }
  return next(err);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Ядро запущено на http://0.0.0.0:${PORT}`);
});

// Планировщик периодических задач — см. server/scheduler.js и маршруты /api/scheduled-tasks/*.
schedulerHandle = startScheduler({ db, getConnection, chatCompletionOnce });
