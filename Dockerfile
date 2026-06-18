FROM nginx:alpine

RUN apk add --no-cache gettext

ARG BACKEND_URL=http://localhost:3001
ARG ENVIRONMENT=production

COPY js/config.template.js /tmp/config.template.js
RUN mkdir -p /usr/share/nginx/html/js && \
    envsubst < /tmp/config.template.js > /usr/share/nginx/html/js/config.js

COPY index.html /usr/share/nginx/html/index.html
COPY css/  /usr/share/nginx/html/css/
COPY js/   /usr/share/nginx/html/js/
COPY lib/  /usr/share/nginx/html/lib/
COPY images/ /usr/share/nginx/html/images/

EXPOSE 80