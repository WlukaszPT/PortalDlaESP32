-- Krok 7: zakładki „Serwis” (historia napraw) i „Dokumentacja” (pliki PDF) w inwestycji.

-- ───────────── Historia serwisu ─────────────

create table public.service_entries (
    id             uuid primary key default gen_random_uuid(),
    investment_id  uuid not null references public.investments (id) on delete cascade,
    entry_date     date not null default current_date,
    body           text not null check (length(btrim(body)) between 1 and 5000),
    author         text default (auth.jwt() ->> 'email'),
    created_at     timestamptz not null default now(),
    updated_at     timestamptz
);

create index service_entries_investment_idx on public.service_entries (investment_id, entry_date desc);

-- Data ostatniej zmiany wpisu ustawiana automatycznie.
create function public.service_entries_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    new.updated_at := now();
    return new;
end $$;
revoke execute on function public.service_entries_touch() from public, anon, authenticated;

create trigger service_entries_touch before update on public.service_entries
    for each row execute function public.service_entries_touch();

alter table public.service_entries enable row level security;
revoke all on public.service_entries from anon;
grant select, delete on public.service_entries to authenticated;
grant insert (investment_id, entry_date, body) on public.service_entries to authenticated;
grant update (entry_date, body) on public.service_entries to authenticated;
create policy "zalogowani zarządzają" on public.service_entries
    for all to authenticated using (true) with check (true);

-- ───────────── Dokumentacja PDF ─────────────

create table public.investment_documents (
    id             uuid primary key default gen_random_uuid(),
    investment_id  uuid not null references public.investments (id) on delete cascade,
    storage_path   text not null unique,
    file_name      text not null check (length(file_name) between 1 and 200),
    size_bytes     int  check (size_bytes >= 0),
    created_at     timestamptz not null default now()
);

create index investment_documents_investment_idx on public.investment_documents (investment_id, created_at);

alter table public.investment_documents enable row level security;
revoke all on public.investment_documents from anon;
grant select, delete on public.investment_documents to authenticated;
grant insert (investment_id, storage_path, file_name, size_bytes) on public.investment_documents to authenticated;
grant update (file_name) on public.investment_documents to authenticated;
create policy "zalogowani zarządzają" on public.investment_documents
    for all to authenticated using (true) with check (true);

-- Prywatny koszyk na pliki PDF (maks. 20 MB na plik).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('investment-docs', 'investment-docs', false, 20971520, array['application/pdf'])
on conflict (id) do nothing;

create policy "zalogowani czytają dokumenty" on storage.objects
    for select to authenticated using (bucket_id = 'investment-docs');
create policy "zalogowani dodają dokumenty" on storage.objects
    for insert to authenticated with check (bucket_id = 'investment-docs');
create policy "zalogowani usuwają dokumenty" on storage.objects
    for delete to authenticated using (bucket_id = 'investment-docs');
