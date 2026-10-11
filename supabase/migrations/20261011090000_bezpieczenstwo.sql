-- Krok 3: zabezpieczenia i dostęp.
--
-- Kto ma dostęp:
--   * zalogowani użytkownicy strony (rola authenticated): zarządzają inwestycjami,
--     urządzeniami, zdjęciami, wyborem danych i poleceniami, czytają odczyty.
--     Rejestracja nowych kont jest wyłączona w ustawieniach Supabase, konta
--     zakłada się ręcznie w panelu (Authentication -> Users).
--   * ESP32 (rola anon, publiczny klucz anon): NIE ma dostępu do tabel. Może tylko
--     wywołać funkcje device_* podając swój klucz PL-123456789.

-- ───────────── Funkcje pomocnicze z kroku 2 ─────────────

-- Wyzwalacze działają z uprawnieniami właściciela, więc użytkownik strony nie musi
-- mieć prawa do ręcznego wstawiania kluczy ani wierszy device_metrics.
alter function public.devices_set_key() security definer;
alter function public.devices_add_default_metrics() security definer;

revoke execute on function
    public.generate_device_key(),
    public.devices_set_key(),
    public.devices_add_default_metrics(),
    public.investment_photos_limit()
from public, anon, authenticated;

-- Funkcja Supabase z opcji "automatic RLS" nie powinna być wywoływalna przez API.
do $$
begin
    if to_regprocedure('public.rls_auto_enable()') is not null then
        revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
    end if;
end;
$$;

-- ───────────── RLS na wszystkich tabelach ─────────────

alter table public.product_types     enable row level security;
alter table public.product_metrics   enable row level security;
alter table public.investments       enable row level security;
alter table public.investment_photos enable row level security;
alter table public.devices           enable row level security;
alter table public.device_metrics    enable row level security;
alter table public.readings          enable row level security;
alter table public.commands          enable row level security;

-- Na wszelki wypadek: anon nie ma żadnych praw do tabel.
revoke all on all tables in schema public from anon;

-- ───────────── Uprawnienia zalogowanych użytkowników ─────────────

-- Słowniki: tylko odczyt.
grant select on public.product_types, public.product_metrics to authenticated;
create policy "zalogowani czytają" on public.product_types   for select to authenticated using (true);
create policy "zalogowani czytają" on public.product_metrics for select to authenticated using (true);

-- Inwestycje i zdjęcia: pełna obsługa.
grant select, insert, update, delete on public.investments, public.investment_photos to authenticated;
create policy "zalogowani zarządzają" on public.investments
    for all to authenticated using (true) with check (true);
create policy "zalogowani zarządzają" on public.investment_photos
    for all to authenticated using (true) with check (true);

-- Urządzenia: klucz i last_seen ustawia baza, użytkownik zmienia tylko nazwę i inwestycję.
grant select, delete on public.devices to authenticated;
grant insert (investment_id, product_type, name) on public.devices to authenticated;
grant update (investment_id, name) on public.devices to authenticated;
create policy "zalogowani zarządzają" on public.devices
    for all to authenticated using (true) with check (true);

-- Wybór danych: tylko włączanie/wyłączanie (wiersze tworzy baza przy dodaniu urządzenia).
grant select on public.device_metrics to authenticated;
grant update (enabled) on public.device_metrics to authenticated;
create policy "zalogowani czytają" on public.device_metrics
    for select to authenticated using (true);
create policy "zalogowani włączają dane" on public.device_metrics
    for update to authenticated using (true) with check (true);

-- Odczyty: podgląd i czyszczenie, dopisuje je tylko ESP32 przez funkcję.
grant select, delete on public.readings to authenticated;
create policy "zalogowani czytają" on public.readings
    for select to authenticated using (true);
create policy "zalogowani usuwają" on public.readings
    for delete to authenticated using (true);

-- Polecenia: tworzenie (tylko dla urządzeń łączących się ze stroną), podgląd, usuwanie.
grant select, delete on public.commands to authenticated;
grant insert (device_id, payload) on public.commands to authenticated;
create policy "zalogowani czytają" on public.commands
    for select to authenticated using (true);
create policy "zalogowani usuwają" on public.commands
    for delete to authenticated using (true);
create policy "zalogowani wysyłają do połączonych urządzeń" on public.commands
    for insert to authenticated
    with check (exists (
        select 1
        from public.devices d
        join public.product_types t on t.code = d.product_type
        where d.id = device_id and t.connected
    ));

-- ───────────── Zdjęcia w Supabase Storage ─────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('investment-photos', 'investment-photos', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "zalogowani czytają zdjęcia" on storage.objects
    for select to authenticated using (bucket_id = 'investment-photos');
create policy "zalogowani dodają zdjęcia" on storage.objects
    for insert to authenticated with check (bucket_id = 'investment-photos');
create policy "zalogowani zmieniają zdjęcia" on storage.objects
    for update to authenticated using (bucket_id = 'investment-photos');
create policy "zalogowani usuwają zdjęcia" on storage.objects
    for delete to authenticated using (bucket_id = 'investment-photos');

-- ───────────── Funkcje dla ESP32 ─────────────
-- Wywołanie z ESP32: POST {SUPABASE_URL}/rest/v1/rpc/<nazwa_funkcji>
-- z nagłówkiem apikey: <klucz anon> i JSON-em z parametrami, np. {"p_key": "PL-123456789"}.

-- Znajduje urządzenie łączące się ze stroną po kluczu i zapisuje, że było online.
create function public.device_from_key(p_key text) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
    v_id uuid;
begin
    update public.devices d
    set last_seen = now()
    from public.product_types t
    where d.device_key = p_key
      and t.code = d.product_type
      and t.connected
    returning d.id into v_id;

    if v_id is null then
        raise exception 'Nieznany klucz urządzenia' using errcode = '28000';
    end if;
    return v_id;
end;
$$;

revoke execute on function public.device_from_key(text) from public, anon, authenticated;

-- Konfiguracja urządzenia: jakie dane ma wysyłać (włączone na stronie).
-- Zwraca np. {"metrics": [{"key": "battery_voltage", "type": "number"}, ...]}
create function public.device_get_config(p_key text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
    v_device uuid := public.device_from_key(p_key);
begin
    return jsonb_build_object('metrics', coalesce((
        select jsonb_agg(jsonb_build_object(
                   'key', m.key,
                   'type', m.value_type,
                   'allowed', to_jsonb(m.allowed_values))
               order by m.sort_order)
        from public.device_metrics dm
        join public.product_metrics m
          on m.product_type = dm.product_type and m.key = dm.metric_key
        where dm.device_id = v_device and dm.enabled
    ), '[]'::jsonb));
end;
$$;

-- Zapis odczytu. Przyjmuje tylko dane włączone dla urządzenia i o poprawnym typie,
-- resztę odrzuca. Np. p_data = {"battery_voltage": 12.6, "activations": 15}
-- Zwraca {"accepted": [...], "rejected": [...]}.
create function public.device_push_reading(p_key text, p_data jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
    v_device   uuid := public.device_from_key(p_key);
    v_clean    jsonb := '{}'::jsonb;
    v_rejected text[] := '{}';
    v_item     record;
    v_metric   public.product_metrics%rowtype;
    v_ok       boolean;
begin
    if p_data is null or jsonb_typeof(p_data) <> 'object' then
        raise exception 'Dane muszą być obiektem JSON' using errcode = '22023';
    end if;
    if octet_length(p_data::text) > 4096 then
        raise exception 'Za duży odczyt (maks. 4 kB)' using errcode = '22023';
    end if;
    -- Ochrona przed zalaniem bazy: najwyżej jeden odczyt na 10 sekund.
    if exists (select 1 from public.readings
               where device_id = v_device and created_at > now() - interval '10 seconds') then
        raise exception 'Za często, odczekaj 10 sekund' using errcode = '54000';
    end if;

    for v_item in select key, value from jsonb_each(p_data) loop
        select m.* into v_metric
        from public.device_metrics dm
        join public.product_metrics m
          on m.product_type = dm.product_type and m.key = dm.metric_key
        where dm.device_id = v_device and dm.enabled and dm.metric_key = v_item.key;

        v_ok := found and case v_metric.value_type
            when 'integer' then jsonb_typeof(v_item.value) = 'number'
                                and (v_item.value #>> '{}')::numeric % 1 = 0
            when 'number'  then jsonb_typeof(v_item.value) = 'number'
            when 'text'    then jsonb_typeof(v_item.value) = 'string'
                                and length(v_item.value #>> '{}') <= 200
            when 'enum'    then jsonb_typeof(v_item.value) = 'string'
                                and (v_item.value #>> '{}') = any (v_metric.allowed_values)
            else false
        end;

        if v_ok then
            v_clean := v_clean || jsonb_build_object(v_item.key, v_item.value);
        else
            v_rejected := v_rejected || v_item.key;
        end if;
    end loop;

    if v_clean <> '{}'::jsonb then
        insert into public.readings (device_id, data) values (v_device, v_clean);
    end if;

    return jsonb_build_object(
        'accepted', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(v_clean) k),
        'rejected', to_jsonb(v_rejected));
end;
$$;

-- Odbiór nowych poleceń/danych ze strony. Zwrócone polecenia dostają status "received".
-- Zwraca [{"id": 1, "payload": {...}, "created_at": "..."}, ...]
create function public.device_fetch_commands(p_key text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
    v_device uuid := public.device_from_key(p_key);
    v_result jsonb;
begin
    with picked as (
        update public.commands c
        set status = 'received', received_at = now()
        where c.id in (
            select id from public.commands
            where device_id = v_device and status = 'new'
            order by created_at
            limit 10
            for update skip locked)
        returning c.id, c.payload, c.created_at
    )
    select coalesce(jsonb_agg(jsonb_build_object(
               'id', id, 'payload', payload, 'created_at', created_at)
           order by created_at), '[]'::jsonb)
    into v_result
    from picked;

    return v_result;
end;
$$;

-- Potwierdzenie wykonania polecenia: p_ok = true (wykonane) / false (błąd).
create function public.device_ack_command(
    p_key text, p_command_id bigint, p_ok boolean, p_result text default null
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
    v_device uuid := public.device_from_key(p_key);
begin
    update public.commands
    set status  = case when p_ok then 'done' else 'failed' end,
        done_at = now(),
        result  = left(p_result, 1000)
    where id = p_command_id
      and device_id = v_device
      and status in ('new', 'received');

    if not found then
        raise exception 'Nie ma takiego oczekującego polecenia' using errcode = 'P0002';
    end if;
end;
$$;

revoke execute on function
    public.device_get_config(text),
    public.device_push_reading(text, jsonb),
    public.device_fetch_commands(text),
    public.device_ack_command(text, bigint, boolean, text)
from public;

grant execute on function
    public.device_get_config(text),
    public.device_push_reading(text, jsonb),
    public.device_fetch_commands(text),
    public.device_ack_command(text, bigint, boolean, text)
to anon, authenticated;
