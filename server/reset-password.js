#!/usr/bin/env node
// Восстановление пароля admin-аккаунта без веб-интерфейса.
// Используется, если пароль забыт, а зайти в /login.html невозможно.
//
// Запуск локально:      node server/reset-password.js <новый_пароль>
// Запуск в контейнере:  docker exec -it yadro node server/reset-password.js <новый_пароль>
//
// Приложение поддерживает ровно один admin-аккаунт, поэтому имя пользователя
// указывать не нужно — скрипт находит единственную запись в users.

const db = require('./db');
const { hashPassword } = require('./auth');

function main() {
  const newPassword = process.argv[2];

  if (!newPassword) {
    console.error('Использование: node server/reset-password.js <новый_пароль>');
    console.error('Пароль должен быть не короче 4 символов.');
    process.exit(1);
  }

  if (newPassword.length < 4) {
    console.error('Ошибка: новый пароль слишком короткий (минимум 4 символа).');
    process.exit(1);
  }

  const users = db.get('users').value();

  if (!users || users.length === 0) {
    console.error('Пользователь не найден. Аккаунт ещё не создан — используйте /setup.html для создания admin-аккаунта.');
    process.exit(1);
  }

  const user = users[0];

  db.get('users')
    .find({ id: user.id })
    .assign({ passwordHash: hashPassword(newPassword) })
    .write();

  console.log(`Пароль обновлён для пользователя "${user.username}".`);
  console.log('Важно: если основной сервер (контейнер) сейчас работает — перезапустите его (например docker restart yadro),');
  console.log('иначе он будет продолжать принимать старый пароль до рестарта (данные кэшируются в памяти работающего процесса). После рестарта входите в /login.html с новым паролем.');
}

main();
