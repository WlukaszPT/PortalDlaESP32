-- Koszt prac przy wpisie serwisowym (zł, opcjonalnie). Suma pokazywana przy historii serwisu.
alter table public.service_entries
    add column cost numeric(12, 2) check (cost >= 0);

grant insert (cost), update (cost) on public.service_entries to authenticated;
