FROM node:22-alpine

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY app/server/package.json app/server/package-lock.json ./
RUN npm ci --omit=dev

# 应用代码
COPY app/server/ ./

# 数据目录：sql.js 数据库文件放在这里，挂载卷即可持久化
ENV NODE_ENV=production \
    PORT=3000 \
    TRIM_PKGVAR=/data
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "server.js"]
