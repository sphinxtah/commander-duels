FROM node:24.19.0-alpine AS build
RUN npm install -g pnpm@11.25.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml VERSION ./
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile
COPY web ./web
RUN pnpm build
FROM nginxinc/nginx-unprivileged:1.28.0-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8080
