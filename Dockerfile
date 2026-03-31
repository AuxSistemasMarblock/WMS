FROM nginx:alpine
# Copia tu archivo al directorio de contenido de Nginx
COPY index.html /usr/share/nginx/html/index.html
# Copia la carpeta de imágenes
COPY images/ /usr/share/nginx/html/images/
EXPOSE 80