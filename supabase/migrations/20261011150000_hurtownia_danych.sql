-- Hurtownia danych: ile miejsca zajmują dane w bazie i w plikach.
-- Funkcja działa z prawami wywołującego (zalogowany użytkownik i tak może czytać te tabele).

create function public.storage_stats() returns jsonb
language plpgsql stable set search_path = '' as $$
declare
    v_tables jsonb := '[]'::jsonb;
    v_rows   bigint;
    t        record;
begin
    for t in
        select c.oid, c.relname
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
    loop
        begin
            execute format('select count(*) from public.%I', t.relname) into v_rows;
        exception when insufficient_privilege then
            v_rows := null;
        end;
        v_tables := v_tables || jsonb_build_object(
            'name', t.relname,
            'rows', v_rows,
            'bytes', pg_catalog.pg_total_relation_size(t.oid));
    end loop;

    return jsonb_build_object(
        'db_bytes', pg_catalog.pg_database_size(pg_catalog.current_database()),
        'tables', v_tables,
        'buckets', coalesce((
            select jsonb_agg(jsonb_build_object('bucket', bucket_id, 'files', files, 'bytes', bytes))
            from (
                select bucket_id, count(*) as files,
                       coalesce(sum((metadata ->> 'size')::bigint), 0) as bytes
                from storage.objects
                group by bucket_id
            ) b
        ), '[]'::jsonb),
        'readings', (
            select jsonb_build_object(
                'count', count(*),
                'first', min(created_at),
                'last', max(created_at),
                'last_24h', count(*) filter (where created_at > now() - interval '24 hours'))
            from public.readings
        ));
end $$;

revoke execute on function public.storage_stats() from public, anon;
grant execute on function public.storage_stats() to authenticated;
