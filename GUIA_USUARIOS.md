# 🔐 GUÍA DE ADMINISTRACIÓN DE USUARIOS - WMS v2.0

## ✨ Métodos para Crear Usuarios

### **OPCIÓN 1: Endpoint de Registro (RECOMENDADO)**

Para crear un usuario programáticamente desde cualquier lugar:

```bash
curl -X POST http://localhost:3001/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "usuario@marblock.com",
    "password": "contraseña_segura_aqui",
    "nombre_completo": "Juan García",
    "ubicacion_id": 1,
    "cargo": "auxiliar_almacen"
  }'
```

**Respuesta exitosa:**
```json
{
  "message": "User created successfully",
  "user": {
    "id": 5,
    "email": "usuario@marblock.com",
    "nombre_completo": "Juan García",
    "cargo": "auxiliar_almacen"
  }
}
```

✅ **VENTAJAS:**
- El hash se genera automáticamente (100% correcto)
- Seguro y sin errores de encoding
- Recomendado para producción

---

### **OPCIÓN 2: Generar Hash y Guardar en Supabase Manualmente**

Si prefieres guardar directamente en Supabase:

**1. Genera el hash:**
```bash
curl -X POST http://localhost:3001/auth/generate-hash \
  -H "Content-Type: application/json" \
  -d '{"password":"tu_contraseña"}'
```

**Respuesta:**
```json
{
  "password": "tu_contraseña",
  "hash": "$2a$10$VIRlJJkQxBvPl8tOSXm9t.G7p5L2bvPPTbTzVSKlAEHPDqPGrN.mq",
  "length": 60
}
```

**2. Copia el hash y ve a Supabase → SQL Editor:**

```sql
INSERT INTO usuarios (nombre_completo, email, password_hash, ubicacion_id, cargo, activo)
VALUES (
  'Juan García',
  'juan@marblock.com',
  '$2a$10$VIRlJJkQxBvPl8tOSXm9t.G7p5L2bvPPTbTzVSKlAEHPDqPGrN.mq',
  1,
  'auxiliar_almacen',
  true
);
```

---

## 📝 Campos Requeridos

| Campo | Tipo | Ejemplo | Notas |
|-------|------|---------|-------|
| `email` | string | `usuario@marblock.com` | Único, se convierte a minúsculas |
| `password` | string | `MiPassword123!` | Min 8 caracteres (recomendado) |
| `nombre_completo` | string | `Juan García` | Nombre completo del usuario |
| `ubicacion_id` | integer | `1` | ID de ubicación en tabla `ubicaciones` |
| `cargo` | string | `auxiliar_almacen` | Rol del usuario |

---

## 🔍 Ubicaciones Válidas

Ejecuta esto en Supabase para ver IDs disponibles:

```sql
SELECT id, nombre FROM ubicaciones WHERE activa = true;
```

**Ubicaciones estándar:**
- ID 1: MEX
- ID 2: MEX:OUTLET
- ID 3: MTY
- ID 4: MTY:OUTLET
- ID 5: GDL
- ID 6: GDL:OUTLET
- ID 7: TEMPORAL
- ID 8: PROYECTOS

---

## 🧪 Testear Login

Una vez creado el usuario, prueba el login:

```bash
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "usuario@marblock.com",
    "password": "contraseña_segura_aqui"
  }'
```

**Respuesta exitosa:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 5,
    "nombre": "Juan García",
    "email": "usuario@marblock.com",
    "cargo": "auxiliar_almacen",
    "ubicacion": {
      "id": 1,
      "nombre": "MEX"
    }
  }
}
```

**Guarda el token** para usar en peticiones protegidas:
```bash
curl -X GET http://localhost:3001/auth/user \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

---

## ⚠️ NOTASde Seguridad

1. ✅ **NUNCA** guardes hashes directamente sin verificación
2. ✅ **SIEMPRE** usa el endpoint de registro o genera el hash con `/auth/generate-hash`
3. ✅ Usa contraseñas fuertes (min 8 caracteres, caracteres especiales)
4. ✅ Cambiar `JWT_SECRET` en producción (archivo `.env`)

---

## 🚀 Comandos Rápidos

**Crear usuario admin:**
```bash
curl -X POST http://localhost:3001/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@marblock.com",
    "password": "AdminPassword123!",
    "nombre_completo": "Administrador",
    "ubicacion_id": 1,
    "cargo": "administrador"
  }'
```

**Listar usuarios en Supabase:**
```sql
SELECT id, email, nombre_completo, cargo, activo FROM usuarios ORDER BY created_at DESC;
```

**Desactivar usuario:**
```sql
UPDATE usuarios SET activo = false WHERE email = 'usuario@marblock.com';
```

**Cambiar contraseña (genera nuevo hash primero):**
```sql
UPDATE usuarios SET password_hash = '$2a$10$...' WHERE email = 'usuario@marblock.com';
```
