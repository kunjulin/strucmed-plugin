# 共用的反向代理標頭（Dockerfile 放到 /etc/nginx/templates/proxy-common.inc.template，啟動時 envsubst 代入 UPSTREAM 後輸出為 /etc/nginx/conf.d/proxy-common.inc）
proxy_http_version 1.1;
proxy_ssl_server_name on;
proxy_set_header Host $proxy_host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
# 表單頁用這兩個組 <base href>：讓相對路徑指回本容器
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $http_host;
proxy_redirect ${UPSTREAM}/ /;
proxy_cookie_domain ~.* $host;
