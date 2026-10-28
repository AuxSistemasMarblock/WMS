-- ============================================================
-- 0009 · 2FA TOTP para Admin (WMS 2.0 · S2)
--
-- Columnas en usuarios:
--   - totp_secret:      secreto TOTP cifrado (AES-256-GCM, clave derivada
--                       de JWT_SECRET) — solo el backend puede descifrarlo
--   - totp_activo:      true cuando el usuario confirma su primer código
--   - totp_backup_codes: hashes bcrypt de los códigos de respaldo (10)
--
-- El 2FA es OBLIGATORIO para el rol admin (enrolamiento forzado al primer
-- login tras el rollout). Los demás roles no tienen 2FA.
-- Idempotente: se puede re-ejecutar sin efectos adicionales.
-- ============================================================

BEGIN;

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_activo boolean NOT NULL DEFAULT false;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_backup_codes text[];

COMMIT;
