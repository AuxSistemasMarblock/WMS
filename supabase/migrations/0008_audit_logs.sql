-- ============================================================
-- 0008 · Bitácora de auditoría (WMS 2.0 · A1)
--
-- Tabla audit_logs: inicios de sesión (exitosos y fallidos), cambios y
-- envíos. Retención INDEFINIDA (decidido en el plan WMS 2.0).
-- RLS habilitado sin políticas: solo el backend (service role) escribe/lee,
-- igual que el resto de tablas del proyecto.
--
-- Idempotente: se puede re-ejecutar sin efectos adicionales.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS audit_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id    bigint REFERENCES usuarios(id),
  email_intento text,
  tipo_evento   text NOT NULL CHECK (tipo_evento IN ('login_exitoso', 'login_fallido', 'cambio', 'envio')),
  accion        text NOT NULL,
  entidad       text,
  entidad_id    text,
  detalle       jsonb,
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx  ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_tipo_evento_idx ON audit_logs (tipo_evento);
CREATE INDEX IF NOT EXISTS audit_logs_usuario_id_idx  ON audit_logs (usuario_id);

-- Sin políticas: acceso exclusivo del backend con service role
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Último inicio de sesión por usuario (visible en la UI de Usuarios, R2)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_login timestamptz;

COMMIT;
