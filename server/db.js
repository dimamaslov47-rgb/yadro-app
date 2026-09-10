// Простое JSON файловое хранилище на базе lowdb (без нативных модулей).
const path = require('path');
const fs = require('fs');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'db.json');
const adapter = new FileSync(DB_FILE);
const db = low(adapter);

db.defaults({
  users: [],
  connections: [],
  modeAssignments: {
    orchestrator: null, // { connectionId, model }  -- used mainly as classifier fallback display
    fast: null,
    code: null,
    complex: null,
    image: null, // генерация изображений — доступен только при явном выборе режима, оркестратор сюда никогда не маршрутизирует
    // computer.model может быть null («авто» — агент сам подбирает модель/модели из пула подключения
    // под каждую задачу, см. server/orchestrator.js и server/modelCapabilities.js).
    computer: null,
  },
  // Разметка возможностей моделей, вручную переопределённая администратором (по умолчанию —
  // авто-разметка по имени модели, см. server/modelCapabilities.js#inferCapabilities).
  // Форма: { [connectionId]: { [modelId]: ['reasoning', 'code', ...] } }
  modelCapabilityOverrides: {},
  threads: [],
  messages: [],
  // Общие настройки приложения (не привязаны к конкретному пользователю).
  // allowAutoCodeExec — разрешает ли модель/агент самостоятельно (без ручного нажатия кнопки)
  // вызывать выполнение кода. По умолчанию выключено — см. CODE_EXECUTION_DESIGN.md §3.1.
  settings: {
    allowAutoCodeExec: false,
  },
  // Журнал запусков кода (для контроля частоты и постфактум-аудита) — см. §7 дизайн-документа.
  codeRuns: [],
  // Периодические задачи планировщика — см. server/scheduler.js.
  // { id, userId, title, prompt, mode, intervalMinutes, enabled, threadId, lastRunAt, nextRunAt, lastError, createdAt }
  scheduledTasks: [],
}).write();

// На случай обновления с более старой версии БД, где секции settings/codeRuns/scheduledTasks
// ещё не существовало.
if (!db.get('settings').value()) {
  db.set('settings', { allowAutoCodeExec: false }).write();
}
if (!db.get('codeRuns').value()) {
  db.set('codeRuns', []).write();
}
if (!db.get('scheduledTasks').value()) {
  db.set('scheduledTasks', []).write();
}
if (db.get('modeAssignments.computer').value() === undefined) {
  db.set('modeAssignments.computer', null).write();
}
if (!db.get('modelCapabilityOverrides').value()) {
  db.set('modelCapabilityOverrides', {}).write();
}

// Polza.ai добавляется подключением по умолчанию на чистой установке (когда подключений ещё нет),
// чтобы не заставлять вводить Base URL вручную — остаётся вписать свой API-ключ и нажать
// «Проверить». Ключ пустой — без него запросы к Polza.ai закономерно вернут ошибку авторизации —
// приложение никогда не выдаёт фиктивный успех.
if (db.get('connections').size().value() === 0) {
  db.get('connections')
    .push({
      id: uuidv4(),
      name: 'Polza.ai',
      baseUrl: 'https://polza.ai/api/v1',
      apiKey: '',
      defaultModel: null,
      createdAt: new Date().toISOString(),
    })
    .write();
}

module.exports = db;
