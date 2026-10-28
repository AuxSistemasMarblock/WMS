-- ============================================================
-- 0010 · Fix de zona horaria en timestamps (WMS 2.0 · hotfix)
--
-- Las columnas `timestamp without time zone` guardaban la hora UTC en "naive"
-- (sin zona) y el navegador las interpretaba como hora local: el visor de
-- Auditoría mostraba horas desfasadas respecto a CDMX.
--
-- Conversión a `timestamp with time zone` interpretando los valores
-- existentes como UTC (que es lo que realmente eran). Las tablas de casos/
-- discrepancias ya eran timestamptz y no se tocan.
--
-- Idempotente: solo convierte si la columna aún es `timestamp without
-- time zone` (re-ejecutar no vuelve a interpretar).
-- ============================================================

DO $$
DECLARE
  reg record;
BEGIN
  FOR reg IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'timestamp without time zone'
      AND (table_name, column_name) IN (
        ('audit_logs', 'created_at'),
        ('firmas', 'created_at'), ('firmas', 'fecha_firma'), ('firmas', 'updated_at'),
        ('ubicaciones', 'created_at'), ('ubicaciones', 'updated_at'),
        ('usuarios', 'created_at'), ('usuarios', 'updated_at')
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE ''UTC''',
      reg.table_name, reg.column_name, reg.column_name
    );
  END LOOP;
END $$;
