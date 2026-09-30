-- 0006_autorizaciones_confronta_pin.sql
-- Añade soporte para PIN de autorización de jefes de almacén y registro de auditoría
-- de confrontas autorizadas con discrepancias.
--
-- Idempotente: sentencias con IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
--
-- Seguridad: RLS habilitado sin políticas (acceso exclusivo por service role desde backend).

begin;

-- ============================================================
-- 1. PIN hasheado en tabla usuarios
-- ============================================================
alter table usuarios
  add column if not exists pin_hash text;

comment on column usuarios.pin_hash is
  'Hash bcrypt del PIN numérico (4-6 dígitos) para autorizaciones en escáner';

-- ============================================================
-- 2. Tabla de auditoría: autorizaciones de confronta
-- ============================================================
create table if not exists autorizaciones_confronta (
  id bigserial primary key,
  if_tranid text not null,
  usuario_auxiliar_id bigint references usuarios (id) on delete set null,
  usuario_jefe_id bigint references usuarios (id) on delete set null,
  ubicacion_id bigint references ubicaciones (id) on delete set null,
  discrepancias jsonb not null default '[]'::jsonb,
  created_at timestamptz default now()
);

comment on table autorizaciones_confronta is
  'Bitácora de autorizaciones emitidas por Jefes de Almacén ante discrepancias en la confronta del escáner';

create index if not exists idx_aut_confronta_if on autorizaciones_confronta (if_tranid);
create index if not exists idx_aut_confronta_fecha on autorizaciones_confronta (created_at desc);
create index if not exists idx_aut_confronta_jefe on autorizaciones_confronta (usuario_jefe_id);
create index if not exists idx_aut_confronta_ubicacion on autorizaciones_confronta (ubicacion_id);

-- RLS: el backend se conecta con service_role (bypassa RLS).
alter table autorizaciones_confronta enable row level security;

commit;
