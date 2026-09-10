// Мок Piston-совместимого сервера для сквозного теста выполнения кода без реального Docker.
// Отвечает на GET /api/v2/runtimes и POST /api/v2/execute в формате настоящего Piston API
// (https://github.com/engineer-man/piston), но по-настоящему запускает код локальными
// интерпретаторами (node/python3/bash) с жёстким таймаутом и лимитом вывода.
//
// ВНИМАНИЕ: это НЕ песочница — процесс выполняется прямо в этом контейнере/окружении без
// namespace/cgroup-изоляции. Годится только для локальной разработки и тестов пайплайна
// «кнопка → API → рендер результата». В продакшене вместо этого файла должен работать
// настоящий Piston-контейнер (см. docker-compose.yml и CODE_EXECUTION_DESIGN.md).
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.MOCK_PISTON_PORT || '4143', 10);

const RUNTIMES = [
  { language: 'python', version: '3.11.4', aliases: ['python3', 'py'], runtime: 'cpython' },
  { language: 'javascript', version: '20.11.1', aliases: ['node', 'nodejs', 'js'], runtime: 'node' },
  { language: 'bash', version: '5.2.0', aliases: ['sh', 'shell'], runtime: 'bash' },
];

const RUN_TIMEOUT_MS = 5000;
const OUTPUT_LIMIT = 64 * 1024;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function truncate(str) {
  if (!str) return str || '';
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= OUTPUT_LIMIT) return str;
  return buf.slice(0, OUTPUT_LIMIT).toString('utf8') + '\n…[обрезано мок-сервером]';
}

// Запускает файл с кодом через нужный интерпретатор и возвращает {stdout, stderr, code, signal}.
function runFile(language, filePath, stdin) {
  return new Promise((resolve) => {
    let cmd;
    let args;
    if (language === 'python') { cmd = 'python3'; args = [filePath]; }
    else if (language === 'javascript') { cmd = 'node'; args = [filePath]; }
    else if (language === 'bash') { cmd = 'bash'; args = [filePath]; }
    else { resolve({ stdout: '', stderr: `Неизвестный язык: ${language}`, code: 1, signal: null }); return; }

    const child = spawn(cmd, args, { timeout: RUN_TIMEOUT_MS, cwd: path.dirname(filePath) });
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > OUTPUT_LIMIT * 2) child.kill('SIGKILL'); });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > OUTPUT_LIMIT * 2) child.kill('SIGKILL'); });

    if (stdin) { child.stdin.write(stdin); }
    child.stdin.end();

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: truncate(stdout), stderr: truncate(stderr + '\n' + err.message), code: 1, signal: null });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: truncate(stdout),
        stderr: truncate(stderr) + (killedByTimeout ? '\n[мок-сервер: превышен таймаут выполнения]' : ''),
        code: killedByTimeout ? null : code,
        signal: killedByTimeout ? 'SIGKILL' : signal,
      });
    });
  });
}

function extFor(language) {
  if (language === 'python') return 'py';
  if (language === 'javascript') return 'js';
  if (language === 'bash') return 'sh';
  return 'txt';
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/v2/runtimes') {
    return sendJson(res, 200, RUNTIMES);
  }

  if (req.method === 'POST' && req.url === '/api/v2/execute') {
    const body = await readBody(req);
    const language = String(body.language || '').toLowerCase();
    const files = Array.isArray(body.files) ? body.files : [];
    const content = files[0] && typeof files[0].content === 'string' ? files[0].content : '';
    const known = RUNTIMES.some((r) => r.language === language);
    if (!known) {
      return sendJson(res, 400, { message: `Язык выполнения не найден: ${language}` });
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-piston-'));
    const filePath = path.join(dir, `main.${extFor(language)}`);
    fs.writeFileSync(filePath, content, 'utf8');

    const started = Date.now();
    const result = await runFile(language, filePath, body.stdin);
    const runtime = RUNTIMES.find((r) => r.language === language);

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    return sendJson(res, 200, {
      language,
      version: runtime.version,
      run: { stdout: result.stdout, stderr: result.stderr, code: result.code, signal: result.signal, output: result.stdout + result.stderr },
      _mockDurationMs: Date.now() - started,
    });
  }

  sendJson(res, 404, { message: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`[mock-piston-server] слушает на порту ${PORT} (языки: ${RUNTIMES.map((r) => r.language).join(', ')})`);
});
