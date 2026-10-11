-- Krok 2: tabele portalu ESP32.
-- Reguły dostępu (RLS, uprawnienia) i funkcje dla ESP32 dodamy w kroku 3,
-- do tego czasu tabele nie są dostępne przez API.

-- Urządzenia (ESP32). Klucz urządzenia przechowujemy tylko jako skrót SHA-256,
-- więc nawet wyciek bazy nie ujawnia samych kluczy.
create table public.devices (
    id               uuid primary key default gen_random_uuid(),
    name             text not null check (length(name) between 1 and 100),
    device_key_hash  bytea not null unique,
    created_at       timestamptz not null default now(),
    last_seen        timestamptz
);

comment on table public.devices is 'Urządzenia ESP32 połączone z portalem';
comment on column public.devices.device_key_hash is 'sha256(klucz urządzenia), klucz jawny zna tylko ESP32';

-- Odczyty wysyłane przez ESP32 (kierunek ESP32 -> strona).
create table public.readings (
    id          bigint generated always as identity primary key,
    device_id   uuid not null references public.devices (id) on delete cascade,
    created_at  timestamptz not null default now(),
    data        jsonb not null
);

create index readings_device_time_idx on public.readings (device_id, created_at desc);

comment on table public.readings is 'Odczyty wysłane przez ESP32, dowolny JSON';

-- Polecenia i małe paczki danych dla ESP32 (kierunek strona -> ESP32).
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
