-- Stałe połączenie ESP32 ↔ strona (Supabase Realtime, kanał Broadcast).
--
-- ESP32 trzyma otwarte połączenie WebSocket z Realtime i nasłuchuje na swoim kanale.
-- Gdy administrator kliknie na stronie „Uruchom przejście” / „Wyłącz przejście”, w tabeli
-- commands pojawia się wiersz, a wyzwalacz od razu wysyła go na kanał urządzenia,
-- więc sterownik reaguje w ułamku sekundy, bez czekania na kolejne odpytanie bazy.
--
-- Bezpieczeństwo: nazwa kanału to losowy identyfikator przechowywany w osobnej tabeli
-- bez żadnych uprawnień dla strony (nie widać go nawet zalogowanym). ESP32 dostaje go
-- wyłącznie przez funkcję device_realtime_topic(klucz), tak jak inne funkcje device_*.
-- Polecenie i tak jest potem potwierdzane przez device_fetch_commands / device_ack_command.

create table public.device_channels (
    device_id  uuid primary key references public.devices (id) on delete cascade,
    topic      uuid not null unique default gen_random_uuid()
);

alter table public.device_channels enable row level security;
revoke all on public.device_channels from anon, authenticated;

comment on table public.device_channels is 'Tajna nazwa kanału Realtime każdego ESP32 (tylko dla funkcji device_*)';

-- Kanał w Realtime: "cloudea-<uuid>".
create function public.device_channel_name(p_device uuid) returns text
language plpgsql security definer
set search_path = ''
as $$
declare
    v_topic uuid;
begin
    insert into public.device_channels (device_id) values (p_device)
    on conflict (device_id) do nothing;
    select topic into v_topic from public.device_channels where device_id = p_device;
    return 'cloudea-' || v_topic::text;
end;
$$;

revoke execute on function public.device_channel_name(uuid) from public, anon, authenticated;

-- ESP32 pyta o nazwę swojego kanału (klucz urządzenia, jak pozostałe funkcje device_*).
-- Zwraca np. {"topic": "cloudea-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"}.
create function public.device_realtime_topic(p_key text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
    v_device uuid := public.device_from_key(p_key);
begin
    return jsonb_build_object('topic', public.device_channel_name(v_device));
end;
$$;

revoke execute on function public.device_realtime_topic(text) from public;
grant execute on function public.device_realtime_topic(text) to anon, authenticated;

-- Nowe polecenie → natychmiast na kanał urządzenia (zdarzenie "command").
-- Błąd Realtime nie blokuje zapisu polecenia: ESP32 i tak odbierze je przy odpytaniu bazy.
create function public.commands_broadcast() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
    begin
        perform realtime.send(
            jsonb_build_object('id', new.id, 'payload', new.payload, 'created_at', new.created_at),
            'command',
            public.device_channel_name(new.device_id),
            false);
    exception when others then
        raise warning 'commands_broadcast: %', sqlerrm;
    end;
    return new;
end;
$$;

revoke execute on function public.commands_broadcast() from public, anon, authenticated;

create trigger commands_broadcast
    after insert on public.commands
    for each row execute function public.commands_broadcast();
