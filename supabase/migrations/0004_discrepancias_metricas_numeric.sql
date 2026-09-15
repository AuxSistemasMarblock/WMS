-- 0004_discrepancias_metricas_numeric.sql
-- Las métricas de placas de una discrepancia pueden ser fraccionarias: la
-- confronta representa las "medias placas" como .5 (p. ej. 2.5 placas). Las
-- columnas eran `int`, así que el upsert de syncDiscrepancias fallaba con:
--   invalid input syntax for type integer: "0.5"
-- Se migran placas_esperadas, placas_escaneadas y diferencia a numeric(10,2)
-- para preservar esa precisión.
--
-- Idempotente: solo altera si placas_esperadas sigue siendo integer.

begin;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'discrepancias'
      and column_name = 'placas_esperadas'
      and data_type = 'integer'
  ) then
    alter table discrepancias
      alter column placas_esperadas  type numeric(10,2) using placas_esperadas::numeric,
      alter column placas_escaneadas type numeric(10,2) using placas_escaneadas::numeric,
      alter column diferencia        type numeric(10,2) using diferencia::numeric;
  end if;
end $$;

commit;
