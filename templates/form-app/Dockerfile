# strucmed form-app（H0 本機 Docker）：以 nginx 提供主機上建好的 dist/，並反向代理 /strucmed、/llmgw、/FM 到院內站台。
# 不在容器內執行 npm：映像只裝入 check-app-dist.mjs 檢查過的同一份 dist/。
# 順序：npm ci → npm run build → node check-app-dist.mjs dist → docker compose build → docker compose up -d → http://localhost:__PORT__/
FROM nginx:1.27-alpine
# 代理目標（院內站台，https）：由 compose.yaml 的環境變數 UPSTREAM 提供；nginx 官方映像啟動時以 envsubst 把 templates/ 下兩個檔代入後輸出到 conf.d/
ENV UPSTREAM=__UPSTREAM__
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY proxy-common.inc /etc/nginx/templates/proxy-common.inc.template
COPY dist /usr/share/nginx/html
EXPOSE 80
