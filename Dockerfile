FROM node:20-alpine

WORKDIR /app

# 先装依赖
COPY package*.json ./
RUN npm ci --omit=dev

# 再复制源码
COPY . .

COPY config.example.jsonc /app/config.example.jsonc
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
