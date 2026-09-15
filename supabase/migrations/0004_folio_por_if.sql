-- 0004_folio_por_if.sql
-- El folio generado `CASO-YYYY-NNNN` no es útil para el usuario, que identifica
-- el caso por su IF. Ahora el folio es el `if_tranid` de la primera discrepancia
-- del caso (p. ej. "IF15958"). Si esa IF ya tuviera un caso (errores posteriores)
-- se agrega un sufijo numérico ("IF15958-2") para respetar la unicidad.
--
-- Idempotente: `create or replace` y el backfill solo actualiza cuando no hay
-- colisión de folio.

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
  v_folio text;
  v_base text;
  v_sufijo int := 0;
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

  -- Folio = IF de la primera discrepancia (con sufijo si ya existe).
  select nullif(btrim(d.if_tranid), '')
    into v_base
    from public.discrepancias d
   where d.id = p_discrepancia_ids[1];
  v_base := coalesce(v_base, 'IF');

  perform pg_advisory_xact_lock(hashtext('casos_folio_' || v_base));
  v_folio := v_base;
  while exists (select 1 from public.casos c where c.folio = v_folio) loop
    v_sufijo := v_sufijo + 1;
    v_folio := v_base || '-' || v_sufijo;
  end loop;

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

-- Backfill de casos existentes: folio = IF de su primera discrepancia (solo si
-- no colisiona con otro folio).
with primera as (
  select distinct on (d.caso_id) d.caso_id, nullif(btrim(d.if_tranid), '') as if_tranid
    from public.discrepancias d
   where d.caso_id is not null
   order by d.caso_id, d.id
)
update public.casos c
   set folio = p.if_tranid
  from primera p
 where c.id = p.caso_id
   and p.if_tranid is not null
   and c.folio <> p.if_tranid
   and not exists (select 1 from public.casos c2 where c2.folio = p.if_tranid and c2.id <> c.id);

commit;
