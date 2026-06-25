# WMS Scanner — Documentación Técnica

> Sistema de Gestión de Almacén (WMS) para escaneo de placas, captura de firmas electrónicas y sincronización con NetSuite.
>
> **Versión**: 2.0
> **Stack**: Node.js 18 + Express · JavaScript vanilla (frontend) · Supabase (Postgres) · NetSuite RESTlet (OAuth 1.0a TBA) · Dokploy + Traefik (despliegue).
>
> **Frontend scanner**: pistola lectora de QR HID (modo principal) + cámara del dispositivo (fallback). Ver [§1.5](#15-arquitectura-del-escáner).

---

## Tabla de contenidos

1. [Visión general](#1-visión-general)
   - 1.5 Arquitectura del escáner
2. [Arquitectura](#2-arquitectura)
3. [Modelo de datos (Supabase)](#3-modelo-de-datos-supabase)
4. [Backend](#4-backend)
5. [Frontend](#5-frontend)
   - 5.2 Estructura de archivos frontend
   - 5.3 Carga de scripts
   - 5.5 Estado global
   - 5.6 Flujo de usuario
   - 5.7 Funciones por módulo
   - 5.8 Convenciones de UI
6. [Integración con NetSuite](#6-integración-con-netsuite)
   - 6.1 Componentes de NetSuite requeridos
   - 6.2 Rol `WMS` — Permisos requeridos
   - 6.3 Integration Record
   - 6.4 Token TBA (Token-Based Authentication)
   - 6.5 Búsqueda guardada
   - 6.6 RESTlet 2217 (`searchResults.js`) — Búsqueda de IFs
   - 6.7 RESTlet 2860 (`wms_restlet.js`) — Subida de archivos y status
   - 6.8 File Cabinet — Estructura
   - 6.9 Estrategias de autenticación
   - 6.10 Procedimiento de regeneración tras pérdida de credenciales
   - 6.11 UserEvent Script `wms_link_firmas.js` — Vinculación de firmas
   - 6.12 Advanced PDF/HTML Template `wms_firma_template.xml` — Render de firmas
   - 6.13 Cómo fluye la data de NetSuite al frontend
7. [Despliegue (Dokploy)](#7-despliegue-dokploy)
8. [Variables de entorno](#8-variables-de-entorno)
9. [Runbook / Troubleshooting](#9-runbook--troubleshooting)
   - 9.12 Cómo agregar un nuevo campo al API de IFs
   - 9.13 Una columna nueva de `customsearch3672` no aparece en el frontend
   - 9.14 El modal de confirmación de salida de placas no aparece
   - 9.15 La pistola no escanea al cargar la página
   - 9.16 El toggle a Cámara no funciona
   - 9.17 El LED de la pistola no se pone verde
   - 9.18 La pistola se lee pero la placa no aparece en la tabla
10. [Anexos](#10-anexos)

---

## 1. Visión general

### 1.1 Propósito

WMS Scanner es la herramienta móvil/web que utilizan los operadores de almacén para:

1. **Registrarse / iniciar sesión** con credenciales corporativas.
2. **Consultar Instrucciones de Fabricación (IF)** abiertas en su ubicación, vía búsqueda guardada en NetSuite (`customsearch3672`).
3. **Escanear placas** mediante **pistola lectora de QR HID** (modo principal) o **cámara del dispositivo** (fallback). Formato QR: `SKU LOTE UBICACION` (3 tokens separados por espacio, ej: `030LTH 12572-3.16X1.96 GDL`).
4. **Capturar firmas electrónicas** (aux. de almacén, cliente, jefe de almacén, gerente) según el número de placas.
5. **Sincronizar con NetSuite**: subir las firmas PNG al File Cabinet, actualizar el status del IF a "Enviado" (`C`) y, opcionalmente, notificar vía webhook a n8n como fallback.

> **Decisión de diseño**: la pistola HID es la fuente principal porque es 5–10x más rápida que apuntar con la cámara del celular en un entorno de almacén, y permite usar ambas manos. La cámara queda como fallback por si falla la pistola o se agotan sus baterías. Ver [§1.5](#15-arquitectura-del-escáner) para el detalle.

### 1.2 Roles y permisos

| `cargo` en `usuarios`           | Permisos visibles en la app          |
|--------------------------------|---------------------------------------|
| `aux_almacen`                  | Escanear, firmar como "Aux. Almacén"  |
| `cliente`                      | Firmar como "Cliente"                 |
| `jefe_almacen`                 | Firma obligatoria si > 3 placas        |
| `gerente`                      | Firma obligatoria si > 10 placas       |
| `administrador`                | Diagnóstico y testing (endpoints)      |

> **Nota**: los cargos `jefe_almacen` y `gerente` no son filtro en backend, solo disparan firmas adicionales en el frontend (`js/signatures.js:38-71`).

### 1.3 Ubicaciones

Las ubicaciones determinan qué IFs ve cada usuario. Reglas:

- Un usuario pertenece a **una sola ubicación** (`usuarios.ubicacion_id`).
- **Solo las ubicaciones restringidas** (las que inician con `MEX`, `MTY` o `GDL`) filtran por usuario. **Cualquier otra ubicación** (ej: `TIJUANA`, `NUEVA SUCURSAL`, `TIENDA_PRUEBA`, etc.) es **compartida y visible para todos los usuarios**, sin importar su `ubicacion_id`.
- Adicionalmente, las ubicaciones explícitamente listadas como `TEMPORAL`, `PROYECTOS`, `Material Transformado` y `MATRIZ` son siempre compartidas, independientemente de su prefijo.
- **Regla de inclusión de outlets** (importante): el campo `location` de una IF en NetSuite puede llegar como string simple (`GDL`) o como string multi-valor separado por espacios o `:` (ej: `GDL:OUTLET GDL`, `MEX:OUTLET MEX`). La lógica de filtrado divide el string por `[\s:]+` y hace `includes` contra el nombre de la ubicación del usuario, por lo que un usuario de `GDL` **sí ve** IFs con location `GDL:OUTLET GDL` (porque el token `GDL` aparece), pero **no ve** IFs con location `MTY:OUTLET MTY`. Esto es intencional: cada outlet hereda las IFs de su sucursal padre, pero no las de otras sucursales.
- Ejemplo: un usuario en `MEX` (id=1) ve IFs de `MEX` y `MEX:OUTLET` (id=2), además de **todas** las IFs con ubicaciones no restringidas (`TIJUANA`, etc.) y las explícitamente compartidas (`TEMPORAL`, `PROYECTOS`).
- **Prefijos reservados**: `MEX`, `MTY`, `GDL` (case-sensitive, match exacto o seguidos de `:` o espacio). Ej: `GDL` ✓, `GDL:OUTLET` ✓, `GDL:OUTLET GDL` ✓, pero `GDLX` ✗, `mex` ✗ (lowercase).

| ID  | Nombre        | Notas                                                                                  |
|-----|---------------|----------------------------------------------------------------------------------------|
| 1   | `MEX`         | Principal (prefijo restringido)                                                        |
| 2   | `MEX:OUTLET`  | Outlet vinculado a MEX (prefijo restringido)                                          |
| 3   | `MTY`         | Principal (prefijo restringido)                                                        |
| 4   | `MTY:OUTLET`  | Outlet vinculado a MTY (prefijo restringido)                                          |
| 5   | `GDL`         | Principal (prefijo restringido)                                                        |
| 6   | `GDL:OUTLET`  | Outlet vinculado a GDL (prefijo restringido)                                          |
| 7   | `TEMPORAL`    | Compartida, visible para todos (whitelist explícita)                                   |
| 8   | `PROYECTOS`   | Compartida, visible para todos (whitelist explícita)                                   |
| 9   | `Material Transformado` | Compartida, visible para todos (whitelist explícita)                          |
| 10  | `MATRIZ`      | Compartida, visible para todos (whitelist explícita)                                   |
| —   | *cualquier otra* | Cualquier ubicación que NO inicie con `MEX`, `MTY` o `GDL` (ej: `TIJUANA`, `TIENDA_PRUEBA`) es **compartida y visible para todos los usuarios** |

### 1.4 Diagrama de componentes

```
┌──────────────┐    HTTPS    ┌──────────────────┐
│   Browser    │ ──────────► │  wms.marblock.shop│  (Traefik → nginx estático)
└──────┬───────┘             └──────────────────┘
       │  HTTPS fetch
       ▼
┌──────────────────┐   OAuth 1.0a TBA    ┌────────────────────┐
│ api.marblock.shop│ ─────────────────►  │  NetSuite Sandbox  │
│ (Traefik → Node) │                     │  (RESTlet 2217/2860)│
└──────┬───────────┘                     └────────────────────┘
       │  service_role
       ▼
┌──────────────────┐
│    Supabase      │   Postgres
│ (ajdnnjxnrazflk) │   tablas: usuarios, ubicaciones, firmas, audit_logs
└──────────────────┘
```

### 1.5 Arquitectura del escáner

El componente de escaneo es crítico y tiene su propia arquitectura. Hay **dos fuentes de entrada** que terminan en una única función `handleScan(text)`:

```
                           ┌─────────────────────────────────────────┐
                           │  js/scanner.js                          │
                           │                                         │
  ┌──────────────┐         │  ┌────────────────────────┐            │
  │  Pistola QR  │──HID──►│  │ onPistolaKeydown(e)    │            │
  │  (USB Keyboard)        │  │  • buffer + terminator │            │
  └──────────────┘         │  │  • timing-based capture │            │
                           │  └───────────┬────────────┘            │
                           │              │                         │
                           │              ▼                         │
                           │  ┌────────────────────────┐            │
                           │  │ handleScan(text)        │◄─────┐     │
                           │  │  • dedupe 3s            │      │     │
                           │  │  • parseQR              │      │     │
                           │  │  • addRecord            │      │     │
                           │  └───────────┬────────────┘      │     │
                           │              │                   │     │
                           │              ▼                   │     │
  ┌──────────────┐         │  ┌────────────────────────┐  │     │
  │   Cámara     │──MD───►│  │ startCamera()           │──┘     │
  │   (fallback) │  qrcode │  │  • Html5Qrcode          │        │
  └──────────────┘         │  │  • callback handleScan  │        │
                           │  └────────────────────────┘        │
                           └─────────────────────────────────────────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │  js/qr-parser.js  │
                                    │  parseQR(text)    │
                                    └──────────────────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │  js/table.js      │
                                    │  addRecord(item)  │  → <tr> en #tableBody
                                    └──────────────────┘
```

**¿Cómo funciona la pistola?** Una pistola lectora de QR (HID Keyboard) emite los caracteres decodificados del código como si el usuario los tipeara muy rápido, seguidos de un carácter terminador (configurable: por default `Enter`). El navegador recibe `keydown` events en el documento, los acumulamos en un buffer, y al recibir el terminador procesamos el buffer como un código único.

**¿Cómo funciona la cámara?** `Html5Qrcode` (CDN) inicializa la cámara trasera del dispositivo con `facingMode: environment`, escanea frames a 10 fps, y cuando detecta un QR llama a `handleScan(decodedText)`.

**¿Por qué dos fuentes?** La pistola es más rápida y práctica en almacén. La cámara es el fallback universal (cualquier dispositivo con cámara puede escanear).

**Selección de fuente**: control `scanSource = 'pistola' | 'camara'`. Por default `'pistola'`. El usuario puede alternar con el toggle en el card del escáner. El listener de pistola se auto-activa al cargar la página (no requiere click). Ver [§5.7 scanner.js](#jsscannerjs) para la lógica completa.

---

## 2. Arquitectura

### 2.1 Servicios Docker (`docker-compose.dokploy.yml`)

| Servicio        | Imagen base        | Puerto host → contenedor | Función                              |
|----------------|--------------------|--------------------------|--------------------------------------|
| `wms-backend`  | `node:18-alpine`   | `3001:3001`              | API REST en Express                  |
| `wms-frontend` | `nginx:alpine`     | `8080:80` (Traefik: 80)  | Sirve HTML/CSS/JS estáticos          |

Traefik (gestionado por Dokploy) actúa como reverse proxy y termination TLS con Let's Encrypt.

### 2.2 Comunicación browser → backend

- URL base: `https://api.marblock.shop` (definida en `window.APP_CONFIG.BACKEND_URL`, inyectada en `index.html`).
- Auth: JWT en header `Authorization: Bearer <token>`.
- Storage del token: `sessionStorage` (se limpia al cerrar la pestaña, ver `js/auth.js:45`).

### 2.3 Comunicación backend → NetSuite

- **RESTlet de búsqueda** (script 2217, deploy 1): `POST /app/site/hosting/restlet.nl?script=2217&deploy=1` con `{"searchId":"customsearch3672","limit":1000,"start":0}`.
- **RESTlet de upload** (script 2860, deploy 1): `POST .../restlet.nl?script=2860&deploy=1` con `{"filename","contents","folder_id"}` o `{"action":"updateIFStatus","internalId"}`.
- Auth: OAuth 1.0a Token-Based Authentication (TBA) con firma `HMAC-SHA256`.

### 2.4 Comunicación backend → Supabase

- Cliente `@supabase/supabase-js` con `service_role_key` (bypass RLS, uso solo backend).
- Operaciones: lectura de `usuarios`, `ubicaciones`; inserciones y updates en `firmas` y `audit_logs`.

---

## 3. Modelo de datos (Supabase)

### 3.1 Diagrama relacional

```
ubicaciones (1) ───< (N) usuarios (1) ───< (N) firmas
        │                                     ▲
        │                                     │
        └────────────< (N) audit_logs ────────┘
```

### 3.2 Tabla `usuarios`

| Columna          | Tipo         | Restricciones            | Descripción                              |
|------------------|--------------|--------------------------|------------------------------------------|
| `id`             | `int8` (PK)  | autoincrement            | Identificador interno                    |
| `email`          | `varchar`    | UNIQUE, NOT NULL         | Email en minúsculas                      |
| `password_hash`  | `varchar`    | NOT NULL                 | Hash bcrypt (cost 10)                    |
| `nombre_completo`| `varchar`    | NOT NULL                 | Nombre visible del usuario               |
| `cargo`          | `varchar`    | NOT NULL                 | `aux_almacen`, `cliente`, `jefe_almacen`, `gerente`, `administrador` |
| `ubicacion_id`   | `int8` (FK)  | → `ubicaciones.id`       | Ubicación primaria del usuario           |
| `activo`         | `bool`       | default `true`           | Soft-delete                              |
| `created_at`     | `timestamp`  | default `now()`          | —                                        |
| `updated_at`     | `timestamp`  | default `now()`          | —                                        |

### 3.3 Tabla `ubicaciones`

| Columna      | Tipo         | Descripción                                |
|--------------|--------------|--------------------------------------------|
| `id`         | `int8` (PK)  | 1..8 (ver §1.3)                            |
| `nombre`     | `varchar`    | `MEX`, `MEX:OUTLET`, etc.                  |
| `netsuite_id`| `varchar`    | ID interno en NetSuite (puede ser NULL)    |
| `activa`     | `bool`       | default `true`                             |
| `created_at` | `timestamp`  | —                                          |
| `updated_at` | `timestamp`  | —                                          |

### 3.4 Tabla `firmas`

| Columna        | Tipo         | Descripción                                            |
|----------------|--------------|--------------------------------------------------------|
| `id`           | `int8` (PK)  | Autoincrement                                          |
| `usuario_id`   | `int8` (FK)  | → `usuarios.id`                                        |
| `if_id`        | `int8`       | ID interno del IF en NetSuite                          |
| `numero_if`    | `varchar`    | TranID del IF (ej. `IF-2026-001`)                      |
| `tipo_firma`   | `varchar`    | `auxAlmacen`, `cliente`, `jefeAlmacen`, `gerente`      |
| `ubicacion_id` | `int8` (FK)  | → `ubicaciones.id`                                     |
| `imagen_buffer`| `bytea`      | PNG firmado (opcional, puede no usarse)                |
| `netsuite_file_id` | `varchar`| ID del archivo en NetSuite File Cabinet                |
| `supabase_url` | `varchar`    | URL pública del PNG (si se subió a Supabase Storage)   |
| `fecha_firma`  | `timestamp`  | Cuándo se firmó                                        |
| `estado`       | `varchar`    | `pendiente`, `subido`, `error`                         |
| `created_at`   | `timestamp`  | —                                                      |
| `updated_at`   | `timestamp`  | —                                                      |

### 3.5 Tabla `audit_logs`

| Columna      | Tipo         | Descripción                                          |
|--------------|--------------|------------------------------------------------------|
| `id`         | `int8` (PK)  | Autoincrement                                        |
| `usuario_id` | `int8` (FK)  | Quién realizó la acción                              |
| `accion`     | `varchar`    | `login`, `create_if`, `submit`, etc.                 |
| `tabla`      | `varchar`    | Tabla afectada (si aplica)                           |
| `registro_id`| `int8`       | ID del registro afectado                             |
| `cambios`    | `jsonb`      | Snapshot de los cambios (json)                       |
| `ip_address` | `varchar`    | IP del cliente                                       |
| `user_agent` | `varchar`    | User-Agent del cliente                               |
| `created_at` | `timestamp`  | —                                                    |

> **Nota**: a la fecha de este documento, la tabla `firmas` y `audit_logs` existen en Supabase pero el backend **no las escribe todavía**. La persistencia final de firmas vive en NetSuite File Cabinet; `firmas` está lista para usarse si se decide duplicar la persistencia en Supabase. Ver §10.2 (pendientes).

---

## 4. Backend

### 4.1 Stack y dependencias

| Paquete               | Versión  | Propósito                                |
|-----------------------|----------|------------------------------------------|
| `express`             | ^4.18.2  | Framework HTTP                           |
| `@supabase/supabase-js` | ^2.38.0 | Cliente Supabase (Postgres + Auth)        |
| `axios`               | ^1.4.0   | Cliente HTTP para NetSuite REST API      |
| `bcryptjs`            | ^2.4.3   | Hash de contraseñas                      |
| `cors`                | ^2.8.5   | CORS middleware                          |
| `dotenv`             | ^16.0.0   | Carga `.env` (solo en desarrollo local)  |
| `form-data`          | ^4.0.0    | Subida de archivos a NetSuite (legacy)   |
| `jsonwebtoken`       | ^9.0.0    | Firma/verificación de JWT                |
| `oauth-1.0a`         | ^2.2.6    | Firmas OAuth 1.0a para TBA               |

### 4.2 Estructura de carpetas

```
backend/
├── server.js                 # Entry point
├── package.json
├── Dockerfile                # node:18-alpine, expone 3001
├── config/
│   ├── environments.js       # Validación de env vars y mapeos
│   ├── supabase.js           # Cliente Supabase (service_role)
│   ├── netsuiteRestlet.js    # Cliente OAuth 1.0a TBA para RESTlets (activo)
│   ├── netsuiteOAuth2.js     # Flujo Authorization Code OAuth 2.0
│   └── _legacy/              # Clientes OAuth 1.0a no usados en el flujo principal
│       ├── netsuiteAuth.js   #   REST API v1
│       ├── netsuiteOAuth.js  #   Variante legacy
│       └── netsuite.js       #   Stub
├── controllers/
│   ├── authController.js
│   ├── netsuiteController.js
│   ├── firmasController.js
│   └── oauthController.js
├── routes/
│   ├── auth.js
│   ├── netsuite.js
│   ├── firmas.js
│   ├── validation.js
│   └── oauth.js
├── services/
│   └── netsuiteFileService.js
└── middleware/
    └── auth.js
```

**Archivos en la raíz del repo** (scripts/templates de NetSuite, no son parte del backend Node.js — se despliegan manualmente al File Cabinet de NetSuite):

```
./
├── wms_link_firmas.js        # UserEvent Script → §6.11
├── wms_firma_template.xml    # Advanced PDF/HTML Template → §6.12
└── wms_restlet.js            # RESTlet 2860 (subida + status IF) → §6.7
```

> Estos archivos viven en la raíz porque se suben directamente a NetSuite vía `Customization → Scripting → Scripts → New` (los `.js`) o `Customization → Forms → Advanced PDF/HTML Templates` (el `.xml`). **No** son ejecutados por el backend ni servidos por nginx.

### 4.3 Entry point (`server.js`)

```js
const PORT = process.env.PORT || 3001;
app.use(cors({ origin: ALLOWED_ORIGINS.split(','), credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.get('/health', ...);
app.use('/auth',           require('./routes/auth'));
app.use('/auth/netsuite',  require('./routes/oauth'));
app.use('/netsuite',       require('./routes/netsuite'));
app.use('/firmas',         require('./routes/firmas'));
app.use('/validate',       require('./routes/validation'));
```

**Health check**: `GET /health` → `{"status":"OK","timestamp":...}`. Usado por Dokploy y por validaciones manuales.

### 4.4 API Endpoints

#### `/auth/*` — Autenticación y usuarios

| Método | Path                | Auth | Descripción                                                                  |
|--------|---------------------|------|------------------------------------------------------------------------------|
| POST   | `/auth/login`       | No   | Login con `email` + `password` → JWT + `user`                                |
| POST   | `/auth/register`    | No   | Crea usuario con hash bcrypt automático                                      |
| GET    | `/auth/user`        | JWT  | Devuelve el usuario del token (re-hidrata desde Supabase)                    |
| POST   | `/auth/logout`      | No   | No-op (stateless); el cliente borra el token                                 |
| POST   | `/auth/generate-hash` | No | Genera hash bcrypt. **Solo desarrollo**                                     |
| GET    | `/auth/netsuite/oauth/test`   | No | Diagnóstico OAuth 2.0                                              |
| GET    | `/auth/netsuite/oauth/initiate` | No | Redirige a NetSuite para iniciar OAuth 2.0                        |
| GET    | `/auth/netsuite/oauth/callback` | No | Recibe `?code=...` de NetSuite, intercambia por access token          |

#### `/netsuite/*` — IFs, NetSuite y diagnósticos

| Método | Path                       | Auth | Descripción                                                  |
|--------|----------------------------|------|--------------------------------------------------------------|
| GET    | `/netsuite/diagnostic`     | No   | Diagnóstico completo: valida env vars, prueba RESTlet 2860 con dummy upload |
| GET    | `/netsuite/ifs?ubicacion_id=X` | JWT | Devuelve IFs filtrados por la ubicación del usuario. **Nota**: hoy no usa el query param, lee de `req.user.ubicacion_id` |
| POST   | `/netsuite/submit`         | JWT  | Sube firmas al File Cabinet y actualiza el status del IF    |

#### `/firmas/*` — Subida de firmas (legacy)

| Método | Path                       | Auth | Descripción                                                  |
|--------|----------------------------|------|--------------------------------------------------------------|
| POST   | `/firmas/upload`           | JWT  | Sube múltiples firmas para un IF                             |
| POST   | `/firmas/upload/single`    | JWT  | Sube una firma individual a un `folderId` arbitrario        |

> Los endpoints `/firmas/*` son legacy. El flujo principal usa `/netsuite/submit` que también sube firmas. Se mantienen para compatibilidad.

**`POST /firmas/upload`** — Request:
```jsonc
{
  "ifNumber": "IF-2026-001",
  "location": "MEX",
  "signatures": {
    "cliente":     "data:image/png;base64,iVBORw0KGgo...",
    "almacen":     "data:image/png;base64,iVBORw0KGgo...",
    "jefe_almacen":"data:image/png;base64,iVBORw0KGgo..."
  }
}
```

**`POST /firmas/upload`** — Response 200/207:
```jsonc
{
  "status": "success" | "partial_success",
  "ifNumber": "IF-2026-001",
  "location": "MEX",
  "uploaded": [ { "type": "cliente", "label": "Cliente", "filename": "IF-2026-001_cliente.png", "size": 12345, "fileId": "...", "folderId": 12849, "url": "..." } ],
  "failed":   undefined,            // presente si hubo failures
  "summary":  { "total": 2, "success": 2, "failures": 0 },
  "timestamp": "2026-06-09T20:30:00.000Z"
}
```

**`POST /firmas/upload/single`** — Request:
```jsonc
{ "filename": "IF-2026-001_cliente.png", "fileContent": "data:image/png;base64,...", "folderId": 12849 }
```

**`POST /firmas/upload/single`** — Response 200:
```jsonc
{ "success": true, "fileName": "...", "fileId": "...", "folderId": 12849, "url": "...", "size": 12345, "uploaded": "2026-06-09T..." }
```

#### `/validate` — Validación de configuración

| Método | Path        | Auth | Descripción                                                                  |
|--------|-------------|------|------------------------------------------------------------------------------|
| GET    | `/validate` | No   | Verifica env vars, folder IDs y hace un test upload dummy al RESTlet 2860    |

### 4.5 Modelos de Request / Response

#### `POST /auth/login`

```jsonc
// Request
{ "email": "usuario@marblock.com", "password": "MiPassword123!" }

// Response 200
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": 5,
    "nombre": "Juan García",
    "email": "usuario@marblock.com",
    "cargo": "aux_almacen",
    "ubicacion": { "id": 1, "nombre": "MEX" }
  }
}
```

#### `POST /auth/register`

```jsonc
// Request
{
  "email": "nuevo@marblock.com",
  "password": "MiPassword123!",
  "nombre_completo": "Juan García",
  "ubicacion_id": 1,
  "cargo": "aux_almacen"
}
// Response 201
{ "message": "User created successfully", "user": { "id": 6, "email": "...", "nombre_completo": "...", "cargo": "..." } }
```

#### `GET /netsuite/ifs`

```jsonc
// Response 200
{
  "ifs": [
    {
      "internalId": 12345,
      "tranid": "IF-2026-001",
      "sourceDoc": "SO14548",
      "description": "Salida de placas MEX",
      "location": "MEX",
      "status": "B",
      "date": "2026-06-09"
    }
  ],
  "ubicacion": "MEX",
  "total": 1
}
```

> Los nombres de los campos del response final son producto de `formatIFRecord` (`backend/controllers/netsuiteController.js:38-48`), que mapea por nombre desde la respuesta cruda del RESTlet 2217. Ver §6.5.5 para la equivalencia entre campos NetSuite y keys del JSON.

#### `POST /netsuite/submit`

```jsonc
// Request
{
  "ifTranid": "IF-2026-001",
  "ifInternalId": 12345,
  "ubicacion_id": 1,
  "items": [
    { "sku": "SKU-A", "lote": "L-001", "ubicacion": "A-1-2", "hora": "14:30:00", "timestamp": "2026-06-09T20:30:00.000Z" }
  ],
  "signatures": {
    "auxAlmacen": "data:image/png;base64,iVBORw0KGgo...",
    "cliente":    "data:image/png;base64,iVBORw0KGgo..."
  }
}

// Response 200 (todo OK) o 207 (parcial)
{
  "status": "success" | "partial_success",
  "message": "All signatures uploaded successfully to NetSuite",
  "ifTranid": "IF-2026-001",
  "ifInternalId": 12345,
  "location": "MEX",
  "itemsCount": 1,
  "uploadedFiles": [ { "type": "auxAlmacen", "label": "Aux. de Almacén", "filename": "IF-2026-001_auxAlmacen.png", "size": 12345, "success": true, "fileId": "...", "folderId": 12848, "url": "...", "uploaded": "..." } ],
  "failedFiles": undefined,
  "ifStatusUpdated": true,
  "ifStatusError": undefined,         // presente si el update de status falló (string con el error)
  "timestamp": "2026-06-09T20:30:00.000Z",
  "summary": { "totalSignatures": 2, "successCount": 2, "failureCount": 0 }
}
```

### 4.6 Middleware

#### `verifyToken` (`backend/middleware/auth.js`)

Lee `Authorization: Bearer <token>`, verifica con `JWT_SECRET`, y pone el payload en `req.user`:

```js
req.user = {
  id, email, nombre, cargo, ubicacion_id,
  iat, exp
}
```

> **Importante**: el JWT no incluye el objeto `ubicacion` completo, solo `ubicacion_id`. Los controllers hacen un lookup a Supabase para hidratar `ubicacion.nombre` cuando lo necesitan.

### 4.7 Controllers

#### `authController` (`backend/controllers/authController.js`)

| Función       | Línea | Responsabilidad                                                              |
|---------------|-------|------------------------------------------------------------------------------|
| `login`       | 8-71  | Busca usuario por email, valida `bcrypt.compare`, genera JWT de 24h         |
| `register`    | 76-128| Valida campos, valida que `ubicacion_id` exista, hashea con `bcrypt` cost 10 |
| `getUser`     | 133-167| Re-hidrata el usuario desde Supabase usando el `id` del JWT                  |
| `logout`      | 172-174| No-op (stateless)                                                            |
| `generateHash`| 179-194| Helper de testing, no usar en producción                                     |

#### `netsuiteController` (`backend/controllers/netsuiteController.js`)

| Función            | Línea  | Responsabilidad                                                                                                       |
|--------------------|--------|-----------------------------------------------------------------------------------------------------------------------|
| `getIFs`           | 54-97  | Llama al RESTlet 2217 con `searchId=customsearch3672`, filtra por ubicación del usuario, mapea a formato simplificado |
| `formatIFRecord`   | 38-48  | Helper que toma la fila cruda del RESTlet 2217 y devuelve el objeto que consume el frontend. Mapea por nombre (no por índice). |
| `submitData`       | 166-324| Por cada firma: sube PNG al File Cabinet (script 2860). Si todas OK, actualiza status del IF a `C`                   |
| `diagnosticTest`   | 333-436| Valida env vars, prueba conexión con OAuth al RESTlet 2860 (dummy upload)                                            |

**Helpers de filtrado de IFs** (`filterIFsByUserLocation`, líneas 27-36, más helpers `extractLocation` línea 8, `isSharedLocation` y `startsWithRestrictedPrefix`):

```js
// Constantes de configuración:
//   RESTRICTED_LOCATION_PREFIXES = ['MEX', 'MTY', 'GDL']   // prefijos exclusivos
//   SHARED_LOCATIONS = ['TEMPORAL', 'PROYECTOS', 'Material Transformado', 'MATRIZ']  // whitelist

// Una IF es visible para el usuario si:
//   1. Su location está en SHARED_LOCATIONS (whitelist explícita), o
//   2. Su location NO inicia con ninguno de los prefijos restringidos (MEX, MTY, GDL)
//      → en ese caso es una ubicación "compartida por default" y todos la ven, o
//   3. Su location inicia con un prefijo restringido Y:
//        (a) location === user.ubicacion.nombre (match exacto), o
//        (b) location contiene el nombre de la ubicación del usuario como token
//            (split por [\s:]+ → includes) — cubre "GDL:OUTLET GDL" para usuarios GDL.
//
// Soporta que location llegue como string, {text} o {value}.
```

> **Importante** (ver §9.8): el caso (3b) es el fix que permite a un usuario de la sucursal padre ver las IFs de su outlet. Sin él, IFs con location `"GDL:OUTLET GDL"` no aparecían para usuarios de `GDL`.
>
> La regla (2) — "cualquier location que no inicie con MEX/MTY/GDL es compartida" — existe porque la lista de ubicaciones puede crecer (nuevas tiendas, proyectos especiales) y el sistema debe ser permisivo: si una nueva ubicación no se parece a ninguna restringida, todos la ven. La `whitelist` explícita (`TEMPORAL`, `PROYECTOS`) se conserva para garantizar que esos nombres siempre sean compartidos sin depender del prefijo.

#### `firmasController` (`backend/controllers/firmasController.js`)

Wrapper sobre `netsuiteFileService` que recibe `ifNumber`, `location`, `signatures` y devuelve resultado agregado.

#### `oauthController` (`backend/controllers/oauthController.js`)

Implementa el flujo OAuth 2.0 (Authorization Code) contra NetSuite. **Nota**: el callback hoy **no persiste el token** (lo retorna en la respuesta), por lo que el flujo no está completo en producción. Usar TBA para el flujo principal.

### 4.8 Servicios

#### `netsuiteFileService` (`backend/services/netsuiteFileService.js`)

Funciones públicas:

```js
uploadFile(filename, fileContent, folderId)        // una firma
uploadSignatures(signatures, ifNumber, location)    // múltiples
base64ToBuffer(base64String)
```

`uploadSignatures` itera por cada firma, llama a `getFolderId(tipoFirma)` y sube a la carpeta correspondiente. Devuelve `{ uploaded: [...], failed: [...] }`. La ubicación del IF no participa en la resolución del folder (ver §6.8).

### 4.9 Configuración

#### `config/environments.js`

- **Valida al boot** (línea 19-25) que existan 9 variables críticas. En `NODE_ENV=production` lanza excepción si falta alguna.
- Expone el objeto `config` con secciones `netsuite`, `supabase`, `jwt`, `server`.
- `config.netsuite.getFolderId(tipoFirma)`: consulta el mapa plano `FIRMAS_CARPETAS` y devuelve el ID de folder de NetSuite. Lanza error si el tipo no existe. La ubicación no participa.

#### `config/supabase.js`

Cliente con `service_role_key` (bypass RLS). Cualquier acceso desde backend ignora las políticas de Supabase. **No exponer esta key al frontend**.

#### `config/netsuiteRestlet.js` (cliente activo para RESTlets)

```js
const oauth = new OAuth({
  consumer:  { key: NETSUITE_CLIENT_ID,    secret: NETSUITE_CLIENT_SECRET    },
  signature_method: 'HMAC-SHA256',
  realm: NETSUITE_REALM,
  hash_function: (b, k) => crypto.createHmac('sha256', k).update(b).digest('base64')
});

// Interceptor firma cada request antes de enviar
netsuiteRestletClient.interceptors.request.use((request) => { ... });
```

- `baseURL` se calcula desde `NETSUITE_RESTLET_URL` parseando solo `protocol + hostname`.
- La URL completa a firmar es `${baseUrl}${request.url}`.
- El header resultante se inyecta en `request.headers['Authorization']`.

#### `config/netsuiteOAuth2.js` y `config/_legacy/`

`netsuiteOAuth2.js` implementa el flujo Authorization Code de OAuth 2.0 (en desarrollo, solo se usa desde los endpoints `/auth/netsuite/oauth/*`). Los clientes `netsuiteAuth.js`, `netsuiteOAuth.js` y `netsuite.js` se movieron a `config/_legacy/` porque no participan en el flujo principal (RESTlets 2217/2860) y solo quedaban como referencia. Ver §6.9.

### 4.10 Logging y errores

- Console logs con prefijos emoji para identificar tipo: `🚀 start`, `🔐 auth`, `📤 upload`, `✅ ok`, `❌ error`, `🔍 debug`.
- 4xx: validación de input (`400`), credenciales (`401`), permisos (`403`), no encontrado (`404`).
- 5xx: error interno con mensaje genérico al cliente y `error.message` solo en `NODE_ENV=development`.

---

## 5. Frontend

### 5.1 Stack y dependencias

- **Sin build step**. JS vanilla, sin bundler, sin TypeScript.
- Librerías externas (CDN o local):
  - `signature_pad.min.js` (local en `lib/`) — captura de firma en canvas.
  - `html5-qrcode` (CDN: cdnjs, con `defer`) — escáner QR por cámara (fallback).
- Iconos: SVG inline.
- Estilos: `css/variables.css` + `css/styles.css`.
- **Cache-busting**: los scripts se sirven con `?v=N` para forzar recarga tras deploy. Incrementar `N` cuando se actualice el JS.

### 5.2 Estructura de archivos frontend

```
WMS/
├── index.html              # Entry point, carga 9 scripts (con ?v=N)
├── css/
│   ├── variables.css       # Variables CSS (colores, fonts)
│   └── styles.css          # Estilos completos
├── images/                 # Assets visuales (logo, etc.)
├── lib/
│   └── signature_pad.min.js  # Librería de firma
└── js/
    ├── utils.js            # showToast, setStatus, esc
    ├── auth.js             # Login, logout, restoreSession, BACKEND_URL
    ├── netsuite-client.js  # loadIFs, submitToNetSuite
    ├── signatures.js       # getRequiredSignatures, captureNextSignature
    ├── qr-parser.js        # parseQR(text, mode)
    ├── webhook.js          # WEBHOOK_URL a n8n (LEGACY / FALLBACK)
    ├── table.js            # records[], addRecord, deleteRow, clearTable
    ├── scanner.js          # Pistola (principal) + Cámara (fallback)
    └── app.js              # initApp, scanMode
```

### 5.3 Carga de scripts

`index.html` define `window.APP_CONFIG` con `BACKEND_URL` (default `https://api.marblock.shop`) **antes** de cargar los scripts. Luego carga en este orden estricto, **con `?v=N` para forzar cache-busting**:

```html
<script src="js/config.js?v=4"></script>
<script src="js/utils.js?v=4"></script>
<script src="js/auth.js?v=4"></script>
<script src="js/netsuite-client.js?v=4"></script>
<script src="js/signatures.js?v=4"></script>
<script src="js/qr-parser.js?v=4"></script>
<script src="js/webhook.js?v=4"></script>
<script src="js/table.js?v=4"></script>
<script src="js/scanner.js?v=4"></script>
<script src="js/app.js?v=4"></script>
```

**Reglas del cache-busting**:
- Cuando se actualice cualquier JS, **incrementar `N`** en TODOS los tags `<script>`.
- El frontend sirve archivos estáticos con cache por defecto; sin `?v=N` los usuarios verían versiones viejas.
- En local (`python -m http.server`), el cache no aplica, pero mantenemos `?v=N` para paridad con producción.

**Orden y dependencias** (debe respetarse):

1. `utils.js` — sin dependencias.
2. `auth.js` — usa `showToast` (utils).
3. `netsuite-client.js` — usa `currentUser`, `authenticatedFetch` (auth).
4. `signatures.js` — usa `records` (table), `clearScanBuffer` (scanner — declarado globalmente en window).
5. `qr-parser.js` — sin dependencias.
6. `webhook.js` — usa `auth`, `table`, `app`.
7. `table.js` — usa `utils`.
8. `scanner.js` — usa `utils`, `table` (addRecord), `qr-parser` (parseQR).
9. `app.js` — usa `table`.

> **Importante**: el orden está hardcodeado en `index.html` y debe respetarse. Refactorizar a ES Modules requeriría servidor con MIME `application/javascript` y agrega complejidad no justificada.

### 5.4 Configuración

```html
<!-- index.html -->
<script>
  window.APP_CONFIG = window.APP_CONFIG || {
    BACKEND_URL: (typeof window.__BACKEND_URL__ === 'string' && window.__BACKEND_URL__)
      ? window.__BACKEND_URL__
      : 'https://api.marblock.shop'
  };
</script>
```

- `window.__BACKEND_URL__` puede inyectarse desde el servidor (nginx `sub_filter` o similar). Si no existe, usa el fallback público.
- El valor se lee en `js/auth.js`.

### 5.5 Estado global

Todas las variables compartidas son globales (declaradas con `var` en cada script, accesible desde todos los demás). Esto evita la necesidad de ES Modules:

| Variable                | Definida en              | Tipo       | Usada en                                                                  |
|-------------------------|--------------------------|------------|---------------------------------------------------------------------------|
| `BACKEND_URL`           | `auth.js`                | string     | `auth.js`, `netsuite-client.js` (vía `authenticatedFetch`)                |
| `currentUser`           | `auth.js`                | object     | `auth.js`, `netsuite-client.js`, `webhook.js`                             |
| `authToken`             | `auth.js`                | string     | `auth.js` (en `authenticatedFetch`)                                       |
| `availableIFs`          | `netsuite-client.js`     | array      | `netsuite-client.js`                                                     |
| `selectedIF`            | `netsuite-client.js`     | object     | `netsuite-client.js`, `signatures.js`, `webhook.js`                      |
| `records`               | `table.js`               | array      | Toda la app                                                               |
| `signaturePad`          | `signatures.js`          | object     | `signatures.js`                                                          |
| `collectedSignatures`   | `signatures.js`          | object     | `signatures.js`                                                          |
| `signatureQueue`        | `signatures.js`          | array      | `signatures.js`                                                          |
| `currentSignatureType`  | `signatures.js`          | string     | `signatures.js`                                                          |
| `hasBeenSent`           | `webhook.js`             | bool       | `webhook.js`, `table.js`                                                 |
| `scanSource`            | `scanner.js`             | string     | `scanner.js` (pistola/cámara)                                             |
| `pistolActive`          | `scanner.js`             | bool       | `scanner.js`                                                              |
| `cameraActive`          | `scanner.js`             | bool       | `scanner.js`                                                              |
| `scanBuffer`            | `scanner.js`             | string     | `scanner.js`                                                              |
| `lastCode`              | `scanner.js`             | string     | `scanner.js` (dedupe 3s: mismo QR dentro de 3s se ignora)                |
| `lastTime`              | `scanner.js`             | number     | `scanner.js` (timestamp ms del último scan aceptado)                     |
| `lastKeyTime`           | `scanner.js`             | number     | `scanner.js` (timestamp ms de la última tecla, para detectar timing)    |
| `scanner`               | `scanner.js`             | Html5Qrcode | `scanner.js`                                                            |

**API expuesta vía `window`** (para que los `onclick` inline en el HTML la encuentren):

| Función                          | Definida en     | Para qué                                            |
|----------------------------------|-----------------|-----------------------------------------------------|
| `window.setScanSource(src)`      | `scanner.js`    | Alternar entre pistola y cámara                     |
| `window.startScanner()`          | `scanner.js`    | Iniciar fuente activa                               |
| `window.stopScanner()`           | `scanner.js`    | Detener fuente activa                               |
| `window.clearScanBuffer()`       | `scanner.js`    | Limpiar buffer manualmente                          |
| `window.getScannerState()`       | `scanner.js`    | Estado en tiempo real (debug desde consola)         |
| `handleLogin`, `handleLogout`, `restoreSession` | `auth.js` | Login flow |
| `loadIFs`, `submitToNetSuite`, `handleIFSelect`, `reloadIFs`, `clearIF` | `netsuite-client.js` | IFs |
| `startSignatureCapture`, `askExitConfirmation`, `captureNextSignature`, `submitSignature`, `submitWithSignatures` | `signatures.js` | Firmas |
| `addRecord`, `deleteRow`, `clearTable`, `getActiveRecords`, `renderEmpty` | `table.js` | Tabla |
| `parseQR` | `qr-parser.js` | Parser (usado por `scanner.js`) |

### 5.6 Flujo de usuario

```
┌────────────┐
│  LOGIN     │  handleLogin(email, password)  →  POST /auth/login
└─────┬──────┘
      │  JWT en sessionStorage
      ▼
┌────────────────┐
│ mainApp visible │  mainApp pasa de display:none a display:block
│ (auto-load IFs) │  loadIFs() se llama en restoreSession() si hay token
└─────┬──────────┘
      │
      ▼
┌────────────────┐
│ PISTOLA ACTIVA  │  IIFE en scanner.js adjunta el listener de keydown
│ (auto-arranque) │  al cargar la página. El LED se pone verde.
└─────┬──────────┘
      │  Usuario selecciona IF
      ▼
┌────────────┐
│ SELECCIONAR│  handleIFSelect(event)  →  selectedIF
│    IF      │  Si cambia con records cargados, pide confirmación
└─────┬──────┘
      │
      ▼
┌────────────────┐
│  ESCANEAR     │  Pistola: onPistolaKeydown() buffer→terminator→handleScan
│  PLACAS       │  Cámara (si activa): Html5Qrcode callback→handleScan
└─────┬──────────┘
      │  records[] poblado
      ▼
┌────────────┐
│  FIRMAR    │  startSignatureCapture()  →  getRequiredSignatures()  →  cola
│            │  submitSignature()  →  collectedSignatures[tipo] = dataURL
└─────┬──────┘
      │  collectedSignatures poblado
      ▼
┌────────────┐
│  ENVIAR    │  submitToNetSuite(signatures)
│            │  →  POST /netsuite/submit
└─────┬──────┘
      │  200 → limpiar tabla, lockFromResend()
      │  207 → partial_success, mostrar archivos fallidos
      │  500 → mostrar error, NO limpiar
      ▼
```

### 5.7 Funciones por módulo

#### `js/utils.js`
- `showToast(msg, type)` — notificación temporal 2.8s. `type`: `success`, `error`, `folio-ok`.
- `setStatus(msg, type)` — actualiza línea de estado del escáner (`#statusText` + `#statusDot`).
- `esc(s)` — escape HTML para evitar XSS al inyectar `sku`, `lote`, `ubicacion`.

#### `js/auth.js`
- `handleLogin(event)` — login con fetch.
- `handleLogout()` — limpia `sessionStorage` y vuelve a vista de login.
- `restoreSession()` — al cargar la página, si hay token en `sessionStorage` lo rehidrata. Llamado en `DOMContentLoaded`.
- `authenticatedFetch(endpoint, options)` — wrapper que agrega `Authorization: Bearer <token>` y maneja 401 (logout forzado).
- `showMainView()` — muestra `#mainApp`, oculta `#loginContainer`. No inicia la pistola (eso lo hace `scanner.js` automáticamente).

#### `js/netsuite-client.js`
- `loadIFs()` — GET a `/netsuite/ifs`. Llena `availableIFs` y el `<select>`.
- `updateIFSelect()` — renderiza opciones del dropdown. Formato: `IF14580 (SO14548)`.
- `handleIFSelect(event)` — al cambiar el select, guarda `selectedIF`. **Si hay placas escaneadas y el usuario cambia de IF, pide confirmación** (no se borran automáticamente, pero advierte que esas placas no se enviarán con la nueva IF).
- `reloadIFs()` — recarga IFs (también pide confirmación si hay placas).
- `clearIF()` — limpia selección.
- `submitToNetSuite(signatures)` — POST a `/netsuite/submit` con `{ifTranid, ifInternalId, ubicacion_id, items, signatures}`.

#### `js/signatures.js`
- `initSignaturePad()` — instancia `new SignaturePad(canvas, ...)`.
- `getRequiredSignatures()` — devuelve objeto con firmas requeridas según `records.length`:
  - siempre: `auxAlmacen` y `cliente`
  - si `> 3`: `jefeAlmacen`
  - si `> 10`: `gerente`
- `startSignatureCapture()` — valida en cascada:
  1. `records.length === 0` → toast "Escanea al menos una placa…" + return.
  2. `!selectedIF` → toast "Selecciona una IF antes…" + return.
  3. Llama `clearScanBuffer()` (defensivo) y muestra `#confirmExitModal`.
- `askExitConfirmation(count, selectedIF)` — modal con "Se registrarán N placas para IF14580 (SO14548). ¿Deseas continuar?".
- `captureNextSignature()` — saca la siguiente firma de la cola y muestra `#signatureModal`. Llama `clearScanBuffer()` antes de mostrar.
- `clearSignature()` — limpia el canvas.
- `submitSignature()` — toma `toDataURL('image/png')` y guarda en `collectedSignatures`.
- `submitWithSignatures()` — llama a `submitToNetSuite(collectedSignatures)`. Si OK, limpia tabla y llama `clearIF()`.

#### `js/qr-parser.js`
- `parseQR(raw, mode)` — devuelve `{tipo:'placa', sku, lote, ubicacion}` si tiene 3+ partes separadas por espacio, o `{tipo:'folio', valor}` si 1 parte. Modo `folio` siempre devuelve `folio`. La app solo usa modo `placa`.

#### `js/table.js`
- `records` (array global) — todas las placas escaneadas.
- `addRecord(item)` — agrega a `records[]` y crea `<tr>` con `hora` formato es-MX. Usa `esc()` para evitar XSS.
- `deleteRow(btn, idx)` — marca como null (soft delete, no remueve del array).
- `clearTable()` — pide confirmación, vacía todo, llama `unlockForResend()`.
- `getActiveRecords()` — filtra los no eliminados.
- `renderEmpty()` — pinta el estado vacío.

#### `js/scanner.js` (CRÍTICO — leer con atención)

Este módulo es el **punto de entrada de los códigos QR** y soporta dos fuentes alternativas (pistola HID o cámara). La lógica es no trivial por los edge cases que resuelve.

**Estado interno** (todas `var` globales):

```js
var scanSource = 'pistola';    // 'pistola' | 'camara'
var pistolActive = false;       // listener de keydown adjunto?
var cameraActive = false;       // cámara Html5Qrcode corriendo?
var scanBuffer = '';            // buffer de caracteres acumulados
var lastKeyTime = 0;            // para detectar timeout entre teclas
```

Constantes (en `js/scanner.js`):
- `SCAN_TERMINATOR_KEYS = ['Enter', 'Tab', '\n', '\r']` — cualquiera de estos cierra el buffer.
- `SCAN_MAX_LENGTH = 200` — límite de caracteres por buffer.
- `SCAN_BUFFER_TIMEOUT = 500` (ms) — sin actividad, se descarta el buffer (anti-ruido).

**API pública** (expuesta en `window`):
- `setScanSource(src)` — alterna entre `'pistola'` y `'camara'`. Detiene la activa antes de cambiar.
- `startPistola()` / `stopPistola()` — adjunta/remueve el listener de keydown.
- `startCamera()` / `stopCamera()` — inicia/detiene `Html5Qrcode`.
- `startScanner()` / `stopScanner()` — orquestadores (llaman al de la fuente activa).
- `handleScan(text)` — entrada única para ambas fuentes: dedupe 3s, `parseQR`, `addRecord`, actualiza `#lastScanText`.
- `clearScanBuffer()` — limpia el buffer manualmente (llamado por `signatures.js` al abrir modales).
- `getScannerState()` — getter para debug en consola.

**Flujo del modo pistola** (paso a paso, en pseudocódigo):

```js
// 1. Se adjunta el listener UNA sola vez al cargar la página (IIFE)
//    y cada vez que el usuario cambia de Cámara → Pistola.

document.addEventListener('keydown', onPistolaKeydown);

function onPistolaKeydown(e) {
    // 2. Si hay un modal abierto, descartar el buffer
    if (isAnyModalOpen()) { scanBuffer = ''; return; }

    // 3. Solo procesar si la pistola está activa
    if (scanSource !== 'pistola' || !pistolActive) return;

    // 4. Detectar el ritmo: pistola ~5-30ms entre teclas, humano ~100-300ms
    var dt = performance.now() - lastKeyTime;
    lastKeyTime = performance.now();
    var isRapid = dt < 50;     // <50ms entre teclas = pistola
    var isTerminator = SCAN_TERMINATOR_KEYS.indexOf(e.key) !== -1;

    // 5. Si el target es un form field Y el tipeo es lento (humano),
    //    dejar pasar al input normalmente y resetear el buffer
    if (isFormField(e.target) && !isRapid && !isTerminator) {
        scanBuffer = '';
        return;
    }

    // 6. Si es el terminador (Enter), procesar el buffer
    if (isTerminator) {
        e.preventDefault();        // evita scroll
        e.stopPropagation();        // evita que Enter active botón
        // Blur del input/select/button con foco para evitar re-dispare
        var active = document.activeElement;
        if (active && active.blur && (isFocusedButton() || isFormField(active))) {
            active.blur();
        }
        var cleanBuf = scanBuffer.replace(/[\r\n\t]+/g, '').trim();
        scanBuffer = '';
        if (cleanBuf.length > 0) handleScan(cleanBuf);
        return;
    }

    // 7. Acumular caracteres imprimibles
    if (e.key && e.key.length === 1) {
        if (scanBuffer && dt > SCAN_BUFFER_TIMEOUT) scanBuffer = '';
        scanBuffer += e.key;
        if (scanBuffer.length > SCAN_MAX_LENGTH) scanBuffer = '';
    }
}
```

**Decisiones de diseño críticas**:

1. **Auto-arranque al cargar la página**: el listener se adjunta en la IIFE al final del archivo, sin esperar a que el usuario haga click. Esto simplifica la UX (el operador solo abre la app y empieza a escanear).

2. **Detección pistola vs humano por timing**: si el `keydown` viene de un `<input>` o `<select>` y el intervalo entre teclas es >50ms, asumimos que es tipeo humano y dejamos pasar al campo. Si es <50ms, asumimos que es la pistola y capturamos los caracteres aunque vengan de un campo de formulario. Esto resuelve el bug histórico donde escanear con foco en el `<select>` de IF no funcionaba (ver §9.15).

3. **Blur del elemento con foco al recibir Enter**: cuando llega el terminador, hacemos `blur()` del input/select/button que tiene foco. Esto evita que (a) caracteres basura queden visibles en un input, y (b) el Enter re-dispare un botón (como pasaba con el botón "Probar scan" en versiones anteriores).

4. **`preventDefault` SIEMPRE en terminador**: aunque el buffer esté vacío, prevenimos el default del Enter. Esto evita el comportamiento por defecto del navegador de hacer scroll cuando se presiona Enter sin target específico.

5. **Helper `isFormField`**: retorna `true` para `INPUT`, `TEXTAREA`, `SELECT` o elementos `contentEditable`. NO incluye `BUTTON` (los botones no aceptan texto).

6. **Helper `isFocusedButton`**: retorna `true` si `document.activeElement.tagName === 'BUTTON'`. Usado para blurear el botón con foco al recibir el terminador.

7. **Helper `isAnyModalOpen`**: detecta si `.confirm-modal.active` o `.signature-modal.active` están abiertos. Si lo están, descartamos el buffer y retornamos (los modales manejan su propio input).

**Flujo del modo cámara** (modo fallback, opcional):

```js
function startCamera() {
    if (cameraActive) return;
    if (typeof Html5Qrcode === 'undefined') {
        showToast('No se pudo cargar la librería de cámara', 'error');
        return;
    }
    scanner = new Html5Qrcode('reader');
    var config = {
        fps: 10,
        qrbox: { width: 220, height: 220 },  // mínimo 50px
        aspectRatio: 1.7778,
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        videoConstraints: {
            facingMode: { ideal: 'environment' },  // cámara trasera
            width: { ideal: 1920, min: 640 },
            height: { ideal: 1080, min: 480 }
        }
    };
    scanner.start({ facingMode: 'environment' }, config, handleScan, () => {})
        .then(() => { cameraActive = true; ... })
        .catch((err) => { showToast('No se pudo acceder a la cámara', 'error'); });
}
```

**Función unificadora `handleScan(text)`**:

```js
function handleScan(text) {
    var now = Date.now();
    if (text === lastCode && (now - lastTime) < 3000) {
        console.log('[WMS-SCAN] dedupe');
        return;  // dedupe: mismo código dentro de 3s
    }
    lastCode = text;
    lastTime = now;

    var result;
    try { result = parseQR(text, 'placa'); }
    catch (e) { console.error('[WMS-SCAN] ERROR en parseQR:', e); return; }

    if (!result) {
        showToast('QR no reconocido (formato inválido)', 'error');
        updateLastScanPreview({ error: 'Formato inválido: ' + text.substring(0, 40) });
        return;
    }

    if (typeof addRecord === 'function') {
        try { addRecord(result); }
        catch (e) {
            console.error('[WMS-SCAN] ERROR en addRecord:', e);
            showToast('Error al agregar registro: ' + e.message, 'error');
        }
    } else {
        console.error('[WMS-SCAN] ERROR: addRecord no está definida. ¿Se cargó table.js?');
    }
    updateLastScanPreview({ ok: result });
}
```

**Importante**: `parseQR` espera el formato `SKU LOTE UBICACION` (3 tokens separados por espacio). Si el QR no tiene este formato, retorna `null` y se muestra un toast de error.

**Init (IIFE al final del archivo)**:

```js
(function initScanner() {
    console.log('[WMS-SCAN] initScanner ejecutándose, readyState:', document.readyState);
    applyScanSourceUI();
    if (scanSource === 'pistola' && !pistolActive) startPistola();

    // Si el DOM no estaba listo, esperar
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            applyScanSourceUI();
            if (scanSource === 'pistola' && !pistolActive) startPistola();
        });
    }
})();
```

**Toggle visual** (en el HTML del card del escáner):
- Botón `#sourcePistola` → `onclick="setScanSource('pistola')"`.
- Botón `#sourceCamara` → `onclick="setScanSource('camara')"`.
- `applyScanSourceUI()` actualiza el panel visible (`#gunPanel` vs `#cameraPanel`), el título del card, y muestra/oculta el banner de aviso (`#cameraWarning`).

**Helpers DOM** (defensivos, no fallan si el elemento no existe):

```js
function _el(id) { return document.getElementById(id); }
function _setDisplay(id, value) { var e = _el(id); if (e) e.style.display = value; }
function _setText(id, value) { var e = _el(id); if (e) e.textContent = value; }
function _setClass(id, cls) { var e = _el(id); if (e) e.className = cls; }
```

#### `js/webhook.js` (LEGACY / FALLBACK)
- `exportJSON()` — POST a `https://n8nmrb.marblock.shop/webhook/...` con el payload. Si falla, descarga JSON local.
- `downloadJSONFallback(payload)` — `<a download>` con Blob.
- `lockFromResend()` / `unlockForResend()` — bloquea el botón "Completar registro" después de un envío exitoso.

> `exportJSON()` **sí se invoca** como fallback paralelo desde `js/signatures.js:201` (`submitWithSignatures`), después de un submit exitoso a NetSuite. Es decir, el frontend siempre intenta publicar al webhook de n8n además de NetSuite; si el webhook falla, descarga el JSON local. `lockFromResend()` se llama en ambos casos (NetSuite OK o webhook OK).

#### `js/app.js`
- `initApp()` — llama a `renderEmpty()`. Listener `DOMContentLoaded`.
- `scanMode = 'placa'` — constante legacy. El modo "folio" existe en el código pero no se usa en la UI actual.

### 5.8 Convenciones de UI

- **Colores**: definidos en `css/variables.css` (no inspeccionado a fondo). Usar variables CSS, no valores hardcoded.
- **Iconos**: SVG inline, no font icons. Estilo: `stroke="currentColor"`, `stroke-width="1.2-2.2"`.
- **Notificaciones**: solo `showToast()`, no alerts nativos.
- **Modales**: clase `.active` para mostrar. Hay dos:
  - `#signatureModal` — modal de captura de firma en canvas.
  - `#confirmExitModal` — modal de confirmación previo al flujo de firmas, `z-index: 1001` (encima del modal de firma).
- **Card del escáner** (estructura HTML):
  - **Header**: título + toggle Pistola/Cámara (segmented control).
  - **Panel pistola** (`#gunPanel`, visible por default): LED de estado (`#gunLed` con clase `active` cuando escucha) + label "Pistola activa" / "Pistola inactiva" + última placa leída (`#lastScanText`).
  - **Panel cámara** (`#cameraPanel`, oculto por default): `#reader` con `Html5Qrcode` + overlay de marco de escaneo.
  - **Banner de aviso** (`#cameraWarning`, oculto por default): "Modo Cámara: la pistola NO funcionará acá. Volvé a Pistola...".
  - **Status line** (`.status-line`): punto de estado + texto del último evento.

---

## 6. Integración con NetSuite

### 6.1 Componentes de NetSuite requeridos

| Componente        | ID / Identificador    | Función                                                              |
|-------------------|------------------------|----------------------------------------------------------------------|
| Account           | `9080139-sb1` (sandbox) | Cuenta de NetSuite sandbox                                     |
| Realm             | `9080139_SB1`          | Identificador TBA                                                     |
| Rol `WMS`         | custom                  | Rol dedicado para TBA con permisos específicos (ver §6.2)             |
| Integration Record| `customscript_28fc666e3cad` | Habilita TBA con `Issue Token Endpoint` y scope `RESTlets` + `REST web services` |
| Token TBA         | `WMS - Rogelio García Aguilar, WMS` | Aplicación `WMS`, Usuario `auxsistemas@marblock.com`, Rol `WMS` |
| Saved Search      | `customsearch3672`      | Devuelve IFs con `Tipo = Ejecución de orden de artículo`, `Estado = Empaquetado`, `Línea principal = verdadero` |
| RESTlet 2217      | `CUSTOMSCRIPT2217`, deploy 1 | Recibe `{searchId, limit, start}` y devuelve IFs         |
| RESTlet 2860      | `CUSTOMSCRIPT2860`, deploy 1 | Sube PNG a File Cabinet y actualiza status del IF (`updateIFStatus`) |

### 6.2 Rol `WMS` — Permisos requeridos

El rol `WMS` debe existir y tener asignados los siguientes permisos. Sin ellos, el TBA falla con `INVALID_LOGIN_ATTEMPT` aunque las credenciales sean correctas.

#### 6.2.1 Permisos a nivel Transacciones

| Permiso                          | Nivel     |
|----------------------------------|-----------|
| Ajustar inventario               | Ver       |
| Buscar transacción               | Completo  |
| Ejecución de orden de artículos  | Completo  |
| Ejecutar órdenes                 | Completo  |
| Orden de compra                  | Ver       |
| Orden de traslado                | Ver       |
| Orden de venta                   | Ver       |
| Recibir orden                    | Ver       |

#### 6.2.2 Permisos a nivel Listas

| Permiso                  | Nivel    |
|--------------------------|----------|
| Artículos                | Ver      |
| Clientes                 | Ver      |
| Documentos y archivos    | Completo |
| Realizar búsquedas       | Completo |
| Ubicaciones              | Ver      |

#### 6.2.3 Permisos a nivel Configuración

| Permiso                                 | Nivel     |
|-----------------------------------------|-----------|
| Campos personalizados                   | Ver       |
| Despliegue de SuiteApp                  | Completo  |
| Gestión de datos secretos               | Editar    |
| Gestión del token de acceso             | Completo  |
| **Iniciar sesión con tokens de acceso** | **Completo** |
| Iniciar sesión con tokens de acceso de OAuth 2.0 | Completo  |
| Listas personalizadas                   | Ver       |
| **Servicios web REST**                  | **Completo** |
| **Servicios web SOAP**                  | **Completo** |
| **SuiteScript**                         | **Completo** |
| Tipos de registros personalizados       | Ver       |
| Tokens de acceso de usuario             | Completo  |

> **Permisos críticos** (marcados arriba): sin `Iniciar sesión con tokens de acceso`, `Servicios web REST`, `SuiteScript` y `Servicios web SOAP`, el TBA no funcionará aunque el resto esté bien configurado.

#### 6.2.4 Audiencia del Deployment de cada RESTlet

Cada RESTlet (`CUSTOMSCRIPT2217` y `CUSTOMSCRIPT2860`) tiene un Deployment asociado. El campo **Audience** del deployment **debe incluir el rol `WMS`** o estar configurado como "All Roles". Si el rol `WMS` no está en el Audience, el RESTlet rechaza las llamadas del TBA con `INVALID_LOGIN_ATTEMPT` aunque las credenciales sean válidas.

Procedimiento para verificar:
1. `Customization → Scripting → Scripts → [2217] → Deployments`.
2. Abrir el deployment activo.
3. Pestaña **Audience** → confirmar que el rol `WMS` está en "Selected Roles" o que está configurado como "All Roles".
4. Save.
5. Repetir para el script 2860.

### 6.3 Integration Record

#### 6.3.1 Configuración del Integration Record `WMS`

| Campo                                    | Valor       |
|------------------------------------------|-------------|
| Nombre de la aplicación                  | `WMS`       |
| Estado                                   | Habilitado  |
| Autenticación basada en token            | ✅ Activado  |
| TBA: punto de acceso issuetoken          | ✅ Activado  |
| TBA: flujo de autorización               | Opcional    |
| OAuth 2.0                                | Desactivado |
| Alcance (Scope)                          | `RESTlets`, `Servicios web REST` |

> **Importante**: el campo **Audience** del Integration Record debe incluir al menos el rol `WMS` o un usuario con ese rol, de lo contrario el token creado no podrá autenticarse.

#### 6.3.2 Credenciales (Client ID / Client Secret)

Tras guardar el Integration Record, NetSuite genera:
- **Client ID** (consumer key)
- **Client Secret** (consumer secret)

Estos valores se copian **una sola vez** y deben guardarse en las env vars del backend (`NETSUITE_CLIENT_ID`, `NETSUITE_CLIENT_SECRET`).

### 6.4 Token TBA (Token-Based Authentication)

#### 6.4.1 Creación del Token

1. `Setup → Users/Roles → Users → [usuario con rol WMS] → Manage Access Tokens → New`.
2. Llenar:
   - **Application Name**: `WMS` (debe coincidir con el Integration Record).
   - **User**: usuario con rol WMS asignado.
   - **Role**: `WMS` (importante, no otro rol).
3. Save.
4. Copiar:
   - **Token ID**
   - **Token Secret**

Estos valores se copian **una sola vez** y deben guardarse en las env vars del backend (`NETSUITE_TOKEN_ID`, `NETSUITE_TOKEN_SECRET`).

#### 6.4.2 Estructura del header OAuth 1.0a

Las credenciales se envían en cada request como header `Authorization`:

```
Authorization: OAuth realm="9080139_SB1", oauth_consumer_key="<CLIENT_ID>", oauth_nonce="<NONCE>", oauth_signature="<SIG>", oauth_signature_method="HMAC-SHA256", oauth_timestamp="<UNIX>", oauth_token="<TOKEN_ID>", oauth_version="1.0"
```

El backend genera la firma con `crypto.createHmac('sha256', key).update(baseString).digest('base64')` usando la librería `oauth-1.0a`.

### 6.5 Búsqueda guardada `customsearch3672`

La búsqueda activa para el flujo de carga de IFs es `customsearch3672`. Su definición debe ser la siguiente.

#### 6.5.1 Tipo de búsqueda

- **Tipo**: `Ejecución de orden de artículo` (Item Fulfillment).

#### 6.5.2 Filtros (criterios)

| Campo                | Operador | Valor                                          |
|----------------------|----------|------------------------------------------------|
| Tipo                 | es       | Ejecución de orden de artículo                 |
| Estado               | es       | Ejecución de orden de artículo: Empaquetado    |
| Línea principal      | es       | verdadero                                      |

> El valor "Empaquetado" corresponde al estado `Picked` o `Packed` en NetSuite. Verificar en la UI de filtros que la traducción al español coincide con el estado real del record.

#### 6.5.3 Columnas (resultados) — orden y nombres de keys

| # | Columna NetSuite              | Key en el JSON devuelto por el RESTlet 2217 | Tipo de campo                  |
|---|-------------------------------|----------------------------------------------|--------------------------------|
| 1 | Internal ID                   | `id`                                         | Internal ID                    |
| 2 | Record Type                   | `recordType`                                 | — (siempre `itemfulfillment`)  |
| 3 | Fórmula texto (doc origen)    | `formulatext`                                | Formula (Text)                 |
| 4 | Número de documento           | `tranid`                                     | Tran ID                        |
| 5 | Nota                          | `memo`                                       | Memo                           |
| 6 | Ubicación                     | `location`                                   | Location (object `{value,text}`) |
| 7 | Estado                        | `statusref`                                  | Ship Status (object `{value,text}`) |
| 8 | Fecha                         | `trandate`                                   | Transaction Date               |

> **Importante**:
> - El **orden de las columnas en la UI de NetSuite es libre** — el backend mapea por **nombre de key**, no por índice.
> - La columna 3 (fórmula texto) es la que captura el número de documento origen de la IF (ej: SO14548 o TO155). Si la renombras en la búsqueda, la key en el JSON cambia y hay que ajustar `formatIFRecord`. Ver §6.5.5 y §9.12.

#### 6.5.4 Mapping backend → frontend

`formatIFRecord` (`backend/controllers/netsuiteController.js:38-48`) mapea **por nombre** la respuesta cruda del RESTlet al JSON que consume el frontend:

```jsonc
{
  "internalId": 12345,         // ← ifRecord.id
  "tranid": "IF-2026-001",     // ← ifRecord.tranid
  "sourceDoc": "SO14548",      // ← ifRecord.formulatext (doc de origen de la IF)
  "description": "Memo",       // ← ifRecord.memo || ifRecord.description || ''
  "location": "MEX",           // ← ifRecord.location (puede llegar como {value, text})
  "status": "B",               // ← ifRecord.statusref ({value, text} → el objeto completo)
  "date": "2026-06-09"         // ← ifRecord.trandate
}
```

Para agregar un campo nuevo al response del backend, hay que (1) tener la columna en `customsearch3672` Results, (2) mapearla aquí. Ver §9.12.

#### 6.5.5 Equivalencia campos NetSuite → keys JSON (referencia rápida)

Cuando debuguees, esta tabla evita tener que ir a `formatIFRecord`:

| Campo / columna en NetSuite             | Key en JSON del RESTlet 2217 | Mapeado a (en `formatIFRecord`) | Notas                                              |
|------------------------------------------|------------------------------|----------------------------------|----------------------------------------------------|
| Internal ID                              | `id`                         | `internalId`                     | String numérico como `"12345"`                     |
| Record Type                              | `recordType`                 | (no se mapea)                    | Siempre `"itemfulfillment"`                         |
| Fórmula texto (doc origen)               | `formulatext`                | `sourceDoc`                      | Solo aparece si NetSuite le puso ese nombre; si lo renombras, la key cambia |
| Tran ID                                  | `tranid`                     | `tranid`                         | —                                                  |
| Memo                                     | `memo`                       | `description`                    | Fallback a `description` y a `''`                  |
| Location                                 | `location`                   | `location`                       | Llega como `{ value: "1", text: "MEX" }`           |
| Ship Status                              | `statusref`                  | `status`                         | ⚠️ NO se llama `shipstatus` en el response, aunque internamente NetSuite lo sigue nombrando así en el record |
| Transaction Date                         | `trandate`                   | `date`                           | —                                                  |

### 6.6 RESTlet 2217 (`searchResults.js`) — Búsqueda de IFs

#### 6.6.1 Metadatos

| Campo           | Valor                |
|-----------------|----------------------|
| Internal ID     | `CUSTOMSCRIPT2217`   |
| Deploy ID       | `CUSTOMDEPLOY1`      |
| Audience        | Rol `WMS`            |
| Script          | `searchResults.js`   |

> **Nota**: el código fuente de este RESTlet **no está versionado en el repo**. Se mantiene en NetSuite.

#### 6.6.2 Contrato

**Request**:
```json
POST /app/site/hosting/restlet.nl?script=2217&deploy=1
Content-Type: application/json
Authorization: OAuth 1.0a ...

{
  "searchId": "customsearch3672",
  "limit": 1000,
  "start": 0
}
```

**Response exitosa**:
```json
{
  "success": true,
  "message": "Búsqueda POST ejecutada correctamente",
  "searchId": "customsearch3672",
  "timestamp": "2026-06-09T...",
  "count": 5,
  "data": [
    {
      "id": 12345,
      "recordType": "itemfulfillment",
      "formulatext": "SO14548",
      "tranid": "IF-2026-001",
      "memo": "Salida de placas MEX",
      "location": { "value": "1", "text": "MEX" },
      "statusref": { "value": "packed", "text": "Empaquetado" },
      "trandate": "2026-06-09"
    }
  ]
}
```

**Response con error**:
```json
{
  "success": false,
  "error": "<mensaje de error>",
  "timestamp": "2026-06-09T..."
}
```

#### 6.6.3 Comportamiento interno

1. `doPost(requestBody)` valida que `searchId` esté presente.
2. Llama a `executeSearch(searchId, requestBody)`.
3. `executeSearch`:
   - Intenta `search.load({ id: searchId })` con el ID como string.
   - Si falla, intenta con `search.load({ id: parseInt(searchId) })` (internal ID numérico).
   - Lee `limit` (default 100) y `start` (default 0) del body.
   - Ejecuta `searchResultSet.getRange({ start, end: start + limit })`.
   - Para cada fila, construye un objeto con `id`, `recordType` y todas las columnas (`name`, `value`, `text`).

> **Nota importante — el RESTlet 2217 es genérico**: NO tiene columnas hardcodeadas en el código. Recibe cualquier `searchId` y devuelve **todas las columnas** que la búsqueda guardada tenga configuradas en su pestaña **Results**. Esto significa que agregar/quitar campos al response del API es 100% decisión de la búsqueda guardada en NetSuite, no del RESTlet. El mapping al JSON que consume el frontend ocurre del lado backend en `formatIFRecord` (ver §6.5.4). Para agregar una columna nueva, ver §9.12.

#### 6.6.4 Errores comunes

| Status | Causa probable                                       | Solución                                                       |
|--------|------------------------------------------------------|----------------------------------------------------------------|
| 400    | Falta `searchId` en el body                          | Verificar que `netsuiteController.js:54` lo envíe              |
| 400    | `searchId` no es una búsqueda válida                | Verificar que `customsearch3672` exista, esté publicada y no esté siendo modificada simultáneamente (puede causar lock temporal) |
| 400    | Rol sin permiso sobre el record type                | Agregar `Ejecución de orden de artículos = Completo` al rol `WMS` |
| 500    | Error de sintaxis en `searchResults.js`             | Revisar Execution Log del RESTlet en NetSuite                  |

### 6.7 RESTlet 2860 (`wms_restlet.js`) — Subida de archivos y status de IF

> **Nota de versionado**: este RESTlet está declarado con `@NApiVersion 2.x` (no `2.1` como `wms_link_firmas.js`).

#### 6.7.1 Metadatos

| Campo           | Valor                |
|-----------------|----------------------|
| Internal ID     | `CUSTOMSCRIPT2860`   |
| Deploy ID       | `CUSTOMDEPLOY1`      |
| Audience        | Rol `WMS`            |
| Script          | `wms_restlet.js` (versionado en el repo) |

#### 6.7.2 Contrato

**Request — Subir firma**:
```json
POST /app/site/hosting/restlet.nl?script=2860&deploy=1
Content-Type: application/json
Authorization: OAuth 1.0a ...

{
  "filename": "IF-2026-001_auxAlmacen.png",
  "contents": "<base64 string>",
  "folder_id": 12848
}
```

**Request — Actualizar status del IF**:
```json
{
  "action": "updateIFStatus",
  "internalId": 12345
}
```

**Response exitosa — Upload**:
```json
{
  "success": true,
  "fileId": 67890,
  "filename": "IF-2026-001_auxAlmacen.png",
  "folderId": 12848,
  "url": "https://..."
}
```

**Response exitosa — Update**:
```json
{
  "success": true,
  "recordId": 12345,
  "message": "IF status updated to C",
  "previousStatus": "B"
}
```

#### 6.7.3 Comportamiento interno

1. `handlePost(requestBody)`:
   - Si `request.action === 'updateIFStatus'` → delega a `updateIFStatus()`.
   - Si no, valida que `filename`, `contents` y `folder_id` estén presentes.
   - Crea el archivo con `file.create({ name, fileType: file.Type.PNGIMAGE, contents, folder })`.
   - Guarda con `fileObj.save()`.
2. `updateIFStatus(data)`:
   - Valida que `internalId` esté presente.
   - Carga el record con `record.load({ type: record.Type.ITEM_FULFILLMENT, id: data.internalId })`.
   - Cambia el campo `shipstatus` a `'C'` (Shipped).
   - Guarda con `recordObj.save()`.

### 6.8 File Cabinet — Estructura simplificada

La estructura física del File Cabinet se simplificó a una sola carpeta raíz `/Firmas` con 4 subcarpetas por tipo de firma, en lugar de la matriz `ubicacion × tipo_firma` original.

```
/Firmas/
├── auxAlmacen/        # Folder ID: 12848
├── Cliente/           # Folder ID: 12849
├── GerenteSucursal/   # Folder ID: 12851
└── JefeAlmacen/       # Folder ID: 12850
```

> **Mapa plano en backend**: el backend ahora usa 4 env vars únicas (`NETSUITE_FOLDER_AUXALMACEN`, `NETSUITE_FOLDER_CLIENTE`, `NETSUITE_FOLDER_JEFE`, `NETSUITE_FOLDER_GERENTE`) en lugar de las 12 vars previas `NETSUITE_FOLDER_<UBICACION>_<TIPO>`. La ubicación del usuario **no determina el folder físico**: el helper `config.netsuite.getFolderId(tipoFirma)` resuelve el folder únicamente por tipo de firma. La ubicación se sigue usando para **filtrar las IFs visibles** por usuario (ej: un usuario de GDL ve GDL + GDL:OUTLET + TEMPORAL + PROYECTOS; TEMPORAL y PROYECTOS son visibles para todos).

#### 6.8.1 Convenciones de nombres de archivo

```
{IF}_{TIPO}.png
```

Ejemplos: `IF-2026-001_auxAlmacen.png`, `IF-2026-001_cliente.png`.

Patrones configurables vía env vars:
- `NETSUITE_FILECABINET_PATH_PREFIX` = `/Firmas`
- `NETSUITE_FILECABINET_SIGNATURE_FOLDER_PATTERN` = `{LOCATION}/{TYPE}`
- `NETSUITE_FILECABINET_FILE_PATTERN` = `{IF}_{TYPE}.png`

> A la fecha, la implementación sube directamente al `folder_id` numérico, no construye paths a partir de los patrones.

**Pipeline completo de firma → impresión**:

1. **Frontend** (`js/signatures.js` + `js/netsuite-client.js`): captura las 4 firmas en `<canvas>` y las envía como base64 a `POST /netsuite/submit`.
2. **Backend** (`backend/controllers/netsuiteController.js:submitData`): sube cada PNG al folder correspondiente vía RESTlet 2860, nombrando como `{IF}_{TIPO}.png`.
3. **Script UserEvent** (`wms_link_firmas.js`, ver §6.11): se dispara en `afterSubmit` de la IF, busca los 4 archivos por patrón y vincula su `internal id` a los custom fields `custbody60/61/62/63`.
4. **Template PDF** (`wms_firma_template.xml`, ver §6.12): al imprimir la IF, el macro `@filecabinet` lee esos custom fields y embebe las imágenes en el PDF.

> Si falta alguno de los 4 pasos, la firma no aparece impresa. El más frágil es el (3) — si el script no está desplegado, los fields quedan vacíos y el template renderiza celdas vacías sin error.

### 6.9 Estrategias de autenticación

| Cliente                       | Auth                  | Uso actual                                  |
|-------------------------------|-----------------------|----------------------------------------------|
| `netsuiteRestlet.js`          | OAuth 1.0a TBA + HMAC-SHA256 | **Activo**. RESTlets 2217 y 2860    |
| `netsuiteOAuth2.js`           | OAuth 2.0 (Auth Code) | Solo endpoints `/auth/netsuite/oauth/*` (en desarrollo) |
| `_legacy/netsuiteAuth.js`     | OAuth 1.0a TBA + HMAC-SHA256 | REST API v1 (no usado; referencia)  |
| `_legacy/netsuiteOAuth.js`    | OAuth 1.0a TBA + HMAC-SHA256 | Variante legacy (no usado; referencia) |
| `_legacy/netsuite.js`         | —                     | Stub legacy (no usado; referencia)           |

### 6.10 Procedimiento de regeneración tras pérdida de credenciales

Si NetSuite sandbox se actualiza o las credenciales TBA dejan de funcionar (escenario real vivido durante el desarrollo):

1. **Crear/verificar el Rol `WMS`** con todos los permisos listados en §6.2. Confirmar que el rol existe y está habilitado.
2. **Crear/verificar el Integration Record `WMS`** según §6.3.1. Confirmar que está habilitado y que el Audience incluye al rol `WMS`.
3. **Verificar el Audience de los Deployments de los RESTlets** según §6.2.4. Si el rol `WMS` no está en el Audience de un RESTlet específico, las llamadas a ese RESTlet fallan con `INVALID_LOGIN_ATTEMPT` aunque las credenciales sean correctas.
4. **Crear/regenerar el Token TBA** según §6.4.1, asegurándose de seleccionar el rol `WMS` (no otro).
5. Actualizar las env vars en Dokploy (panel → Environment del servicio `wms-backend`):
   - `NETSUITE_CLIENT_ID`
   - `NETSUITE_CLIENT_SECRET`
   - `NETSUITE_TOKEN_ID`
   - `NETSUITE_TOKEN_SECRET`
6. Forzar redeploy desde Dokploy (push vacío o click en "Redeploy").
7. Validar: `curl https://api.marblock.shop/health` debe responder 200, y desde la UI cargar IFs debe poblar el dropdown.

> **Importante**: el cambio de IDs en env vars en Dokploy **no requiere commit al repo**. Solo se actualiza en el panel y se hace redeploy.

### 6.11 UserEvent Script `wms_link_firmas.js` — Vinculación de firmas al IF

**Propósito**: después de que el backend sube los PNG de firma al File Cabinet, este script UserEvent (desplegado sobre la **Instrucción de Fabricación / Item Fulfillment**) busca los archivos esperados por patrón y vincula su `internal id` a los `custom body fields` del IF. Así, cuando se imprime la IF con el template avanzado, las firmas aparecen embebidas.

**Tipo y deployment**:

| Propiedad              | Valor                                                       |
|------------------------|-------------------------------------------------------------|
| `@NApiVersion`         | `2.1`                                                       |
| `@NScriptType`         | `UserEventScript`                                           |
| Records objetivo       | `Item Fulfillment` (ejecución de orden de artículo)          |
| Eventos                | `CREATE`, `EDIT` (no `XEDIT` para evitar doble disparo)     |
| Función                | `afterSubmit` (nunca `beforeLoad` para evitar recursión)    |

**Custom Body Fields que debe crear el administrador en NetSuite** (sobre el record `Item Fulfillment` / ejecución de orden de artículo):

| Label              | ID interno    | Tipo                | Aplicar a         | Notas                                                  |
|--------------------|---------------|---------------------|-------------------|--------------------------------------------------------|
| `wms_Cliente`      | `custbody61`  | **Document (File)** | Item Fulfillment  | Almacena el `internal id` del PNG firmado por cliente |
| `wms_AuxAlmacen`   | `custbody60`  | **Document (File)** | Item Fulfillment  | Almacena el `internal id` del PNG firmado por aux. almacén |
| `wms_JefeAlmacen`  | `custbody62`  | **Document (File)** | Item Fulfillment  | Almacena el `internal id` del PNG firmado por jefe de almacén |
| `wms_Gerente`      | `custbody63`  | **Document (File)** | Item Fulfillment  | Almacena el `internal id` del PNG firmado por gerente  |

> **Creación paso a paso en NetSuite**:
> 1. `Customization → Lists, Records, & Fields → Entity / Item / Transaction Body Fields → New`
> 2. **Type**: `Document` (no `Image` — el template lo resuelve a través del macro `@filecabinet`).
> 3. **Label**: el nombre legible (ej: `wms_Cliente`).
> 4. **ID**: el internal id (NetSuite lo autopropone como `custbodyNN`; se puede dejar el sugerido o forzar uno específico).
> 5. **Applies To**: marcar **Item Fulfillment** únicamente.
> 6. **Store Value** = `T` (para que el `submitFields` funcione).
> 7. Guardar y registrar el ID interno (columna **ID**) en una tabla interna — esos IDs son los que el script lee.
> 8. Repetir para los 4 tipos de firma.

**Mapeo interno del script** (en `wms_link_firmas.js:16-21`):

```js
const FIRMAS = [
    { tipo: 'auxAlmacen',  folderId: 12848, fieldId: 'custbody60' },
    { tipo: 'cliente',     folderId: 12849, fieldId: 'custbody61' },
    { tipo: 'jefeAlmacen', folderId: 12850, fieldId: 'custbody62' },
    { tipo: 'gerente',     folderId: 12851, fieldId: 'custbody63' }
];
```

> ⚠️ **Importante**: los `folderId` (12848 / 12849 / 12850 / 12851) son los del sandbox actual. **Antes de promover a producción, ajustar a los folder IDs de producción** (los mismos definidos en `backend/config/environments.js §6.8`).

**Lógica de búsqueda**:

1. En `afterSubmit`, obtiene el `tranid` del IF (ej: `IF14639`).
2. Por cada tipo de firma, busca en el File Cabinet un archivo con nombre exacto:
   ```
   {tranid}_{tipo}.png
   ```
   Ejemplo: `IF14639_auxAlmacen.png` en el folder `12848`.
3. Compara el `internal id` encontrado contra el valor actual del custom field:
   - Si difieren y el archivo existe, lo actualiza vía `record.submitFields`.
   - Si no hay archivo, deja el field intacto.
4. Hace **un solo `submitFields`** con todos los cambios para minimizar round-trips.
5. Loggea: `Resumen` (debug, siempre) y `Firmas vinculadas` (audit, solo cuando hubo cambios).

**Convenciones de nombre** (consistente con §6.8.1):
- Patrón: `{IF}_{TIPO}.png`
- El sub-folder depende solo del **tipo de firma**, no de la ubicación del IF (ver §6.8 — estructura plana).

**Despliegue del script en NetSuite** (procedimiento manual, no automatizado):

1. `Customization → Scripting → Scripts → New` → seleccionar el archivo `wms_link_firmas.js` del File Cabinet.
2. Completar:
   - **Name**: `WMS Link Firmas`
   - **Owner**: rol administrador
   - **Script Type**: User Event
3. En la pestaña **Deployments** → `New`:
   - **Title**: `WMS Link Firmas - Item Fulfillment`
   - **Record Type**: `Item Fulfillment` (ejecución de orden de artículo)
   - **Execute As Role**: `WMS` (o el rol que tenga permisos sobre custom fields, ver §6.2)
   - **Status**: `Released`
   - **Available Without Logging In**: `false`
   - **Event Types**: `Create`, `Edit` (desmarcar `XEDIT` y `Delete`)
   - **Audience**: el mismo rol `WMS` (o todos si el admin lo prefiere)
4. **Save and Deploy**.
5. Validar: crear/editar un IF en NetSuite, subir firmas vía el frontend WMS, y verificar que el log del script (`Customization → Scripting → Script Execution Log`) muestre:
   ```
   wms_link_firmas.js | CUSTOMDEPLOY1 | audit | Firmas vinculadas | {"tranid":"IF14639","custbody60":"318445","custbody61":"318446"}
   ```

> Si el log no aparece: revisar (a) que el `Status` del deployment sea `Released`, (b) que el record sea `Item Fulfillment` (no `Sales Order`), (c) que el `Execute As Role` tenga permisos sobre los custom fields.

**Idempotencia**: el script es idempotente. Solo escribe si el `internal id` actual del field difiere del encontrado en File Cabinet. No hay riesgo de loop infinito porque corre en `afterSubmit` (no en `beforeLoad`) y no se dispara a sí mismo.

---

### 6.12 Advanced PDF/HTML Template `wms_firma_template.xml` — Render de firmas en la IF

**Propósito**: al imprimir la IF desde NetSuite (botón "Imprimir" o el Advanced PDF Template asignado al record), este template muestra las 4 firmas dinámicas (cliente, aux. almacén, jefe, gerente) usando el macro `@filecabinet` con los custom body fields `custbody60/61/62/63` como fuente.

**Tipo de template**:

| Propiedad                 | Valor                                                                                  |
|---------------------------|----------------------------------------------------------------------------------------|
| Tipo                      | Advanced PDF/HTML Template (BFO engine)                                                |
| Versión del schema DTD    | `report-1.1.dtd`                                                                       |
| Aplicado al record        | `Item Fulfillment` (ejecución de orden de artículo)                                   |

**Asociación en NetSuite**:
1. Subir el archivo `wms_firma_template.xml` al File Cabinet (recomendado: carpeta `/Templates`).
2. `Customization → Forms → Advanced PDF/HTML Templates → Customize` (o "Set Up Template" en la IF).
3. En el record `Item Fulfillment`, asignar este template como **Standard Template** o como template específico para Subsidiary / Location si se requiere.

**Sección de firmas dinámicas** (en `wms_firma_template.xml:193-216`):

```xml
<#-- INICIO SECCIÓN FIRMA DINÁMICA -->
<table style="margin-top: 20px; width: 100%;">
    <tr>
        <td align="center" style="width: 50%; padding: 8px;">
            <p style="font-weight: bold; margin-bottom: 5px;">Aux. Almacén</p>
            <@filecabinet nstype="image" src="${record.custbody60}" width="200" height="80"/>
        </td>
        <td align="center" style="width: 50%; padding: 8px;">
            <p style="font-weight: bold; margin-bottom: 5px;">Cliente</p>
            <@filecabinet nstype="image" src="${record.custbody61}" width="200" height="80"/>
        </td>
    </tr>
    <tr>
        <td align="center" style="width: 50%; padding: 8px;">
            <p style="font-weight: bold; margin-bottom: 5px;">Jefe de Almacén</p>
            <@filecabinet nstype="image" src="${record.custbody62}" width="200" height="80"/>
        </td>
        <td align="center" style="width: 50%; padding: 8px;">
            <p style="font-weight: bold; margin-bottom: 5px;">Gerente</p>
            <@filecabinet nstype="image" src="${record.custbody63}" width="200" height="80"/>
        </td>
    </tr>
</table>
<#-- FIN SECCIÓN FIRMA DINÁMICA -->
```

**Cómo funciona**:
- `${record.custbody60}` resuelve al **internal id del file** en NetSuite (guardado por `wms_link_firmas.js`).
- El macro BFO `<@filecabinet nstype="image" ...>` descarga el archivo, lo embebe en el PDF, y lo renderiza al tamaño solicitado (`width="200" height="80"`).
- Si el field está vacío (no se firmó aún), la celda queda vacía sin error.
- El layout es **2x2**: fila 1 = Aux. Almacén + Cliente; fila 2 = Jefe + Gerente. Replicable según necesidad de roles.

**Requisitos para que funcione**:
- Los 4 custom body fields `custbody60/61/62/63` deben existir y ser de tipo **Document (File)** (§6.11).
- El archivo PNG debe existir en el File Cabinet con nombre exacto `{tranid}_{tipo}.png` (§6.8.1).
- El `wms_link_firmas.js` debe estar desplegado y haber corrido en `afterSubmit` (§6.11).
- El `Executed As Role` del template debe tener permiso de lectura sobre los custom fields (mismo rol `WMS`).

**Invalidar caché del template** (cuando se actualiza el XML):
1. `Customization → Forms → Advanced PDF/HTML Templates`.
2. Buscar el template por nombre.
3. Click → "Invalidate Cache" en el menú.
4. Re-imprimir la IF y validar.

**Limitación conocida**: el macro `@filecabinet` con file ID directo funciona porque el field es de tipo Document (File). Si en algún ambiente se cambia a tipo **Image**, la sintaxis correcta es diferente (`${record.custbody60.url}` o el helper `?url`). Mantener tipo **Document (File)** en los 4 fields.

**Probar sin afectar IFs reales**:
1. Crear una IF de prueba (puede ser vía Sales Order → Mark Picked / Packed / Shipped).
2. Firmar las 4 firmas en el frontend WMS.
3. Esperar a que `wms_link_firmas.js` corra (~5 segundos).
4. En NetSuite, sobre la IF de prueba, click **Print** → seleccionar el template.
5. Validar visualmente que las 4 firmas aparezcan. Si alguna no aparece, revisar el Script Execution Log de `wms_link_firmas.js` para confirmar que el file ID se vinculó.

---

### 6.13 Cómo fluye la data de NetSuite al frontend

Esta sección existe para evitar tener que debuguear de nuevo el camino de los datos cuando se agreguen campos nuevos. La intuición de "cambié la búsqueda y debería aparecer en el frontend" es incorrecta porque hay 3 capas intermedias.

**Flujo completo de un IF** (de NetSuite al dropdown de la UI):

```
┌─────────────────────┐
│  NetSuite           │
│  customsearch3672   │  ← Aquí defines qué columnas devuelve
│  (Resultados)       │
└──────────┬──────────┘
           │ el RESTlet 2217 ejecuta esa búsqueda
           ▼
┌─────────────────────┐
│  RESTlet 2217       │  ← Devuelve TODAS las columnas de Results,
│  (searchResults.js) │    sin filtrar. Key por columna.
│  en NetSuite        │
└──────────┬──────────┘
           │ POST con searchId → array en .data
           ▼
┌─────────────────────┐
│  Backend Node       │
│  netsuiteController │  ← formatIFRecord (línea 38) decide qué
│  .js                │    keys del response crudo pasan al frontend
└──────────┬──────────┘
           │ res.json con .ifs mapeadas
           ▼
┌─────────────────────┐
│  Frontend           │
│  js/netsuite-client │  ← updateIFSelect (línea 42) arma el <option>
│  .js                │    con el formato visible al usuario
└─────────────────────┘
```

**Reglas derivadas**:

1. **Para que un campo llegue al frontend**, debe existir en (a) los Results de la búsqueda, (b) el mapping de `formatIFRecord`, y (c) la lógica de display en `js/netsuite-client.js` (o donde se use).
2. **El Network tab del navegador muestra la respuesta del backend** (`/netsuite/ifs`), NO la de NetSuite. Por eso cambios a la búsqueda no se ven reflejados al instante en Network — pasan por `formatIFRecord` primero.
3. **Para ver la respuesta cruda de NetSuite** (antes del mapping), hay que loguearla en el backend. Ver §9.12.
4. **El RESTlet 2217 no filtra columnas** — devuelve todo lo que la búsqueda expone. Si agregas una columna y no la mapeas en `formatIFRecord`, queda invisible para el frontend pero sigue viajando por la red.

---



### 7.1 Provider

- Tipo: **GitHub**
- Repo: `WMS`
- Branch: `main`
- Compose path: `./docker-compose.dokploy.yml`
- Trigger: **On Push**

### 7.2 Servicios

```yaml
# docker-compose.dokploy.yml
services:
  wms-backend:
    build: ./backend
    container_name: wms-backend
    restart: always
    environment:
      - NODE_ENV=production
      - PORT=3001
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
      # ... 43 variables más, todas con sintaxis ${VAR}
    ports:
      - "3001:3001"

  wms-frontend:
    build: .
    container_name: wms-frontend
    restart: always
    ports:
      - "8080:80"   # Traefik mapea 80 → 8080 en el host
    depends_on:
      - wms-backend
```

### 7.3 DNS y dominios

| Subdominio            | Servicio     | Puerto | TLS                     |
|-----------------------|--------------|--------|--------------------------|
| `wms.marblock.shop`   | wms-frontend | 80     | Let's Encrypt automático |
| `api.marblock.shop`   | wms-backend  | 3001   | Let's Encrypt automático |

Ambos registros deben apuntar a la IP del VPS. Traefik (gestionado por Dokploy) enruta según el `Host:` header.

### 7.4 Procedimiento de actualización

1. **Cambios de código**: push a `main` → Dokploy detecta y redeploya automáticamente.
2. **Cambios de env vars**: panel de Dokploy → Service → Environment → Save → redeploy manual o esperar el próximo push.
3. **Cambios de credenciales NetSuite**: actualizar env vars en Dokploy + redeploy.

### 7.5 Local vs Producción

| Aspecto               | Local                                | Producción (Dokploy)            |
|----------------------|--------------------------------------|----------------------------------|
| Env vars             | `backend/.env` (gitignored)          | Panel de Dokploy                 |
| Frontend `BACKEND_URL` | `http://localhost:3001` (default en `auth.js`) | `https://api.marblock.shop` (default) |
| TLS                  | No                                   | Sí (Traefik + Let's Encrypt)    |
| Persistencia         | No                                   | No (stateless)                   |
| Logs                 | stdout del proceso                   | Panel de Dokploy / `docker logs` |

---

## 8. Variables de entorno

### 8.1 Backend

| Variable                                  | Requerida | Ejemplo / default                                  | Descripción                                |
|-------------------------------------------|-----------|----------------------------------------------------|--------------------------------------------|
| `NODE_ENV`                                | No        | `production`                                       | `development` muestra stack traces         |
| `PORT`                                    | No        | `3001`                                             | Puerto del backend                          |
| `LOG_LEVEL`                               | No        | `info`                                             | Reservado (no implementado en código)       |
| `JWT_SECRET`                              | **Sí**    | `dev_secret_key_change_in_production_12345`        | **Cambiar en producción**                   |
| `SUPABASE_URL`                            | **Sí**    | `https://ajdnnjxnrazflkhholsu.supabase.co`        | URL del proyecto Supabase                   |
| `SUPABASE_ANON_KEY`                       | Sí        | `sb_publishable_...`                               | Para operaciones autenticadas del usuario   |
| `SUPABASE_SERVICE_ROLE_KEY`                | **Sí**    | `sb_secret_...`                                    | Bypass RLS. **No exponer al frontend**      |
| `NETSUITE_ACCOUNT_ID`                     | **Sí**    | `9080139-sb1`                                      | ID con sufijo `-sb1` para sandbox           |
| `NETSUITE_REALM`                          | **Sí**    | `9080139_SB1`                                      | Para producción: `9080139`                  |
| `NETSUITE_ENVIRONMENT`                    | No        | `sandbox`                                          | `sandbox` o `production`                    |
| `NETSUITE_API_VERSION`                    | No        | `2022.1`                                           | Versión de la REST API                      |
| `NETSUITE_CLIENT_ID`                      | **Sí**    | `d7ab13ab...`                                      | Consumer key del Integration Record         |
| `NETSUITE_CLIENT_SECRET`                  | **Sí**    | `8a58af4d...`                                      | Consumer secret                              |
| `NETSUITE_TOKEN_ID`                       | **Sí**    | `30f96ce0...`                                      | Token ID del TBA                            |
| `NETSUITE_TOKEN_SECRET`                   | **Sí**    | `44be223e...`                                      | Token secret del TBA                        |
| `NETSUITE_SEARCH_ID`                      | **Sí**    | `customsearch3672`                                  | ID de la búsqueda guardada                 |
| `NETSUITE_RESTLET_URL`                    | **Sí**    | `https://9080139-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=2860&deploy=1` | URL completa del RESTlet 2860 (upload) |
| `NETSUITE_RESTLET_SCRIPT_ID`              | No        | `2860`                                             | ID del script (upload + updateIFStatus)    |
| `NETSUITE_RESTLET_DEPLOY_ID`              | No        | `1`                                                | Deploy del script                           |
| `NETSUITE_SEARCH_RESTLET_URL`             | **Sí**    | `https://9080139-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=2217&deploy=1` | URL completa del RESTlet 2217 (search) |
| `NETSUITE_SEARCH_RESTLET_SCRIPT_ID`       | No        | `2217`                                             | ID del script (búsqueda de IFs)            |
| `NETSUITE_SEARCH_RESTLET_DEPLOY_ID`       | No        | `1`                                                | Deploy del script                           |
| `NETSUITE_FOLDER_AUXALMACEN`              | **Sí**    | `12848`                                            | Folder ID `auxAlmacen` (compartido)         |
| `NETSUITE_FOLDER_CLIENTE`                 | **Sí**    | `12849`                                            | Folder ID `Cliente` (compartido)            |
| `NETSUITE_FOLDER_JEFE`                    | **Sí**    | `12850`                                            | Folder ID `JefeAlmacen` (compartido)        |
| `NETSUITE_FOLDER_GERENTE`                 | **Sí**    | `12851`                                            | Folder ID `GerenteSucursal` (compartido)    |
| `NETSUITE_FILECABINET_PATH_PREFIX`        | No        | `/Firmas`                                          | Prefijo conceptual de path                  |
| `NETSUITE_FILECABINET_SIGNATURE_FOLDER_PATTERN` | No  | `{LOCATION}/{TYPE}`                                | Patrón de carpeta                           |
| `NETSUITE_FILECABINET_FILE_PATTERN`       | No        | `{IF}_{TYPE}.png`                                  | Patrón de filename                          |
| `ALLOWED_ORIGINS`                         | **Sí**    | `https://wms.marblock.shop`                        | CSV de orígenes permitidos por CORS         |

### 8.2 Validación al boot

`backend/config/environments.js:6-25` lista las variables **estrictamente requeridas**:

```js
const requiredVars = [
  'NETSUITE_ACCOUNT_ID', 'NETSUITE_REALM',
  'NETSUITE_CLIENT_ID', 'NETSUITE_CLIENT_SECRET',
  'NETSUITE_TOKEN_ID', 'NETSUITE_TOKEN_SECRET',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET'
];
```

Si alguna falta y `NODE_ENV=production`, el proceso **lanza excepción y muere** (no arranca con config incompleta).

---

## 9. Runbook / Troubleshooting

### 9.1 `401 INVALID_LOGIN_ATTEMPT` desde NetSuite

**Síntoma**: las llamadas a RESTlet devuelven 401 con `{"error":{"code":"INVALID_LOGIN_ATTEMPT","message":"Invalid login attempt."}}`.

**Causas posibles (en orden de probabilidad)**:

1. **Integration Record deshabilitado o eliminado** en NetSuite (por actualización del sandbox).
2. **Token TBA expirado o revocado**.
3. **Whitelist de IP** en el Integration Record que no incluye la IP del VPS.
4. **Credenciales incorrectas** en las env vars de Dokploy.

**Diagnóstico**:

```bash
# 1. Verificar env vars en el contenedor
docker exec wms-backend sh -c \
  "echo CID:\$NETSUITE_CLIENT_ID; echo TID:\$NETSUITE_TOKEN_ID; echo REALM:\$NETSUITE_REALM"

# 2. Probar la firma con node puro
docker exec wms-backend node -e "
const https=require('https'),O=require('oauth-1.0a'),c=require('crypto');
const o=new O({consumer:{key:process.env.NETSUITE_CLIENT_ID,secret:process.env.NETSUITE_CLIENT_SECRET},signature_method:'HMAC-SHA256',hash_function:(b,k)=>c.createHmac('sha256',k).update(b).digest('base64')});
const url='https://9080139-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=2217&deploy=1';
const h=o.toHeader(o.authorize({url,method:'POST'},{key:process.env.NETSUITE_TOKEN_ID,secret:process.env.NETSUITE_TOKEN_SECRET}));
const u=new URL(url);
const req=https.request({hostname:u.hostname,path:u.pathname+u.search,method:'POST',headers:{'Content-Type':'application/json','Content-Length':54,'Authorization':h.Authorization}},(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log('STATUS:',res.statusCode,'BODY:',d))});
req.write(JSON.stringify({searchId:'customsearch3672',limit:10,start:0}));
req.end();
"
```

**Fix**: ver §6.7 (procedimiento de regeneración de credenciales).

### 9.2 `403 Forbidden` con `WWW-Authenticate: OAuth realm="..."`

**Causa**: la firma se construye con un método que el Integration Record no acepta. Hoy el código usa `HMAC-SHA256` y **funciona en local**, así que no debería verse en producción si las credenciales son válidas. Si llegara a verse, validar que el Integration Record tenga **TBA habilitado**.

### 9.3 Backend no arranca en Dokploy

1. Revisar logs: Dokploy → Service → Logs.
2. Si dice `Variables requeridas faltantes: ...`: ir a Environment y agregar las que falten.
3. Si el build de Docker falla: revisar `backend/Dockerfile` y `Dockerfile` raíz. Verificar que el contexto de build es la raíz del repo.

### 9.4 Frontend no conecta al backend

1. Abrir DevTools → Console. Verificar que `window.APP_CONFIG.BACKEND_URL` sea `https://api.marblock.shop`.
2. DevTools → Network. Hacer login. Verificar que la request vaya al dominio correcto, no a `localhost:3001`.
3. Si el `BACKEND_URL` es incorrecto, recordar que está hardcodeado en `index.html:234` como fallback. Para cambiarlo, editar el `index.html`, commit, push.

### 9.5 CORS error en el navegador

**Síntoma**: la consola muestra `Access to fetch at '...' has been blocked by CORS policy`.

**Causa**: `ALLOWED_ORIGINS` no incluye el origen del frontend.

**Fix**: en Dokploy → Environment del backend, actualizar `ALLOWED_ORIGINS`:
```
ALLOWED_ORIGINS=https://wms.marblock.shop
```
Sin espacios, sin slash final, con `https://`. Redeploy.

### 9.6 Las IFs no aparecen / dan error al cargar

1. Verificar que el Token TBA tenga permiso para ejecutar el script 2217.
2. Verificar que la búsqueda `customsearch3672` exista y devuelva resultados para la ubicación del usuario.
3. Probar el RESTlet directamente:
   ```bash
   docker exec wms-backend node -e "<el script de §9.1>"
   ```
4. Si devuelve 401, ir a §9.1.

### 9.7 Logs útiles en Dokploy

```bash
# Ver logs del backend
docker logs -f wms-backend

# Entrar al contenedor
docker exec -it wms-backend sh

# Health check
curl https://api.marblock.shop/health

# Validación completa
curl https://api.marblock.shop/validate
```

### 9.8 IFs de Outlet no se muestran al usuario de la sucursal padre

**Síntoma**: un usuario con `ubicacion_id = 5` (GDL) no ve las IFs que en NetSuite están asignadas a la ubicación `GDL:OUTLET GDL` (id=6). Captura típica: la tabla muestra `GDL:OUTLET GDL` en la columna "Ubicación" pero la IF no aparece en el dropdown de la UI.

**Causa**: el campo `location` que devuelve la búsqueda guardada en NetSuite (`customsearch3672`) es un string multi-valor como `GDL:OUTLET GDL`, donde se listan **dos** ubicaciones concatenadas (el outlet y su sucursal padre). Un comparador `===` rechazaba esas IFs para el usuario de la sucursal padre.

**Fix (aplicado)**: `backend/controllers/netsuiteController.js:25-34` ahora divide el string por `[\s:]+` y hace `includes`. Un usuario de `GDL` ve tanto IFs `GDL` como IFs `GDL:OUTLET GDL`, pero **no** ve IFs `MTY:OUTLET MTY`.

**Verificar el fix**:
```bash
# En el backend
docker exec -it wms-backend node -e "
const ej = [
  {tranid:'IF14611', location:'GDL:OUTLET GDL'},
  {tranid:'IF14609', location:'MEX'},
  {tranid:'IF14616', location:'MTY:OUTLET MTY'},
  {tranid:'IF_TJ',   location:'TIJUANA'},
  {tranid:'IF_TMP',  location:'TEMPORAL'},
  {tranid:'IF_MTZ',  location:'MATRIZ'}
];
const SHARED = ['TEMPORAL','PROYECTOS','Material Transformado','MATRIZ'];
const RESTR  = ['MEX','MTY','GDL'];
const filtra = (arr, user) => arr.filter(r => {
  const ifLoc = r.location;
  if (!ifLoc) return false;
  if (SHARED.includes(ifLoc)) return true;
  if (!RESTR.some(p => ifLoc === p || ifLoc.startsWith(p+':') || ifLoc.startsWith(p+' '))) return true;
  if (ifLoc === user) return true;
  return ifLoc.split(/[\s:]+/).includes(user);
});
console.log('GDL ve:', filtra(ej, 'GDL').map(r => r.tranid));
console.log('MEX ve:', filtra(ej, 'MEX').map(r => r.tranid));
console.log('MTY ve:', filtra(ej, 'MTY').map(r => r.tranid));
"
```

Salida esperada:
- GDL ve: `IF14611` (outlet propio), `IF_TJ`, `IF_TMP`, `IF_MTZ`
- MEX ve: `IF14609`, `IF_TJ`, `IF_TMP`, `IF_MTZ`
- MTY ve: `IF14616`, `IF_TJ`, `IF_TMP`, `IF_MTZ`

Si alguna IF de outlet sigue sin aparecer:
1. Confirmar que la búsqueda guardada devuelve el string multi-valor (no un objeto `{text:'GDL', value:'6'}`). Si es objeto, `extractLocation` ya lo maneja.
2. Confirmar que el deploy tiene el último código: `git log --oneline -1 backend/controllers/netsuiteController.js`.
3. Forzar redeploy si el código en Dokploy no incluye el fix.

### 9.9 Firmas no aparecen en la IF impresa

**Síntoma**: la IF se imprime sin firmas (celdas vacías), aunque las firmas se capturaron y el backend reportó éxito. O bien, las firmas aparecen como placeholder/imagen rota en el PDF.

**Causa más probable**: el script `wms_link_firmas.js` (§6.11) no está desplegado o no corrió, dejando los custom fields `custbody60/61/62/63` vacíos.

**Diagnóstico paso a paso**:

1. **¿El script está desplegado?**
   `Customization → Scripting → Scripts` → buscar `WMS Link Firmas`. Verificar que existe y tiene al menos un Deployment con Status = Released.

2. **¿El script corrió en el último IF?**
   `Customization → Scripting → Script Execution Log` → filtrar por `wms_link_firmas.js` y por el tranid (ej: `IF14639`). Buscar:
   - Línea `Resumen` con `found` mostrando los tipos de firma detectados.
   - Línea `Firmas vinculadas` con los custom fields actualizados.

3. **¿El archivo PNG existe en el File Cabinet?**
   `Documents → Files → File Cabinet` → navegar a la carpeta correspondiente (§6.8) y verificar que existe `{tranid}_{tipo}.png`.

4. **¿Los custom fields existen y son tipo Document?**
   `Customization → Lists, Records, & Fields → Transaction Body Fields` → buscar `custbody60`, `custbody61`, `custbody62`, `custbody63`. Verificar:
   - Type = **Document** (no Image, no Free-Form Text).
   - Applies To = Item Fulfillment (marcado).

5. **¿El template está asignado y usa el macro correcto?**
   `Customization → Forms → Advanced PDF/HTML Templates` → buscar el template → Invalidar Caché y volver a imprimir.

6. **¿El campo es accesible por el rol que ejecuta el template?**
   En el template, revisar el campo `Execute As Role`. Debe tener permiso de lectura sobre los 4 custom fields (mismo rol `WMS`).

**Fix típico**: si el script no estaba desplegado, seguir el procedimiento de §6.11 (Deployments). Si el template no muestra las imágenes, verificar que el macro sea exactamente `<@filecabinet nstype="image" src="${record.custbody60}" width="200" height="80"/>` y que el `Record Type` del template sea `Item Fulfillment`.

**Si el campo no se renderiza pero los logs del script muestran OK**:
El problema está en el template. Verificar que `custbody60/61/62/63` son tipo **Document**, no Image. Si son Image, cambiar el macro a `${record.custbody60}` directo dentro de un `<img src="...">` o usar el helper `?url`. Mantener tipo Document para compatibilidad con el macro `@filecabinet`.

### 9.10 `Error en línea 200, columna 27 de la plantilla` al guardar el template

**Síntoma**: NetSuite rechaza guardar `wms_firma_template.xml` con error de "atributo 'src' contiene el carácter '<'".

**Causa**: la URL del File Cabinet construida en FreeMarker contiene un `&` (separador de query params) que el parser XML interpreta como inicio de una entity reference no escapada, o el file object expone su `toString()` con `<` (ej: `<File:6217>`).

**Fix**: usar exclusivamente el macro `<@filecabinet nstype="image" src="${record.custbody60}" .../>` (sin construir URL manualmente, sin `&amp;` ni `&#38;`). El macro maneja la resolución del file ID internamente.

**Si necesitas URL explícita** (caso raro): construirla dentro de un `<#assign>` y escapar `&` como `&amp;` solo en el output final, nunca literal en el fuente XML. Alternativamente, evitar la URL y delegar al macro.

### 9.11 Nueva ubicación de NetSuite no es visible para los usuarios

**Síntoma**: se creó una nueva ubicación/tienda en NetSuite (ej: `TIJUANA`, `PUEBLA`, `TIENDA_PRUEBA`), se le asignaron IFs, pero los usuarios de la app WMS no las ven en el dropdown. Lo opuesto también puede ocurrir: una nueva ubicación que **debería** ser restringida termina siendo visible para todos.

**Diagnóstico rápido**: revisar si el nombre de la nueva ubicación inicia con uno de los **prefijos restringidos** (`MEX`, `MTY`, `GDL`).

- Si **NO** inicia con `MEX`, `MTY` o `GDL` → es tratada como **compartida por default** y todos la ven. No requiere cambio de código.
- Si **SÍ** inicia con `MEX`, `MTY` o `GDL` → es tratada como restringida, y solo el usuario con `ubicacion.nombre` igual al de la IF la ve (más su outlet, vía token match).

**Caso especial — agregar una nueva ubicación restringida** (ej: una nueva ciudad `PUEBLA` que debe ser exclusiva de usuarios `PUEBLA`):
1. Editar `backend/controllers/netsuiteController.js:5` y agregar `'PUEBLA'` al array `RESTRICTED_LOCATION_PREFIXES`.
2. Hacer commit, push, redeploy en Dokploy.
3. Documentar el nuevo prefijo en §1.3.

**Caso especial — agregar una ubicación a la whitelist explícita** (ej: `BODEGA_CENTRAL` debe ser visible para todos, aunque el nombre sea específico):
1. Editar `backend/controllers/netsuiteController.js:6` y agregar `'BODEGA_CENTRAL'` al array `SHARED_LOCATIONS` (que actualmente contiene `TEMPORAL`, `PROYECTOS`, `Material Transformado`, `MATRIZ`).
2. Hacer commit, push, redeploy.

**Caso especial — la nueva ubicación se llama `MEX_NUEVO`**: por el prefijo `MEX`, será tratada como restringida. Un usuario de `MEX` no la verá porque el match requiere `MEX` exacto o como token separado (el `_` no es separador). Considerar renombrar a `MEX:NUEVO` o agregar a la whitelist.

**Prueba unitaria rápida**:
```bash
docker exec -it wms-backend node -e "
const SHARED = ['TEMPORAL','PROYECTOS','Material Transformado','MATRIZ'];
const RESTR  = ['MEX','MTY','GDL'];
const filtra = (arr, user) => arr.filter(loc => {
  if (!loc) return false;
  if (SHARED.includes(loc)) return true;
  if (!RESTR.some(p => loc === p || loc.startsWith(p+':') || loc.startsWith(p+' '))) return true;
  if (loc === user) return true;
  return loc.split(/[\s:]+/).includes(user);
});
console.log(filtra(['GDL','GDL:OUTLET GDL','MEX:OUTLET MEX','TIJUANA','PUEBLA','TEMPORAL','BODEGA_CENTRAL','MATRIZ'], 'GDL'));
"
```

Salida esperada: `['GDL', 'GDL:OUTLET GDL', 'TIJUANA', 'PUEBLA', 'TEMPORAL', 'BODEGA_CENTRAL', 'MATRIZ']` (excluye `MEX:OUTLET MEX` porque el usuario es GDL).

### 9.12 Cómo agregar un nuevo campo al API de IFs

**Síntoma / necesidad**: quieres exponer un campo nuevo de la IF en el frontend (ej: el documento de origen, una fecha custom, un campo de texto, etc.).

**Procedimiento completo** (3 archivos + redeploy):

**Paso 1 — Agregar la columna a `customsearch3672` en NetSuite**
1. `Reports → Saved Searches → All Saved Searches` → abrir `customsearch3672`.
2. Pestaña **Results** → agregar la columna (puede ser un campo del record, una fórmula, o un join).
3. Si es fórmula de texto y no le pones nombre custom, NetSuite la llamará `formulatext` (es la key que verás en el JSON).
4. **Save** arriba a la derecha.
5. Esperar 5-10 minutos por cache de NetSuite (a veces menos, a veces más).

**Paso 2 — Mapear en `formatIFRecord`**
- Editar `backend/controllers/netsuiteController.js:38-48`.
- Agregar la nueva key con un nombre semántico (no uses la key cruda de NetSuite en el resto del código):
  ```js
  function formatIFRecord(ifRecord) {
    return {
      // ... campos existentes ...
      sourceDoc: ifRecord.formulatext,   // ← ejemplo
    };
  }
  ```
- Considerar fallback `|| ''` si el campo podría no existir en todos los IFs:
  ```js
  sourceDoc: ifRecord.formulatext || '',
  ```

**Paso 3 — Mostrar en el frontend**
- **Dropdown** (`js/netsuite-client.js:46-52`): incluir el campo en el `textContent` del `<option>`.
- **Modal de warning** (`js/signatures.js:77-102`): incluir el campo en el `ifDisplay` que se setea en `#confirmIFText`.
- **Badge superior** (opcional, `js/netsuite-client.js:69`): si quieres que también se vea al seleccionar.

**Paso 4 — Redeploy**
- Commit + push → Dokploy redeploy automático del backend.
- Refrescar el frontend (Ctrl+F5 si hace falta para limpiar cache del navegador).

**Verificación rápida** (sin esperar al frontend):
```bash
docker exec wms-backend sh -c \
  "curl -s -X POST http://localhost:3001/auth/login \
   -H 'Content-Type: application/json' \
   -d '{\"email\":\"test@marblock.com\",\"password\":\"xxx\"}' | jq ."
# tomar el token y usarlo en la siguiente llamada
docker exec wms-backend sh -c \
  "curl -s -X GET 'http://localhost:3001/netsuite/ifs' \
   -H 'Authorization: Bearer <token>' | jq '.ifs[0]'"
```
Deberías ver el campo nuevo en el JSON.

### 9.13 Una columna nueva de `customsearch3672` no aparece en el frontend

**Síntoma**: agregaste una columna a la búsqueda, redeployaste, recargaste el frontend, y el campo no aparece. Network tab muestra el response del backend (`/netsuite/ifs`) sin el campo nuevo.

**Diagnóstico en orden de probabilidad**:

1. **Falta el paso 2 (`formatIFRecord`)**:
   - El 90% de las veces es esto. La columna SÍ llega a NetSuite, pero `formatIFRecord` no la incluye, así que el backend no la expone.
   - Verificar `backend/controllers/netsuiteController.js:38-48`.
   - **Solución**: agregar el mapeo y redeploy.

2. **La columna no está en la pestaña Results de la búsqueda**:
   - Abrir `customsearch3672` en NetSuite → ir a **Results** (no Available Filters ni Filters).
   - Si la columna está en Available Filters, moverla a Results.
   - **Solución**: mover + Save.

3. **Cache de NetSuite**:
   - NetSuite cachea los resultados de saved search agresivamente.
   - **Solución**: esperar 5-10 minutos. Si sigue sin aparecer, en NetSuite abrir la búsqueda → click "Refresh" (a veces hay un botón explícito) o re-guardar.

4. **La fórmula está mal escrita y devuelve null**:
   - En NetSuite, abrir la fórmula → "Set Formula" → probar con un valor literal (ej: `'TEST'`) para descartar error de sintaxis.
   - Si con valor literal aparece y con la fórmula real no, hay error en la fórmula.

5. **No se hizo Save en NetSuite**:
   - El botón **Save** arriba a la derecha. Sin save, los cambios no se publican.

**Verificación rápida para distinguir "no llega a NetSuite" de "no se mapea en backend"**:

Agregar un `console.log` temporal en `backend/controllers/netsuiteController.js:82-83` (justo antes de `formatIFRecord`):
```js
const allIFs = searchResponse.data.data || [];
console.log('🔍 [DEBUG] Keys crudas:', Object.keys(allIFs[0] || {}));
console.log('🔍 [DEBUG] Primer IF:', JSON.stringify(allIFs[0], null, 2));
```
Hacer restart del backend, login en el frontend, y revisar `docker logs --tail 30 wms-backend`. Si la key nueva aparece aquí pero no en Network, el problema es `formatIFRecord`. Si no aparece aquí, el problema es la búsqueda o el cache de NetSuite. **Recordar revertir los `console.log` después.**

### 9.14 El modal de confirmación de salida de placas no aparece

**Síntoma**: el usuario hace click en "Completar registro" pero el modal con "Se registrarán N placas para la IF..." no se muestra. No hay error en consola.

**Causas posibles**:

1. **No hay IF seleccionada** → `startSignatureCapture()` muestra `showToast('Selecciona una IF antes de completar el registro', 'error')` y hace `return` antes del modal.
   - **Fix**: el usuario debe seleccionar una IF del dropdown antes de completar.

2. **No hay placas escaneadas** → toast "Escanea al menos una placa antes de capturar firmas" + return.
   - **Fix**: escanear al menos una placa.

3. **Error de JavaScript en `askExitConfirmation`**:
   - Abrir DevTools → Console.
   - Buscar errores tipo `Cannot read properties of null` o `selectedIF is undefined`.
   - Verificar que `selectedIF` no fue limpiado entre el `onchange` del select y el click del botón (revisar `clearIF()` en `js/netsuite-client.js:87-91`).

4. **El modal existe en el DOM pero su CSS no lo muestra**:
   - Verificar que el CSS de `.confirm-modal` y `.confirm-modal.active` existe en `css/styles.css:956-1016`.
   - Verificar que `z-index: 1001` está seteado (debe ser mayor que el del signature modal, que es 1000).

5. **El backend no está exponiendo `sourceDoc` correctamente**:
   - Si `selectedIF.sourceDoc` es `undefined`, el `ifDisplay` cae al fallback `selectedIF.tranid` y se ve "para la IF14580", no "para la IF14580 (SO14548)".
   - Verificar que `formatIFRecord` incluye `sourceDoc` y que la columna de NetSuite está bien configurada (ver §9.13).

### 9.15 La pistola no escanea al cargar la página

**Síntoma**: el operador carga la página, escanea con la pistola, y no pasa nada. **Después de hacer click en el toggle Pistola→Cámara→Pistola, la pistola empieza a funcionar**.

**Causa**: el listener de keydown de la pistola se adjunta en la IIFE al final del archivo `scanner.js`, pero **si el foco está en un `<select>` (el dropdown de IF) o un `<input>` al momento de escanear**, el listener retorna temprano porque `e.target` es un form field.

Esto es especialmente común porque:
- El operador selecciona la IF del dropdown
- El foco queda en el `<select>` (los selects retienen el foco después de seleccionar)
- El operador escanea sin hacer click afuera
- El listener `onPistolaKeydown` ve `e.target.tagName === 'SELECT'` y hace `return` sin procesar

**Fix (aplicado)**: la lógica actual en `js/scanner.js` distingue pistola vs humano por **timing**:
- Si el `keydown` viene de un form field Y el intervalo entre teclas es >50ms (tipeo humano) → deja pasar al campo normalmente.
- Si el `keydown` viene de un form field Y el intervalo entre teclas es <50ms (pistola) → captura los caracteres y los acumula en el buffer.

Cuando llega el terminador (Enter), hace `blur()` del elemento con foco para evitar caracteres basura y para que el próximo scan también funcione.

**Workaround adicional**: si el problema persiste, hacer click en el `<body>` (o en cualquier área gris) antes de escanear para sacar el foco del select.

**Diagnóstico**:
```js
// En la consola del navegador:
window.getScannerState()
// Devuelve: { scanSource, pistolActive, cameraActive, bufferLen, buffer }
```

Si `pistolActive === false`, la pistola no está escuchando. Si `scanSource !== 'pistola'`, el usuario está en modo cámara.

### 9.16 El toggle a Cámara no funciona

**Síntoma**: el operador hace click en el botón "Cámara" del toggle superior derecho del card del escáner, y no pasa nada (o tira error en consola).

**Causas posibles**:

1. **Cache del navegador**: la versión vieja del JS no tiene `setScanSource` exportada a `window`. **Fix**: hard refresh (Ctrl+Shift+R) o limpiar cache.

2. **Error de carga de script**: si el script `scanner.js` no se cargó correctamente, `setScanSource` no está definida. **Fix**: DevTools → Network → verificar que `js/scanner.js?v=N` se cargó con status 200.

3. **El CDN de html5-qrcode no cargó**: la cámara requiere `Html5Qrcode` del CDN. Si la red del operador bloquea cdnjs, `startCamera()` falla con "Librería de cámara no disponible". **Fix**: el operador puede seguir usando la pistola; el modo cámara solo es fallback.

**Diagnóstico en orden**:
1. Abrir DevTools → Console.
2. Buscar el error: si dice `ReferenceError: setScanSource is not defined`, es cache (fix: hard refresh).
3. Si dice `Librería de cámara no disponible`, es el CDN bloqueado.
4. Si no hay error pero no pasa nada, verificar que `window.setScanSource` existe:
   ```js
   typeof window.setScanSource === 'function'  // debe ser true
   ```

### 9.17 El LED de la pistola no se pone verde

**Síntoma**: el operador carga la página, pero el círculo LED del card del escáner aparece gris (clase `idle`) en vez de verde (clase `active`).

**Causa**: la IIFE en `scanner.js` no se ejecutó, o `startPistola()` no fue llamado. Posibles razones:
- Error de sintaxis en `scanner.js` (el script no parseó).
- El DOM no contenía el elemento `#gunLed` cuando se llamó `setGunLedActive(true)`.
- `scanSource` se cambió a `'camara'` antes de cargar la página (improbable pero posible).

**Diagnóstico**:
```js
// En la consola:
window.getScannerState()
// Verificar pistolActive === true
```

Si `pistolActive === false`:
1. Verificar que no hay errores en consola al cargar.
2. Verificar que el HTML contiene `<div class="gun-led" id="gunLed">`.
3. Hard refresh.

**Fix manual temporal** (en consola):
```js
window.startScanner()  // fuerza el inicio
```

### 9.18 La pistola se lee pero la placa no aparece en la tabla

**Síntoma**: el operador dispara la pistola, la pistola pita, pero la fila no aparece en `#tableBody`. Posibles causas:

1. **`addRecord` no está definida**: `scanner.js` se cargó antes que `table.js`. **Fix**: verificar orden de scripts (ver §5.3).

2. **`addRecord` falla internamente**: el método ejecuta operaciones DOM que pueden fallar. **Fix**: revisar consola — debería haber un log `[WMS-SCAN] ERROR en addRecord: ...`.

3. **Dedupe de 3s bloqueó el scan**: si escaneás el mismo código dos veces en menos de 3s, el segundo es ignorado. **Fix**: esperar 3s o escanear un código diferente.

4. **El formato del QR no es `SKU LOTE UBICACION`**: el parser espera exactamente 3 tokens separados por espacio. Ejemplos:
   - ✅ `030LTH 12572-3.16X1.96 GDL` (3 tokens)
   - ✅ `SKU-A L-001 A-1-2` (3 tokens)
   - ❌ `030LTH-12572-3.16X1.96-GDL` (1 token, guión como separador)
   - ❌ `030LTH 12572-3.16X1.96` (2 tokens, falta ubicación)
   - ❌ `030LTH:12572-3.16X1.96:GDL` (1 token, `:` como separador en vez de espacio)

   **Fix**: configurar el QR para usar **espacio** como separador, o ajustar `js/qr-parser.js:parseQR` para aceptar el formato de la pistola.

5. **El modal de firma está abierto**: el listener descarta el buffer si detecta un modal abierto. **Fix**: cerrar el modal antes de escanear.

**Diagnóstico paso a paso**:
```js
// 1. Verificar que el listener se está disparando
//    Disparar la pistola y mirar la consola: debería haber logs [WMS-SCAN] ESCANEO:

// 2. Si hay log, ver qué buffer se procesó
//    El log muestra: [WMS-SCAN] ESCANEO: <texto>

// 3. Verificar que parseQR funciona
parseQR('030LTH 12572-3.16X1.96 GDL', 'placa')
// Debe devolver: { tipo: 'placa', sku: '030LTH', lote: '12572-3.16X1.96', ubicacion: 'GDL' }

// 4. Verificar que addRecord se llama
addRecord({ tipo: 'placa', sku: 'TEST', lote: 'TEST', ubicacion: 'TEST' })
// Debe agregar una fila a la tabla
```

---

## 10. Anexos

### 10.1 Glosario

| Término | Significado                                                              |
|---------|--------------------------------------------------------------------------|
| **IF**  | Item Fulfillment (Instrucción de Fabricación) en NetSuite.               |
| **TBA** | Token-Based Authentication. NetSuite lo usa para RESTlets y REST API.   |
| **RESTlet** | Endpoint server-side de NetSuite con scripts SuiteScript 1.0/2.x.   |
| **HMAC-SHA256** | Algoritmo de firma para OAuth 1.0a. Hash con SHA-256 y clave HMAC. |
| **realm** | Identificador de la cuenta NetSuite dentro del header OAuth 1.0a.   |
| **File Cabinet** | Sistema de archivos de NetSuite donde se suben los PNG de firma. |
| **Item Fulfillment** | Tipo de registro en NetSuite para salidas de inventario.     |
| **shipstatus** | Nombre del campo nativo de NetSuite en el record `Item Fulfillment`. Valores: `A` Pending Approval, `B` Pending Fulfillment, `C` Shipped, `D` Partially Shipped, `E` Pending Billing, `F` Billed, `G` Closed. En el response de la búsqueda guardada (RESTlet 2217) este campo llega como `statusref` (`{value, text}`). |
| **statusref** | Nombre de la key en el JSON de respuesta del RESTlet 2217. Contiene `{ value: "packed", text: "Empaquetado" }`. Mapeado a `status` en el response del backend por `formatIFRecord`. |
| **formulatext** | Nombre por default que NetSuite asigna a una columna de fórmula de texto en una búsqueda guardada. Si no le pusiste un nombre custom, el RESTlet 2217 la devuelve bajo esta key. Mapeado a `sourceDoc` en el response del backend. |
| **HID Keyboard** | Human Interface Device Keyboard. Una pistola lectora de QR en modo USB Keyboard se comporta como un teclado y emite los caracteres del código QR como keystrokes seguidos de un terminador (Enter). El navegador los recibe como eventos `keydown`. |
| **scanSource** | Variable global en `js/scanner.js` que indica la fuente activa: `'pistola'` (default) o `'camara'`. Cambiable vía el toggle visual en el card del escáner o vía `window.setScanSource(src)`. |
| **Buffer de scan** | Variable global `scanBuffer` en `js/scanner.js` que acumula caracteres del QR hasta recibir el terminador. Se descarta automáticamente después de 500ms sin actividad (anti-ruido). |

### 10.2 Pendientes y mejoras

| #  | Estado | Pendiente                                                                                |
|----|--------|-------------------------------------------------------------------------------------------|
| 1  | ⏳     | Persistir firmas también en `firmas` de Supabase (hoy solo en NetSuite).                  |
| 2  | ⏳     | Escribir `audit_logs` desde el backend (hoy la tabla existe pero no se usa).              |
| 3  | ⏳     | Eliminar `GUIA_USUARIOS.md` (no actualizado).                                             |
| 4  | ⏳     | Completar flujo OAuth 2.0 en `oauthController.js` (hoy el callback no persiste el token). |
| 5  | ⏳     | Considerar agregar `package-lock.json` al repo para builds reproducibles.                 |
| 6  | ⏳     | Mover el `BACKEND_URL` a una variable de entorno del frontend (requiere `sub_filter` en nginx). |
| 7  | ⏳     | Refactor del `WEBHOOK_URL` de n8n: está hardcodeado en `js/webhook.js` y no se usa.        |
| 8  | ✅     | ~~Documentar el script 2217 (no está en el repo, solo existe en NetSuite).~~ Resuelto en §6.13. |
| 9  | ⏳     | Internacionalización (i18n) — hoy todo en español-MX.                                     |
| 10 | ⏳     | Tests automatizados (no hay suite de tests).                                              |
| 11 | ✅     | ~~Ajustar los `folderId` (12848/12849/12850/12851) en `wms_link_firmas.js` cuando se promuevan a producción.~~ Documentado en §6.11 con warning explícito. |
| 12 | ⏳     | Agregar `wms_link_firmas.js` y `wms_firma_template.xml` al File Cabinet de producción y desplegar script + asignar template al record Item Fulfillment. |
| 13 | ⏳     | Considerar extraer el helper de filtrado de location a un módulo separado (`backend/utils/locationFilter.js`) para que sea testeable aisladamente. |
| 14 | ⏳     | Mover `RESTRICTED_LOCATION_PREFIXES` y `SHARED_LOCATIONS` a `backend/config/environments.js` para que sean configurables sin tocar el controller. |
| 15 | ⏳     | Cuando se cambie el nombre de la columna fórmula en NetSuite (de `formulatext` a un ID custom como `custbody_num_doc_origen`), actualizar `formatIFRecord` y §6.5.5. Mientras siga como `formulatext` default, no requiere cambio. |
| 16 | ✅     | ~~Migrar el escáner de cámara a pistola HID como fuente principal.~~ Resuelto en v2.0. Documentado en §1.5, §5.7, §9.15-9.18. |
| 17 | ✅     | ~~Cache-busting de los scripts del frontend.~~ Resuelto con `?v=N` (incrementar al actualizar JS). |
| 18 | ✅     | ~~Bug: pistola no escaneaba con foco en `<select>` de IF.~~ Resuelto con detección por timing en `js/scanner.js` (pistola: <50ms entre teclas, humano: >50ms). |
| 19 | ✅     | ~~Bug: pistola no se activaba al cargar la página.~~ Resuelto con IIFE en `scanner.js` que llama `startPistola()` automáticamente. |
| 20 | ⏳     | Cuando se cambie la pistola de modelo, verificar que el terminador siga siendo `Enter` (algunas pistolas usan `Tab`). Configurable vía `SCAN_TERMINATOR_KEYS` en `js/scanner.js:24`. |
| 21 | ⏳     | Considerar agregar feedback visual/sonoro al recibir un scan (toast verde, beep, vibración). Por ahora solo se actualiza `#lastScanText`. |
| 22 | ⏳     | Documentar y automatizar la regeneración de credenciales NetSuite (script `scripts/regen-netsuite-creds.sh`?). |

### 10.3 Comandos útiles

```bash
# Reconstruir y redesplegar local (sin Dokploy)
docker compose -f docker-compose.yml up --build

# Ver logs de Dokploy vía CLI
ssh user@vps "docker logs --tail 200 wms-backend"

# Generar un hash bcrypt para un nuevo usuario
docker exec wms-backend node -e "
const b=require('bcryptjs');
b.hash('MiPassword123!',10).then(h=>console.log(h));
"

# Probar login programáticamente
curl -X POST https://api.marblock.shop/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@marblock.com","password":"MiPassword123!"}'
```

### 10.4 Archivos no documentados a profundidad

- `css/variables.css` y `css/styles.css` — estilos; no afectan la lógica.
- `images/` — assets visuales.
- `lib/signature_pad.min.js` — librería externa, no inspeccionada.
- `docker-compose.yml` (raíz) — versión local/dev, no usada en Dokploy.
- `backend/package-lock.json` — no se commitea (está en `.gitignore`).
- `test-scanner.html` — *(eliminado del repo, ya no existe en la raíz)*. Era una página standalone para verificar la pistola sin login.

**Archivos documentados a profundidad** (referencias cruzadas):
- `wms_restlet.js` → §6.7 (RESTlet 2860)
- `wms_link_firmas.js` → §6.11 (UserEvent script)
- `wms_firma_template.xml` → §6.12 (Advanced PDF template)
- `js/scanner.js` → §1.5 (arquitectura), §5.7 (API), §9.15-9.18 (troubleshooting)

---

**Mantenido por**: equipo WMS Marblock.
**Última actualización**: junio 2026

### Cambios recientes (v2.0)

**Scanner** (principal cambio):
- §1.5 nueva: arquitectura del escáner con diagrama de flujo de las dos fuentes (pistola + cámara)
- §5.1, §5.2, §5.3 actualizadas: stack, estructura de archivos, cache-busting `?v=N`
- §5.5 actualizada: tabla de variables globales incluyendo `scanSource`, `pistolActive`, `cameraActive`, `scanBuffer`, `scanner`
- §5.5 nueva: tabla de funciones expuestas en `window.*` para los `onclick` inline
- §5.6 actualizada: flujo de usuario incluye auto-arranque de la pistola
- §5.7 reescrita: `js/scanner.js` documentado con pseudocódigo del listener, decisiones de diseño, helpers, IIFE de init, flujo del modo cámara, función unificadora `handleScan`
- §9.15-9.18 nuevas: troubleshooting específico del escáner (foco en select, toggle, LED, no aparece en tabla)
- §10.1 glosario extendido: HID Keyboard, scanSource, buffer de scan
- §10.2 actualizadas: marcadores ✅/⏳; 7 ítems nuevos (#16-22) reflejando lo hecho y los pendientes del escáner

**Otros cambios pendientes de documentar** (en futuras revisiones):
- v1.x: Modal de confirmación de salida de placas (`#confirmExitModal`) con conteo + IF + doc origen
- v1.x: Campo `sourceDoc` agregado al API (mapea `ifRecord.formulatext` en `formatIFRecord`)
- v1.x: Dropdown y modal de warning muestran formato `IF14580 (SO14548)`
- v1.x: Validaciones en cascada en `startSignatureCapture()` (records + selectedIF)
- v1.x: §6.13 flujo completo de data de NetSuite al frontend
- v1.x: §9.12-9.14 cómo agregar un campo nuevo, diagnosticar columnas faltantes, diagnosticar modal que no aparece
- v1.x: §6.5.5 equivalencia campos NetSuite → keys JSON
- v1.x: Regla de ubicaciones compartidas por default; whitelist de `Material Transformado` y `MATRIZ`; fix de filtrado de outlets; documentación de `wms_link_firmas.js` y `wms_firma_template.xml`
