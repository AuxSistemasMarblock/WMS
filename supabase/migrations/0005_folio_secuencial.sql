-- 0005_folio_secuencial.sql
-- Se regresa al folio anual secuencial `YYYY-NNNN` (p. ej. 2026-0001). Un caso
-- agrupa N IFs, así que el `if_tranid` no sirve como identificador único.
--
-- Idempotente: `create or replace` + backfill que solo toca folios que no
-- cumplen el formato `^\d{4}-\d+$`.

begin;

create or replace function public.crear_caso(
  p_discrepancia_ids bigint[],
  p_tipo_justificacion_id bigint,
  p_justificacion text,
  p_ubicacion_id bigint default null,
  p_sucursal text default null,
  p_creado_por bigint default null
)
returns public.casos
language plpgsql
set search_path = ''
as $$
declare
  v_anio int := extract(year from now())::int;
  v_prefijo text := v_anio::text || '-';
  v_seq int;
  v_folio text;
  v_caso public.casos;
  v_faltantes int;
  v_no_abiertas bigint[];
  v_sucursal text;
begin
  if p_discrepancia_ids is null or array_length(p_discrepancia_ids, 1) is null then
    raise exception 'discrepancia_ids es requerido' using errcode = '22023';
  end if;
  if p_justificacion is null or btrim(p_justificacion) = '' then
    raise exception 'justificacion es requerida' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.tipos_justificacion
     where id = p_tipo_justificacion_id and activo is true
  ) then
    raise exception 'tipo_justificacion_id inválido o inactivo' using errcode = '22023';
  end if;

  select count(*) into v_faltantes
    from unnest(p_discrepancia_ids) x
   where not exists (select 1 from public.discrepancias d where d.id = x);
  if v_faltantes > 0 then
    raise exception 'discrepancias no encontradas: %', v_faltantes using errcode = '22023';
  end if;

  select array_agg(d.id) into v_no_abiertas
    from public.discrepancias d
   where d.id = any(p_discrepancia_ids) and d.estado <> 'abierta';
  if v_no_abiertas is not null then
    raise exception 'discrepancias que no están abiertas: %', v_no_abiertas using errcode = '22023';
  end if;

  v_sucursal := coalesce(
    p_sucursal,
    (select d.sucursal from public.discrepancias d where d.id = p_discrepancia_ids[1])
  );

  -- Folio anual secuencial: YYYY-NNNN, serializado con advisory lock.
  perform pg_advisory_xact_lock(hashtext('casos_folio_' || v_anio));
  select coalesce(max((substring(folio from '[0-9]+$'))::int), 0) + 1
    into v_seq
    from public.casos
   where folio ~ ('^' || v_prefijo || '[0-9]+$');
  v_folio := v_prefijo || lpad(v_seq::text, 4, '0');

  insert into public.casos (
    folio, ubicacion_id, sucursal, tipo_justificacion_id,
    justificacion, estado, creado_por, enviado_at
  ) values (
    v_folio, p_ubicacion_id, v_sucursal, p_tipo_justificacion_id,
    p_justificacion, 'pendiente_aprobacion', p_creado_por, now()
  )
  returning * into v_caso;

  update public.discrepancias
     set estado = 'en_revision', caso_id = v_caso.id, updated_at = now()
   where id = any(p_discrepancia_ids);

  insert into public.caso_eventos (caso_id, evento, actor_id, datos)
  values
    (v_caso.id, 'caso_creado', p_creado_por,
      jsonb_build_object('folio', v_folio, 'discrepancia_ids', p_discrepancia_ids)),
    (v_caso.id, 'justificacion_enviada', p_creado_por,
      jsonb_build_object('tipo_justificacion_id', p_tipo_justificacion_id, 'justificacion', p_justificacion));

  return v_caso;
end;
$$;

revoke all on function public.crear_caso(bigint[], bigint, text, bigint, text, bigint) from public;
revoke all on function public.crear_caso(bigint[], bigint, text, bigint, text, bigint) from anon;
revoke all on function public.crear_caso(bigint[], bigint, text, bigint, text, bigint) from authenticated;
grant execute on function public.crear_caso(bigint[], bigint, text, bigint, text, bigint) to service_role;

-- Backfill: los casos con folio que no es `YYYY-NNNN` reciben el siguiente
-- secuencial del año en curso, en orden de creación.
with base as (
  select coalesce(max((substring(folio from '[0-9]+$'))::int), 0) as n
    from public.casos
   where folio ~ '^[0-9]{4}-[0-9]+$'
),
ordenados as (
  select c.id, row_number() over (order by c.created_at, c.id) as rn
    from public.casos c
   where c.folio !~ '^[0-9]{4}-[0-9]+$'
)
update public.casos c
   set folio = to_char(now(), 'YYYY') || '-' || lpad(((select n from base) + o.rn)::text, 4, '0')
  from ordenados o
 where c.id = o.id;

commit;
