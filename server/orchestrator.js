// server/orchestrator.js
// Динамический мультимодельный оркестратор режима «Компьютер».
// Вместо одной зафиксированной модели: 1) планирует задачу и решает, нужно ли её разбить на
// несколько независимых подзадач под разные модели пула провайдера; 2) выполняет подзадачи
// (параллельно, при необходимости — с инструментами run_code/write_file/create_document);
// 3) собирает единый результат (при нескольких подзадачах или явном запросе на файл — отдельным
// вызовом модели, которая тоже может создать итоговый файл инструментом); 4) технически и
// смысловой проверкой (доп. вызов модели) сверяет результат с исходной задачей и, если находит
// проблему, делает один цикл исправления. Возвращает финальную модель + историю сообщений,
// готовую для обычного стримингового ответа пользователю (server.js делает финальный стрим сам).
'use strict';

const { chatCompletionOnce, runToolLoop } = require('./llm');

const MAX_SUBTASKS = 5;
const PLAN_MAX_TOKENS = 900;
const SUBTASK_SUMMARY_MAX_TOKENS = 450;
const ASSEMBLY_SUMMARY_TOOL_ROUNDS = 4;
const VERIFY_MAX_TOKENS = 350;
const MAX_MODELS_IN_PROMPT = 30;

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

// Последнее сообщение пользователя может быть строкой либо OpenAI-vision-массивом частей
// (текст + image_url) — приводим к плоскому текстовому описанию для текстовых (не-vision) вызовов
// и отдельно даём доступ к самим частям для vision-подзадач.
function describeContent(content) {
  if (Array.isArray(content)) {
    const textParts = content.filter((p) => p && p.type === 'text').map((p) => p.text);
    const imageParts = content.filter((p) => p && p.type === 'image_url');
    return { text: textParts.join(' '), hasImages: imageParts.length > 0, imageParts };
  }
  return { text: String(content || ''), hasImages: false, imageParts: [] };
}

function buildSubtaskMessage(originalContent, instructions, includeImages) {
  const { text, imageParts } = describeContent(originalContent);
  const combinedText = `${instructions}\n\n(Исходное сообщение пользователя для контекста: ${text.slice(0, 3000)})`;
  if (includeImages && imageParts.length) {
    return [{ type: 'text', text: combinedText }, ...imageParts];
  }
  return combinedText;
}

function formatModelListForPrompt(pool) {
  // Ограничиваем список моделей в промпте — иначе на аккаунтах с сотнями моделей у Polza.ai
  // системный промпт становится неоправданно большим. Берём разнообразный срез: хотя бы одну
  // модель каждого тега возможностей, затем заполняем до лимита.
  const seenTags = new Set();
  const picked = [];
  for (const m of pool) {
    if (picked.length >= MAX_MODELS_IN_PROMPT) break;
    const newTag = m.capabilities.some((c) => !seenTags.has(c));
    if (newTag) {
      picked.push(m);
      m.capabilities.forEach((c) => seenTags.add(c));
    }
  }
  for (const m of pool) {
    if (picked.length >= MAX_MODELS_IN_PROMPT) break;
    if (!picked.includes(m)) picked.push(m);
  }
  return picked.map((m) => `- ${m.id} [${m.capabilities.join(', ')}]`).join('\n');
}

function pickModelForCapability(pool, capability, preferredId) {
  if (preferredId && pool.some((m) => m.id === preferredId)) return preferredId;
  const byTag = pool.find((m) => m.capabilities.includes(capability));
  if (byTag) return byTag.id;
  return pool[0] ? pool[0].id : preferredId || null;
}

function pickPlannerModel(pool, fallbackModel) {
  const reasoning = pool.find((m) => m.capabilities.includes('reasoning'));
  if (reasoning) return reasoning.id;
  if (fallbackModel && pool.some((m) => m.id === fallbackModel)) return fallbackModel;
  return pool[0] ? pool[0].id : fallbackModel;
}

async function planTask(connection, plannerModel, userText, pool, hasImages, onEvent) {
  const modelList = formatModelListForPrompt(pool);
  const systemPrompt =
    'Ты — планировщик задач для автономного агента «Компьютер». У тебя есть список доступных моделей ' +
    'провайдера с их возможностями (в квадратных скобках). Возможные теги: reasoning (сложное рассуждение), ' +
    'code (программирование), vision (анализ изображений), audio (аудио), image_gen (генерация изображений), ' +
    'fast (быстрая/дешёвая), general (общего назначения).\n\n' +
    `Доступные модели:\n${modelList}\n\n` +
    'Проанализируй задачу пользователя. Если задача простая и не распадается на независимые части — ' +
    'верни РОВНО ОДНУ подзадачу на всю задачу. Если задача содержит несколько независимых частей ' +
    '(например: расшифровать/проанализировать вложение И написать код И собрать таблицу) — раздели её на ' +
    `отдельные подзадачи (не больше ${MAX_SUBTASKS}) и подбери для каждой наиболее подходящую по возможностям ` +
    'модель ИЗ ПРИВЕДЁННОГО СПИСКА (указывай точный id модели). Если в задаче есть изображение — используй ' +
    'модель с тегом vision для подзадачи, которая его анализирует.\n\n' +
    'Если пользователь просит СКАЧИВАЕМЫЙ файл — это не только офисный документ/таблица/презентация, но и ' +
    'скрипт, код, конфиг или любой текстовый файл, а также если явно упомянуты слова «скачать», «файл», «архив», ' +
    '«zip» — обязательно ставь "needsDocumentOutput": true (иначе финальный ответ будет собран без доступа к ' +
    'инструментам создания файлов и скачиваемый файл не появится). В инструкции соответствующей подзадачи прямо ' +
    'напиши, что результат нужно сохранить файлом через write_file (для скриптов/кода/текста) или create_document ' +
    '(для настоящих pdf/docx/xlsx/pptx/csv/rtf/odt), а не просто написать текстом в ответе.\n\n' +
    'Ответь СТРОГО валидным JSON без пояснений и без markdown-разметки, по схеме:\n' +
    '{"subtasks": [{"id": "s1", "title": "короткое название", "capability": "reasoning|code|vision|audio|fast|general", ' +
    '"model": "точный id модели из списка", "instructions": "подробная инструкция для модели, что сделать"}], ' +
    '"needsDocumentOutput": true|false, "outputFormat": "pdf|docx|xlsx|pptx|csv|rtf|odt|text" или null ("text" — ' +
    'скрипт/код/произвольный текстовый файл через write_file, а не через create_document), ' +
    '"outputFilename": "имя файла с расширением" или null}';

  const userContent =
    `Задача пользователя${hasImages ? ' (в сообщении есть изображение)' : ''}:\n${userText.slice(0, 4000)}`;

  let plan = null;
  try {
    const raw = await chatCompletionOnce(
      connection,
      plannerModel,
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      { maxTokens: PLAN_MAX_TOKENS },
    );
    plan = extractJson(raw);
  } catch (e) {
    plan = null;
  }

  if (!plan || !Array.isArray(plan.subtasks) || !plan.subtasks.length) {
    // Резервный вариант: планировщик не ответил валидным JSON — не разбиваем, одна подзадача на всё.
    return {
      subtasks: [
        {
          id: 's1',
          title: 'Выполнение задачи',
          capability: 'general',
          model: pickModelForCapability(pool, 'general', plannerModel),
          instructions: userText,
        },
      ],
      needsDocumentOutput: false,
      outputFormat: null,
      outputFilename: null,
      source: 'fallback',
    };
  }

  const subtasks = plan.subtasks.slice(0, MAX_SUBTASKS).map((s, i) => ({
    id: s.id || `s${i + 1}`,
    title: String(s.title || `Подзадача ${i + 1}`).slice(0, 120),
    capability: CAPABILITY_OR_GENERAL(s.capability),
    model: pickModelForCapability(pool, CAPABILITY_OR_GENERAL(s.capability), s.model),
    instructions: String(s.instructions || userText).slice(0, 4000),
  }));

  return {
    subtasks,
    needsDocumentOutput: !!plan.needsDocumentOutput,
    outputFormat: plan.outputFormat || null,
    outputFilename: plan.outputFilename || null,
    source: 'model',
  };
}

function CAPABILITY_OR_GENERAL(c) {
  const known = ['reasoning', 'code', 'vision', 'audio', 'fast', 'general'];
  return known.includes(c) ? c : 'general';
}

// Находит текст последнего ассистентского сообщения в истории — используется для верификации,
// чтобы сравнивать с реальным текстом ответа, а не с его пересказом-резюме.
function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return '';
}

async function runSubtask(connection, subtask, baseMessages, originalLastContent, tools, executeToolCall, onEvent) {
  onEvent('subtask_start', { id: subtask.id, title: subtask.title, model: subtask.model, capability: subtask.capability });
  const includeImages = subtask.capability === 'vision';
  const subtaskContent = buildSubtaskMessage(originalLastContent, subtask.instructions, includeImages);
  const subtaskMessages = baseMessages.slice(0, -1).concat([{ role: 'user', content: subtaskContent }]);

  try {
    const afterTools = await runToolLoop(
      connection,
      subtask.model,
      subtaskMessages,
      tools,
      executeToolCall,
      {
        maxRounds: 4,
        appendFinalText: true,
        onToolEvent: (evt) => onEvent('tool_event', { ...evt, subtaskId: subtask.id }),
      },
    );
    // Полный (несокращённый) ответ подзадачи — сохраняем отдельно от краткого резюме, так как резюме
    // удобно для сборки нескольких подзадач в один ответ, но теряет конкретные детали (например,
    // сам текст кода) и не годится для проверки результата.
    const rawText = lastAssistantText(afterTools);
    // Короткое резюме подзадачи для последующей сборки — не стримим пользователю напрямую.
    const summary = await chatCompletionOnce(
      connection,
      subtask.model,
      afterTools.concat([{ role: 'user', content: 'Кратко (не более 6-8 предложений) резюмируй результат выполнения этой подзадачи для дальнейшей сборки итогового ответа.' }]),
      { maxTokens: SUBTASK_SUMMARY_MAX_TOKENS },
    );
    const result = {
      id: subtask.id,
      title: subtask.title,
      model: subtask.model,
      ok: true,
      summary: summary || '(пустой ответ модели)',
      rawText: rawText || summary || '',
    };
    onEvent('subtask_done', result);
    return result;
  } catch (e) {
    const result = { id: subtask.id, title: subtask.title, model: subtask.model, ok: false, error: e.message || String(e), rawText: '' };
    onEvent('subtask_done', result);
    return result;
  }
}

async function assembleFinal(connection, assemblyModel, originalUserText, subtaskResults, plan, tools, executeToolCall, onEvent, correctionNote) {
  onEvent('assembly_start', { model: assemblyModel });
  // Передаём в сборку полный ответ подзадачи (rawText), а не только краткое резюме — иначе, если
  // нужно вложить настоящий код/содержимое в файл (write_file/create_document), у сборочной модели
  // не будет реального текста и она будет вынуждена придумывать содержимое заново по пересказу.
  const resultsText = subtaskResults
    .map((r) => (r.ok ? `[${r.title} — модель ${r.model}]\n${(r.rawText || r.summary || '').slice(0, 6000)}` : `[${r.title} — модель ${r.model}] ОШИБКА: ${r.error}`))
    .join('\n\n');

  let systemPrompt =
    'Ты собираешь единый итоговый ответ пользователю на основе результатов подзадач, выполненных разными ' +
    'моделями агента «Компьютер». Сформулируй связный, понятный ответ на русском языке. Если по задаче нужно ' +
    'подготовить итоговый файл, который пользователь должен скачать, и он ещё не был создан ни в одной из ' +
    'подзадач — выбери правильный инструмент: create_document для настоящих офисных форматов (pdf, docx, xlsx, ' +
    'pptx, csv, rtf, odt); write_file для скрипта, кода, конфига или любого простого текстового файла (например ' +
    '.ps1, .py, .txt, .md, .json) — НЕ пытайся уложить такой файл в create_document, если он не подходит ни под ' +
    'один из его форматов. Файлы, сохранённые любым из этих инструментов, автоматически собираются в один ' +
    'скачиваемый zip-архив и предлагаются пользователю — отдельно упаковывать в zip не нужно.';
  if (correctionNote) {
    systemPrompt += `\n\nВАЖНО — при предыдущей проверке найдены проблемы, обязательно исправь их: ${correctionNote}`;
  }

  const assemblyMessages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Исходная задача пользователя:\n${originalUserText.slice(0, 3000)}\n\nРезультаты подзадач:\n${resultsText}` },
  ];

  const afterTools = await runToolLoop(
    connection,
    assemblyModel,
    assemblyMessages,
    tools,
    executeToolCall,
    {
      maxRounds: ASSEMBLY_SUMMARY_TOOL_ROUNDS,
      onToolEvent: (evt) => onEvent('tool_event', { ...evt, subtaskId: 'assembly' }),
    },
  );
  return afterTools;
}

async function verifyResult(connection, reviewerModel, originalUserText, draftText, taskFilesList) {
  const filesDesc = taskFilesList && taskFilesList.length
    ? taskFilesList.map((f) => `${f.filename} (${f.bytes} байт)`).join(', ')
    : 'файлы не создавались';
  const systemPrompt =
    'Ты — контролёр качества результата автономного агента. Оцени, решает ли итоговый черновик ответа ' +
    'исходную задачу пользователя полностью и корректно. Ответь СТРОГО валидным JSON без пояснений: ' +
    '{"ok": true|false, "issues": "краткое описание проблем на русском, если ok=false, иначе пустая строка"}';
  const userContent =
    `Исходная задача:\n${originalUserText.slice(0, 3000)}\n\nЧерновик итогового ответа:\n${draftText.slice(0, 3000)}\n\n` +
    `Созданные файлы: ${filesDesc}`;
  try {
    const raw = await chatCompletionOnce(
      connection,
      reviewerModel,
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      { maxTokens: VERIFY_MAX_TOKENS },
    );
    const parsed = extractJson(raw);
    if (parsed && typeof parsed.ok === 'boolean') return { ok: parsed.ok, issues: parsed.issues || '' };
  } catch (e) {
    /* при ошибке проверки не блокируем ответ пользователю — считаем результат принятым */
  }
  return { ok: true, issues: '' };
}

// Главная точка входа. Возвращает { finalModel, finalMessages, plan, subtaskResults, verification }
// для последующего обычного стримингового ответа пользователю в server.js.
async function orchestrateComputerTask({ connection, pool, chatMessages, tools, executeToolCall, fallbackModel, onEvent, listTaskFilesFn }) {
  if (!pool || !pool.length) {
    throw new Error('Для режима «Компьютер» не удалось получить список моделей у провайдера — проверьте подключение и API-ключ.');
  }

  const lastContent = chatMessages[chatMessages.length - 1].content;
  const { text: userText, hasImages } = describeContent(lastContent);

  const plannerModel = pickPlannerModel(pool, fallbackModel);
  onEvent('planning_start', { model: plannerModel });
  const plan = await planTask(connection, plannerModel, userText, pool, hasImages, onEvent);
  onEvent('plan', { subtasks: plan.subtasks, outputFormat: plan.outputFormat, source: plan.source });

  const subtaskResults = await Promise.all(
    plan.subtasks.map((st) => runSubtask(connection, st, chatMessages, lastContent, tools, executeToolCall, onEvent)),
  );

  let finalMessages;
  let finalModel;
  const singleSuccessOnly = subtaskResults.length === 1 && subtaskResults[0].ok && !plan.needsDocumentOutput;

  if (singleSuccessOnly) {
    finalModel = subtaskResults[0].model;
    finalMessages = chatMessages.slice(0, -1).concat([
      { role: 'user', content: lastContent },
      // Используется полный ответ подзадачи (rawText), а не краткое резюме — иначе следующий шаг
      // «оформи как финальный ответ» вынужден восстанавливать содержимое (например, сам текст кода)
      // через пересочинение из краткого пересказа, что теряет точность.
      { role: 'assistant', content: subtaskResults[0].rawText || subtaskResults[0].summary },
      { role: 'user', content: 'Оформи это как окончательный ответ пользователю на русском языке, сохранив всё содержимое без сокращения (включая любой код целиком) — можно только улучшить изложение, не пересказывая вкратке.' },
    ]);
  } else {
    finalModel = pickPlannerModel(pool, fallbackModel);
    finalMessages = await assembleFinal(connection, finalModel, userText, subtaskResults, plan, tools, executeToolCall, onEvent, null);
  }

  // Черновой текст для смысловой проверки: для собранного ответа (assembleFinal) в finalMessages уже есть
  // реальный текст финального ответа — используем именно его, а не пересказ через summary. Для ветки
  // «одна успешная подзадача без сборки» реальный текст финального ответа появится только после отдельного
  // стрима в server.js, поэтому берём полный (несокращённый) ответ подзадачи (rawText) — это ближе
  // к тому, что увидит пользователь, чем 6-8-предложение-пересказ резюме (тот, из-за которого
  // верификация раньше ложно решала, что черновик не содержит код, тогда как код в нём был).
  const draftText = singleSuccessOnly
    ? (subtaskResults[0].rawText || subtaskResults[0].summary)
    : (lastAssistantText(finalMessages) || subtaskResults.map((r) => (r.ok ? r.summary : `Ошибка: ${r.error}`)).join('\n\n'));
  const filesNow = typeof listTaskFilesFn === 'function' ? listTaskFilesFn() : [];
  const reviewerModel = pickPlannerModel(pool, fallbackModel);
  let verification = await verifyResult(connection, reviewerModel, userText, draftText, filesNow);
  onEvent('verify', { ok: verification.ok, issues: verification.issues, repaired: false });

  if (!verification.ok && verification.issues) {
    // Один цикл исправления — пересобираем финальный ответ с учётом найденных проблем, затем
    // принимаем результат независимо от исхода повторной проверки (чтобы не зациклиться).
    finalModel = pickPlannerModel(pool, fallbackModel);
    finalMessages = await assembleFinal(connection, finalModel, userText, subtaskResults, plan, tools, executeToolCall, onEvent, verification.issues);
    const filesAfter = typeof listTaskFilesFn === 'function' ? listTaskFilesFn() : [];
    // Как и выше — проверяем реальный пересобранный текст из finalMessages, а не заглушку-плейсхолдер,
    // которая никак не отражает реально исправленный ответ.
    const draftAfter = lastAssistantText(finalMessages) || ('исходный черновик с замечаниями: ' + verification.issues);
    const secondCheck = await verifyResult(connection, reviewerModel, userText, draftAfter, filesAfter);
    onEvent('verify', { ok: secondCheck.ok, issues: secondCheck.issues, repaired: true });
    verification = secondCheck.ok ? secondCheck : { ok: secondCheck.ok, issues: verification.issues };
  }

  return { finalModel, finalMessages, plan, subtaskResults, verification };
}

module.exports = { orchestrateComputerTask, planTask, verifyResult };
