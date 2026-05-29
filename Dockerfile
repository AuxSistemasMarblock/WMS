FROM nginx:alpine

# Copia la estructura del proyecto
COPY index.html /usr/share/nginx/html/index.html
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/
COPY lib/ /usr/share/nginx/html/lib/
COPY images/ /usr/share/nginx/html/images/

EXPOSE 80