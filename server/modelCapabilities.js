// server/modelCapabilities.js
// Определяет "возможности" моделей провайдера (Polza.ai и совместимые) по названию модели —
// нужно режиму «Компьютер», чтобы самостоятельно подбирать подходящую модель под конкретную
// подзадачу (код / изображения / рассуждение / быстрый ответ), а не работать всегда на одной
// зафиксированной модели. Разметка по имени — эвристика (гарантий нет), но покрывает основные
// схемы наименования моделей у крупных провайдеров, агрегируемых Polza.ai (OpenAI, Anthropic,
// Google, Meta, Mistral, DeepSeek, Qwen и т.п.). Администратор может переопределить разметку
// вручную в Настройках — см. db.modelCapabilityOverrides и /api/computer/model-pool.
'use strict';

const { fetchModels } = require('./llm');

// Порядок важен только для отображения в UI.
const CAPABILITY_TAGS = ['reasoning', 'code', 'vision', 'audio', 'image_gen', 'fast', 'general'];

const CAPABILITY_LABELS = {
  reasoning: 'Сложное рассуждение',
  code: 'Код',
  vision: 'Изображения (зрение)',
  audio: 'Аудио',
  image_gen: 'Генерация изображений',
  fast: 'Быстрая/дешёвая',
  general: 'Общего назначения',
};

function inferCapabilities(modelId) {
  const id = String(modelId || '').toLowerCase();
  const tags = new Set();
  if (/whisper|speech-to-text|transcri/.test(id)) tags.add('audio');
  if (/dall-?e|stable-diffusion|sdxl|midjourney|\bflux\b|imagen|image-gen|ideogram/.test(id)) tags.add('image_gen');
  if (/coder|code-|codestral|starcoder|deepseek-coder|copilot|codegen/.test(id)) tags.add('code');
  if (/vision|gpt-4o|gpt-4\.1|gpt-5|claude-3|claude-4|claude-opus|claude-sonnet|gemini|qwen.*-?vl|llava|pixtral|internvl/.test(id)) tags.add('vision');
  if (/\bo1\b|\bo3\b|\bo4\b|opus|gpt-4(?!o-mini)|gpt-5|sonnet|deepseek-r|\br1\b|405b|70b|72b|\blarge\b|\bultra\b|\bmax\b/.test(id)) tags.add('reasoning');
  if (/mini|haiku|flash|nano|\b8b\b|\b7b\b|\b3b\b|\bsmall\b|\blite\b|\bfast\b|turbo/.test(id)) tags.add('fast');
  if (!tags.size) tags.add('general');
  return Array.from(tags);
}

// Собирает пул моделей подключения: живой список от провайдера (GET /models) + разметка
// (авто по имени, при наличии — переопределённая администратором).
async function buildModelPool(connection, overridesForConnection) {
  const ids = await fetchModels(connection.baseUrl, connection.apiKey);
  const overrides = overridesForConnection || {};
  return ids.map((id) => {
    const auto = inferCapabilities(id);
    const override = Array.isArray(overrides[id]) && overrides[id].length ? overrides[id] : null;
    return { id, capabilities: override || auto, auto, overridden: !!override };
  });
}

module.exports = { CAPABILITY_TAGS, CAPABILITY_LABELS, inferCapabilities, buildModelPool };
