#!/bin/bash
# Setup Docker para WMS
# Ejecutar con: sudo bash setup-docker.sh

echo "🐳 Configurando Docker para WMS..."

# 1. Iniciar Docker daemon
echo "1️⃣  Iniciando Docker daemon..."
systemctl start docker
systemctl enable docker

# 2. Agregar usuario actual al grupo docker
USER_NAME=$(whoami)
echo "2️⃣  Agregando usuario '$USER_NAME' al grupo docker..."
usermod -aG docker $USER_NAME

# 3. Crear directorio .docker si no existe
mkdir -p /home/$USER_NAME/.docker

# 4. Verificar instalación
echo ""
echo "✅ Setup completado. Verifica:"
echo "   - Cierra sesión completa y vuelve a entrar"
echo "   - O ejecuta: newgrp docker"
echo "   - Luego: docker ps"
echo ""
echo "🚀 Para verificar la configuración:"
docker --version
echo ""
