-- Wiadomość serwera: krótki tekst ustawiany na stronie (zakładka „Wiadomość serwera”
-- w inwestycji), który ESP32 pobiera i wypisuje w monitorze portu szeregowego
-- po dotknięciu pinu dotykowego. Jedna wiadomość na inwestycję, wspólna dla jej urządzeń.

alter table public.investments
    add column server_message    text check (length(server_message) <= 500),
    add column server_message_at timestamptz;

comment on column public.investments.server_message is 'Wiadomość dla urządzeń ESP32 tej inwestycji (np. „Zachowaj ostrożność”)';
comment on column public.investments.server_message_at is 'Kiedy wiadomość serwera była ostatnio zmieniona';

-- Odczyt wiadomości przez ESP32 (klucz urządzenia, jak pozostałe funkcje device_*).
-- Zwraca np. {"message": "Zachowaj ostrożność", "updated_at": "2026-10-17T19:20:00+00:00"};
-- gdy wiadomości nie ma: {"message": "", "updated_at": null}.
create function public.device_get_message(p_key text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
    v_device uuid := public.device_from_key(p_key);
begin
    return (
        select jsonb_build_object(
                   'message', coalesce(i.server_message, ''),
                   'updated_at', i.server_message_at)
        from public.devices d
        join public.investments i on i.id = d.investment_id
        where d.id = v_device);
end;
$$;

revoke execute on function public.device_get_message(text) from public;
grant execute on function public.device_get_message(text) to anon, authenticated;
