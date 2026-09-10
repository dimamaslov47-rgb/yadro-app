// Клиент для исполнителя кода, совместимого с Piston API (https://github.com/engineer-man/piston).
// В продакшене PISTON_URL указывает на соседний Docker-контейнер (см. docker-compose.yml,
// сеть code-exec-net). Локально/в тестах — на mock-piston-server.js (см. корень проекта).
const fetch = require('node-fetch');

const PISTON_URL = (process.env.PISTON_URL || 'http://127.0.0.1:4143').replace(/\/+$/, '');
const OUTPUT_LIMIT = 64 * 1024; // 64 КБ — защита от гигантского вывода, см. CODE_EXECUTION_DESIGN.md §6
const RUN_TIMEOUT_MS = 5000;
const COMPILE_TIMEOUT_MS = 10000;
const RUN_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024; // 256 МБ
const MAX_CODE_BYTES = 200 * 1024; // 200 КБ — лимит на входной код
const RUNTIMES_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = COMPILE_TIMEOUT_MS + RUN_TIMEOUT_MS + 5000;

// Синонимы языков, под которыми они встречаются в блоках кода markdown (```python, ```js, ...),
// сопоставленные с каноническими именами языков в Piston.
const LANGUAGE_ALIASES = {
  python: 'python', py: 'python', python3: 'python',
  javascript: 'javascript', js: 'javascript', node: 'javascript', nodejs: 'javascript',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash',
};

let runtimesCache = null;
let runtimesCacheAt = 0;

async function fetchRuntimes() {
  const now = Date.now();
  if (runtimesCache && now - runtimesCacheAt < RUNTIMES_TTL_MS) return runtimesCache;
  const res = await fetch(`${PISTON_URL}/api/v2/runtimes`, { timeout: 8000 });
  if (!res.ok) throw new Error(`Исполнитель кода недоступен (HTTP ${res.status})`);
  const list = await res.json();
  runtimesCache = Array.isArray(list) ? list : [];
  runtimesCacheAt = now;
  return runtimesCache;
}

// Пересечение того, что мы умеем сопоставлять (LANGUAGE_ALIASES), с тем, что реально
// установлено у исполнителя. Если исполнитель недоступен — возвращает [], фронтенд просто
// скрывает кнопку "Запустить" на всех блоках кода.
async function getSupportedLanguages() {
  let installed;
  try {
    installed = await fetchRuntimes();
  } catch (e) {
    return [];
  }
  const installedLangs = new Set(installed.map((r) => r.language));
  const result = new Set();
  for (const [alias, canonical] of Object.entries(LANGUAGE_ALIASES)) {
    if (installedLangs.has(canonical)) result.add(alias);
  }
  return Array.from(result);
}

function resolveLanguage(rawLang) {
  const key = String(rawLang || '').toLowerCase().trim();
  return LANGUAGE_ALIASES[key] || null;
}

function truncate(text) {
  if (!text) return { text: text || '', truncated: false };
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= OUTPUT_LIMIT) return { text, truncated: false };
  return { text: buf.slice(0, OUTPUT_LIMIT).toString('utf8') + '\n…[вывод обрезан]', truncated: true };
}

function fileNameFor(canonical) {
  if (canonical === 'python') return 'main.py';
  if (canonical === 'javascript') return 'main.js';
  if (canonical === 'bash') return 'main.sh';
  return 'main.txt';
}

// Выполняет код через Piston (или мок в разработке). Бросает Error с человекочитаемым
// сообщением при любой проблеме — вызывающая сторона (server.js) превращает её в HTTP-ответ.
async function runCode({ language, code, stdin }) {
  const canonical = resolveLanguage(language);
  if (!canonical) {
    throw new Error(`Язык «${language}» не поддерживается исполнителем кода`);
  }
  if (!code || !code.trim()) {
    throw new Error('Пустой код');
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    throw new Error(`Код слишком большой (лимит ${Math.round(MAX_CODE_BYTES / 1024)} КБ)`);
  }

  const started = Date.now();
  let res;
  try {
    res = await fetch(`${PISTON_URL}/api/v2/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language: canonical,
        version: '*',
        files: [{ name: fileNameFor(canonical), content: code }],
        stdin: stdin || '',
        compile_timeout: COMPILE_TIMEOUT_MS,
        run_timeout: RUN_TIMEOUT_MS,
        run_memory_limit: RUN_MEMORY_LIMIT_BYTES,
      }),
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (e) {
    throw new Error(`Исполнитель кода недоступен: ${e.message}`);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Некорректный ответ исполнителя (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(json.message || `Исполнитель вернул ошибку (HTTP ${res.status})`);
  }

  const durationMs = Date.now() - started;
  const run = json.run || {};
  const compile = json.compile || null;
  const stdoutT = truncate(run.stdout || '');
  const stderrCombined = [compile && compile.stderr, run.stderr].filter(Boolean).join('\n');
  const stderrT = truncate(stderrCombined);

  return {
    language: canonical,
    version: json.version || null,
    stdout: stdoutT.text,
    stderr: stderrT.text,
    truncated: stdoutT.truncated || stderrT.truncated,
    exitCode: typeof run.code === 'number' ? run.code : null,
    signal: run.signal || null,
    durationMs,
  };
}

module.exports = { runCode, getSupportedLanguages, resolveLanguage };
