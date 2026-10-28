-- ============================================================
-- 0007 · Rol 'lider' + migración selectiva (WMS 2.0 · R1)
--
-- Modelo de roles decidido:
--   - lider:   ve Confronta (TODAS las ubicaciones) y gestiona/aprueba Casos.
--              Autoriza discrepancias por PIN (global). Migran los gerentes
--              que hoy aprueban casos.
--   - gerente: gerente de sucursal, SOLO lectura de Confronta de SU ubicación.
--              Sin PIN, sin Casos, sin Escáner. Su firma >10 placas se
--              conserva tal cual en el flujo del escáner.
--
-- Migración selectiva confirmada por el usuario (2026-10-28):
--   id 11  Alejandro Ramos   gerente -> lider
--   id 12  Marco Vargas      gerente -> lider
--   id 17  Aaron Santamaria  gerente -> gerente (visor de su ubicación)
--   (los demás usuarios se quedan como están)
--
-- Idempotente: se puede re-ejecutar sin efectos adicionales.
-- Nota: NO altera pin_hash (hoy ninguno de los tres tiene PIN).
-- ============================================================

BEGIN;

-- 1) Crear el rol 'lider' si no existe
INSERT INTO roles (clave, nombre, descripcion)
SELECT 'lider', 'Líder de Almacén',
       'Confronta (todas las ubicaciones), gestión y aprobación de casos, autorización por PIN'
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE clave = 'lider');

-- 2) Migración selectiva por id (conserva pin_hash)
UPDATE usuarios
SET rol_id = (SELECT id FROM roles WHERE clave = 'lider'),
    cargo  = 'lider'
WHERE id = 11;  -- Alejandro Ramos

UPDATE usuarios
SET rol_id = (SELECT id FROM roles WHERE clave = 'lider'),
    cargo  = 'lider'
WHERE id = 12;  -- Marco Vargas

UPDATE usuarios
SET rol_id = (SELECT id FROM roles WHERE clave = 'gerente'),
    cargo  = 'gerente'
WHERE id = 17;  -- Aaron Santamaria

-- 3) Normalizar cargo legacy divergente (corrige p.ej. cargo='admin' con
--    rol 'gerente' y cualquier otra diferencia restante)
UPDATE usuarios u
SET cargo = r.clave
FROM roles r
WHERE r.id = u.rol_id
  AND u.cargo IS DISTINCT FROM r.clave;

COMMIT;
