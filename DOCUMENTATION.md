# WMS Scanner — Documentación Técnica

> Sistema de Gestión de Almacén (WMS) para escaneo de placas, captura de firmas electrónicas y sincronización con NetSuite.
>
> **Versión**: 2.0
> **Stack**: Node.js 18 + Express · JavaScript vanilla (frontend) · Supabase (Postgres) · NetSuite RESTlet (OAuth 1.0a TBA) · Dokploy + Traefik (despliegue).

---

## Tabla de contenidos

1. [Visión general](#1-visión-general)
2. [Arquitectura](#2-arquitectura)
3. [Modelo de datos (Supabase)](#3-modelo-de-datos-supabase)
4. [Backend](#4-backend)
5. [Frontend](#5-frontend)
6. [Integración con NetSuite](#6-integración-con-netsuite)
7. [Despliegue (Dokploy)](#7-despliegue-dokploy)
8. [Variables de entorno](#8-variables-de-entorno)
9. [Runbook / Troubleshooting](#9-runbook--troubleshooting)
10. [Anexos](#10-anexos)

---

## 1. Visión general

### 1.1 Propósito

WMS Scanner es la herramienta móvil/web que utilizan los operadores de almacén para:

1. **Registrarse / iniciar sesión** con credenciales corporativas.
2. **Consultar Instrucciones de Fabricación (IF)** abiertas en su ubicación, vía búsqueda guardada en NetSuite (`customsearch3434`).
3. **Escanear placas** mediante la cámara del dispositivo (formato QR: `SKU LOTE UBICACION`).
4. **Capturar firmas electrónicas** (aux. de almacén, cliente, jefe de almacén, gerente) según el número de placas.
5. **Sincronizar con NetSuite**: subir las firmas PNG al File Cabinet, actualizar el status del IF a "Enviado" (`C`) y, opcionalmente, notificar vía webhook a n8n como fallback.

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
- Las IFs se filtran en backend por la ubicación del usuario + outlets + las ubicaciones compartidas `TEMPORAL` y `PROYECTOS` (ver `backend/controllers/netsuiteController.js:7-22`).
- Ejemplo: un usuario en `MEX` (id=1) ve IFs de `MEX` y `MEX:OUTLET` (id=2), además de `TEMPORAL` y `PROYECTOS`.

| ID  | Nombre        | Notas                       |
|-----|---------------|-----------------------------|
| 1   | `MEX`         | Principal                   |
| 2   | `MEX:OUTLET`  | Outlet vinculado a MEX      |
| 3   | `MTY`         | Principal                   |
| 4   | `MTY:OUTLET`  | Outlet vinculado a MTY      |
| 5   | `GDL`         | Principal                   |
| 6   | `GDL:OUTLET`  | Outlet vinculado a GDL      |
| 7   | `TEMPORAL`    | Compartida, visible para todos |
| 8   | `PROYECTOS`   | Compartida, visible para todos |

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

- **RESTlet de búsqueda** (script 2217, deploy 1): `POST /app/site/hosting/restlet.nl?script=2217&deploy=1` con `{"searchId":"customsearch3434","limit":1000,"start":0}`.
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
  "uploadedFiles": [ { "type": "auxAlmacen", "label": "Aux. de Almacén", "filename": "IF-2026-001_auxAlmacen.png", "size": 12345, "success": true, "fileId": "...", "folderId": 11765, "url": "...", "uploaded": "..." } ],
  "failedFiles": undefined,
  "ifStatusUpdated": true,
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
| `getIFs`           | 39-82  | Llama al RESTlet 2217 con `searchId=customsearch3434`, filtra por ubicación del usuario, mapea a formato simplificado |
| `submitData`       | 151-309| Por cada firma: sube PNG al File Cabinet (script 2860). Si todas OK, actualiza status del IF a `C`                   |
| `diagnosticTest`   | 318-440| Valida env vars, prueba conexión sin OAuth y con OAuth a `/record/salesorder/1`                                      |

**Lógica de filtrado de IFs** (`filterIFsByUserLocation`):

```js
// Si la IF.location es TEMPORAL o PROYECTOS → siempre visible
// Si no, solo si location === user.ubicacion.nombre
// Soporta que location llegue como string, {text} o {value}
```

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

`netsuiteOAuth2.js` implementa el flujo Authorization Code de OAuth 2.0 (en desarrollo, solo se usa desde los endpoints `/auth/netsuite/oauth/*`). Los clientes `netsuiteAuth.js`, `netsuiteOAuth.js` y `netsuite.js` se movieron a `config/_legacy/` porque no participan en el flujo principal (RESTlets 2217/2976/2860) y solo quedaban como referencia. Ver §6.9.

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
  - `html5-qrcode` (CDN: cdnjs) — escáner QR.
- Iconos: SVG inline.
- Estilos: `css/variables.css` + `css/styles.css`.

### 5.2 Estructura

```
WMS/
├── index.html              # Entry point, carga 9 scripts
├── css/
├── images/
├── lib/signature_pad.min.js
└── js/
    ├── utils.js            # showToast, setStatus, esc
    ├── auth.js             # Login, logout, restoreSession, BACKEND_URL
    ├── netsuite-client.js  # loadIFs, submitToNetSuite
    ├── signatures.js       # getRequiredSignatures, captureNextSignature
    ├── qr-parser.js        # parseQR(text, mode)
    ├── webhook.js          # WEBHOOK_URL a n8n (FALLBACK)
    ├── table.js            # records[], addRecord, deleteRow, clearTable
    ├── scanner.js          # startScanner, stopScanner, handleScan
    └── app.js              # initApp, scanMode
```

### 5.3 Carga de scripts

`index.html` define `window.APP_CONFIG` con `BACKEND_URL` (default `https://api.marblock.shop`) **antes** de cargar los scripts. Luego carga en este orden estricto:

1. `utils.js` — sin dependencias.
2. `auth.js` — define `BACKEND_URL`, `currentUser`, `authToken`. Depende de `utils.js` (showToast).
3. `netsuite-client.js` — depende de `auth.js` (`currentUser`, `authenticatedFetch`).
4. `signatures.js` — depende de `auth.js`, `table.js` (`records`).
5. `qr-parser.js` — sin dependencias.
6. `webhook.js` — depende de `auth.js`, `table.js`, `app.js`.
7. `table.js` — depende de `utils.js`.
8. `scanner.js` — depende de `utils.js`, `table.js`, `qr-parser.js`, `app.js`.
9. `app.js` — depende de `table.js`.

> **Importante**: el orden está hardcodeado en `index.html` y debe respetarse. Refactorizar a ES Modules requeriría servidor con MIME `application/javascript` y agrega complejidad no justificada.

### 5.4 Configuración

```html
<!-- index.html:229-237 -->
<script>
  window.APP_CONFIG = window.APP_CONFIG || {
    BACKEND_URL: (typeof window.__BACKEND_URL__ === 'string' && window.__BACKEND_URL__)
      ? window.__BACKEND_URL__
      : 'https://api.marblock.shop'
  };
</script>
```

- `window.__BACKEND_URL__` puede inyectarse desde el servidor (nginx `sub_filter` o similar). Si no existe, usa el fallback público.
- El valor se lee en `js/auth.js:6-9`.

### 5.5 Estado global

Todas las variables compartidas están en `window` (no en módulos):

| Variable       | Definida en          | Usada en                                |
|----------------|----------------------|------------------------------------------|
| `BACKEND_URL`  | `auth.js:6`          | `auth.js`, `webhook.js` (no), `netsuite-client.js` (vía `authenticatedFetch`) |
| `currentUser`  | `auth.js:7`          | `auth.js`, `netsuite-client.js`, `webhook.js` |
| `authToken`    | `auth.js:8`          | `auth.js` (en `authenticatedFetch`)      |
| `availableIFs` | `netsuite-client.js:6` | `netsuite-client.js`                  |
| `selectedIF`   | `netsuite-client.js:7` | `netsuite-client.js`, `signatures.js`, `webhook.js` |
| `records`      | `table.js:6`         | Toda la app                              |
| `signaturePad` | `signatures.js:6`    | `signatures.js`                          |
| `collectedSignatures` | `signatures.js:7` | `signatures.js`                   |
| `signatureQueue` | `signatures.js:8`  | `signatures.js`                          |
| `currentSignatureType` | `signatures.js:9` | `signatures.js`                    |
| `scanMode`     | `app.js:6`           | `scanner.js`                             |
| `hasBeenSent`  | `webhook.js:11`      | `webhook.js`, `table.js`                 |

### 5.6 Flujo de usuario

```
┌────────────┐
│  LOGIN     │  handleLogin(email, password)  →  POST /auth/login
└─────┬──────┘
      │  JWT en sessionStorage
      ▼
┌────────────┐
│ CARGAR IFs │  loadIFs()  →  GET /netsuite/ifs  (con Bearer token)
└─────┬──────┘
      │  dropdown poblado con IFs filtradas
      ▼
┌────────────┐
│ SELECCIONAR│  onChange del select  →  selectedIF
│    IF      │
└─────┬──────┘
      │
      ▼
┌────────────┐
│  ESCANEAR  │  startScanner() + handleScan(text)  →  addRecord(parsedQR)
│  PLACAS    │
└─────┬──────┘
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
- `setStatus(msg, type)` — actualiza línea de estado del escáner.
- `esc(s)` — escape HTML para evitar XSS al inyectar `sku`, `lote`, `ubicacion`.

#### `js/auth.js`
- `handleLogin(event)` — login con fetch.
- `handleLogout()` — limpia `sessionStorage` y vuelve a vista de login.
- `restoreSession()` — al cargar la página, si hay token en `sessionStorage` lo rehidrata.
- `authenticatedFetch(endpoint, options)` — wrapper que agrega `Authorization: Bearer <token>` y maneja 401 (logout forzado).

#### `js/netsuite-client.js`
- `loadIFs()` — GET a `/netsuite/ifs` con la ubicación del usuario. Llena `availableIFs` y el `<select>`.
- `updateIFSelect()` — renderiza opciones del dropdown.
- `handleIFSelect(event)` — al cambiar el select, guarda `selectedIF`.
- `reloadIFs()` — recarga IFs.
- `clearIF()` — limpia selección.
- `submitToNetSuite(signatures)` — POST a `/netsuite/submit` con todo el payload.

#### `js/signatures.js`
- `initSignaturePad()` — instancia `new SignaturePad(canvas, ...)`.
- `getRequiredSignatures()` — devuelve objeto con firmas requeridas según `records.length`:
  - siempre: `auxAlmacen` y `cliente`
  - si `> 3`: `jefeAlmacen`
  - si `> 10`: `gerente`
- `startSignatureCapture()` — arma la cola y arranca.
- `captureNextSignature()` — saca la siguiente firma de la cola y muestra el modal.
- `clearSignature()` — limpia el canvas.
- `submitSignature()` — toma `toDataURL('image/png')` y la guarda en `collectedSignatures`.
- `submitWithSignatures()` — llama a `submitToNetSuite(collectedSignatures)`.

#### `js/qr-parser.js`
- `parseQR(raw, mode)` — devuelve `{tipo:'placa', sku, lote, ubicacion}` si tiene 3+ partes separadas por espacio, o `{tipo:'folio', valor}` si 1 parte. Modo `folio` siempre devuelve `folio`.

#### `js/table.js`
- `addRecord(item)` — agrega a `records[]` y crea `<tr>` con `hora` en formato es-MX.
- `deleteRow(btn, idx)` — marca como null (soft delete).
- `clearTable()` — pide confirmación, vacía todo, llama a `unlockForResend()`.
- `getActiveRecords()` — filtra los no eliminados.
- `renderEmpty()` — pinta el estado vacío.

#### `js/scanner.js`
- `handleScan(text)` — dedupe de 3s, llama a `parseQR` y `addRecord`.
- `startScanner()` — instancia `Html5Qrcode`, configura resolución 4K ideal, `facingMode: environment`, `experimentalFeatures.useBarCodeDetectorIfSupported: true`. Aplica autoenfoque continuo vía `applyConstraints`.
- `applyFocus()` — pide `focusMode: continuous` y `focusDistance: min` al track.
- `stopScanner()` — detiene y limpia.

#### `js/webhook.js` (LEGACY / FALLBACK)
- `exportJSON()` — POST a `https://n8nmrb.marblock.shop/webhook/...` con el payload. Si falla, descarga JSON local.
- `downloadJSONFallback(payload)` — `<a download>` con Blob.
- `lockFromResend()` / `unlockForResend()` — bloquea el botón "Completar registro" después de un envío exitoso.

> El frontend hoy **no llama a `exportJSON()`** (no hay botón que la invoque). La función existe para compatibilidad pero el flujo activo es `submitToNetSuite()`. Ver §10.2.

#### `js/app.js`
- `initApp()` — llama a `renderEmpty()`.
- `scanMode = 'placa'` — constante, el modo "folio" existe en el código pero no se usa en la UI actual.

### 5.8 Convenciones de UI

- **Colores**: definidos en `css/variables.css` (no inspeccionado a fondo). Usar variables CSS, no valores hardcoded.
- **Iconos**: SVG inline, no font icons. Estilo: `stroke="currentColor"`, `stroke-width="1.2-2.2"`.
- **Notificaciones**: solo `showToast()`, no alerts nativos.
- **Modales**: clase `.active` para mostrar (`signatureModal`).

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
| RESTlet 2976      | `CUSTOMSCRIPT2976`, deploy 1 | Sube PNG a File Cabinet y actualiza status del IF (`updateIFStatus`) |

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

Cada RESTlet (`CUSTOMSCRIPT2217` y `CUSTOMSCRIPT2976`) tiene un Deployment asociado. El campo **Audience** del deployment **debe incluir el rol `WMS`** o estar configurado como "All Roles". Si el rol `WMS` no está en el Audience, el RESTlet rechaza las llamadas del TBA con `INVALID_LOGIN_ATTEMPT` aunque las credenciales sean válidas.

Procedimiento para verificar:
1. `Customization → Scripting → Scripts → [2217] → Deployments`.
2. Abrir el deployment activo.
3. Pestaña **Audience** → confirmar que el rol `WMS` está en "Selected Roles" o que está configurado como "All Roles".
4. Save.
5. Repetir para el script 2976.

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

#### 6.5.3 Columnas (resultados) — en este orden

| # | Columna              | Tipo de campo       |
|---|----------------------|---------------------|
| 1 | Número de documento  | Tran ID (tranid)    |
| 2 | Nota                 | Memo                |
| 3 | Ubicación            | Location            |
| 4 | Estado               | Ship Status         |
| 5 | Fecha                | Transaction Date    |

> **Importante**: el orden de las columnas es relevante porque el backend (`backend/controllers/netsuiteController.js:24-33` y `formatIFRecord`) mapea por índice. Si se cambia el orden en la búsqueda, hay que actualizar el código.

#### 6.5.4 Mapping backend → frontend

El backend mapea las columnas a este JSON:

```jsonc
{
  "internalId": 12345,      // Internal ID
  "tranid": "IF-2026-001",   // Columna 1
  "description": "Memo",    // Columna 2
  "location": "MEX",        // Columna 3 (puede llegar como {value, text})
  "status": "B",            // Columna 4
  "date": "2026-06-09"      // Columna 5
}
```

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
      "tranid": "IF-2026-001",
      "memo": "Salida de placas MEX",
      "location": { "value": "1", "text": "MEX" },
      "shipstatus": { "value": "B", "text": "Empaquetado" },
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

#### 6.6.4 Errores comunes

| Status | Causa probable                                       | Solución                                                       |
|--------|------------------------------------------------------|----------------------------------------------------------------|
| 400    | Falta `searchId` en el body                          | Verificar que `netsuiteController.js:54` lo envíe              |
| 400    | `searchId` no es una búsqueda válida                | Verificar que `customsearch3672` exista y esté publicada       |
| 400    | Rol sin permiso sobre el record type                | Agregar `Ejecución de orden de artículos = Completo` al rol `WMS` |
| 500    | Error de sintaxis en `searchResults.js`             | Revisar Execution Log del RESTlet en NetSuite                  |

### 6.7 RESTlet 2976 (`wms_restlet.js`) — Subida de archivos y status de IF

#### 6.7.1 Metadatos

| Campo           | Valor                |
|-----------------|----------------------|
| Internal ID     | `CUSTOMSCRIPT2976`   |
| Deploy ID       | `CUSTOMDEPLOY1`      |
| Audience        | Rol `WMS`            |
| Script          | `wms_restlet.js` (versionado en el repo) |

#### 6.7.2 Contrato

**Request — Subir firma**:
```json
POST /app/site/hosting/restlet.nl?script=2976&deploy=1
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
├── GerenteSucursal/   # Folder ID: 11773
└── JefeAlmacen/       # Folder ID: 11772
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

---

## 7. Despliegue (Dokploy)

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
| `NETSUITE_RESTLET_URL`                    | **Sí**    | `https://9080139-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=2976&deploy=1` | URL completa del RESTlet 2976 (upload) |
| `NETSUITE_RESTLET_SCRIPT_ID`              | No        | `2976`                                             | ID del script (upload + updateIFStatus)    |
| `NETSUITE_RESTLET_DEPLOY_ID`              | No        | `1`                                                | Deploy del script                           |
| `NETSUITE_SEARCH_RESTLET_URL`             | **Sí**    | `https://9080139-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=2217&deploy=1` | URL completa del RESTlet 2217 (search) |
| `NETSUITE_SEARCH_RESTLET_SCRIPT_ID`       | No        | `2217`                                             | ID del script (búsqueda de IFs)            |
| `NETSUITE_SEARCH_RESTLET_DEPLOY_ID`       | No        | `1`                                                | Deploy del script                           |
| `NETSUITE_FOLDER_AUXALMACEN`              | **Sí**    | `12848`                                            | Folder ID `auxAlmacen` (compartido)         |
| `NETSUITE_FOLDER_CLIENTE`                 | **Sí**    | `12849`                                            | Folder ID `Cliente` (compartido)            |
| `NETSUITE_FOLDER_JEFE`                    | **Sí**    | `11772`                                            | Folder ID `JefeAlmacen` (compartido)        |
| `NETSUITE_FOLDER_GERENTE`                 | **Sí**    | `11773`                                            | Folder ID `GerenteSucursal` (compartido)    |
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
req.write(JSON.stringify({searchId:'customsearch3434',limit:10,start:0}));
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
2. Verificar que la búsqueda `customsearch3434` exista y devuelva resultados para la ubicación del usuario.
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
| **shipstatus** | Estado del IF. Valores: `A` Pending Approval, `B` Pending Fulfillment, `C` Shipped, `D` Partially Shipped, `E` Pending Billing, `F` Billed, `G` Closed. |

### 10.2 Pendientes y mejoras

| # | Pendiente                                                                                |
|---|-------------------------------------------------------------------------------------------|
| 1 | Persistir firmas también en `firmas` de Supabase (hoy solo en NetSuite).                  |
| 2 | Escribir `audit_logs` desde el backend (hoy la tabla existe pero no se usa).              |
| 3 | Eliminar `GUIA_USUARIOS.md` (no actualizado).                                             |
| 4 | Completar flujo OAuth 2.0 en `oauthController.js` (hoy el callback no persiste el token). |
| 5 | Considerar agregar `package-lock.json` al repo para builds reproducibles.                 |
| 6 | Mover el `BACKEND_URL` a una variable de entorno del frontend (requiere `sub_filter` en nginx). |
| 7 | Refactor del `WEBHOOK_URL` de n8n: está hardcodeado en `js/webhook.js:10` y no se usa.   |
| 8 | Documentar el script 2217 (no está en el repo, solo existe en NetSuite).                  |
| 9 | Internacionalización (i18n) — hoy todo en español-MX.                                     |
| 10| Tests automatizados (no hay suite de tests).                                              |

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
- `wms_restlet.js` — RESTlet 2860 documentado parcialmente en §6.2.
- `docker-compose.yml` (raíz) — versión local/dev, no usada en Dokploy.
- `backend/package-lock.json` — no se commitea (está en `.gitignore`).

---

**Mantenido por**: equipo WMS Marblock.
**Última actualización**: junio 2026.
