-- Rejestracja z zatwierdzaniem przez administratora.
-- Każde nowe konto dostaje rolę 'pending' i do czasu zatwierdzenia nie widzi żadnych danych.

alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'user', 'pending'));

-- Czy zalogowana osoba jest zatwierdzona (administrator albo użytkownik).
-- SECURITY DEFINER, bo jest używana w politykach tabeli profiles (bez tego byłaby rekurencja).
create function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (
        select 1 from public.profiles
        where user_id = (select auth.uid()) and role in ('admin', 'user')
    );
$$;
revoke execute on function public.is_member() from public, anon;
grant execute on function public.is_member() to authenticated;

-- Nowe konto w Supabase Auth od razu dostaje profil oczekujący na zatwierdzenie
-- (wyzwalacz on_auth_user_created już istnieje, zmieniamy tylko funkcję).
-- Konta tworzone przez administratora (funkcja admin-users) nadpisują potem rolę.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    insert into public.profiles (user_id, email, full_name, role)
    values (
        new.id,
        coalesce(new.email, ''),
        nullif(left(trim(new.raw_user_meta_data ->> 'full_name'), 120), ''),
        'pending'
    )
    on conflict (user_id) do nothing;
    return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Polityki zawężające (RESTRICTIVE): łączą się przez AND z dotychczasowymi,
-- więc konto oczekujące nie przejdzie żadnej z nich.
create policy "tylko zatwierdzeni" on public.product_types        as restrictive for all to authenticated using ((select public.is_member())) with check ((select public.is_member()));
create policy "tylko zatwierdzeni" on public.product_metrics      as restrictive for all to authenticated using ((select public.is_member())) with check ((select public.is_member()));
create policy "tylko zatwierdzeni" on public.investments          as restrictive for all to authenticated using ((select public.is_member())) with check ((select public.is_member()));
create policy "tylko zatwierdzeni" on public.investment_photos    as restrictive for all to authenticated using ((select public.is_member())) with check ((select public.is_member()));
create policy "tylko zatwierdzeni" on public.devices              as restrictive for all to authenticated using ((select public.is_member())) with check ((select public.is_member()));
create policy "tylko zatwierdzeni" on public.device_metrics       as restrictive for all to authenticated using ((select public.is_member())) with check ((select public.is_member()));
create policy "tylko zatwierdzeni" on public.readings             as restrictive for all to authenticated using ((select public.is_member())) with check ((select public.is_member()));
create policy "tylko zatwierdzeni" on public.commands             as restrictive for all to authenticated using ((select public.is_member())) with check ((select public.is_member()));
create policy "tylko zatwierdzeni" on public.service_entries      as restrictive for all to authenticated using ((select public.is_member())) with check ((select public.is_member()));
create policy "tylko zatwierdzeni" on public.investment_documents as restrictive for all to authenticated using ((select public.is_member())) with check ((select public.is_member()));

-- Profil: oczekujący widzi tylko swój wiersz (żeby strona wiedziała, że czeka na zatwierdzenie).
create policy "tylko zatwierdzeni lub własny" on public.profiles as restrictive for all to authenticated
    using ((select public.is_member()) or user_id = (select auth.uid()))
    with check ((select public.is_member()));

-- Pliki: zdjęcia i dokumenty tylko dla zatwierdzonych.
create policy "tylko zatwierdzeni" on storage.objects as restrictive for all to authenticated
    using (bucket_id not in ('investment-photos', 'investment-docs') or (select public.is_member()))
    with check (bucket_id not in ('investment-photos', 'investment-docs') or (select public.is_member()));
