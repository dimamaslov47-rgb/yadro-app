// Простой планировщик периодических задач — без внешних cron-библиотек и без cron-синтаксиса,
// только "каждые N минут" (осознанное упрощение ради минимальной поверхности отказа при
// разворачивании в контейнере). Раз в минуту проверяет db.scheduledTasks на предмет
// подошедших задач, выполняет их через уже настроенное подключение/модель выбранного режима
// (не-стриминговый вызов) и сохраняет результат как обычное сообщение в отдельном треде —
// так результаты сразу видно в обычном списке диалогов, без отдельного UI для "уведомлений".
const { v4: uuidv4 } = require('uuid');

function startScheduler({ db, getConnection, chatCompletionOnce }) {
  const TICK_MS = 60 * 1000;

  async function runTask(task) {
    const assignments = db.get('modeAssignments').value();
    const assignment = assignments[task.mode];
    const nextRunAt = new Date(Date.now() + task.intervalMinutes * 60 * 1000).toISOString();

    if (!assignment) {
      db.get('scheduledTasks').find({ id: task.id }).assign({
        lastRunAt: new Date().toISOString(),
        lastError: 'Для выбранного режима не настроено подключение/модель',
        nextRunAt,
      }).write();
      return;
    }
    const connection = getConnection(assignment.connectionId);
    if (!connection) {
      db.get('scheduledTasks').find({ id: task.id }).assign({
        lastRunAt: new Date().toISOString(),
        lastError: 'Настроенное подключение не найдено (возможно, удалено)',
        nextRunAt,
      }).write();
      return;
    }

    let thread = task.threadId && db.get('threads').find({ id: task.threadId }).value();
    if (!thread) {
      thread = {
        id: uuidv4(),
        userId: task.userId,
        title: `⏱ ${task.title}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.get('threads').push(thread).write();
      db.get('scheduledTasks').find({ id: task.id }).assign({ threadId: thread.id }).write();
    }

    const user = db.get('users').find({ id: task.userId }).value();
    const profileNote = (user && user.profileNote) || '';
    const messages = [];
    if (profileNote.trim()) {
      messages.push({ role: 'system', content: `Память о пользователе (учитывай при ответе): ${profileNote.trim()}` });
    }
    messages.push({ role: 'user', content: task.prompt });

    let content = '';
    let errorMsg = null;
    try {
      content = await chatCompletionOnce(connection, assignment.model, messages, { maxTokens: 2000 });
    } catch (e) {
      errorMsg = e.message || 'Ошибка выполнения задачи';
    }

    const msg = {
      id: uuidv4(),
      threadId: thread.id,
      role: errorMsg ? 'system' : 'assistant',
      content: errorMsg ? `Планировщик: ошибка выполнения задачи «${task.title}»: ${errorMsg}` : content,
      mode: task.mode,
      effectiveMode: task.mode,
      connectionName: connection.name,
      model: assignment.model,
      scheduledTaskId: task.id,
      createdAt: new Date().toISOString(),
    };
    db.get('messages').push(msg).write();
    db.get('threads').find({ id: thread.id }).assign({ updatedAt: new Date().toISOString() }).write();
    db.get('scheduledTasks').find({ id: task.id }).assign({
      lastRunAt: new Date().toISOString(),
      lastError: errorMsg || null,
      nextRunAt,
    }).write();
  }

  async function tick() {
    const now = Date.now();
    const tasks = db.get('scheduledTasks').value() || [];
    for (const task of tasks) {
      if (!task.enabled) continue;
      const due = task.nextRunAt ? new Date(task.nextRunAt).getTime() : 0;
      if (due > now) continue;
      try {
        await runTask(task);
      } catch (e) {
        console.error('[scheduler] ошибка выполнения задачи', task.id, e.message);
      }
    }
  }

  const interval = setInterval(() => {
    tick().catch((e) => console.error('[scheduler] ошибка тика', e.message));
  }, TICK_MS);

  return { stop: () => clearInterval(interval), runTaskNow: runTask };
}

module.exports = { startScheduler };
