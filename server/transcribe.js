// server/transcribe.js
// Транскрибация аудио/видео через настроенное OpenAI-совместимое подключение
// (эндпоинт /audio/transcriptions, Whisper-совместимая схема — mp3/wav/mp4/m4a/webm и т.п.
// принимаются напрямую, без извлечения звука из видео на нашей стороне).
// Используем встроенный fetch/FormData/Blob (Node >=18, глобальные — реализация undici) —
// node-fetch@2 (уже используемый в server/llm.js) не умеет отправлять multipart с нативным
// FormData, а тащить отдельный пакет form-data ради этого одного эндпоинта избыточно.
'use strict';

const DEFAULT_MODEL = 'whisper-1';

async function transcribeAudio(connection, buffer, filename, mimetype, model) {
  const base = connection.baseUrl.replace(/\/+$/, '');
  const url = base + '/audio/transcriptions';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype || 'application/octet-stream' }), filename || 'audio');
  form.append('model', model || DEFAULT_MODEL);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
      body: form,
    });
  } catch (e) {
    throw new Error(`Не удалось связаться с провайдером транскрибации: ${e.message}`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Провайдер вернул не-JSON ответ (HTTP ${res.status}) — возможно, эндпоинт /audio/transcriptions не поддерживается: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = (json && (json.error?.message || json.error || json.message)) || `HTTP ${res.status}`;
    throw new Error(`Провайдер отклонил запрос транскрибации: ${msg}`);
  }
  const transcript = typeof json.text === 'string' ? json.text : '';
  if (!transcript.trim()) throw new Error('Провайдер вернул пустую транскрипцию');
  return transcript.trim();
}

module.exports = { transcribeAudio, DEFAULT_MODEL };
