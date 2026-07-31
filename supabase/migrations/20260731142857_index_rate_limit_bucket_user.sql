create index if not exists rate_limit_buckets_user_id_idx
  on private.rate_limit_buckets (user_id);
