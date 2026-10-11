-- Użytkownicy portalu i role: administrator (wszystko) oraz użytkownik (podgląd + serwis, zdjęcia, dokumenty).
-- Uprawnienia egzekwuje baza (RLS), strona tylko ukrywa niedostępne przyciski.

-- ───────────── Profile użytkowników ─────────────

create table public.profiles (
    user_id    uuid primary key references auth.users (id) on delete cascade,
    email      text not null,
    full_name  text check (length(full_name) <= 120),
    role       text not null default 'user' check (role in ('admin', 'user')),
    created_at timestamptz not null default now()
);

-- Każde nowe konto w Supabase Auth dostaje profil z rolą „użytkownik”.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    insert into public.profiles (user_id, email, full_name)
    values (new.id, coalesce(new.email, ''), nullif(new.raw_user_meta_data ->> 'full_name', ''))
    on conflict (user_id) do nothing;
    return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created after insert on auth.users
    for each row execute function public.handle_new_user();

-- Istniejące konta (zakładane ręcznie przed wprowadzeniem ról) zostają administratorami.
insert into public.profiles (user_id, email, role)
select id, coalesce(email, ''), 'admin' from auth.users
on conflict (user_id) do nothing;

-- Czy zalogowana osoba jest administratorem. Działa z prawami wywołującego:
-- każdy zalogowany może czytać profile, więc nie potrzeba SECURITY DEFINER.
create function public.is_admin() returns boolean
language sql stable set search_path = '' as $$
    select exists (
        select 1 from public.profiles
        where user_id = (select auth.uid()) and role = 'admin'
    );
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Nie można odebrać roli ostatniemu administratorowi.
create function public.profiles_keep_admin() returns trigger
language plpgsql set search_path = '' as $$
begin
    if old.role = 'admin' and new.role <> 'admin'
       and (select count(*) from public.profiles where role = 'admin') <= 1 then
        raise exception 'Musi zostać co najmniej jeden administrator.';
    end if;
    return new;
end $$;
revoke execute on function public.profiles_keep_admin() from public, anon, authenticated;

create trigger profiles_keep_admin before update of role on public.profiles
    for each row execute function public.profiles_keep_admin();

alter table public.profiles enable row level security;
revoke all on public.profiles from anon;
grant select on public.profiles to authenticated;
grant update (full_name, role) on public.profiles to authenticated;
create policy "zalogowani czytają" on public.profiles
    for select to authenticated using (true);
create policy "administrator zmienia" on public.profiles
    for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- ───────────── Adres inwestycji ─────────────

alter table public.investments add column address text check (length(address) <= 300);

-- ───────────── Uprawnienia według ról ─────────────

-- Inwestycje: czytają wszyscy, zmienia administrator.
drop policy "zalogowani zarządzają" on public.investments;
create policy "zalogowani czytają" on public.investments
    for select to authenticated using (true);
create policy "administrator dodaje" on public.investments
    for insert to authenticated with check ((select public.is_admin()));
create policy "administrator zmienia" on public.investments
    for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "administrator usuwa" on public.investments
    for delete to authenticated using ((select public.is_admin()));

-- Zdjęcia: dodaje każdy, podpis zmienia i usuwa administrator.
drop policy "zalogowani zarządzają" on public.investment_photos;
create policy "zalogowani czytają" on public.investment_photos
    for select to authenticated using (true);
create policy "zalogowani dodają" on public.investment_photos
    for insert to authenticated with check (true);
create policy "administrator zmienia" on public.investment_photos
    for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "administrator usuwa" on public.investment_photos
    for delete to authenticated using ((select public.is_admin()));

-- Urządzenia: czytają wszyscy, dodaje, zmienia i usuwa administrator.
drop policy "zalogowani zarządzają" on public.devices;
create policy "zalogowani czytają" on public.devices
    for select to authenticated using (true);
create policy "administrator dodaje" on public.devices
    for insert to authenticated with check ((select public.is_admin()));
create policy "administrator zmienia" on public.devices
    for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "administrator usuwa" on public.devices
    for delete to authenticated using ((select public.is_admin()));

-- Wybór danych z urządzenia: tylko administrator.
drop policy "zalogowani włączają dane" on public.device_metrics;
create policy "administrator włącza dane" on public.device_metrics
    for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- Odczyty: usuwa tylko administrator.
drop policy "zalogowani usuwają" on public.readings;
create policy "administrator usuwa" on public.readings
    for delete to authenticated using ((select public.is_admin()));

-- Wysyłanie danych do ESP32 i czyszczenie historii: tylko administrator.
drop policy "zalogowani usuwają" on public.commands;
create policy "administrator usuwa" on public.commands
    for delete to authenticated using ((select public.is_admin()));
drop policy "zalogowani wysyłają do połączonych urządzeń" on public.commands;
create policy "administrator wysyła do połączonych urządzeń" on public.commands
    for insert to authenticated
    with check (
        (select public.is_admin())
        and exists (
            select 1
            from public.devices d
            join public.product_types t on t.code = d.product_type
            where d.id = device_id and t.connected
        )
    );

-- Serwis: wpisy dodaje każdy, zmienia i usuwa autor albo administrator.
alter table public.service_entries
    add column author_id uuid default auth.uid() references auth.users (id) on delete set null;
create index service_entries_author_idx on public.service_entries (author_id);
drop policy "zalogowani zarządzają" on public.service_entries;
create policy "zalogowani czytają" on public.service_entries
    for select to authenticated using (true);
create policy "zalogowani dodają własne" on public.service_entries
    for insert to authenticated with check (author_id = (select auth.uid()));
create policy "autor lub administrator zmienia" on public.service_entries
    for update to authenticated
    using (author_id = (select auth.uid()) or (select public.is_admin()))
    with check (author_id = (select auth.uid()) or (select public.is_admin()));
create policy "autor lub administrator usuwa" on public.service_entries
    for delete to authenticated using (author_id = (select auth.uid()) or (select public.is_admin()));

-- Dokumentacja: dodaje każdy, nazwę zmienia i usuwa administrator.
drop policy "zalogowani zarządzają" on public.investment_documents;
create policy "zalogowani czytają" on public.investment_documents
    for select to authenticated using (true);
create policy "zalogowani dodają" on public.investment_documents
    for insert to authenticated with check (true);
create policy "administrator zmienia" on public.investment_documents
    for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "administrator usuwa" on public.investment_documents
    for delete to authenticated using ((select public.is_admin()));

-- Pliki w Storage: usuwanie i podmiana tylko przez administratora.
drop policy "zalogowani zmieniają zdjęcia" on storage.objects;
drop policy "zalogowani usuwają zdjęcia" on storage.objects;
drop policy "zalogowani usuwają dokumenty" on storage.objects;
create policy "administrator zmienia zdjęcia" on storage.objects
    for update to authenticated using (bucket_id = 'investment-photos' and (select public.is_admin()));
create policy "administrator usuwa zdjęcia" on storage.objects
    for delete to authenticated using (bucket_id = 'investment-photos' and (select public.is_admin()));
create policy "administrator usuwa dokumenty" on storage.objects
    for delete to authenticated using (bucket_id = 'investment-docs' and (select public.is_admin()));
