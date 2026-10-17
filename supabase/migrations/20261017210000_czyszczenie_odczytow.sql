-- Automatyczne czyszczenie starych odczytów (krok 10 planu).
-- Darmowy plan Supabase ma 500 MB na bazę, a jeden ESP32 wysyłający odczyt co 20 s
-- dokłada ok. 1 MB dziennie. Co noc usuwamy więc:
--   1) odczyty starsze niż 180 dni,
--   2) najstarsze odczyty ponad 1 000 000 (ok. 260 MB), gdyby urządzeń było dużo.
-- Zwolnione miejsce Postgres wykorzystuje na nowe odczyty, więc baza przestaje rosnąć.

create extension if not exists pg_cron;

create function public.cleanup_readings() returns integer
language plpgsql set search_path = '' as $$
declare
    v_keep_days constant integer := 180;
    v_max_rows  constant bigint  := 1000000;
    v_old       integer;
    v_extra     integer := 0;
    v_cutoff_id bigint;
begin
    -- Co noc to tylko jedna doba odczytów, więc wystarczy jedno polecenie.
    delete from public.readings
    where created_at < now() - make_interval(days => v_keep_days);
    get diagnostics v_old = row_count;

    -- Zabezpieczenie na wypadek wielu urządzeń: zostawiamy najwyżej v_max_rows najnowszych.
    -- Numery odczytów rosną z czasem, więc szukamy granicy po kluczu głównym (indeks).
    select id into v_cutoff_id
    from public.readings
    order by id desc
    offset v_max_rows limit 1;

    if v_cutoff_id is not null then
        delete from public.readings where id <= v_cutoff_id;
        get diagnostics v_extra = row_count;
    end if;

    return v_old + v_extra;
end $$;

comment on function public.cleanup_readings() is
    'Usuwa odczyty starsze niż 180 dni i nadmiar ponad 1 mln najnowszych. Uruchamiana co noc przez pg_cron.';

-- Tylko dla harmonogramu (działa jako właściciel bazy), nie przez API.
revoke execute on function public.cleanup_readings() from public, anon, authenticated;

-- Codziennie o 2:15 UTC (3:15 lub 4:15 czasu polskiego).
select cron.schedule('czyszczenie-odczytow', '15 2 * * *', 'select public.cleanup_readings()');
