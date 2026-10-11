-- Krok 2: tabele portalu ESP32.
--
-- Model danych:
--   inwestycja (np. "Stare Juchy") ze współrzędnymi i galerią zdjęć (do 5)
--     └─ urządzenia (produkt danego typu, np. AllinOne); te łączące się ze stroną
--        mają klucz PL-123456789, pozostałe (Lite4, aktywne, pasywne) są informacyjne
--          ├─ wybrane dane, które urządzenie ma wysyłać (device_metrics)
--          ├─ odczyty wysłane przez ESP32 (readings)
--          └─ polecenia/dane dla ESP32 (commands)
--
-- Reguły dostępu (RLS, uprawnienia) i funkcje dla ESP32 dodamy w kroku 3,
-- do tego czasu tabele nie są dostępne przez API.

-- ───────────── Słowniki: typy produktów i dane, które mogą wysyłać ─────────────

create table public.product_types (
    code        text primary key,
    name        text not null,
    connected   boolean not null,
    sort_order  int  not null default 0
);

comment on table public.product_types is 'Typy produktów; connected = łączy się ze stroną (ESP32)';
comment on column public.product_types.connected is 'false: urządzenie tylko informacyjne, bez klucza i danych';

insert into public.product_types (code, name, connected, sort_order) values
    ('allinone',         'AllinOne',                    true,  1),
    ('dale',             'Sterownik doświetlenia Dale', true,  2),
    ('lite4',            'Lite4',                       false, 3),
    ('active_lighting',  'Aktywne doświetlenie',        false, 4),
    ('passive_lighting', 'Pasywne doświetlenie',        false, 5),
    ('bikedale',         'Sterownik BikeDale',          true,  6);

-- Katalog danych (pomiarów), które może wysyłać dany typ produktu.
-- value_type: integer | number | text | enum (dla enum dozwolone wartości w allowed_values).
create table public.product_metrics (
    product_type    text not null references public.product_types (code) on delete cascade,
    key             text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
    label           text not null,
    unit            text,
    value_type      text not null check (value_type in ('integer', 'number', 'text', 'enum')),
    allowed_values  text[],
    sort_order      int  not null default 0,
    primary key (product_type, key),
    check ((value_type = 'enum') = (allowed_values is not null))
);

comment on table public.product_metrics is 'Dane, które może wysyłać dany typ produktu';

insert into public.product_metrics (product_type, key, label, unit, value_type, allowed_values, sort_order) values
    ('allinone', 'battery_voltage', 'Napięcie akumulatora',            'V',  'number',  null, 1),
    ('allinone', 'activations',     'Ilość uruchomień',                null, 'integer', null, 2),
    ('allinone', 'pedestrians',     'Ilość pieszych',                  null, 'integer', null, 3),

    ('dale',     'activations',     'Ilość uruchomień',                null, 'integer', null, 1),
    ('dale',     'lighting_hours',  'Godziny działania doświetlenia',  null, 'text',    null, 2),

    ('bikedale', 'activations',     'Ilość uruchomień',                null, 'integer', null, 1),
    ('bikedale', 'eyes_count',      'Ilość oczek',                     null, 'integer', null, 2),
    ('bikedale', 'light_mode',      'Tryb świecenia',                  null, 'enum',
        array['wszystkie', 'kaskada', 'stroboskop'], 3);
-- Lite4, aktywne i pasywne doświetlenie są na razie tylko informacyjne (bez danych).

-- ───────────── Inwestycje ─────────────

create table public.investments (
    id          uuid primary key default gen_random_uuid(),
    name        text not null check (length(name) between 1 and 200),
    notes       text,
    latitude    double precision check (latitude between -90 and 90),
    longitude   double precision check (longitude between -180 and 180),
    created_at  timestamptz not null default now(),
    check ((latitude is null) = (longitude is null))
);

comment on table public.investments is 'Inwestycje, np. "Stare Juchy"';
comment on column public.investments.latitude is 'Szerokość geograficzna (WGS84), pinezka na mapie';

-- Galeria inwestycji: do 5 zdjęć. Pliki leżą w Supabase Storage
-- (bucket utworzymy w kroku 3 razem z uprawnieniami), tu tylko ich ścieżki.
create table public.investment_photos (
    id             uuid primary key default gen_random_uuid(),
    investment_id  uuid not null references public.investments (id) on delete cascade,
    storage_path   text not null unique,
    caption        text check (length(caption) <= 300),
    sort_order     int  not null default 0,
    created_at     timestamptz not null default now()
);

create index investment_photos_investment_idx on public.investment_photos (investment_id, sort_order);

comment on table public.investment_photos is 'Zdjęcia inwestycji (maks. 5), pliki w Storage';

create function public.investment_photos_limit() returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if (select count(*) from public.investment_photos
        where investment_id = new.investment_id) >= 5 then
        raise exception 'Inwestycja może mieć maksymalnie 5 zdjęć';
    end if;
    return new;
end;
$$;

create trigger investment_photos_limit
    before insert on public.investment_photos
    for each row execute function public.investment_photos_limit();

-- ───────────── Urządzenia (produkty w inwestycji) ─────────────

-- Klucz urządzenia w formacie PL-123456789 (9 losowych cyfr z bezpiecznego generatora).
create function public.generate_device_key() returns text
language sql volatile
set search_path = ''
as $$
    select 'PL-' || lpad(
        ((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 15))::bit(60)::bigint)
            % 1000000000)::text,
        9, '0');
$$;

create table public.devices (
    id             uuid primary key default gen_random_uuid(),
    investment_id  uuid not null references public.investments (id) on delete cascade,
    product_type   text not null references public.product_types (code),
    name           text check (length(name) <= 200),
    device_key     text unique check (device_key ~ '^PL-[0-9]{9}$'),
    created_at     timestamptz not null default now(),
    last_seen      timestamptz,
    unique (id, product_type)
);

create index devices_investment_idx on public.devices (investment_id);

comment on table public.devices is 'Produkty (sterowniki ESP32) w inwestycjach';
comment on column public.devices.device_key is 'Klucz wpisywany do kodu ESP32; tylko dla typów connected';

-- Klucz nadajemy automatycznie urządzeniom łączącym się ze stroną,
-- urządzenia informacyjne (Lite4, pasywne) nie mają klucza.
create function public.devices_set_key() returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if tg_op = 'UPDATE' and new.product_type <> old.product_type then
        raise exception 'Typu produktu nie można zmienić, usuń urządzenie i dodaj je ponownie';
    end if;
    if (select connected from public.product_types where code = new.product_type) then
        if new.device_key is null then
            new.device_key := public.generate_device_key();
        end if;
    else
        new.device_key := null;
    end if;
    return new;
end;
$$;

create trigger devices_set_key
    before insert or update of product_type, device_key on public.devices
    for each row execute function public.devices_set_key();

-- Które dane mają przychodzić z danego urządzenia na stronę.
create table public.device_metrics (
    device_id     uuid not null,
    product_type  text not null,
    metric_key    text not null,
    enabled       boolean not null default true,
    primary key (device_id, metric_key),
    foreign key (device_id, product_type)
        references public.devices (id, product_type) on delete cascade,
    foreign key (product_type, metric_key)
        references public.product_metrics (product_type, key) on delete cascade
);

comment on table public.device_metrics is 'Wybór danych wysyłanych przez urządzenie (włącz/wyłącz)';

-- Nowe urządzenie od razu dostaje wszystkie dane swojego typu jako włączone.
create function public.devices_add_default_metrics() returns trigger
language plpgsql
set search_path = ''
as $$
begin
    insert into public.device_metrics (device_id, product_type, metric_key)
    select new.id, m.product_type, m.key
    from public.product_metrics m
    where m.product_type = new.product_type;
    return new;
end;
$$;

create trigger devices_add_default_metrics
    after insert on public.devices
    for each row execute function public.devices_add_default_metrics();

-- ───────────── Odczyty: ESP32 → strona ─────────────

create table public.readings (
    id          bigint generated always as identity primary key,
    device_id   uuid not null references public.devices (id) on delete cascade,
    created_at  timestamptz not null default now(),
    data        jsonb not null check (jsonb_typeof(data) = 'object')
);

create index readings_device_time_idx on public.readings (device_id, created_at desc);

comment on table public.readings is 'Odczyty z ESP32, np. {"battery_voltage": 12.6, "activations": 15}';

-- ───────────── Polecenia: strona → ESP32 ─────────────

create table public.commands (
    id           bigint generated always as identity primary key,
    device_id    uuid not null references public.devices (id) on delete cascade,
    created_at   timestamptz not null default now(),
    payload      jsonb not null check (octet_length(payload::text) <= 8192),
    status       text not null default 'new'
                 check (status in ('new', 'received', 'done', 'failed')),
    received_at  timestamptz,
    done_at      timestamptz,
    result       text check (length(result) <= 1000)
);

create index commands_device_pending_idx on public.commands (device_id, created_at)
    where status in ('new', 'received');

comment on table public.commands is 'Dane dla ESP32 (do 8 kB): new -> received -> done/failed';
