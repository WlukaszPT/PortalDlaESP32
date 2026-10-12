-- Odczyty do wykresów z całego wybranego okresu, równomiernie rozłożone w czasie.
-- Gdy odczytów jest więcej niż p_max, zwracamy co n-ty (zawsze z pierwszym i ostatnim),
-- żeby wykres tygodnia czy miesiąca nie kończył się na 1000 najnowszych odczytów.
-- SECURITY INVOKER: obowiązują zwykłe uprawnienia (RLS) do tabeli readings.
create function public.readings_sample(
    p_device_id uuid,
    p_from timestamptz default null,
    p_to timestamptz default null,
    p_max integer default 2000
)
returns table (created_at timestamptz, data jsonb, total bigint)
language sql stable security invoker set search_path = '' as $$
    with r as (
        select r.created_at, r.data,
               row_number() over (order by r.created_at) as rn,
               count(*) over () as n
        from public.readings r
        where r.device_id = p_device_id
          and (p_from is null or r.created_at >= p_from)
          and (p_to is null or r.created_at < p_to)
    ), k as (
        select greatest(1, ceil(max(n)::numeric / least(greatest(coalesce(p_max, 2000), 2), 5000)))::bigint as step from r
    )
    select r.created_at, r.data, r.n
    from r, k
    where (r.rn - 1) % k.step = 0 or r.rn = r.n
    order by r.created_at;
$$;
revoke execute on function public.readings_sample(uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.readings_sample(uuid, timestamptz, timestamptz, integer) to authenticated;
