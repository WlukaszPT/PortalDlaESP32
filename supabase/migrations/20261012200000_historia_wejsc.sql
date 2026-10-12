-- Historia wejść na stronę: kto i kiedy otworzył portal.
-- Widzi ją tylko właściciel portalu (pierwsze konto założone w bazie), inni administratorzy nie.

-- ───────────── Właściciel portalu ─────────────

-- Jeden wiersz. Nikt nie ma do tej tabeli uprawnień przez API, więc nie da się jej zmienić ze strony.
create table public.app_owner (
    user_id uuid primary key references auth.users (id) on delete cascade,
    single  boolean not null default true unique check (single)
);
alter table public.app_owner enable row level security;
revoke all on public.app_owner from public, anon, authenticated;

insert into public.app_owner (user_id)
select id from auth.users order by created_at limit 1;

-- Czy zalogowana osoba jest właścicielem portalu.
create function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.app_owner where user_id = (select auth.uid()));
$$;
revoke execute on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated;

-- ───────────── Wejścia na stronę ─────────────

create table public.page_visits (
    id         bigint generated always as identity primary key,
    user_id    uuid not null references auth.users (id) on delete cascade,
    visited_at timestamptz not null default now(),
    device     text check (length(device) <= 120)
);
create index page_visits_visited_at_idx on public.page_visits (visited_at desc);
create index page_visits_user_id_idx on public.page_visits (user_id);
alter table public.page_visits enable row level security;
-- Brak polityk i uprawnień: zapis i odczyt tylko przez funkcje niżej.
revoke all on public.page_visits from public, anon, authenticated;

-- Strona woła ją po każdym otwarciu przez zalogowaną osobę.
-- Wpisy starsze niż rok są usuwane, żeby tabela nie rosła bez końca.
create function public.log_visit(p_device text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if auth.uid() is null then
        raise exception 'Brak zalogowanego użytkownika.';
    end if;
    insert into public.page_visits (user_id, device)
    values (auth.uid(), nullif(left(trim(p_device), 120), ''));
    delete from public.page_visits where visited_at < now() - interval '1 year';
end;
$$;
revoke execute on function public.log_visit(text) from public, anon;
grant execute on function public.log_visit(text) to authenticated;

-- Historia wejść, najnowsze najpierw. Tylko dla właściciela portalu.
create function public.visit_log(p_limit integer default 500)
returns table (visited_at timestamptz, user_id uuid, full_name text, email text, device text)
language plpgsql stable security definer set search_path = '' as $$
begin
    if not public.is_owner() then
        raise exception 'Historia wejść jest dostępna tylko dla właściciela portalu.';
    end if;
    return query
        select v.visited_at, v.user_id, p.full_name, coalesce(p.email, ''), v.device
        from public.page_visits v
        left join public.profiles p on p.user_id = v.user_id
        order by v.visited_at desc
        limit least(greatest(coalesce(p_limit, 500), 1), 1000);
end;
$$;
revoke execute on function public.visit_log(integer) from public, anon;
grant execute on function public.visit_log(integer) to authenticated;
