-- Numer wersji programu ESP32 liczony automatycznie z daty i godziny kompilacji
-- w postaci RRMMDDGGMM (np. 2610311838 = 31.10.2026, 18:38). Nie mieści się w int,
-- więc wersje przechodzą na bigint. Stare małe numery (1, 2, …) dalej działają.

drop function public.device_check_firmware(text, int);
drop function public.device_firmware_file(text, int);

alter table public.firmware_releases
    drop constraint firmware_releases_version_check,
    alter column version type bigint,
    add constraint firmware_releases_version_check check (version between 1 and 9999999999);

alter table public.devices alter column firmware_version type bigint;

create function public.device_check_firmware(p_key text, p_version bigint) returns jsonb
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

revoke execute on function public.device_check_firmware(text, bigint) from public;
grant execute on function public.device_check_firmware(text, bigint) to anon, authenticated;

create function public.device_firmware_file(p_key text, p_version bigint) returns jsonb
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

revoke execute on function public.device_firmware_file(text, bigint) from public, anon, authenticated;
grant execute on function public.device_firmware_file(text, bigint) to service_role;
