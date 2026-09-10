// Модуль общения с настроенными OpenAI-совместимыми эндпоинтами.
const fetch = require('node-fetch');

// Получить список моделей у подключения: GET {base_url}/models
async function fetchModels(baseUrl, apiKey) {
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const res = await fetch(url, {
    method: 'GET',
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    timeout: 15000,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Некорректный ответ (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = (json && (json.error?.message || json.error || json.message)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const list = json.data || json.models || (Array.isArray(json) ? json : []);
  return list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
}

// Генерация изображения: POST {images_url}/images/generations (OpenAI-совместимая схема, response_format=b64_json,
// чтобы не зависеть от CDN-ссылок провайдера, которые часто протухают через несколько дней).
// У Polza.ai этот эндпоинт реально живёт на /v2, а не /v1 (авто-подмену /v1→/v2 делает только их
// официальный SDK-клиент, обычный fetch на baseUrl вида ".../api/v1" получит 404) — подставляем сами.
async function generateImage(connection, model, { prompt, size = 'auto', quality = 'auto', n = 1 } = {}) {
  const base = connection.baseUrl.replace(/\/+$/, '');
  const url = /\/v1$/.test(base)
    ? base.replace(/\/v1$/, '/v2') + '/images/generations'
    : base + '/images/generations';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.apiKey}`,
    },
    body: JSON.stringify({ model, prompt, size, quality, n, response_format: 'b64_json' }),
    timeout: 130000,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Некорректный ответ (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = (json && (json.error?.message || json.error || json.message)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (json.status === 'pending' || json.status === 'processing') {
    throw new Error('Провайдер не успел сгенерировать изображение синхронно и перешёл в асинхронный режим — попробуйте другую модель или повторите запрос.');
  }
  const data = Array.isArray(json.data) ? json.data : [];
  if (!data.length) throw new Error('Провайдер не вернул изображение');
  const images = data.map((d) => ({ b64Json: d.b64_json || null, url: d.b64_json ? null : (d.url || null) }));
  const revisedPrompt = data[0].revised_prompt || null;
  return { images, revisedPrompt, usage: json.usage || null };
}

// Неструктурированный (не-стриминговый) вызов chat/completions — используется для классификации оркестратора.
async function chatCompletionOnce(connection, model, messages, { maxTokens = 8 } = {}) {
  const url = connection.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0,
      stream: false,
    }),
    timeout: 20000,
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = (json && (json.error?.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const content = json.choices?.[0]?.message?.content || '';
  return content;
}

// Стриминговый вызов chat/completions с SSE. onToken(deltaText), onDone({citations}).
async function streamChatCompletion(connection, model, messages, { onToken, onCitations, onError, onDone, signal, webSearch }) {
  const url = connection.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model,
    messages,
    stream: true,
    // Просим провайдера вернуть статистику токенов в последнем чанке (стандарт OpenAI-совместимых API).
    // Если конкретный провайдер это поле не поддерживает — оно просто игнорируется, ничего не ломается.
    stream_options: { include_usage: true },
  };
  if (webSearch) {
    // Включает реальный веб-поиск для любой модели через Polza.ai (и советимые агрегаторы).
    // Провайдеры, которые этот параметр не знают, просто игнорируют его.
    body.plugins = [{ id: 'web' }];
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    onError(e.message || 'Ошибка подключения');
    return;
  }

  if (!res.ok || !res.body) {
    let errText = '';
    try {
      errText = await res.text();
    } catch (e) {
      /* ignore */
    }
    onError(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
    return;
  }

  let buffer = '';
  let citations = null;
  let usage = null;

  await new Promise((resolve) => {
    res.body.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          // Citations may appear at top-level (Perplexity Sonar style) or nested.
          if (json.citations && Array.isArray(json.citations) && json.citations.length) {
            citations = json.citations;
          }
          // Статистика токенов обычно приходит в последнем chunk'е с пустым choices — не фабрикуем, просто берём если есть.
          if (json.usage && typeof json.usage === 'object') {
            usage = json.usage;
          }
          if (json.choices && json.choices[0]) {
            const choice = json.choices[0];
            const delta = choice.delta || {};
            if (typeof delta.content === 'string' && delta.content.length) {
              onToken(delta.content);
            }
            if (choice.citations && Array.isArray(choice.citations) && choice.citations.length) {
              citations = choice.citations;
            }
            // Формат веб-поиска Polza.ai/OpenAI: annotations с type "url_citation" — могут прийти в delta
            // промежуточного чанка или в итоговом сообщении.
            const annotations = delta.annotations || choice.message?.annotations;
            if (Array.isArray(annotations) && annotations.length) {
              const mapped = annotations
                .filter((a) => a && a.url_citation)
                .map((a) => ({ url: a.url_citation.url, title: a.url_citation.title || a.url_citation.url }));
              if (mapped.length) citations = mapped;
            }
          }
        } catch (e) {
          // ignore malformed SSE lines
        }
      }
    });
    res.body.on('end', () => resolve());
    res.body.on('error', (err) => {
      onError(err.message || 'Ошибка потока');
      resolve();
    });
  });

  if (citations && onCitations) onCitations(citations);
  onDone({ usage });
}

// Не-стриминговый вызов chat/completions с передачей схемы инструментов (function calling).
// Возвращает { content, toolCalls, finishReason }. toolCalls — массив в формате OpenAI
// ({ id, function: { name, arguments } }) или null, если модель ответила обычным текстом.
async function chatCompletionWithTools(connection, model, messages, tools) {
  const url = connection.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: 'auto',
      stream: false,
    }),
    timeout: 30000,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Некорректный ответ (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = (json && (json.error?.message || json.error || json.message)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const choice = json.choices && json.choices[0];
  const message = (choice && choice.message) || {};
  return {
    content: message.content || '',
    toolCalls: message.tool_calls || null,
    finishReason: choice && choice.finish_reason,
  };
}

// Цикл автономного вызова инструментов моделью — до maxRounds раундов "модель просит инструмент →
// мы выполняем → отдаём результат обратно". executor(name, argsObj) должен вернуть текстовую
// строку-результат (или бросить исключение, которое превратится в текст ошибки для модели).
// Возвращает готовый массив messages (с добавленными раундами tool-calls), который дальше
// можно передать в обычный streamChatCompletion БЕЗ параметра tools — финальный ответ всё
// равно стримится пользователю как раньше.
async function runToolLoop(connection, model, messages, tools, executor, { maxRounds = 3, onToolEvent } = {}) {
  let current = messages.slice();
  for (let round = 0; round < maxRounds; round++) {
    let result;
    try {
      result = await chatCompletionWithTools(connection, model, current, tools);
    } catch (e) {
      break; // провайдер не поддержал tools/ошибся — просто уходим к обычному финальному стримингу
    }
    if (!result.toolCalls || !result.toolCalls.length) break;
    current.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      const name = call.function && call.function.name;
      let args = {};
      try {
        args = JSON.parse((call.function && call.function.arguments) || '{}');
      } catch (e) {
        /* некорректный JSON аргументов — оставляем пустой объект */
      }
      if (onToolEvent) onToolEvent({ phase: 'call', name, args });
      let toolResultText;
      try {
        toolResultText = await executor(name, args);
      } catch (e) {
        toolResultText = `Ошибка выполнения инструмента: ${e.message || e}`;
      }
      if (onToolEvent) onToolEvent({ phase: 'result', name, args, result: toolResultText });
      current.push({ role: 'tool', tool_call_id: call.id, content: String(toolResultText).slice(0, 4000) });
    }
  }
  return current;
}

// Классификация запроса для режима "Оркестратор": возвращает 'fast' | 'code' | 'complex'
async function classifyRoute(connection, model, userText) {
  const systemPrompt =
    'Ты — маршрутизатор запросов. Прочитай сообщение пользователя и ответь ОДНИМ словом без пунктуации: ' +
    'fast — если это простой быстрый вопрос; code — если это про программирование/код; ' +
    'complex — если требуется сложное рассуждение, анализ или многошаговое решение. Ответь только одним из этих трёх слов.';
  try {
    const content = await chatCompletionOnce(
      connection,
      model,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText.slice(0, 4000) },
      ],
      { maxTokens: 6 },
    );
    const normalized = content.toLowerCase().replace(/[^a-z]/g, '');
    if (normalized.includes('code')) return 'code';
    if (normalized.includes('complex')) return 'complex';
    if (normalized.includes('fast')) return 'fast';
    return 'fast';
  } catch (e) {
    return 'fast'; // fallback при ошибке классификации
  }
}

module.exports = {
  fetchModels,
  generateImage,
  chatCompletionOnce,
  chatCompletionWithTools,
  runToolLoop,
  streamChatCompletion,
  classifyRoute,
};
