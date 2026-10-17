-- Wiadomość serwera może zmieniać tylko właściciel portalu (jak historia wejść).
-- Pozostali administratorzy dalej edytują inwestycje, ale bez tej wiadomości.

create function public.investments_guard_message() returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if (new.server_message is distinct from old.server_message
        or new.server_message_at is distinct from old.server_message_at)
       and (select auth.uid()) is not null  -- zmiany z panelu Supabase (bez zalogowanego użytkownika) przechodzą
       and not public.is_owner() then
        raise exception 'Wiadomość serwera może zmienić tylko właściciel portalu' using errcode = '42501';
    end if;
    return new;
end;
$$;

create trigger investments_guard_message
    before update on public.investments
    for each row execute function public.investments_guard_message();
