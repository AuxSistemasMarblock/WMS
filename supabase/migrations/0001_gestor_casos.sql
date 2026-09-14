-- 0001_gestor_casos.sql
-- Núcleo de auditoría persistente para el gestor de casos de discrepancias.
--
-- Idempotente: todas las sentencias usan IF NOT EXISTS / ON CONFLICT, por lo
-- que puede ejecutarse varias veces sin efectos secundarios.
--
-- NOTA DE SEGURIDAD: el backend se conecta a Supabase con la SERVICE ROLE key
-- (ver backend/config/supabase.js), la cual bypassa RLS. Por eso las 4 tablas
-- tienen RLS habilitado SIN políticas: ningún rol anon/authenticated puede
-- leer o escribir; solo el service role (backend) accede a estos datos.
--
-- NOTA DE ESQUEMA: no se declaran foreign keys hacia usuarios/ubicaciones
-- porque no se asume su esquema en esta migración. Los identificadores
-- (creado_por, revisado_por, actor_id, ubicacion_id, tipo_justificacion_id,
-- caso_id, discrepancia_id) se guardan como bigint simples.

begin;

-- ============================================================
-- Tipos de justificación (catálogo)
-- ============================================================
create table if not exists tipos_justificacion (
  id bigserial primary key,
  clave text unique,
  nombre text,
  descripcion text,
  requiere_comentario boolean default true,
  activo boolean default true,
  orden int default 0,
  created_at timestamptz default now()
);

-- Seed del catálogo (idempotente)
insert into tipos_justificacion (clave, nombre, descripcion, requiere_comentario, activo, orden) values
  ('captura_sheets',      'Error de captura en Sheets/escaneo',    null, true, true, 1),
  ('if_cancelada',        'IF cancelada o reabierta en NetSuite',  null, true, true, 2),
  ('material_no_localizado','Material no localizado físicamente',  null, true, true, 3),
  ('cambio_ubicacion',    'Cambio de ubicación autorizado',        null, true, true, 4),
  ('falla_sistema',       'Falla de escáner/red/sistema',          null, true, true, 5),
  ('ajuste_inventario',   'Ajuste de inventario en curso',         null, true, true, 6),
  ('otro',                'Otro (requiere detalle)',               null, true, true, 7)
on conflict (clave) do nothing;

-- ============================================================
-- Discrepancias (una fila por huella única)
-- ============================================================
create table if not exists discrepancias (
  id bigserial primary key,
  fingerprint text unique not null,
  tipo text not null,
  if_tranid text,
  if_id text,
  if_so text,
  sucursal text,
  if_fecha text,
  sku text,
  lote text,
  id_lote text,
  placas_esperadas int,
  placas_escaneadas int,
  diferencia int,
  diff_m2 numeric,
  m2_esperados numeric,
  m2_escaneados numeric,
  es_cruzado boolean default false,
  datos jsonb,
  estado text not null default 'abierta'
    check (estado in ('abierta','en_revision','justificada')),
  caso_id bigint,
  primera_vista timestamptz default now(),
  ultima_vista timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_discrepancias_tipo     on discrepancias (tipo);
create index if not exists idx_discrepancias_sucursal on discrepancias (sucursal);
create index if not exists idx_discrepancias_estado   on discrepancias (estado);
create index if not exists idx_discrepancias_caso_id  on discrepancias (caso_id);

-- ============================================================
-- Casos (justificación enviada a revisión)
-- ============================================================
create table if not exists casos (
  id bigserial primary key,
  folio text unique not null,
  ubicacion_id bigint,
  sucursal text,
  tipo_justificacion_id bigint,
  justificacion text not null,
  estado text not null default 'pendiente_aprobacion'
    check (estado in ('pendiente_aprobacion','aprobado','rechazado')),
  creado_por bigint,
  enviado_at timestamptz,
  revisado_por bigint,
  revisado_at timestamptz,
  comentario_revision text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_casos_estado     on casos (estado);
create index if not exists idx_casos_sucursal   on casos (sucursal);
create index if not exists idx_casos_creado_por on casos (creado_por);

-- ============================================================
-- Eventos de caso (bitácora de auditoría)
-- ============================================================
create table if not exists caso_eventos (
  id bigserial primary key,
  caso_id bigint not null,
  discrepancia_id bigint,
  evento text not null,
  actor_id bigint,
  datos jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_caso_eventos_caso_id on caso_eventos (caso_id);

-- ============================================================
-- RLS habilitado sin políticas (acceso solo vía service role)
-- ============================================================
alter table tipos_justificacion enable row level security;
alter table discrepancias       enable row level security;
alter table casos               enable row level security;
alter table caso_eventos        enable row level security;

commit;
