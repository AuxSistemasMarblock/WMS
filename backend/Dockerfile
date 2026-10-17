FROM node:22-alpine

WORKDIR /app

# Copiar package files
COPY package*.json ./

# Instalar dependencias
RUN npm install --omit=dev

# Copiar código fuente
COPY . .

# Exponer puerto
EXPOSE 3001

# Comando de inicio
# node directo (sin npm): las señales SIGTERM/SIGINT llegan sin intermediarios
# y se evita el ruido "npm error signal SIGTERM" al detener el contenedor
CMD ["node", "server.js"]
