-- ============================================================
-- 0008 · Bitácora de auditoría (WMS 2.0 · A1)
--
-- La tabla audit_logs YA EXISTE (diseño original del ER de
-- DOCUMENTATION.md: accion, tabla, registro_id, cambios, ip_address,
-- user_agent) pero está vacía y sin uso. Esta migración la EXTIENDE con:
--   - tipo_evento (login_exitoso | login_fallido | cambio | envio)
--   - email_intento (para logins fallidos)
--   - default/NOT NULL en created_at
--   - índices de consulta y RLS (solo service role, como el resto)
--   - usuarios.ultimo_login (visible en la UI de Usuarios, R2)
--
-- Retención de logs: INDEFINIDA (decidido en el plan WMS 2.0).
-- Idempotente: se puede re-ejecutar sin efectos adicionales.
-- ============================================================

BEGIN;

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS tipo_evento text NOT NULL
  CHECK (tipo_evento IN ('login_exitoso', 'login_fallido', 'cambio', 'envio'));

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS email_intento text;

ALTER TABLE audit_logs ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE audit_logs ALTER COLUMN created_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx  ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_tipo_evento_idx ON audit_logs (tipo_evento);
CREATE INDEX IF NOT EXISTS audit_logs_usuario_id_idx  ON audit_logs (usuario_id);

-- Sin políticas: acceso exclusivo del backend con service role
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Último inicio de sesión por usuario
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_login timestamptz;

COMMIT;
