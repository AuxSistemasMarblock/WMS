FROM nginx:alpine

RUN apk add --no-cache gettext

ARG BACKEND_URL
ARG ENVIRONMENT=production

# Validar que BACKEND_URL fue pasado como build arg
# Sin esto, el ENV queda con string vacío y el frontend no funciona
RUN if [ -z "$BACKEND_URL" ]; then \
      echo "ERROR: BACKEND_URL build arg is required. Pass it via docker-compose args:" && \
      echo "  build:" && \
      echo "    args:" && \
      echo "      BACKEND_URL: https://your-backend-url" && \
      exit 1; \
    fi

# Todas las páginas (index, dashboard, etiquetas, casos, auditoria, ...)
# con glob para que páginas nuevas no requieran tocar el Dockerfile
COPY *.html /usr/share/nginx/html/
COPY css/  /usr/share/nginx/html/css/
COPY js/   /usr/share/nginx/html/js/
COPY lib/  /usr/share/nginx/html/lib/
COPY images/ /usr/share/nginx/html/images/

# Generar config.js AL FINAL con envsubst para garantizar que nunca sea sobreescrito
COPY js/config.template.js /tmp/config.template.js
RUN envsubst < /tmp/config.template.js > /usr/share/nginx/html/js/config.js

EXPOSE 80