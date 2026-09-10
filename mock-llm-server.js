// Мок OpenAI-совместимого сервера для сквозного теста без реального ключа Polza.ai.
// Отвечает на GET /models и стримит SSE-ответ на POST /chat/completions.
// Иногда включает поле citations (в духе Perplexity Sonar), чтобы проверить вкладку "Источники".
const http = require('http');

const PORT = parseInt(process.env.MOCK_PORT || '4142', 10);

// Набор макетов для теста разметки возможностей (server/modelCapabilities.js#inferCapabilities) и
// мультимодельной диспетчеризации оркестратора режима «Компьютер» без реального ключа Polza.ai:
// mock-fast-1 -> fast, mock-code-1 -> code, mock-reasoning-large -> reasoning, mock-vision-pro -> vision,
// mock-audio-whisper -> audio, mock-complex-1/mock-sonar-cited/mock-image-1 -> general (старые, совместимость).
const MODELS = ['mock-fast-1', 'mock-code-1', 'mock-complex-1', 'mock-sonar-cited', 'mock-image-1', 'mock-reasoning-large', 'mock-vision-pro', 'mock-audio-whisper'];

// Маленький валидный PNG 8x8 (сплошной цвет), закодированный в base64 — для теста без реального API-ключа.
const MOCK_IMAGE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAI0lEQVR4nGP8z8DwHwYYGP4zoIkxMDAwMDCwMKAaCcAAABsSBRQR8SDBAAAAAElFTkSuQmCC';

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

function fakeAnswer(userText, model, hasImageParts) {
  const lower = (userText || '').toLowerCase();
  const imgNote = hasImageParts ? ' (получено изображение — мок имитирует vision-ответ без реального распознавания)' : '';
  if (lower.includes('код') || lower.includes('code') || model.includes('code')) {
    return `Вот пример кода по вашему запросу «${userText}»${imgNote}:\n\n\`\`\`python\ndef sum_two(a, b):\n    return a + b\n\`\`\`\n\nЭта функция складывает два числа. В режиме "Код" мок-сервер имитирует ответ модели ${model}.`;
  }
  if (lower.includes('сложн') || lower.includes('почему') || model.includes('complex')) {
    return `Это сложный вопрос: «${userText}». Мок-сервер (модель ${model}) сформировал развёрнутый ответ с несколькими шагами рассуждения. Во-первых, нужно учесть контекст. Во-вторых, важны нюансы. В-третьих, вывод: тестовый ответ сгенерирован успешно.`;
  }
  return `Быстрый тестовый ответ на вопрос «${userText}» от модели ${model}. Это фиктивный (мок) ответ для сквозного теста приложения Ядро.`;
}

const CITATIONS_SAMPLE = [
  { title: 'Mock Source One — Example Docs', url: 'https://example.com/docs/one' },
  { title: 'Mock Source Two — Reference', url: 'https://example.org/reference' },
  { title: 'Mock Source Three — Wiki', url: 'https://example.net/wiki/page' },
];

// Имитация формата аннотаций Polza.ai/OpenAI при plugins:[{id:'web'}].
const ANNOTATIONS_SAMPLE = [
  { type: 'url_citation', url_citation: { url: 'https://example.com/web-search/one', title: 'Mock Web Result One' } },
  { type: 'url_citation', url_citation: { url: 'https://example.org/web-search/two', title: 'Mock Web Result Two' } },
];

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url.endsWith('/models')) {
    return sendJson(res, 200, { data: MODELS.map((id) => ({ id, object: 'model' })) });
  }

  if (req.method === 'POST' && url.endsWith('/images/generations')) {
    const body = await readBody(req);
    const prompt = body.prompt || '';
    // Имитируем небольшую задержку, как у реального провайдера, чтобы было видно состояние загрузки в UI.
    setTimeout(() => {
      sendJson(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: MOCK_IMAGE_B64, revised_prompt: `[тест] ${prompt}` }],
        usage: { cost_rub: 2.5 },
      });
    }, 600);
    return;
  }

  if (req.method === 'POST' && url.endsWith('/audio/transcriptions')) {
    // Мультипарт-тело не разбираем — мок не распознаёт реальный аудио, только возвращает фиксированный
    // текст для сквозного теста /api/uploads/transcribe без реального ключа провайдера.
    req.on('data', () => {}); // дренируем тело запроса, иначе клиент может не дождаться завершения ответа
    req.on('end', () => {
      sendJson(res, 200, { text: '[Мок-транскрибация] Файл успешно распознан мок-сервером. Здесь был бы реальный текст, расшифрованный из аудио/видео.' });
    });
    return;
  }

  if (req.method === 'POST' && url.endsWith('/chat/completions')) {
    const body = await readBody(req);
    const messages = body.messages || [];
    const model = body.model || 'mock-fast-1';
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    // Вложения (изображения) приводят content к массиву частей в стиле OpenAI vision —
    // вытаскиваем только текстовые части, чтобы мок мог имитировать ответ как и реальный vision-провайдер.
    const rawContent = lastUser ? lastUser.content : '';
    const userText = Array.isArray(rawContent)
      ? rawContent.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ')
      : rawContent || '';
    const hasImageParts = Array.isArray(rawContent) && rawContent.some((p) => p && p.type === 'image_url');
    const isClassifier = messages.some((m) => m.role === 'system' && /fast, code|fast\b.*code\b.*complex|\u043c\u0430\u0440\u0448\u0440\u0443\u0442\u0438\u0437\u0430\u0442\u043e\u0440/i.test(m.content || ''));

    // Имитация function calling: если клиент передал tools и в истории ещё нет результата
    // инструмента (role:'tool') — если в тексте пользователя есть триггер-слово — отвечает запросом
    // на вызов run_code (только не-стриминговый режим — так его и вызывает chatCompletionWithTools).
    // Второй раунд (когда role:'tool' уже есть в истории) отвечает обычным текстом, ссылаясь на результат.
    const hasTools = Array.isArray(body.tools) && body.tools.some((t) => t && t.function && t.function.name === 'run_code');
    const hasToolResult = messages.some((m) => m.role === 'tool');
    const wantsCodeRun = /запусти|выполни|посчитай|run.?code|execute/i.test(userText || '');
    const hasWriteFileTool = Array.isArray(body.tools) && body.tools.some((t) => t && t.function && t.function.name === 'write_file');
    const wantsFileWrite = /создай файл|сохрани файл|write.?file/i.test(userText || '');
    // Имитация вызова create_document — тест бинарных форматов без реального ключа провайдера.
    // Формат выбирается по ключевым словам в тексте пользователя — удобно для ручного curl-теста любого из форматов.
    const hasCreateDocTool = Array.isArray(body.tools) && body.tools.some((t) => t && t.function && t.function.name === 'create_document');
    const wantsCreateDoc = /сделай (таблицу|excel|xlsx|презентацию|pptx|pdf|docx|csv|rtf|odt|ворд|документ)/i.test(userText || '');
    function pickMockDocArgs(text) {
      const t = (text || '').toLowerCase();
      if (/таблиц|excel|xlsx/.test(t)) return { format: 'xlsx', filename: 'Отчёт.xlsx', title: 'Отчёт', rows: [['Статья', 'Сумма'], ['Мок-тест', 42]] };
      if (/презентац|pptx|слайд/.test(t)) return { format: 'pptx', filename: 'Презентация.pptx', slides: [{ title: 'Мок-слайд', bullets: ['Пункт один', 'Пункт два'] }] };
      if (/csv/.test(t)) return { format: 'csv', filename: 'данные.csv', rows: [['A', 'B'], [1, 2]] };
      if (/rtf/.test(t)) return { format: 'rtf', filename: 'документ.rtf', title: 'Документ', content: '# Заголовок\nМок-текст.' };
      if (/odt/.test(t)) return { format: 'odt', filename: 'документ.odt', title: 'Документ', content: '# Заголовок\nМок-текст.' };
      if (/word|docx/.test(t)) return { format: 'docx', filename: 'Документ.docx', title: 'Документ', content: '# Заголовок\nМок-текст.' };
      return { format: 'pdf', filename: 'Документ.pdf', title: 'Документ', content: '# Заголовок\nМок-текст.' };
    }

    // Имитация вызова write_file для теста режима «Компьютер» без реального ключа провайдера.
    if (body.stream === false && hasWriteFileTool && wantsFileWrite && !hasToolResult) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        id: 'mock-toolcall-wf-' + Date.now(),
        object: 'chat.completion',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_mock_wf_1',
              type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ filename: 'hello.txt', content: 'Привет от агента! Файл создан в режиме «Компьютер».' }) },
            }],
          },
        }],
      }));
    }

    if (body.stream === false && hasCreateDocTool && wantsCreateDoc && !hasToolResult) {
      const docArgs = pickMockDocArgs(userText);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        id: 'mock-toolcall-cd-' + Date.now(),
        object: 'chat.completion',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_mock_cd_1',
              type: 'function',
              function: { name: 'create_document', arguments: JSON.stringify(docArgs) },
            }],
          },
        }],
      }));
    }

    if (body.stream === false && hasTools && wantsCodeRun && !hasToolResult) {
      // Модель «решает» вызвать run_code вместо ответа текстом.
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        id: 'mock-toolcall-' + Date.now(),
        object: 'chat.completion',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_mock_1',
              type: 'function',
              function: { name: 'run_code', arguments: JSON.stringify({ language: 'python', code: 'print(2 + 2)' }) },
            }],
          },
        }],
      }));
    }

    if (body.stream === false && hasTools && hasToolResult) {
      const toolMsg = [...messages].reverse().find((m) => m.role === 'tool');
      const answer = `Агент выполнил код и получил результат: ${toolMsg ? toolMsg.content : '(нет данных)'}. Мок-ответ (модель ${model}) после автономного вызова инструмента.`;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        id: 'mock-toolresult-' + Date.now(),
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      }));
    }

    // Мок-планировщик и мок-контролёр качества для сквозного теста оркестратора режима «Компьютер»
    // (server/orchestrator.js) без реального ключа провайдера — отвечают строгим JSON, как и требует реальный агент.
    const systemContent = messages.filter((m) => m.role === 'system').map((m) => m.content || '').join('\n');
    const isPlanner = /\u043f\u043b\u0430\u043d\u0438\u0440\u043e\u0432\u0449\u0438\u043a \u0437\u0430\u0434\u0430\u0447 \u0434\u043b\u044f \u0430\u0432\u0442\u043e\u043d\u043e\u043c\u043d\u043e\u0433\u043e \u0430\u0433\u0435\u043d\u0442\u0430/i.test(systemContent);
    const isVerifier = /\u043a\u043e\u043d\u0442\u0440\u043e\u043b\u0451\u0440 \u043a\u0430\u0447\u0435\u0441\u0442\u0432\u0430 \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442\u0430/i.test(systemContent);

    if (body.stream === false && isPlanner) {
      const modelLines = [...systemContent.matchAll(/^- (\S+) \[([^\]]*)\]$/gm)].map((m) => ({ id: m[1], tags: m[2].split(',').map((s) => s.trim()) }));
      function findByTag(tag) {
        const found = modelLines.find((m) => m.tags.includes(tag));
        return found ? found.id : (modelLines[0] ? modelLines[0].id : 'mock-fast-1');
      }
      const wantsSplit = /\u043c\u043e\u043a:\u0440\u0430\u0437\u0434\u0435\u043b\u0438/i.test(userText);
      const wantsDoc = /\u0441\u0434\u0435\u043b\u0430\u0439 (\u0442\u0430\u0431\u043b\u0438\u0446\u0443|excel|xlsx|\u043f\u0440\u0435\u0437\u0435\u043d\u0442\u0430\u0446\u0438\u044e|pptx|pdf|docx|csv|rtf|odt|\u0432\u043e\u0440\u0434|\u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442)/i.test(userText);
      const docArgs = wantsDoc ? pickMockDocArgs(userText) : null;
      let plan;
      if (wantsSplit) {
        plan = {
          subtasks: [
            { id: 's1', title: '\u0410\u043d\u0430\u043b\u0438\u0437 \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u044f', capability: 'vision', model: findByTag('vision'), instructions: '\u041f\u0440\u043e\u0430\u043d\u0430\u043b\u0438\u0437\u0438\u0440\u0443\u0439 \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435.' },
            { id: 's2', title: '\u041d\u0430\u043f\u0438\u0441\u0430\u043d\u0438\u0435 \u043a\u043e\u0434\u0430', capability: 'code', model: findByTag('code'), instructions: '\u041d\u0430\u043f\u0438\u0448\u0438 \u043a\u043e\u0434 \u043f\u043e \u0437\u0430\u043f\u0440\u043e\u0441\u0443.' },
          ],
          needsDocumentOutput: !!wantsDoc,
          outputFormat: docArgs ? docArgs.format : null,
          outputFilename: docArgs ? docArgs.filename : null,
        };
      } else {
        plan = {
          subtasks: [{ id: 's1', title: '\u0412\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u0435 \u0437\u0430\u0434\u0430\u0447\u0438', capability: wantsDoc ? 'general' : 'fast', model: findByTag(wantsDoc ? 'general' : 'fast'), instructions: userText }],
          needsDocumentOutput: !!wantsDoc,
          outputFormat: docArgs ? docArgs.format : null,
          outputFilename: docArgs ? docArgs.filename : null,
        };
      }
      return sendJson(res, 200, {
        id: 'mock-plan-' + Date.now(),
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(plan) }, finish_reason: 'stop' }],
      });
    }

    if (body.stream === false && isVerifier) {
      const wantsFail = /\u043c\u043e\u043a:\u043d\u0435\u0432\u0435\u0440\u043d\u043e/i.test(userText);
      const verdict = wantsFail
        ? { ok: false, issues: '\u0442\u0435\u0441\u0442\u043e\u0432\u0430\u044f \u043f\u0440\u043e\u0431\u043b\u0435\u043c\u0430: \u043c\u043e\u043a-\u043a\u043e\u043d\u0442\u0440\u043e\u043b\u0451\u0440 \u043d\u0430\u0448\u0451\u043b \u0442\u0440\u0438\u0433\u0433\u0435\u0440 \u041c\u041e\u041a:\u041d\u0435\u0432\u0435\u0440\u043d\u043e' }
        : { ok: true, issues: '' };
      return sendJson(res, 200, {
        id: 'mock-verify-' + Date.now(),
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(verdict) }, finish_reason: 'stop' }],
      });
    }

    if (isClassifier) {
      // Классификатор: не-стриминговый ответ одним словом
      const lower = (userText || '').toLowerCase();
      let route = 'fast';
      if (lower.includes('код') || lower.includes('code') || lower.includes('script') || lower.includes('powershell')) route = 'code';
      else if (lower.includes('почему') || lower.includes('сравни') || lower.includes('объясни') || lower.includes('разниц')) route = 'complex';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        id: 'mock-classify-' + Date.now(),
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: route }, finish_reason: 'stop' }],
      }));
    }

    if (body.stream === false) {
      const answer = fakeAnswer(userText, model, hasImageParts);
      return sendJson(res, 200, {
        id: 'mock-' + Date.now(),
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      });
    }

    // Стриминг SSE, формат совместим с OpenAI
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const hasWebPlugin = Array.isArray(body.plugins) && body.plugins.some((p) => p && p.id === 'web');
    const answer = hasWebPlugin
      ? `${fakeAnswer(userText, model, hasImageParts)} (включён веб-поиск — мок-источники ниже)`
      : fakeAnswer(userText, model, hasImageParts);
    const words = answer.split(/(\s+)/); // сохраняем пробелы как отдельные токены
    const includeCitations = !hasWebPlugin && (model.includes('sonar') || Math.random() < 0.5); // иногда с цитатами, иногда без
    // Имитируем что не все провайдеры отдают usage — нужно проверить что счётчик в UI корректно прятан, когда данных нет.
    const includeUsage = Math.random() < 0.7;

    let i = 0;
    const chunkId = 'mock-chunk-' + Date.now();

    function sendChunk(deltaContent, extra = {}) {
      const payload = {
        id: chunkId,
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: deltaContent !== undefined ? { content: deltaContent } : {}, finish_reason: null }],
        ...extra,
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

    const interval = setInterval(() => {
      if (i >= words.length) {
        clearInterval(interval);
        const finalChunk = { id: chunkId, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
        if (includeCitations) {
          // Отправляем финальный чанк с citations на верхнем уровне (стиль Perplexity Sonar)
          finalChunk.citations = CITATIONS_SAMPLE;
        }
        if (hasWebPlugin) {
          // Формат веб-визажа Polza.ai/OpenAI: annotations с url_citation в delta итогового чанка.
          finalChunk.choices[0].delta.annotations = ANNOTATIONS_SAMPLE;
        }
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        if (includeUsage) {
          // Завершающий chunk c usage и пустым choices — так обычно возвращают статистику OpenAI-совместимые API с stream_options.include_usage.
          const promptTokens = Math.max(8, Math.round(userText.length / 4));
          const completionTokens = Math.max(4, Math.round(answer.length / 4));
          res.write(`data: ${JSON.stringify({
            id: chunkId,
            object: 'chat.completion.chunk',
            model,
            choices: [],
            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
          })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      sendChunk(words[i]);
      i++;
    }, 25);

    req.on('close', () => clearInterval(interval));
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mock LLM server listening on http://0.0.0.0:${PORT}`);
});
