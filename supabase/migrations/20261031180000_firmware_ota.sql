-- Zdalna aktualizacja programu ESP32 (OTA).
-- Administrator wgrywa na stronie (zakładka „Firmware” w inwestycji) skompilowany plik .bin
-- z numerem wersji, opcjonalnie z kopią źródła .ino. ESP32 co minutę pyta funkcją
-- device_check_firmware, czy jest nowsza wersja, a plik pobiera przez funkcję brzegową
-- device-firmware (sprawdza klucz urządzenia i czyta plik z prywatnego koszyka).

-- ───────────── Wersje programu ─────────────

create table public.firmware_releases (
    id            uuid primary key default gen_random_uuid(),
    device_id     uuid not null references public.devices (id) on delete cascade,
    version       int  not null check (version between 1 and 1000000),
    storage_path  text not null unique,
    file_name     text not null check (length(file_name) between 1 and 200),
    size_bytes    int  not null check (size_bytes > 0),
    source_path   text unique,
    source_name   text check (length(source_name) <= 200),
    notes         text check (length(notes) <= 500),
    author        text default (auth.jwt() ->> 'email'),
    created_at    timestamptz not null default now(),
    unique (device_id, version)
);

comment on table public.firmware_releases is 'Skompilowane programy (.bin) do zdalnej aktualizacji ESP32';

alter table public.firmware_releases enable row level security;
revoke all on public.firmware_releases from anon;
grant select, delete on public.firmware_releases to authenticated;
grant insert (device_id, version, storage_path, file_name, size_bytes, source_path, source_name, notes)
    on public.firmware_releases to authenticated;
create policy "administrator zarządza" on public.firmware_releases
    for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- Wersja zgłoszona przez urządzenie przy ostatnim sprawdzeniu (zapisuje tylko funkcja niżej).
alter table public.devices
    add column firmware_version    int,
    add column firmware_checked_at timestamptz;

-- ───────────── Prywatny koszyk na pliki ─────────────

-- Plik .bin zawiera wkompilowane dane Wi-Fi i klucze, więc dostęp ma tylko administrator.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('device-firmware', 'device-firmware', false, 4194304, array['application/octet-stream', 'text/plain'])
on conflict (id) do nothing;

create policy "administrator czyta firmware" on storage.objects
    for select to authenticated using (bucket_id = 'device-firmware' and (select public.is_admin()));
create policy "administrator dodaje firmware" on storage.objects
    for insert to authenticated with check (bucket_id = 'device-firmware' and (select public.is_admin()));
create policy "administrator usuwa firmware" on storage.objects
    for delete to authenticated using (bucket_id = 'device-firmware' and (select public.is_admin()));

-- ───────────── Sprawdzanie wersji przez ESP32 ─────────────

-- ESP32 podaje swój klucz i wersję, którą ma wkompilowaną.
-- Zwraca np. {"update": true, "version": 3, "size": 1123456}
-- albo {"update": false, "version": 2} (version = najnowsza wersja na stronie, null gdy brak).
create function public.device_check_firmware(p_key text, p_version int) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
    v_device uuid := public.device_from_key(p_key);
    v_rel    record;
begin
    update public.devices
    set firmware_version = p_version, firmware_checked_at = now()
    where id = v_device;

    select version, size_bytes into v_rel
    from public.firmware_releases
    where device_id = v_device
    order by version desc
    limit 1;

    if v_rel.version is not null and v_rel.version > coalesce(p_version, 0) then
        return jsonb_build_object('update', true, 'version', v_rel.version, 'size', v_rel.size_bytes);
    end if;
    return jsonb_build_object('update', false, 'version', v_rel.version);
end;
$$;

revoke execute on function public.device_check_firmware(text, int) from public;
grant execute on function public.device_check_firmware(text, int) to anon, authenticated;

-- Dla funkcji brzegowej device-firmware: ścieżka pliku danej wersji dla klucza urządzenia.
-- Wywołuje ją tylko service_role (funkcja brzegowa), nie przeglądarka ani ESP32.
create function public.device_firmware_file(p_key text, p_version int) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
    v_device uuid := public.device_from_key(p_key);
begin
    return (
        select jsonb_build_object('path', storage_path, 'size', size_bytes, 'version', version)
        from public.firmware_releases
        where device_id = v_device and version = p_version);
end;
$$;

revoke execute on function public.device_firmware_file(text, int) from public, anon, authenticated;
grant execute on function public.device_firmware_file(text, int) to service_role;
