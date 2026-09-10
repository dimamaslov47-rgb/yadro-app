# Ядро — простой образ на базе node:20-alpine.
# Без нативной компиляции (нет better-sqlite3/bcrypt и т.п.), подходит для
# сборки на слабом домашнем сервере пользователя (ARM/x86, Portainer).

FROM node:20-alpine

WORKDIR /app

# Сначала зависимости — чтобы Docker кэшировал npm install между сборками
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Затем остальной код приложения
COPY server.js ./
COPY server ./server
COPY public ./public

# Каталог данных (JSON-хранилище lowdb) — монтируется как named volume в compose
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data
ENV PORT=4141
ENV NODE_ENV=production

EXPOSE 4141

CMD ["node", "server.js"]
