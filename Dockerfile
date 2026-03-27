FROM nginx:alpine
# Copia tu archivo al directorio de contenido de Nginx
COPY index.html /usr/share/nginx/html/index.html
EXPOSE 80