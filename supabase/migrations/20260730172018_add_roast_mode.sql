alter table public.user_preferences drop constraint if exists user_preferences_default_mode_check;
alter table public.user_preferences add constraint user_preferences_default_mode_check
  check (default_mode in ('argue', 'brainstorm', 'roast'));

alter table public.conversations drop constraint if exists conversations_mode_check;
alter table public.conversations add constraint conversations_mode_check
  check (mode in ('argue', 'brainstorm', 'roast'));
