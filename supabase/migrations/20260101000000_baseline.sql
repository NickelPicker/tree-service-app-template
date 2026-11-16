-- Baseline: the whole database for the tree-service app in one file.
--
-- A fresh Supabase project gets everything from here: tables, row-level
-- security policies, functions, triggers, grants and the realtime
-- tables. The deploy workflow applies it (`supabase db push --remote`);
-- locally, `supabase start` / `supabase db reset` apply it.
--
-- Never edit this file once it has been applied to your project. Every
-- later change is a NEW file in supabase/migrations/, made with
-- `supabase migration new <name>` (see CLAUDE.md).
--
-- Settings that live in the database:
--   * public.business_time_zone() - the business's time zone (clock-in
--     dates, the 8 PM automatic clock-out, "today" for emails). It ships
--     as America/Denver (Colorado) as an example. To change it, add a new
--     migration with, for example:
--       CREATE OR REPLACE FUNCTION public.business_time_zone()
--         RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
--         AS $$ SELECT 'America/Chicago' $$;
--     and change BUSINESS_TIME_ZONE in src/businessSettings.ts and
--     supabase/functions/_shared/businessSettings.ts to match.
--   * public.app_config - which email becomes the owner, and the
--     company id. The deploy workflow fills in the owner email from the
--     GitHub variable OWNER_EMAIL; the company id must equal
--     companyId in src/config.ts (11111111-1111-4111-8111-111111111111).

SET check_function_bodies = false;

-- ---------- Business time zone (one place for the database) ----------
CREATE FUNCTION public.business_time_zone() RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT 'America/Denver' $$;

COMMENT ON FUNCTION public.business_time_zone() IS
  'The business time zone (IANA name). Example value: America/Denver. Change it with a new migration; keep src/businessSettings.ts and supabase/functions/_shared/businessSettings.ts the same.';

CREATE FUNCTION public.accept_estimate_by_link(p_token_hash text, p_option_id text, p_name text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE
  l public.estimate_accept_links%ROWTYPE;
  e public.estimates%ROWTYPE;
  c public.customers%ROWTYPE;
  st text;
  v_name text;
  v_option jsonb;
  v_option_id text;
  v_label text := '';
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_thread text;
  v_old_status text;
BEGIN
  v_name := trim(regexp_replace(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g'));
  IF char_length(v_name) < 2 OR char_length(v_name) > 100 THEN
    RETURN jsonb_build_object('status', 'bad-name');
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'not-found');
  END IF;

  SELECT * INTO l FROM public.estimate_accept_links WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not-found');
  END IF;
  SELECT * INTO e FROM public.estimates
   WHERE id = l.estimate_id AND company_id = l.company_id
   FOR UPDATE;
  st := public.estimate_link_state(l, e);
  IF st IN ('accepted', 'accepted-elsewhere') THEN
    RETURN jsonb_build_object('status', 'already-accepted');
  END IF;
  IF st <> 'open' THEN
    RETURN jsonb_build_object('status', st);
  END IF;

  IF jsonb_typeof(e.options) = 'array' AND jsonb_array_length(e.options) > 0 THEN
    SELECT o INTO v_option FROM jsonb_array_elements(e.options) o
     WHERE o->>'id' = coalesce(p_option_id, '') AND coalesce(p_option_id, '') <> ''
     LIMIT 1;
    IF v_option IS NULL THEN
      RETURN jsonb_build_object('status', 'bad-option');
    END IF;
    v_option_id := v_option->>'id';
    v_label := coalesce(v_option->>'label', '');
  ELSIF coalesce(p_option_id, '') <> '' THEN
    RETURN jsonb_build_object('status', 'bad-option');
  END IF;

  v_old_status := e.status;
  UPDATE public.estimates
     SET status = 'accepted', accepted_option_id = v_option_id,
         accepted_by = v_name, accepted_at = v_now
   WHERE id = e.id;
  UPDATE public.estimate_accept_links
     SET accepted_at = now(), accepted_option_id = v_option_id, accepted_name = v_name
   WHERE id = l.id;
  UPDATE public.estimate_accept_links
     SET revoked_at = now(), revoked_reason = 'replaced'
   WHERE estimate_id = e.id AND id <> l.id AND revoked_at IS NULL AND accepted_at IS NULL;

  -- History, as the app writes it for an accept.
  INSERT INTO public.audit_log
    (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id)
  VALUES
    (gen_random_uuid()::text, e.company_id, v_now, left('Customer online: ' || v_name, 120), 'Estimate', e.id,
     e.title, 'status', coalesce(v_old_status, ''), 'accepted', e.customer_id, e.job_id),
    (gen_random_uuid()::text, e.company_id, v_now, left('Customer online: ' || v_name, 120), 'Estimate', e.id,
     e.title, 'accepted option', '(none)', coalesce(nullif(v_label, ''), 'the estimate'), e.customer_id, e.job_id);

  -- The customer's message thread.
  v_thread := public.customer_email_thread(e.company_id, e.customer_id);
  INSERT INTO public.messages
    (id, company_id, customer_id, job_id, estimate_id, channel, direction,
     sender_crew_id, sender_name, body, created_at, from_number, thread_id)
  VALUES
    (gen_random_uuid()::text, e.company_id, e.customer_id, e.job_id, e.id, 'email', 'in',
     '', v_name,
     'Accepted the estimate online: ' || coalesce(nullif(e.title, ''), 'Estimate')
       || CASE WHEN v_label <> '' THEN ' — option "' || v_label || '"' ELSE '' END
       || '. Signed "' || v_name || '", agreed to the terms.',
     v_now, NULL, v_thread);

  SELECT * INTO c FROM public.customers WHERE id = e.customer_id AND company_id = e.company_id;
  RETURN jsonb_build_object(
    'status', 'accepted',
    'company_id', e.company_id,
    'estimate_id', e.id,
    'customer_id', e.customer_id,
    'job_id', e.job_id,
    'customer_email', coalesce(c.email, ''),
    'customer_name', left(coalesce(nullif(trim(concat_ws(' ', nullif(trim(c.first_name), ''), nullif(trim(c.last_name), ''))), ''),
                              nullif(trim(c.company_name), ''), nullif(trim(c.company), ''), 'Customer'), 200),
    'greeting', coalesce(nullif(trim(c.first_name), ''), nullif(trim(c.company_name), ''), nullif(trim(c.company), ''), ''),
    'signed_by', v_name,
    'option_label', v_label,
    'estimate', public.estimate_for_customer(e) || jsonb_build_object('accepted_option_id', v_option_id),
    'company', public.company_for_customer(e.company_id));
END;
$_$;

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE public.jobs (
    id text NOT NULL,
    company_id uuid NOT NULL,
    customer_id text NOT NULL,
    service_type text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    date text NOT NULL,
    start_time text DEFAULT ''::text NOT NULL,
    status text NOT NULL,
    crew_ids text[] DEFAULT '{}'::text[] NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    customer_notes text DEFAULT ''::text NOT NULL,
    team_notes text DEFAULT ''::text NOT NULL,
    office_notes text DEFAULT ''::text NOT NULL,
    prune_class text,
    estimated_hours numeric,
    estimate_id text,
    invoice_id text,
    value numeric,
    tree_ids text[] DEFAULT '{}'::text[] NOT NULL,
    equipment_ids text[] DEFAULT '{}'::text[] NOT NULL,
    end_date text,
    recurring text,
    recurring_until text,
    materials_cost numeric,
    other_cost numeric,
    labor_rate numeric,
    lat double precision,
    lng double precision,
    address_id text,
    expected_crew integer,
    equipment_drivers jsonb,
    billing_type text,
    hourly_rate numeric,
    crew_arrivals jsonb,
    time_promised boolean DEFAULT false NOT NULL,
    replaced_price numeric,
    CONSTRAINT jobs_crew_arrivals_is_object CHECK (((crew_arrivals IS NULL) OR (jsonb_typeof(crew_arrivals) = 'object'::text)))
);

CREATE FUNCTION public.app_jobs(p_company_id uuid) RETURNS SETOF public.jobs
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_sales boolean;
  v_climber boolean;
BEGIN
  IF NOT public.is_company_member(p_company_id) THEN
    RETURN;
  END IF;
  IF public.is_company_staff(p_company_id) THEN
    RETURN QUERY SELECT j.* FROM public.jobs j WHERE j.company_id = p_company_id;
    RETURN;
  END IF;
  v_sales := public.is_sales_person(p_company_id);
  v_climber := public.is_climber(p_company_id);
  RETURN QUERY
    SELECT r.*
      FROM public.jobs j
     CROSS JOIN LATERAL jsonb_populate_record(
            NULL::public.jobs,
            to_jsonb(j)
              - public.job_office_columns()
              - CASE WHEN public.job_money_visible(j.company_id, j.crew_ids, j.date, j.estimate_id, j.customer_id)
                     THEN '{}'::text[]
                     WHEN v_climber THEN public.job_cost_columns()
                     ELSE public.job_money_columns() END) r
     WHERE j.company_id = p_company_id
       AND (v_sales OR public.job_row_visible(j.company_id, j.crew_ids, j.date));
END;
$$;

CREATE FUNCTION public.approve_customer_edit(p_request_id uuid, p_changes jsonb DEFAULT NULL::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  r public.customer_edit_requests;
  c public.customers;
  a public.customer_addresses;
  ch jsonb;
  v_suggested jsonb;
  v_with_changes boolean := false;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_actor text;
  v_label text;
  f record;
  v_old text;
  v_new text;
  v_addr boolean;
BEGIN
  SELECT * INTO r FROM public.customer_edit_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_staff(r.company_id) THEN
    RAISE EXCEPTION 'Only the office can approve a suggested change.' USING ERRCODE = '42501';
  END IF;
  IF r.requested_user IS NOT DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'A suggestion cannot be approved by the person who made it.' USING ERRCODE = '42501';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'This suggestion was already %.', r.status USING ERRCODE = '55000';
  END IF;
  SELECT * INTO c FROM public.customers
    WHERE id = r.customer_id AND company_id = r.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The customer no longer exists.' USING ERRCODE = '55000';
  END IF;

  v_suggested := public.customer_edit_allowed(r.changes);
  IF p_changes IS NULL OR jsonb_typeof(p_changes) = 'null' THEN
    ch := v_suggested;
  ELSE
    -- The office's values: same rules as a suggestion, and only for the
    -- fields that were suggested (anything else is a normal edit).
    IF NOT public.customer_edit_changes_ok(p_changes) THEN
      RAISE EXCEPTION 'Those changes cannot be applied (a field is not allowed, empty or too long).'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes) AS k WHERE NOT v_suggested ? k) THEN
      RAISE EXCEPTION 'Only the suggested fields can be changed here; edit the customer for anything else.'
        USING ERRCODE = '22023';
    END IF;
    ch := p_changes;
    v_with_changes := ch IS DISTINCT FROM v_suggested;
  END IF;

  v_actor := coalesce(nullif(public.current_crew_name(r.company_id), ''), 'Owner');
  v_label := btrim(c.first_name || ' ' || c.last_name);

  -- Customer fields: (key in changes, column, field name in the history).
  FOR f IN
    SELECT * FROM (VALUES
      ('first_name', 'firstName'), ('last_name', 'lastName'), ('company', 'company'),
      ('phone', 'phone'), ('email', 'email'), ('gate_code', 'gateCode'),
      ('property_notes', 'propertyNotes'), ('notes', 'notes')
    ) AS t(k, field)
  LOOP
    CONTINUE WHEN NOT ch ? f.k;
    EXECUTE format('SELECT %I FROM public.customers WHERE id = $1', f.k) INTO v_old USING c.id;
    v_new := ch ->> f.k;
    CONTINUE WHEN v_old IS NOT DISTINCT FROM v_new;
    EXECUTE format('UPDATE public.customers SET %I = $1 WHERE id = $2', f.k) USING v_new, c.id;
    INSERT INTO public.audit_log
      (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id)
    VALUES
      (gen_random_uuid()::text, r.company_id, v_now, v_actor, 'Customer', c.id, v_label, f.field,
       coalesce(nullif(v_old, ''), '(blank)'), coalesce(nullif(v_new, ''), '(blank)'), c.id, NULL);
  END LOOP;

  -- Primary address (street, city, state, ZIP); the customer row's
  -- address/city/zip mirror it, as the app keeps them.
  v_addr := ch ?| ARRAY['street', 'city', 'state', 'zip'];
  IF v_addr THEN
    SELECT * INTO a FROM public.customer_addresses
      WHERE customer_id = c.id AND company_id = r.company_id
      ORDER BY is_primary DESC, id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.customer_addresses (id, company_id, customer_id, label, street, city, state, zip, is_primary)
      VALUES (gen_random_uuid()::text, r.company_id, c.id, '', c.address, c.city, 'CO', c.zip, true)
      RETURNING * INTO a;
    END IF;
    FOR f IN
      SELECT * FROM (VALUES ('street', 'address'), ('city', 'city'), ('state', 'state'), ('zip', 'zip')) AS t(k, field)
    LOOP
      CONTINUE WHEN NOT ch ? f.k;
      EXECUTE format('SELECT %I FROM public.customer_addresses WHERE id = $1', f.k) INTO v_old USING a.id;
      v_new := ch ->> f.k;
      CONTINUE WHEN v_old IS NOT DISTINCT FROM v_new;
      EXECUTE format('UPDATE public.customer_addresses SET %I = $1 WHERE id = $2', f.k) USING v_new, a.id;
      INSERT INTO public.audit_log
        (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id)
      VALUES
        (gen_random_uuid()::text, r.company_id, v_now, v_actor, 'Customer', c.id, v_label, f.field,
         coalesce(nullif(v_old, ''), '(blank)'), coalesce(nullif(v_new, ''), '(blank)'), c.id, NULL);
    END LOOP;
    UPDATE public.customer_addresses SET is_primary = (id = a.id)
      WHERE customer_id = c.id AND company_id = r.company_id;
    UPDATE public.customers cu SET address = ad.street, city = ad.city, zip = ad.zip
      FROM public.customer_addresses ad
      WHERE ad.id = a.id AND cu.id = c.id;
  END IF;

  UPDATE public.customer_edit_requests
    SET status = 'approved', decided_user = auth.uid(), decided_by = v_actor, decided_at = now(),
        applied_changes = ch
    WHERE id = r.id;
  INSERT INTO public.audit_log
    (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id)
  VALUES
    (gen_random_uuid()::text, r.company_id, v_now, v_actor, 'Customer', c.id, v_label, 'suggested change',
     CASE WHEN v_with_changes
          THEN 'suggested by ' || r.requested_name || ': ' || public.customer_edit_describe(v_suggested)
          ELSE 'suggested by ' || r.requested_name END,
     CASE WHEN v_with_changes
          THEN 'approved with changes: ' || public.customer_edit_describe(ch)
          ELSE 'approved' END,
     c.id, NULL);
END $_$;

CREATE TABLE public.timesheet_week_approvals (
    company_id uuid NOT NULL,
    week_start date NOT NULL,
    approved_by text DEFAULT ''::text NOT NULL,
    approved_user uuid,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    total_hours numeric(8,2) DEFAULT 0 NOT NULL,
    CONSTRAINT timesheet_week_approvals_total_hours_check CHECK (((total_hours >= (0)::numeric) AND (total_hours < (100000)::numeric))),
    CONSTRAINT timesheet_week_approvals_week_start_check CHECK ((EXTRACT(isodow FROM week_start) = (1)::numeric))
);

CREATE FUNCTION public.approve_timesheet_week(p_company uuid, p_week date, p_hours numeric) RETURNS public.timesheet_week_approvals
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  r public.timesheet_week_approvals;
BEGIN
  IF NOT public.is_company_admin(p_company) THEN
    RAISE EXCEPTION 'Only an owner or manager can approve a week.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.timesheet_week_approvals
   WHERE company_id = p_company AND week_start = p_week;
  INSERT INTO public.timesheet_week_approvals (company_id, week_start, total_hours)
  VALUES (p_company, p_week, round(coalesce(p_hours, 0), 2))
  RETURNING * INTO r;
  RETURN r;
END;
$$;

CREATE FUNCTION public.audit_actor_name(p_company_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_id text := public.current_crew_id(p_company_id);
  v_name text := NULLIF(btrim(public.current_crew_name(p_company_id)), '');
BEGIN
  IF v_name IS NULL THEN
    RETURN 'Team member';
  END IF;
  IF v_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.crew c
        WHERE c.company_id = p_company_id AND c.id <> v_id
          AND lower(btrim(c.name)) = lower(v_name)) THEN
    RETURN v_name || ' (' || v_id || ')';
  END IF;
  RETURN v_name;
END;
$$;

CREATE FUNCTION public.audit_entry_visible(p_company_id uuid, p_job_id text, p_entity text, p_entity_id text, p_field text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  j record;
  e record;
BEGIN
  IF public.is_company_staff(p_company_id) THEN
    RETURN true;
  END IF;
  IF p_job_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT x.company_id, x.crew_ids, x.date, x.estimate_id, x.customer_id INTO j
    FROM public.jobs x WHERE x.company_id = p_company_id AND x.id = p_job_id;
  IF NOT FOUND OR NOT public.job_row_visible(j.company_id, j.crew_ids, j.date) THEN
    RETURN false;
  END IF;
  -- Office notes: never for crew (field names as the app writes them).
  IF lower(coalesce(p_field, '')) IN ('officenotes', 'office notes', 'office_notes') THEN
    RETURN false;
  END IF;
  CASE p_entity
    WHEN 'Job' THEN
      IF lower(coalesce(p_field, '')) IN (
           'value', 'hourlyrate', 'hourly rate', 'hourly_rate',
           'laborrate', 'labor rate', 'labor_rate',
           'materialscost', 'materials cost', 'materials_cost',
           'othercost', 'other costs', 'other cost', 'other_cost') THEN
        RETURN public.job_money_visible(j.company_id, j.crew_ids, j.date, j.estimate_id, j.customer_id);
      END IF;
      RETURN true;
    WHEN 'Message' THEN
      RETURN true;
    WHEN 'Estimate' THEN
      IF public.is_sales_person(p_company_id) THEN
        SELECT x.customer_id, x.created_by_crew_id INTO e
          FROM public.estimates x WHERE x.company_id = p_company_id AND x.id = p_entity_id;
        RETURN FOUND AND public.sales_can_read_estimate(p_company_id, e.customer_id, e.created_by_crew_id);
      END IF;
      RETURN public.crew_perm(p_company_id, 'seeMoney');
    WHEN 'Invoice' THEN
      IF public.is_sales_person(p_company_id) THEN
        RETURN false;
      END IF;
      RETURN public.crew_perm(p_company_id, 'seeMoney');
    WHEN 'Timesheet' THEN
      RETURN EXISTS (
        SELECT 1 FROM public.timesheets t
        WHERE t.company_id = p_company_id AND t.id = p_entity_id
          AND t.crew_id = public.current_crew_id(p_company_id));
    ELSE
      RETURN false;
  END CASE;
END;
$$;

CREATE FUNCTION public.auto_invoice_restore_hand_stops(p_company_id uuid) RETURNS integer
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
  WITH restored AS (
    UPDATE public.invoices i
       SET auto_send_status = 'waiting', auto_send_note = NULL
     WHERE i.company_id = p_company_id
       AND i.auto_send_status = 'stopped' AND i.auto_send_note = 'sent-by-hand'
       AND i.emailed_at IS NULL
       AND NOT public.invoice_is_split(i.splits)
       AND NOT EXISTS (SELECT 1 FROM public.automation_sends a
                        WHERE a.company_id = i.company_id AND a.rule_kind = 'invoice_emailed'
                          AND a.target_id = i.id AND a.status IN ('sent', 'sending'))
    RETURNING 1
  )
  SELECT count(*)::int FROM restored;
$$;

CREATE FUNCTION public.auto_invoice_send_claim(p_invoice_id text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.invoices
     SET auto_send_status = 'sending', auto_send_claimed_at = now()
   WHERE id = p_invoice_id AND auto_send_at <= now()
     AND NOT public.invoice_is_split(splits)
     AND (auto_send_status = 'waiting'
          OR (auto_send_status = 'sending'
              AND (auto_send_claimed_at IS NULL OR auto_send_claimed_at < now() - interval '30 minutes')));
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.auto_invoice_send_finish(p_invoice_id text, p_status text, p_note text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_status NOT IN ('sent', 'waiting', 'stopped') THEN
    RAISE EXCEPTION 'unknown status' USING ERRCODE = '22023';
  END IF;
  UPDATE public.invoices
     SET auto_send_status = p_status,
         auto_send_note = CASE WHEN p_status = 'stopped' THEN coalesce(p_note, 'failed') END,
         auto_sent_at = CASE WHEN p_status = 'sent' THEN now() END,
         emailed_at = CASE WHEN p_status = 'sent' THEN now() ELSE emailed_at END
   WHERE id = p_invoice_id AND auto_send_status = 'sending';
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.auto_invoice_stop_split(p_company_id uuid) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  n integer;
BEGIN
  -- A stuck send that the sends log says went: record it as sent.
  UPDATE public.invoices i
     SET auto_send_status = 'sent', auto_send_note = NULL,
         auto_sent_at = coalesce(a.sent_at, now()),
         emailed_at = coalesce(i.emailed_at, a.sent_at, now())
    FROM public.automation_sends a
   WHERE i.company_id = p_company_id
     AND public.invoice_is_split(i.splits)
     AND i.auto_send_status = 'sending'
     AND (i.auto_send_claimed_at IS NULL OR i.auto_send_claimed_at < now() - interval '30 minutes')
     AND a.company_id = i.company_id AND a.dedupe_key = 'invoice_send:' || i.id AND a.status = 'sent';

  WITH stopped AS (
    UPDATE public.invoices i
       SET auto_send_status = 'stopped', auto_send_note = 'split'
     WHERE i.company_id = p_company_id
       AND public.invoice_is_split(i.splits)
       AND (i.auto_send_status = 'waiting'
            OR (i.auto_send_status = 'sending'
                AND (i.auto_send_claimed_at IS NULL OR i.auto_send_claimed_at < now() - interval '30 minutes')))
    RETURNING i.company_id, i.job_id, i.customer_id
  ), listed AS (
    INSERT INTO public.invoice_reviews (company_id, job_id, customer_id, reason)
    SELECT s.company_id, s.job_id, coalesce(s.customer_id, ''), 'split_invoice'
      FROM stopped s
     WHERE s.job_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.company_id = s.company_id AND j.id = s.job_id)
    ON CONFLICT (company_id, job_id) DO UPDATE
      SET reason = 'split_invoice', created_at = now()
    RETURNING 1
  )
  SELECT count(*)::int INTO n FROM stopped;
  RETURN n;
END;
$$;

CREATE FUNCTION public.auto_invoice_stop_unsendable(p_company_id uuid, p_allowed boolean) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.invoices
     SET auto_send_status = 'stopped',
         auto_send_note = CASE WHEN NOT p_allowed THEN 'switched-off' ELSE 'too-late' END
   WHERE company_id = p_company_id AND auto_send_status = 'waiting' AND auto_send_at <= now()
     AND (NOT p_allowed OR auto_send_at < now() - interval '2 days');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE FUNCTION public.automation_batch_claim(p_batch_id uuid, p_company_id uuid, p_user uuid) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.automation_batches
     SET status = 'sending', claimed_at = now(), updated_at = now(),
         decided_by = p_user, decided_at = now()
   WHERE id = p_batch_id AND company_id = p_company_id
     AND (status = 'waiting'
          OR (status = 'sending' AND (claimed_at IS NULL OR claimed_at < now() - interval '30 minutes')));
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.automation_batch_item_finish(p_item_id uuid, p_status text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_status NOT IN ('sent', 'failed', 'skipped') THEN
    RAISE EXCEPTION 'unknown status' USING ERRCODE = '22023';
  END IF;
  UPDATE public.automation_batch_items
     SET status = p_status, finished_at = now()
   WHERE id = p_item_id AND status = 'waiting';
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.automation_batch_release(p_batch_id uuid) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_status text;
BEGIN
  UPDATE public.automation_batches b
     SET status = CASE WHEN EXISTS (
                    SELECT 1 FROM public.automation_batch_items i
                     WHERE i.batch_id = b.id AND i.status = 'waiting') THEN 'waiting' ELSE 'done' END,
         claimed_at = NULL, updated_at = now()
   WHERE b.id = p_batch_id AND b.status = 'sending'
  RETURNING b.status INTO v_status;
  RETURN v_status;
END;
$$;

CREATE FUNCTION public.booking_limits_take(p_ip_hash text, p_contact_hash text DEFAULT NULL::text, p_max_visitor_hour integer DEFAULT 5, p_max_contact_day integer DEFAULT 3, p_max_day integer DEFAULT 40, p_max_pending integer DEFAULT 300) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('booking:all'));
  DELETE FROM public.booking_rate_limits WHERE created_at < now() - interval '1 day';
  IF (SELECT count(*) FROM public.booking_rate_limits
       WHERE created_at > now() - interval '1 day') >= p_max_day THEN
    RETURN 'daily';
  END IF;
  IF (SELECT count(*) FROM public.booking_requests WHERE status = 'pending') >= p_max_pending THEN
    RETURN 'backlog';
  END IF;
  IF (SELECT count(*) FROM public.booking_rate_limits
       WHERE ip_hash = p_ip_hash AND created_at > now() - interval '1 hour') >= p_max_visitor_hour THEN
    RETURN 'visitor';
  END IF;
  IF coalesce(p_contact_hash, '') <> '' AND (SELECT count(*) FROM public.booking_rate_limits
       WHERE contact_hash = p_contact_hash AND created_at > now() - interval '1 day') >= p_max_contact_day THEN
    RETURN 'visitor';
  END IF;
  INSERT INTO public.booking_rate_limits (ip_hash, contact_hash)
    VALUES (p_ip_hash, nullif(p_contact_hash, ''));
  RETURN 'ok';
END;
$$;

CREATE FUNCTION public.booking_rate_limit_take(p_ip_hash text, p_max integer DEFAULT 5) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  recent int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('booking:' || p_ip_hash));
  DELETE FROM public.booking_rate_limits WHERE created_at < now() - interval '1 day';
  SELECT count(*) INTO recent FROM public.booking_rate_limits
    WHERE ip_hash = p_ip_hash AND created_at > now() - interval '1 hour';
  IF recent >= p_max THEN
    RETURN false;
  END IF;
  INSERT INTO public.booking_rate_limits (ip_hash) VALUES (p_ip_hash);
  RETURN true;
END;
$$;

CREATE FUNCTION public.calendar_jobs(p_company_id uuid) RETURNS TABLE(id text, date text, end_date text, start_time text, title text, service_type text, status text, crew_ids text[], estimated_hours numeric, area text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT j.id, j.date, j.end_date, j.start_time, j.title, j.service_type, j.status,
         j.crew_ids, j.estimated_hours,
         -- The town only: the primary address's city, else the customer's city.
         COALESCE(
           NULLIF((SELECT a.city FROM public.customer_addresses a
                   WHERE a.company_id = j.company_id AND a.customer_id = j.customer_id
                   ORDER BY a.is_primary DESC, a.id LIMIT 1), ''),
           NULLIF(c.city, '')
         )
  FROM public.jobs j
  LEFT JOIN public.customers c ON c.company_id = j.company_id AND c.id = j.customer_id
  WHERE j.company_id = p_company_id
    AND public.is_company_member(p_company_id);
$$;

CREATE FUNCTION public.can_change_job(p_company_id uuid, p_job_id text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.company_id = p_company_id AND j.id = p_job_id
      AND public.job_row_assigned(j.company_id, j.crew_ids, j.date)
  );
$$;

CREATE FUNCTION public.can_read_customer(p_company_id uuid, p_customer_id text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT public.is_company_member(p_company_id) THEN
    RETURN false;
  END IF;
  IF public.is_company_staff(p_company_id)
     OR public.crew_perm(p_company_id, 'seeAllCustomers') THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.company_id = p_company_id AND j.customer_id = p_customer_id
      AND public.job_row_visible(j.company_id, j.crew_ids, j.date)
  );
END;
$$;

CREATE FUNCTION public.can_read_job(p_company_id uuid, p_job_id text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.company_id = p_company_id AND j.id = p_job_id
      AND public.job_row_visible(j.company_id, j.crew_ids, j.date)
  );
$$;

CREATE FUNCTION public.change_job_price(p_job_id text, p_value numeric, p_hourly_rate numeric, p_billing_type text, p_reason text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  j public.jobs;
  v_staff boolean;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_actor text;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_id uuid;
  v_replaced numeric;
  f record;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_member(j.company_id) THEN
    RAISE EXCEPTION 'Only a Climber on this job or the office can change its price.' USING ERRCODE = '42501';
  END IF;
  v_staff := public.is_company_staff(j.company_id);
  IF NOT v_staff AND NOT (public.is_climber(j.company_id)
                          AND public.job_row_assigned(j.company_id, j.crew_ids, j.date)) THEN
    RAISE EXCEPTION 'Only a Climber on this job or the office can change its price.' USING ERRCODE = '42501';
  END IF;
  IF NOT v_staff AND char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Say why the price changed (at least 3 characters).' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'The reason is too long (at most 1000 characters).' USING ERRCODE = '22023';
  END IF;
  IF p_billing_type IS NOT NULL AND p_billing_type NOT IN ('flat', 'hourly') THEN
    RAISE EXCEPTION 'Billing is flat or hourly.' USING ERRCODE = '22023';
  END IF;
  IF (p_value IS NOT NULL AND (p_value < 0 OR p_value > 10000000))
     OR (p_hourly_rate IS NOT NULL AND (p_hourly_rate < 0 OR p_hourly_rate > 100000)) THEN
    RAISE EXCEPTION 'That price is out of range.' USING ERRCODE = '22023';
  END IF;
  IF p_value IS NOT DISTINCT FROM j.value
     AND p_hourly_rate IS NOT DISTINCT FROM j.hourly_rate
     AND p_billing_type IS NOT DISTINCT FROM j.billing_type THEN
    RAISE EXCEPTION 'The price did not change.' USING ERRCODE = '22023';
  END IF;

  v_actor := coalesce(nullif(public.current_crew_name(j.company_id), ''), CASE WHEN v_staff THEN 'Owner' ELSE 'Crew' END);
  -- A Climber's price replaces the one shown before (business rule).
  v_replaced := CASE WHEN v_staff THEN j.replaced_price
                     ELSE coalesce(j.replaced_price, public.job_price_before_change(j)) END;

  -- Let limit_crew_job_edits pass this job's price, for this one update.
  PERFORM set_config('app.job_price_change', j.id, true);
  UPDATE public.jobs
     SET value = p_value, hourly_rate = p_hourly_rate, billing_type = p_billing_type,
         replaced_price = v_replaced
   WHERE id = j.id;
  PERFORM set_config('app.job_price_change', '', true);

  -- Change history, one entry per changed field, as the app's job edits.
  FOR f IN
    SELECT * FROM (VALUES
      ('value', j.value::text, p_value::text),
      ('billingType', j.billing_type, p_billing_type),
      ('hourlyRate', j.hourly_rate::text, p_hourly_rate::text)
    ) AS t(field, old_v, new_v)
  LOOP
    CONTINUE WHEN f.old_v IS NOT DISTINCT FROM f.new_v;
    INSERT INTO public.audit_log
      (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id)
    VALUES
      (gen_random_uuid()::text, j.company_id, v_now, v_actor, 'Job', j.id, j.title, f.field,
       coalesce(nullif(f.old_v, ''), '(blank)'), coalesce(nullif(f.new_v, ''), '(blank)'), j.customer_id, j.id);
  END LOOP;

  INSERT INTO public.job_price_changes
    (company_id, job_id, changed_by, changed_user, changed_by_name, by_office,
     old_value, new_value, old_hourly_rate, new_hourly_rate, old_billing_type, new_billing_type,
     reason, seen_by, seen_user, seen_at)
  VALUES
    (j.company_id, j.id, public.current_crew_id(j.company_id), auth.uid(), v_actor, v_staff,
     j.value, p_value, j.hourly_rate, p_hourly_rate, j.billing_type, p_billing_type,
     v_reason,
     CASE WHEN v_staff THEN v_actor END, CASE WHEN v_staff THEN auth.uid() END,
     CASE WHEN v_staff THEN now() END)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION public.check_crew_clock_tap(p_date text, p_time text, p_in text, p_kind text, p_now timestamp with time zone) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_max_hours int := CASE WHEN p_kind = 'in' THEN 12 ELSE 24 END;
  verdict text := CASE WHEN p_kind = 'in'
    THEN public.timesheet_clock_in_check(p_date, p_time, p_now)
    ELSE public.timesheet_clock_out_check(p_date, p_time, p_in, p_now) END;
BEGIN
  IF verdict IN ('ok', 'cap') THEN
    RETURN verdict;
  END IF;
  IF verdict = 'after_8' THEN
    RAISE EXCEPTION 'After 8 PM the office enters hours. This clock-in couldn''t be saved. Tell the office the time you tapped: % at %.',
      p_date, left(p_time, 5)
      USING ERRCODE = 'CT001';
  END IF;
  IF verdict = 'before_in' THEN
    RAISE EXCEPTION 'This clock-out is earlier than the clock-in and couldn''t be saved. Ask the office to fix this entry. Tell the office the time you tapped: % at %.',
      p_date, left(p_time, 5)
      USING ERRCODE = 'CT001';
  END IF;
  IF verdict = 'old' THEN
    RAISE EXCEPTION 'This tap was made more than % hours ago and couldn''t be saved. Tell the office the time you tapped: % at %.',
      v_max_hours, p_date, left(p_time, 5)
      USING ERRCODE = 'CT001';
  END IF;
  RAISE EXCEPTION 'Clock times come from tapping Clock in and Clock out on your phone. Ask the office to change them.'
    USING ERRCODE = '42501';
END;
$$;

CREATE FUNCTION public.claim_automation_send(p_company_id uuid, p_rule_kind text, p_dedupe_key text, p_target_id text, p_customer_id text, p_customer_name text) RETURNS uuid
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
  INSERT INTO public.automation_sends AS s
    (company_id, rule_kind, dedupe_key, target_id, customer_id, customer_name)
  VALUES (p_company_id, p_rule_kind, p_dedupe_key, coalesce(p_target_id, ''),
          p_customer_id, left(coalesce(p_customer_name, ''), 200))
  ON CONFLICT (company_id, dedupe_key) DO UPDATE
    SET status = 'sending', attempts = s.attempts + 1, created_at = now()
    WHERE s.status = 'failed' AND s.attempts < 3
  RETURNING id;
$$;

CREATE FUNCTION public.claim_day_plan_sends(p_company_id uuid, p_items jsonb, p_per_hour integer, p_per_day integer) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  n integer;
  v_hour integer;
  v_day integer;
  it jsonb;
  v_id uuid;
  v_claims jsonb := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'items must be an array' USING ERRCODE = '22023';
  END IF;
  n := jsonb_array_length(p_items);
  IF n = 0 OR n > 100 OR p_per_hour IS NULL OR p_per_day IS NULL OR p_per_hour < 1 OR p_per_day < 1 THEN
    RAISE EXCEPTION 'bad request' USING ERRCODE = '22023';
  END IF;
  FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF coalesce(it ->> 'key', '') NOT LIKE 'day_plan:%' THEN
      RAISE EXCEPTION 'not a day-plan key' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('day_plan:' || p_company_id::text, 0));
  SELECT count(*)::int INTO v_hour FROM public.automation_sends
   WHERE company_id = p_company_id AND rule_kind = 'day_plan' AND created_at >= now() - interval '1 hour';
  IF v_hour + n > p_per_hour THEN
    RETURN jsonb_build_object('refused', 'too-many');
  END IF;
  SELECT count(*)::int INTO v_day FROM public.automation_sends
   WHERE company_id = p_company_id AND status IN ('sent', 'sending') AND created_at >= now() - interval '24 hours';
  IF v_day + n > p_per_day THEN
    RETURN jsonb_build_object('refused', 'daily-limit');
  END IF;

  FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_id := public.claim_automation_send(p_company_id, 'day_plan', it ->> 'key',
                                         left(coalesce(it ->> 'crew_id', ''), 100), '', 'Day plan');
    v_claims := v_claims || jsonb_build_object(it ->> 'key', v_id);
  END LOOP;
  RETURN jsonb_build_object('claims', v_claims);
END;
$$;

CREATE FUNCTION public.claim_invoice_payer_sends(p_company_id uuid, p_invoice_id text, p_customer_id text, p_items jsonb, p_per_hour integer, p_per_day integer) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  n integer;
  v_hour integer;
  v_day integer;
  it jsonb;
  v_key text;
  v_id uuid;
  v_claims jsonb := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'items must be an array' USING ERRCODE = '22023';
  END IF;
  n := jsonb_array_length(p_items);
  IF n = 0 OR n > 50 OR p_per_hour IS NULL OR p_per_day IS NULL OR p_per_hour < 1 OR p_per_day < 1 THEN
    RAISE EXCEPTION 'bad request' USING ERRCODE = '22023';
  END IF;
  FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_key := it ->> 'key';
    IF v_key IS NULL OR left(v_key, length('invoice_emailed:' || p_invoice_id || ':payer-'))
                        <> 'invoice_emailed:' || p_invoice_id || ':payer-' THEN
      RAISE EXCEPTION 'not a payer key of this invoice' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('invoice_emailed:' || p_company_id::text, 0));
  SELECT count(*)::int INTO v_hour FROM public.automation_sends
   WHERE company_id = p_company_id AND rule_kind = 'invoice_emailed' AND created_at >= now() - interval '1 hour';
  IF v_hour + n > p_per_hour THEN
    RETURN jsonb_build_object('refused', 'too-many');
  END IF;
  SELECT count(*)::int INTO v_day FROM public.automation_sends
   WHERE company_id = p_company_id AND status IN ('sent', 'sending') AND created_at >= now() - interval '24 hours';
  IF v_day + n > p_per_day THEN
    RETURN jsonb_build_object('refused', 'daily-limit');
  END IF;

  FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_id := public.claim_automation_send(p_company_id, 'invoice_emailed', it ->> 'key', p_invoice_id,
                                         p_customer_id, coalesce(it ->> 'name', ''));
    v_claims := v_claims || jsonb_build_object(it ->> 'key', v_id);
  END LOOP;
  RETURN jsonb_build_object('claims', v_claims);
END;
$$;

CREATE FUNCTION public.claim_payment_receipts(p_company_id uuid, p_invoice_id text, p_customer_id text, p_items jsonb, p_per_hour integer, p_per_day integer) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  n integer;
  v_hour integer;
  v_day integer;
  it jsonb;
  v_key text;
  v_prefix text := 'payment_receipt:' || coalesce(p_invoice_id, '') || ':payer-';
  v_id uuid;
  v_claims jsonb := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'items must be an array' USING ERRCODE = '22023';
  END IF;
  n := jsonb_array_length(p_items);
  IF n = 0 OR n > 50 OR coalesce(p_invoice_id, '') = '' OR p_per_hour IS NULL OR p_per_day IS NULL
     OR p_per_hour < 1 OR p_per_day < 1 THEN
    RAISE EXCEPTION 'bad request' USING ERRCODE = '22023';
  END IF;
  FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_key := it ->> 'key';
    IF v_key IS NULL OR left(v_key, length(v_prefix)) <> v_prefix THEN
      RAISE EXCEPTION 'not a receipt key of this invoice' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('payment_receipt:' || p_company_id::text, 0));
  SELECT count(*)::int INTO v_hour FROM public.automation_sends
   WHERE company_id = p_company_id AND rule_kind = 'payment_receipt' AND created_at >= now() - interval '1 hour';
  IF v_hour + n > p_per_hour THEN
    RETURN jsonb_build_object('refused', 'too-many');
  END IF;
  SELECT count(*)::int INTO v_day FROM public.automation_sends
   WHERE company_id = p_company_id AND status IN ('sent', 'sending') AND created_at >= now() - interval '24 hours';
  IF v_day + n > p_per_day THEN
    RETURN jsonb_build_object('refused', 'daily-limit');
  END IF;

  FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_id := public.claim_automation_send(p_company_id, 'payment_receipt', it ->> 'key', p_invoice_id,
                                         p_customer_id, coalesce(it ->> 'name', ''));
    v_claims := v_claims || jsonb_build_object(it ->> 'key', v_id);
  END LOOP;
  RETURN jsonb_build_object('claims', v_claims);
END;
$$;

CREATE FUNCTION public.clear_replaced_price(p_job_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  j public.jobs;
  v_actor text;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_staff(j.company_id) THEN
    RAISE EXCEPTION 'Only the office can do this.' USING ERRCODE = '42501';
  END IF;
  IF j.replaced_price IS NULL THEN
    RAISE EXCEPTION 'This job already uses its estimate''s price.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.jobs SET replaced_price = NULL WHERE id = j.id;
  v_actor := coalesce(nullif(public.current_crew_name(j.company_id), ''), 'Owner');
  INSERT INTO public.audit_log
    (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id)
  VALUES
    (gen_random_uuid()::text, j.company_id, v_now, v_actor, 'Job', j.id, j.title, 'replacedPrice',
     j.replaced_price::text, '(blank)', j.customer_id, j.id);
END;
$$;

CREATE FUNCTION public.clock_now() RETURNS timestamp with time zone
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v text;
BEGIN
  IF session_user = 'postgres' THEN
    v := current_setting('app.clock_now_for_tests', true);
    IF v IS NOT NULL AND v <> '' THEN
      RETURN v::timestamptz;
    END IF;
  END IF;
  RETURN now();
END;
$$;

CREATE FUNCTION public.close_open_clocks_at_8pm(p_company_id uuid DEFAULT NULL::uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_local timestamp := public.clock_now() AT TIME ZONE public.business_time_zone();
  v_today text := to_char(v_local, 'YYYY-MM-DD');
  v_time text := to_char(v_local, 'HH24:MI');
  n integer;
BEGIN
  IF COALESCE(auth.role(), '') NOT IN ('service_role', '')
     AND (p_company_id IS NULL OR NOT public.is_company_member(p_company_id)) THEN
    RAISE EXCEPTION 'Not allowed.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.timesheets t
     SET clock_out = '20:00', auto_closed = true
   WHERE (p_company_id IS NULL OR t.company_id = p_company_id)
     AND t.clock_out IS NULL
     AND t.clock_in ~ '^\d{2}:\d{2}'
     AND left(t.clock_in, 5) < '20:00'
     AND t.date ~ '^\d{4}-\d{2}-\d{2}$'
     AND (t.date < v_today OR (t.date = v_today AND v_time >= '20:00'))
     AND public.timesheet_may_auto_close(t.company_id, t.date, public.clock_now());
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$_$;

CREATE FUNCTION public.close_other_open_clocks() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
BEGIN
  -- Open entries from an earlier day ended at 8 PM on their own day.
  UPDATE public.timesheets t
     SET clock_out = '20:00', auto_closed = true
   WHERE t.company_id = NEW.company_id
     AND t.crew_id = NEW.crew_id
     AND t.id <> NEW.id
     AND t.clock_out IS NULL
     AND t.clock_in ~ '^\d{2}:\d{2}'
     AND left(t.clock_in, 5) < '20:00'
     AND t.date ~ '^\d{4}-\d{2}-\d{2}$'
     AND t.date < NEW.date
     AND public.timesheet_may_auto_close(t.company_id, t.date, public.clock_now());
  -- A finished entry closes the open one it follows only when a
  -- live-only crew login adds it (both taps saved at once from a phone
  -- that had no signal); one typed by the office closes nothing.
  IF NEW.clock_out IS NOT NULL
     AND (COALESCE(auth.role(), '') <> 'authenticated' OR public.may_enter_hours_by_hand(NEW.company_id)) THEN
    RETURN NULL;
  END IF;
  UPDATE public.timesheets t
     SET clock_out = NEW.clock_in
   WHERE t.company_id = NEW.company_id
     AND t.crew_id = NEW.crew_id
     AND t.date = NEW.date
     AND t.id <> NEW.id
     AND t.clock_out IS NULL
     AND t.clock_in IS NOT NULL
     AND t.clock_in <= NEW.clock_in;
  RETURN NULL;
END;
$_$;

CREATE FUNCTION public.company_for_customer(p_company_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'name', coalesce(nullif(trim(s.company_profile->>'name'), ''), c.name, ''),
    'phone', coalesce(s.company_profile->>'phone', ''),
    'email', coalesce(s.company_profile->>'email', ''))
    FROM public.companies c
    LEFT JOIN public.settings s ON s.company_id = c.id
   WHERE c.id = p_company_id;
$$;

CREATE FUNCTION public.create_estimate_accept_link(p_company_id uuid, p_estimate_id text, p_token_hash text, p_again boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE
  e public.estimates%ROWTYPE;
  v_hash text;
  v_live public.estimate_accept_links%ROWTYPE;
  v_id uuid;
  v_expires timestamptz;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'bad token hash';
  END IF;
  SELECT * INTO e FROM public.estimates
   WHERE id = p_estimate_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not-found');
  END IF;
  IF e.status = 'accepted' THEN
    RETURN jsonb_build_object('status', 'accepted');
  END IF;
  IF e.status = 'closed' THEN
    RETURN jsonb_build_object('status', 'closed');
  END IF;
  v_hash := public.estimate_content_hash(e);

  SELECT * INTO v_live FROM public.estimate_accept_links
   WHERE estimate_id = e.id AND revoked_at IS NULL AND accepted_at IS NULL
     AND expires_at > now() AND content_hash = v_hash
   ORDER BY created_at DESC
   LIMIT 1;
  IF FOUND AND (NOT coalesce(p_again, false) OR v_live.created_at > now() - interval '2 minutes') THEN
    RETURN jsonb_build_object('status', 'already-sent', 'sent_at', v_live.created_at);
  END IF;

  UPDATE public.estimate_accept_links
     SET revoked_at = now(), revoked_reason = 'replaced'
   WHERE estimate_id = e.id AND revoked_at IS NULL AND accepted_at IS NULL;

  INSERT INTO public.estimate_accept_links (company_id, estimate_id, token_hash, content_hash)
  VALUES (e.company_id, e.id, p_token_hash, v_hash)
  RETURNING id, expires_at INTO v_id, v_expires;
  RETURN jsonb_build_object('status', 'ok', 'link_id', v_id, 'expires_at', v_expires,
    'estimate', public.estimate_for_customer(e),
    'company', public.company_for_customer(e.company_id));
END;
$_$;

CREATE FUNCTION public.crew_directory(p_company_id uuid) RETURNS TABLE(id text, company_id uuid, name text, role text, color text, phone text, status text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT c.id, c.company_id, c.name, c.role, c.color, c.phone, c.status
  FROM public.crew c
  WHERE c.company_id = p_company_id
    AND c.status = 'active'
    AND public.is_company_member(p_company_id);
$$;

CREATE FUNCTION public.crew_job_price_before_change(p_job_id text) RETURNS numeric
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  j public.jobs;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id;
  IF NOT FOUND OR j.replaced_price IS NOT NULL
     OR NOT public.is_company_member(j.company_id)
     OR NOT public.is_climber(j.company_id)
     OR NOT public.job_row_assigned(j.company_id, j.crew_ids, j.date) THEN
    RETURN NULL;
  END IF;
  RETURN public.job_price_before_change(j);
END;
$$;

CREATE FUNCTION public.crew_job_prices(p_company_id uuid) RETURNS TABLE(job_id text, line_id text, description text, price numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT public.is_company_member(p_company_id) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.crew c
    WHERE c.company_id = p_company_id AND c.auth_user_id = auth.uid()
      AND c.role = 'Climber' AND c.status = 'active'
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH est AS (
    SELECT DISTINCT ON (j.id) j.id AS jid, e.lines, e.options, e.accepted_option_id
    FROM public.jobs j
    JOIN public.estimates e
      ON e.company_id = j.company_id
     AND (e.id = j.estimate_id OR (j.estimate_id IS NULL AND e.job_id = j.id))
    WHERE j.company_id = p_company_id
      AND e.status = 'accepted'
      AND public.job_row_visible(j.company_id, j.crew_ids, j.date)
    ORDER BY j.id, (e.id = j.estimate_id) DESC, e.id
  ),
  picked AS (
    SELECT jid,
      COALESCE(
        (SELECT o -> 'lines' FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(options) = 'array' THEN options ELSE '[]'::jsonb END) o
         WHERE o ->> 'id' = accepted_option_id LIMIT 1),
        lines
      ) AS lines
    FROM est
  )
  SELECT p.jid,
         COALESCE(l ->> 'id', ''),
         COALESCE(l ->> 'description', ''),
         round(
           (CASE WHEN jsonb_typeof(l -> 'quantity') = 'number' THEN (l ->> 'quantity')::numeric ELSE 1 END)
         * (CASE WHEN jsonb_typeof(l -> 'unitPrice') = 'number' THEN (l ->> 'unitPrice')::numeric ELSE 0 END), 2)
  FROM picked p,
       jsonb_array_elements(CASE WHEN jsonb_typeof(p.lines) = 'array' THEN p.lines ELSE '[]'::jsonb END) l;
END;
$$;

CREATE FUNCTION public.crew_perm(p_company_id uuid, p_flag text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE((
    SELECT (c.permissions ->> p_flag) = 'true' FROM public.crew c
    WHERE c.auth_user_id = auth.uid() AND c.company_id = p_company_id
    LIMIT 1
  ), false)
  AND EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.user_id = auth.uid() AND m.company_id = p_company_id
  )
  AND (
    COALESCE(auth.jwt() ->> 'aal', '') = 'aal2'
    OR NOT EXISTS (
      SELECT 1 FROM auth.mfa_factors f
      WHERE f.user_id = auth.uid() AND f.status = 'verified'
    )
  );
$$;

CREATE FUNCTION public.current_crew_id(p_company_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT c.id FROM public.crew c
  WHERE c.auth_user_id = auth.uid() AND c.company_id = p_company_id
    AND EXISTS (
      SELECT 1 FROM public.company_members m
      WHERE m.user_id = auth.uid() AND m.company_id = p_company_id
    )
    AND (
      COALESCE(auth.jwt() ->> 'aal', '') = 'aal2'
      OR NOT EXISTS (
        SELECT 1 FROM auth.mfa_factors f
        WHERE f.user_id = auth.uid() AND f.status = 'verified'
      )
    )
  LIMIT 1;
$$;

CREATE FUNCTION public.current_crew_name(p_company_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT c.name FROM public.crew c
  WHERE c.auth_user_id = auth.uid() AND c.company_id = p_company_id
    AND EXISTS (
      SELECT 1 FROM public.company_members m
      WHERE m.user_id = auth.uid() AND m.company_id = p_company_id
    )
    AND (
      COALESCE(auth.jwt() ->> 'aal', '') = 'aal2'
      OR NOT EXISTS (
        SELECT 1 FROM auth.mfa_factors f
        WHERE f.user_id = auth.uid() AND f.status = 'verified'
      )
    )
  LIMIT 1;
$$;

CREATE FUNCTION public.current_member_role(p_company_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT role FROM public.company_members
  WHERE user_id = auth.uid() AND company_id = p_company_id
    AND (
      COALESCE(auth.jwt() ->> 'aal', '') = 'aal2'
      OR NOT EXISTS (
        SELECT 1 FROM auth.mfa_factors f
        WHERE f.user_id = auth.uid() AND f.status = 'verified'
      )
    );
$$;

CREATE FUNCTION public.customer_edit_allowed(p jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(jsonb_object_agg(e.k, e.v), '{}'::jsonb)
    FROM jsonb_each(CASE WHEN jsonb_typeof(p) = 'object' THEN p ELSE '{}'::jsonb END) AS e(k, v)
   WHERE e.k = ANY (public.customer_edit_fields()) AND jsonb_typeof(e.v) = 'string';
$$;

CREATE FUNCTION public.customer_edit_changes_ok(p jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_typeof(p) = 'object'
    AND p <> '{}'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p) AS e(k, v)
      WHERE e.k <> ALL (public.customer_edit_fields())
         OR jsonb_typeof(e.v) <> 'string'
         OR length(e.v #>> '{}') > CASE WHEN e.k IN ('notes', 'property_notes') THEN 4000 ELSE 200 END
    );
$$;

CREATE FUNCTION public.customer_edit_describe(p jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(string_agg(
           replace(e.k, '_', ' ') || ' → ' || coalesce(nullif(e.v #>> '{}', ''), '(blank)'),
           '; ' ORDER BY array_position(public.customer_edit_fields(), e.k)), '')
    FROM jsonb_each(public.customer_edit_allowed(p)) AS e(k, v);
$$;

CREATE FUNCTION public.customer_edit_fields() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT ARRAY['first_name', 'last_name', 'company', 'phone', 'email',
               'street', 'city', 'state', 'zip',
               'gate_code', 'property_notes', 'notes']::text[];
$$;

CREATE FUNCTION public.customer_email_thread(p_company_id uuid, p_customer_id text) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_thread text;
  v_today text := to_char(now() AT TIME ZONE public.business_time_zone(), 'YYYY-MM-DD');
BEGIN
  SELECT t.id INTO v_thread
    FROM public.email_threads t
   WHERE t.company_id = p_company_id AND t.customer_id = p_customer_id
     AND t.created_at ~ '^\d{4}-\d{2}-\d{2}'
     AND left(t.created_at, 10)::date > (v_today::date - 365)
   ORDER BY t.created_at DESC
   LIMIT 1;
  IF v_thread IS NULL THEN
    v_thread := gen_random_uuid()::text;
    INSERT INTO public.email_threads (id, company_id, customer_id, created_at)
    VALUES (v_thread, p_company_id, p_customer_id, v_today);
  END IF;
  RETURN v_thread;
END;
$$;

CREATE FUNCTION public.decline_customer_edit(p_request_id uuid, p_reason text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  r public.customer_edit_requests;
  v_actor text;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO r FROM public.customer_edit_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_staff(r.company_id) THEN
    RAISE EXCEPTION 'Only the office can decline a suggested change.' USING ERRCODE = '42501';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'This suggestion was already %.', r.status USING ERRCODE = '55000';
  END IF;
  IF char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'The reason is too long (500 characters at most).' USING ERRCODE = '22001';
  END IF;
  v_actor := coalesce(nullif(public.current_crew_name(r.company_id), ''), 'Owner');
  UPDATE public.customer_edit_requests
    SET status = 'declined', decided_user = auth.uid(), decided_by = v_actor, decided_at = now(),
        decline_reason = v_reason
    WHERE id = r.id;
  INSERT INTO public.audit_log
    (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id)
  SELECT gen_random_uuid()::text, r.company_id,
         to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), v_actor, 'Customer', cu.id,
         btrim(cu.first_name || ' ' || cu.last_name), 'suggested change',
         'suggested by ' || r.requested_name,
         CASE WHEN v_reason = '' THEN 'declined' ELSE 'declined: ' || v_reason END,
         cu.id, NULL
  FROM public.customers cu WHERE cu.id = r.customer_id;
END $$;

CREATE FUNCTION public.discard_automation_batch(p_batch_id uuid, p_item_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  b public.automation_batches%ROWTYPE;
  n integer;
BEGIN
  SELECT * INTO b FROM public.automation_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_staff(b.company_id) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF b.status <> 'waiting' THEN
    RETURN 0;
  END IF;

  WITH gone AS (
    UPDATE public.automation_batch_items
       SET status = 'discarded', finished_at = now()
     WHERE batch_id = p_batch_id AND status = 'waiting' AND id = ANY (coalesce(p_item_ids, '{}'))
    RETURNING rule_kind, target_id
  ), stopped AS (
    UPDATE public.invoices v
       SET auto_send_status = 'stopped', auto_send_note = 'not-approved'
      FROM gone g
     WHERE g.rule_kind = 'invoice_send' AND v.id = g.target_id
       AND v.company_id = b.company_id AND v.auto_send_status = 'waiting'
    RETURNING v.id
  )
  SELECT count(*) INTO n FROM gone;

  UPDATE public.automation_batches x
     SET status = CASE WHEN EXISTS (
                    SELECT 1 FROM public.automation_batch_items i
                     WHERE i.batch_id = x.id AND i.status = 'waiting') THEN 'waiting' ELSE 'discarded' END,
         decided_by = auth.uid(), decided_at = now(), updated_at = now()
   WHERE x.id = p_batch_id;
  RETURN n;
END;
$$;

CREATE TABLE public.estimates (
    id text NOT NULL,
    company_id uuid NOT NULL,
    customer_id text NOT NULL,
    job_id text,
    title text DEFAULT ''::text NOT NULL,
    lines jsonb DEFAULT '[]'::jsonb NOT NULL,
    tax_rate numeric DEFAULT 0 NOT NULL,
    discount_type text DEFAULT 'none'::text NOT NULL,
    discount_value numeric DEFAULT 0 NOT NULL,
    status text NOT NULL,
    created_date text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    email_queued_at text,
    options jsonb,
    accepted_option_id text,
    accepted_by text,
    accepted_at text,
    expected_crew integer,
    visit_date text,
    visit_time text,
    equipment_ids text[],
    expected_climbers integer,
    expected_groundsmen integer,
    expected_crew_ids text[],
    created_by_crew_id text,
    CONSTRAINT estimates_equipment_ids_size CHECK (((equipment_ids IS NULL) OR (cardinality(equipment_ids) <= 100))),
    CONSTRAINT estimates_expected_climbers_range CHECK (((expected_climbers IS NULL) OR ((expected_climbers >= 0) AND (expected_climbers <= 50)))),
    CONSTRAINT estimates_expected_crew_ids_size CHECK (((expected_crew_ids IS NULL) OR (cardinality(expected_crew_ids) <= 100))),
    CONSTRAINT estimates_expected_groundsmen_range CHECK (((expected_groundsmen IS NULL) OR ((expected_groundsmen >= 0) AND (expected_groundsmen <= 50))))
);

COMMENT ON COLUMN public.estimates.equipment_ids IS 'Internal: equipment the job needs (equipment ids). Never shown to the customer.';

COMMENT ON COLUMN public.estimates.expected_climbers IS 'Internal: climbers the estimator expects the job to take.';

COMMENT ON COLUMN public.estimates.expected_groundsmen IS 'Internal: groundsmen the estimator expects the job to take.';

COMMENT ON COLUMN public.estimates.expected_crew_ids IS 'Internal: named crew the estimator expects on the job (crew ids).';

COMMENT ON COLUMN public.estimates.created_by_crew_id IS 'Roster card (crew.id) of the app user who added the estimate. Set by trigger estimate_author_on_insert; app users cannot change it. NULL = added by the service role (or before authors were recorded).';

CREATE FUNCTION public.done_job_review_reason(j public.jobs, e public.estimates) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_today text := to_char(now() AT TIME ZONE public.business_time_zone(), 'YYYY-MM-DD');
  v_lines jsonb;
  v_subtotal numeric;
BEGIN
  IF (j.invoice_id IS NOT NULL AND j.invoice_id <> '')
     OR EXISTS (SELECT 1 FROM public.invoices i
                 WHERE i.company_id = j.company_id
                   AND (i.job_id = j.id OR (j.estimate_id IS NOT NULL AND i.estimate_id = j.estimate_id))) THEN
    RETURN 'has_invoice';
  END IF;
  IF coalesce(j.billing_type, 'flat') = 'hourly' THEN
    RETURN 'hourly';
  END IF;
  IF coalesce(j.materials_cost, 0) <> 0 OR coalesce(j.other_cost, 0) <> 0 THEN
    RETURN 'extra_costs';
  END IF;
  IF j.end_date ~ '^\d{4}-\d{2}-\d{2}' AND left(j.end_date, 10) > left(j.date, 10)
     AND v_today < left(j.end_date, 10) THEN
    RETURN 'multi_day';
  END IF;
  IF coalesce(j.recurring, '') <> '' THEN
    RETURN 'recurring';
  END IF;
  IF e.id IS NULL OR e.status <> 'accepted' OR e.customer_id <> j.customer_id THEN
    RETURN 'no_estimate';
  END IF;
  -- A Climber replaced the price: the job's own value is billed.
  IF j.replaced_price IS NOT NULL THEN
    IF coalesce(j.value, 0) <= 0 THEN
      RETURN 'no_price';
    END IF;
    RETURN NULL;
  END IF;
  IF e.accepted_option_id IS NOT NULL AND e.accepted_option_id <> '' THEN
    SELECT o -> 'lines' INTO v_lines
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.options) = 'array' THEN e.options ELSE '[]'::jsonb END) o
     WHERE o ->> 'id' = e.accepted_option_id
     LIMIT 1;
    IF v_lines IS NULL THEN
      RETURN 'no_estimate';
    END IF;
  ELSE
    v_lines := e.lines;
  END IF;
  IF jsonb_typeof(v_lines) <> 'array' OR jsonb_array_length(v_lines) = 0 THEN
    RETURN 'no_price';
  END IF;
  SELECT sum(
           CASE WHEN (l ->> 'quantity') ~ '^-?\d+(\.\d+)?$' THEN (l ->> 'quantity')::numeric ELSE 0 END *
           CASE WHEN (l ->> 'unitPrice') ~ '^-?\d+(\.\d+)?$' THEN (l ->> 'unitPrice')::numeric ELSE 0 END)
    INTO v_subtotal
    FROM jsonb_array_elements(v_lines) l;
  IF coalesce(v_subtotal, 0) <= 0 THEN
    RETURN 'no_price';
  END IF;
  RETURN NULL;
END;
$_$;

CREATE FUNCTION public.drop_replaced_document_file() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF OLD.file_id IS NOT NULL
     AND (TG_OP = 'DELETE' OR NEW.file_id IS DISTINCT FROM OLD.file_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.company_documents d
       WHERE d.company_id = OLD.company_id AND d.file_id = OLD.file_id
     ) THEN
    DELETE FROM public.company_document_files f
      WHERE f.company_id = OLD.company_id AND f.id = OLD.file_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.equipment_problem_has_photo() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.equipment_problems SET has_photo = true
      WHERE id = NEW.problem_id AND company_id = NEW.company_id;
  ELSE
    UPDATE public.equipment_problems SET has_photo = false
      WHERE id = OLD.problem_id AND company_id = OLD.company_id;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION public.estimate_accept_links_revoke_on_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF public.estimate_content_hash(OLD) IS DISTINCT FROM public.estimate_content_hash(NEW) THEN
    UPDATE public.estimate_accept_links
       SET revoked_at = now(), revoked_reason = 'changed'
     WHERE estimate_id = NEW.id AND revoked_at IS NULL AND accepted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.estimate_accept_view(p_token_hash text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE
  l public.estimate_accept_links%ROWTYPE;
  e public.estimates%ROWTYPE;
  c public.customers%ROWTYPE;
  st text;
  v_terms int;
  v_out jsonb;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'not-found');
  END IF;
  SELECT * INTO l FROM public.estimate_accept_links WHERE token_hash = p_token_hash;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not-found');
  END IF;
  SELECT * INTO e FROM public.estimates WHERE id = l.estimate_id AND company_id = l.company_id;
  st := public.estimate_link_state(l, e);
  v_out := jsonb_build_object('status', st, 'company', public.company_for_customer(l.company_id));
  IF st NOT IN ('open', 'accepted', 'accepted-elsewhere') THEN
    RETURN v_out;
  END IF;

  SELECT * INTO c FROM public.customers WHERE id = e.customer_id AND company_id = e.company_id;
  SELECT CASE WHEN c.customer_type = 'commercial' THEN s.commercial_terms_days ELSE s.residential_terms_days END
    INTO v_terms FROM public.settings s WHERE s.company_id = e.company_id;

  IF st = 'open' AND l.first_viewed_at IS NULL THEN
    UPDATE public.estimate_accept_links SET first_viewed_at = now() WHERE id = l.id;
  END IF;

  RETURN v_out || jsonb_build_object(
    'estimate', public.estimate_for_customer(e),
    'greeting', coalesce(nullif(trim(c.first_name), ''), nullif(trim(c.company_name), ''), nullif(trim(c.company), ''), ''),
    'terms_days', coalesce(v_terms, 0),
    'billing_terms', coalesce(nullif(trim(c.billing_terms), ''), ''),
    'expires_at', l.expires_at,
    'accepted_option_id', CASE WHEN st = 'open' THEN NULL ELSE e.accepted_option_id END,
    'accepted_at', CASE WHEN st = 'open' THEN NULL ELSE e.accepted_at END);
END;
$_$;

CREATE FUNCTION public.estimate_active_total(e public.estimates) RETURNS numeric
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_lines jsonb;
  v_sub numeric;
  v_disc numeric := 0;
  v_dv numeric := coalesce(e.discount_value, 0);
BEGIN
  IF e.accepted_option_id IS NOT NULL AND e.accepted_option_id <> '' AND jsonb_typeof(e.options) = 'array' THEN
    SELECT o -> 'lines' INTO v_lines FROM jsonb_array_elements(e.options) o
     WHERE o ->> 'id' = e.accepted_option_id LIMIT 1;
  END IF;
  IF v_lines IS NULL THEN
    v_lines := e.lines;
  END IF;
  IF v_lines IS NULL OR jsonb_typeof(v_lines) <> 'array' THEN
    v_lines := '[]'::jsonb;
  END IF;
  SELECT coalesce(sum(
           CASE WHEN (l ->> 'quantity') ~ '^-?\d+(\.\d+)?$' THEN (l ->> 'quantity')::numeric ELSE 0 END *
           CASE WHEN (l ->> 'unitPrice') ~ '^-?\d+(\.\d+)?$' THEN (l ->> 'unitPrice')::numeric ELSE 0 END), 0)
    INTO v_sub
    FROM jsonb_array_elements(v_lines) l;
  IF e.discount_type = 'percent' THEN
    v_disc := v_sub * (least(100, greatest(0, v_dv)) / 100);
  ELSIF e.discount_type = 'fixed' THEN
    v_disc := least(v_sub, greatest(0, v_dv));
  END IF;
  RETURN round((v_sub - v_disc) * (1 + coalesce(e.tax_rate, 0) / 100), 2);
END;
$_$;

CREATE FUNCTION public.estimate_author_card(p_company_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT c.id FROM public.crew c
  WHERE c.auth_user_id = auth.uid() AND c.company_id = p_company_id
    AND public.current_crew_id(p_company_id) IS NOT NULL
  ORDER BY (c.status = 'active' AND lower(btrim(c.role)) = 'sales') DESC,
           (c.status = 'active') DESC,
           c.id
  LIMIT 1;
$$;

CREATE FUNCTION public.estimate_content_hash(e public.estimates) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT md5(jsonb_build_array(
    e.customer_id, e.title, e.lines, coalesce(e.options, '[]'::jsonb),
    e.tax_rate, e.discount_type, e.discount_value, e.notes)::text);
$$;

CREATE FUNCTION public.estimate_for_customer(e public.estimates) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'title', e.title,
    'created_date', e.created_date,
    'notes', e.notes,
    'tax_rate', e.tax_rate,
    'discount_type', e.discount_type,
    'discount_value', e.discount_value,
    'lines', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'description', coalesce(l->>'description', ''),
        'quantity', coalesce(l->'quantity', '0'::jsonb),
        'unitPrice', coalesce(l->'unitPrice', '0'::jsonb)) ORDER BY n)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.lines) = 'array' THEN e.lines ELSE '[]'::jsonb END)
             WITH ORDINALITY AS x(l, n)), '[]'::jsonb),
    'options', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', coalesce(o->>'id', ''),
        'label', coalesce(o->>'label', ''),
        'description', coalesce(o->>'description', ''),
        'lines', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'description', coalesce(l->>'description', ''),
            'quantity', coalesce(l->'quantity', '0'::jsonb),
            'unitPrice', coalesce(l->'unitPrice', '0'::jsonb)) ORDER BY m)
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o->'lines') = 'array' THEN o->'lines' ELSE '[]'::jsonb END)
                 WITH ORDINALITY AS y(l, m)), '[]'::jsonb)) ORDER BY n)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.options) = 'array' THEN e.options ELSE '[]'::jsonb END)
             WITH ORDINALITY AS x(o, n)), '[]'::jsonb)
  );
$$;

CREATE FUNCTION public.estimate_heads_up_recipients(p_company_id uuid) RETURNS text[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(array_agg(DISTINCT lower(trim(u.email))), ARRAY[]::text[])
    FROM public.company_members m
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.company_id = p_company_id
     AND m.role = 'manager'
     AND u.email_confirmed_at IS NOT NULL
     AND coalesce(trim(u.email), '') <> ''
     AND EXISTS (SELECT 1 FROM public.crew c
                  WHERE c.company_id = p_company_id AND c.auth_user_id = m.user_id AND c.status = 'active');
$$;

CREATE TABLE public.estimate_accept_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    estimate_id text NOT NULL,
    token_hash text NOT NULL,
    content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '60 days'::interval) NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text,
    first_viewed_at timestamp with time zone,
    accepted_at timestamp with time zone,
    accepted_option_id text,
    accepted_name text,
    CONSTRAINT estimate_accept_links_accepted_name_check CHECK ((char_length(accepted_name) <= 100)),
    CONSTRAINT estimate_accept_links_revoked_reason_check CHECK ((revoked_reason = ANY (ARRAY['changed'::text, 'replaced'::text, 'email-failed'::text]))),
    CONSTRAINT estimate_accept_links_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE FUNCTION public.estimate_link_state(l public.estimate_accept_links, e public.estimates) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
    WHEN e.id IS NULL THEN 'not-found'
    -- Dead links never show the estimate, accepted or not.
    WHEN l.revoked_at IS NOT NULL
         OR l.content_hash IS DISTINCT FROM public.estimate_content_hash(e) THEN 'changed'
    WHEN l.expires_at <= now() THEN 'expired'
    -- A live link.
    WHEN e.status = 'accepted' AND l.accepted_at IS NOT NULL THEN 'accepted'
    WHEN e.status = 'accepted' THEN 'accepted-elsewhere'
    -- This link accepted it, but the office took the acceptance back.
    WHEN l.accepted_at IS NOT NULL THEN 'changed'
    WHEN e.status = 'closed' THEN 'closed'
    ELSE 'open'
  END;
$$;

CREATE FUNCTION public.finish_automation_send(p_send_id uuid, p_ok boolean, p_body text DEFAULT ''::text, p_job_id text DEFAULT NULL::text, p_estimate_id text DEFAULT NULL::text, p_sender_name text DEFAULT 'Automatic email'::text) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  s public.automation_sends%ROWTYPE;
  v_thread text;
  v_message text := gen_random_uuid()::text;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  SELECT * INTO s FROM public.automation_sends WHERE id = p_send_id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'sending' THEN
    RETURN NULL;
  END IF;
  IF NOT p_ok THEN
    UPDATE public.automation_sends SET status = 'failed' WHERE id = p_send_id;
    IF s.rule_kind = 'estimate_sent' THEN
      UPDATE public.estimate_accept_links
         SET revoked_at = now(), revoked_reason = 'email-failed'
       WHERE id::text = s.target_id AND company_id = s.company_id AND revoked_at IS NULL;
    END IF;
    RETURN NULL;
  END IF;

  v_thread := public.customer_email_thread(s.company_id, s.customer_id);
  INSERT INTO public.messages
    (id, company_id, customer_id, job_id, estimate_id, channel, direction,
     sender_crew_id, sender_name, body, created_at, from_number, thread_id, automatic)
  VALUES
    (v_message, s.company_id, s.customer_id, p_job_id, p_estimate_id, 'email', 'out',
     '', left(coalesce(nullif(trim(p_sender_name), ''), 'Automatic email'), 100),
     coalesce(p_body, ''), v_now, NULL, v_thread, true);

  UPDATE public.automation_sends
     SET status = 'sent', sent_at = now(), message_id = v_message
   WHERE id = p_send_id;

  IF s.rule_kind = 'estimate_sent' AND p_estimate_id IS NOT NULL THEN
    UPDATE public.estimates
       SET email_queued_at = v_now,
           status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END
     WHERE id = p_estimate_id AND company_id = s.company_id;
  END IF;
  IF s.rule_kind = 'invoice_emailed' THEN
    UPDATE public.invoices
       SET emailed_at = now(), email_queued_at = v_now
     WHERE id = s.target_id AND company_id = s.company_id;
  END IF;
  RETURN v_message;
END;
$$;

CREATE FUNCTION public.finish_day_plan_send(p_send_id uuid, p_ok boolean) RETURNS boolean
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
  UPDATE public.automation_sends
     SET status = CASE WHEN p_ok THEN 'sent' ELSE 'failed' END,
         sent_at = CASE WHEN p_ok THEN now() END
   WHERE id = p_send_id AND rule_kind = 'day_plan' AND status = 'sending'
  RETURNING true;
$$;

CREATE FUNCTION public.handle_crew_email_confirmed() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL THEN
    PERFORM public.process_confirmed_signup(NEW.id, NEW.email, NEW.raw_user_meta_data);
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.handle_new_crew_signup() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.email_confirmed_at IS NOT NULL THEN
    PERFORM public.process_confirmed_signup(NEW.id, NEW.email, NEW.raw_user_meta_data);
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.hold_automation_emails(p_company_id uuid, p_items jsonb) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_batch uuid;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('automation_batches:' || p_company_id::text));
  SELECT id INTO v_batch FROM public.automation_batches
   WHERE company_id = p_company_id AND status IN ('waiting', 'sending')
   FOR UPDATE;
  IF v_batch IS NULL THEN
    INSERT INTO public.automation_batches (company_id) VALUES (p_company_id) RETURNING id INTO v_batch;
  END IF;

  INSERT INTO public.automation_batch_items
    (batch_id, company_id, rule_kind, dedupe_key, target_id, customer_id, customer_name, due_day)
  SELECT v_batch, p_company_id, x->>'kind', x->>'dedupe_key', coalesce(x->>'target_id', ''),
         x->>'customer_id', left(coalesce(x->>'customer_name', ''), 200),
         CASE WHEN coalesce(x->>'due_day', '') ~ '^\d{4}-\d{2}-\d{2}$' THEN x->>'due_day' END
    FROM jsonb_array_elements(p_items) AS x
   WHERE NOT EXISTS (
           SELECT 1 FROM public.automation_sends s
            WHERE s.company_id = p_company_id AND s.dedupe_key = x->>'dedupe_key'
              AND NOT (s.status = 'failed' AND s.attempts < 3))
     AND NOT EXISTS (
           SELECT 1 FROM public.automation_batch_items i
            WHERE i.company_id = p_company_id AND i.dedupe_key = x->>'dedupe_key'
              AND i.status IN ('waiting', 'discarded'))
  ON CONFLICT DO NOTHING;

  UPDATE public.automation_batches SET updated_at = now() WHERE id = v_batch;
  RETURN v_batch;
END;
$_$;

CREATE FUNCTION public.invoice_for_done_job(j public.jobs) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  e public.estimates%ROWTYPE;
  c public.customers%ROWTYPE;
  st public.settings%ROWTYPE;
  v_reason text;
  v_lines jsonb;
  v_tax numeric;
  v_dtype text;
  v_dvalue numeric;
  v_id text := gen_random_uuid()::text;
  v_number text;
  v_today text := to_char(now() AT TIME ZONE public.business_time_zone(), 'YYYY-MM-DD');
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_days integer;
  v_send boolean;
BEGIN
  -- The job's estimate: the one it links to, else the one accepted estimate pointing at it.
  IF j.estimate_id IS NOT NULL AND j.estimate_id <> '' THEN
    SELECT * INTO e FROM public.estimates WHERE id = j.estimate_id AND company_id = j.company_id;
  END IF;
  IF e.id IS NULL THEN
    SELECT * INTO e FROM public.estimates
     WHERE company_id = j.company_id AND job_id = j.id AND status = 'accepted'
     ORDER BY id LIMIT 1;
  END IF;

  v_reason := public.done_job_review_reason(j, e);
  IF v_reason IS NOT NULL THEN
    INSERT INTO public.invoice_reviews (company_id, job_id, customer_id, reason)
    VALUES (j.company_id, j.id, j.customer_id, v_reason)
    ON CONFLICT (company_id, job_id) DO UPDATE SET reason = EXCLUDED.reason, created_at = now();
    RETURN NULL;
  END IF;

  IF j.replaced_price IS NOT NULL THEN
    -- A Climber's price replaces the estimate's (business rule).
    v_lines := jsonb_build_array(jsonb_build_object(
      'description', coalesce(j.service_type, '') || ' — ' || coalesce(j.title, ''),
      'quantity', 1,
      'unitPrice', j.value));
    v_tax := 0;
    v_dtype := 'none';
    v_dvalue := 0;
  ELSE
    IF e.accepted_option_id IS NOT NULL AND e.accepted_option_id <> '' THEN
      SELECT o -> 'lines' INTO v_lines FROM jsonb_array_elements(e.options) o
       WHERE o ->> 'id' = e.accepted_option_id LIMIT 1;
    ELSE
      v_lines := e.lines;
    END IF;
    v_tax := coalesce(e.tax_rate, 0);
    v_dtype := coalesce(e.discount_type, 'none');
    v_dvalue := coalesce(e.discount_value, 0);
  END IF;

  SELECT * INTO c FROM public.customers WHERE id = j.customer_id AND company_id = j.company_id;
  SELECT * INTO st FROM public.settings WHERE company_id = j.company_id;
  v_days := CASE WHEN c.customer_type = 'commercial'
                 THEN coalesce(st.commercial_terms_days, 30)
                 ELSE coalesce(st.residential_terms_days, 0) END;

  -- Same numbering as the app: INV-<highest number + 1>, from INV-1001.
  PERFORM pg_advisory_xact_lock(hashtext('invoice-number:' || j.company_id::text));
  SELECT 'INV-' || (coalesce(max(n), 1000) + 1)::text INTO v_number
    FROM (SELECT regexp_replace(number, '\D', '', 'g') AS d FROM public.invoices WHERE company_id = j.company_id) x,
         LATERAL (SELECT CASE WHEN d <> '' AND length(d) <= 15 THEN d::bigint END AS n) y;

  v_send := coalesce(st.auto_emails, false)
    AND EXISTS (SELECT 1 FROM public.automations a
                 WHERE a.company_id = j.company_id AND a.kind = 'invoice_send' AND a.enabled)
    AND coalesce(c.no_auto_emails, false) = false
    AND coalesce(trim(c.email), '') ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$';

  INSERT INTO public.invoices
    (id, company_id, number, customer_id, job_id, estimate_id, lines, tax_rate,
     discount_type, discount_value, status, issued_date, due_date, paid_date,
     email_queued_at, splits, auto_created, auto_send_at, auto_send_status)
  VALUES
    (v_id, j.company_id, v_number, j.customer_id, j.id, e.id, v_lines, v_tax,
     v_dtype, v_dvalue, 'unpaid', v_today,
     to_char(v_today::date + greatest(v_days, 0), 'YYYY-MM-DD'), NULL,
     NULL, '[]'::jsonb, true,
     CASE WHEN v_send THEN now() + interval '2 hours' END,
     CASE WHEN v_send THEN 'waiting' END);

  INSERT INTO public.audit_log
    (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id)
  VALUES
    (gen_random_uuid()::text, j.company_id, v_now, 'Automatic (job marked done)', 'Invoice', v_id,
     v_number, '(created)', '', v_number, j.customer_id, j.id),
    (gen_random_uuid()::text, j.company_id, v_now, 'Automatic (job marked done)', 'Job', j.id,
     j.title, 'invoice', '(blank)', v_number, j.customer_id, j.id);

  DELETE FROM public.invoice_reviews WHERE company_id = j.company_id AND job_id = j.id;
  RETURN v_id;
END;
$_$;

CREATE FUNCTION public.invoice_is_split(p_splits jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_typeof(p_splits) = 'array' AND jsonb_array_length(p_splits) > 0;
$$;

CREATE FUNCTION public.invoices_after_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.job_id IS NOT NULL AND NEW.job_id <> '' THEN
    IF NOT NEW.auto_created THEN
      UPDATE public.invoices
         SET auto_send_status = 'stopped', auto_send_note = 'another-invoice'
       WHERE company_id = NEW.company_id AND job_id = NEW.job_id
         AND id <> NEW.id AND auto_send_status = 'waiting';
    END IF;
    -- The job has an invoice now: nothing left to review.
    DELETE FROM public.invoice_reviews
     WHERE company_id = NEW.company_id AND job_id = NEW.job_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.invoices_auto_send_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  auto_cols text[] := ARRAY['auto_created', 'auto_send_at', 'auto_send_status', 'auto_send_note',
                            'auto_sent_at', 'auto_send_claimed_at', 'auto_undo_until', 'emailed_at'];
BEGIN
  -- Migrations, the service role (run-automations, send-invoice) and the
  -- SECURITY DEFINER functions are not limited.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.auto_created := false;
    NEW.auto_send_at := NULL;
    NEW.auto_send_status := NULL;
    NEW.auto_send_note := NULL;
    NEW.auto_sent_at := NULL;
    NEW.auto_send_claimed_at := NULL;
    NEW.auto_undo_until := NULL;
    NEW.emailed_at := NULL;
    RETURN NEW;
  END IF;

  NEW.auto_created := OLD.auto_created;
  NEW.auto_send_at := OLD.auto_send_at;
  NEW.auto_sent_at := OLD.auto_sent_at;
  NEW.auto_send_claimed_at := OLD.auto_send_claimed_at;
  NEW.auto_undo_until := OLD.auto_undo_until;
  NEW.emailed_at := OLD.emailed_at;
  IF NEW.auto_send_status IS DISTINCT FROM OLD.auto_send_status THEN
    IF OLD.auto_send_status = 'waiting' AND NEW.auto_send_status = 'stopped' THEN
      NEW.auto_send_note := 'stopped';
      NEW.auto_undo_until := NULL;
    ELSE
      NEW.auto_send_status := OLD.auto_send_status;
      NEW.auto_send_note := OLD.auto_send_note;
    END IF;
  ELSE
    NEW.auto_send_note := OLD.auto_send_note;
  END IF;

  IF (to_jsonb(NEW) - auto_cols) IS DISTINCT FROM (to_jsonb(OLD) - auto_cols) THEN
    -- Someone worked on it: a later Undo of Done keeps it.
    NEW.auto_undo_until := NULL;
    -- Any real change to a waiting invoice cancels its automatic email.
    IF OLD.auto_send_status = 'waiting' AND NEW.auto_send_status = 'waiting' THEN
      NEW.auto_send_status := 'stopped';
      NEW.auto_send_note := 'edited';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.invoices_unique_number() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('invoice-number:' || NEW.company_id::text));
  IF coalesce(trim(NEW.number), '') = ''
     OR EXISTS (SELECT 1 FROM public.invoices
                 WHERE company_id = NEW.company_id AND number = NEW.number AND id <> NEW.id) THEN
    NEW.number := public.next_invoice_number(NEW.company_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.is_climber(p_company_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF public.current_crew_id(p_company_id) IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.crew c
    WHERE c.company_id = p_company_id AND c.auth_user_id = auth.uid()
      AND c.role = 'Climber' AND c.status = 'active'
  );
END;
$$;

CREATE FUNCTION public.is_company_admin(p_company_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
      AND role IN ('owner', 'manager')
  ) AND (
    COALESCE(auth.jwt() ->> 'aal', '') = 'aal2'
    OR NOT EXISTS (
      SELECT 1 FROM auth.mfa_factors f
      WHERE f.user_id = auth.uid() AND f.status = 'verified'
    )
  );
$$;

CREATE FUNCTION public.is_company_member(p_company_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) AND (
    COALESCE(auth.jwt() ->> 'aal', '') = 'aal2'
    OR NOT EXISTS (
      SELECT 1 FROM auth.mfa_factors f
      WHERE f.user_id = auth.uid() AND f.status = 'verified'
    )
  );
$$;

CREATE FUNCTION public.is_company_owner(p_company_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
      AND role = 'owner'
  ) AND (
    COALESCE(auth.jwt() ->> 'aal', '') = 'aal2'
    OR NOT EXISTS (
      SELECT 1 FROM auth.mfa_factors f
      WHERE f.user_id = auth.uid() AND f.status = 'verified'
    )
  );
$$;

CREATE FUNCTION public.is_company_staff(p_company_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
      AND role IN ('owner', 'manager', 'office')
  ) AND (
    COALESCE(auth.jwt() ->> 'aal', '') = 'aal2'
    OR NOT EXISTS (
      SELECT 1 FROM auth.mfa_factors f
      WHERE f.user_id = auth.uid() AND f.status = 'verified'
    )
  );
$$;

CREATE FUNCTION public.is_sales_person(p_company_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT public.is_company_member(p_company_id) AND EXISTS (
    SELECT 1 FROM public.crew
    WHERE auth_user_id = auth.uid() AND company_id = p_company_id
      AND lower(btrim(role)) = 'sales'
      AND status = 'active'
  );
$$;

CREATE FUNCTION public.job_cost_columns() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT ARRAY['labor_rate', 'materials_cost', 'other_cost']::text[] $$;

CREATE FUNCTION public.job_money_columns() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT ARRAY['value', 'hourly_rate', 'labor_rate', 'materials_cost', 'other_cost', 'replaced_price']::text[] $$;

CREATE FUNCTION public.job_money_visible(p_company_id uuid, p_crew_ids text[], p_date text, p_estimate_id text, p_customer_id text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT public.is_company_member(p_company_id) THEN
    RETURN false;
  END IF;
  IF public.is_company_staff(p_company_id) THEN
    RETURN true;
  END IF;
  IF public.is_sales_person(p_company_id) THEN
    RETURN EXISTS (
        SELECT 1 FROM public.customers cu
         WHERE cu.company_id = p_company_id AND cu.id = p_customer_id
           AND lower(btrim(coalesce(cu.customer_type, ''))) <> 'commercial')
      OR (p_estimate_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.estimates e
          JOIN public.crew c ON c.id = e.created_by_crew_id AND c.company_id = e.company_id
         WHERE e.company_id = p_company_id AND e.id = p_estimate_id
           AND c.auth_user_id = auth.uid()));
  END IF;
  RETURN public.crew_perm(p_company_id, 'seeMoney');
END;
$$;

CREATE FUNCTION public.job_office_columns() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT ARRAY['office_notes']::text[] $$;

CREATE FUNCTION public.job_price_before_change(j public.jobs) RETURNS numeric
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  e public.estimates;
BEGIN
  IF j.billing_type = 'hourly' AND j.hourly_rate IS NOT NULL AND coalesce(j.estimated_hours, 0) > 0 THEN
    RETURN round(j.hourly_rate * j.estimated_hours, 2);
  END IF;
  IF j.replaced_price IS NULL THEN
    IF j.estimate_id IS NOT NULL AND j.estimate_id <> '' THEN
      SELECT * INTO e FROM public.estimates WHERE id = j.estimate_id AND company_id = j.company_id;
    END IF;
    IF e.id IS NULL THEN
      SELECT * INTO e FROM public.estimates
       WHERE company_id = j.company_id AND job_id = j.id AND status = 'accepted'
       ORDER BY id LIMIT 1;
    END IF;
    IF e.id IS NOT NULL THEN
      RETURN public.estimate_active_total(e);
    END IF;
  END IF;
  RETURN j.value;
END;
$$;

CREATE FUNCTION public.job_row_assigned(p_company_id uuid, p_crew_ids text[], p_date text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  me text;
BEGIN
  IF NOT public.is_company_member(p_company_id) THEN
    RETURN false;
  END IF;
  IF public.is_company_staff(p_company_id) THEN
    RETURN true;
  END IF;
  me := public.current_crew_id(p_company_id);
  IF me IS NULL THEN
    RETURN false;
  END IF;
  IF me = ANY (p_crew_ids) THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.day_crews d
    WHERE d.company_id = p_company_id
      AND d.date = p_date
      AND me = ANY (d.member_ids)
      AND d.member_ids && p_crew_ids
  );
END;
$$;

CREATE FUNCTION public.job_row_visible(p_company_id uuid, p_crew_ids text[], p_date text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  me text;
BEGIN
  IF public.job_row_assigned(p_company_id, p_crew_ids, p_date) THEN
    RETURN true;
  END IF;
  IF public.crew_perm(p_company_id, 'seeAllJobs') THEN
    RETURN true;
  END IF;
  me := public.current_crew_id(p_company_id);
  IF me IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.company_id = p_company_id AND j.date = p_date AND me = ANY (j.crew_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.day_crews d
    WHERE d.company_id = p_company_id AND d.date = p_date AND me = ANY (d.member_ids)
  );
END;
$$;

CREATE FUNCTION public.keep_estimate_author() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF COALESCE(auth.role(), '') = 'authenticated' THEN
    NEW.created_by_crew_id := OLD.created_by_crew_id;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.limit_crew_clock_times() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  live_only constant text :=
    'Clock times come from tapping Clock in and Clock out on your phone. Ask the office to change them.';
  v_now timestamptz;
  v text;
BEGIN
  -- Only signed-in app users are limited; migrations, the dashboard
  -- and the service role are not.
  IF COALESCE(auth.role(), '') <> 'authenticated' OR public.may_enter_hours_by_hand(NEW.company_id) THEN
    RETURN NEW;
  END IF;
  v_now := public.clock_now();
  -- One check at a time per person: two requests sent together (each
  -- in its own transaction) would otherwise not see each other's entry
  -- and could both be saved. Released at the end of the transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':' || COALESCE(NEW.crew_id, ''), 0));

  IF TG_OP = 'INSERT' THEN
    -- An upsert of an entry that is already there becomes an update,
    -- which this trigger checks against the old row.
    IF EXISTS (SELECT 1 FROM public.timesheets t WHERE t.id = NEW.id) THEN
      RETURN NEW;
    END IF;
    IF NEW.hours IS NOT NULL THEN
      RAISE EXCEPTION 'Hours can only be typed by the office, or by someone allowed to enter hours by hand.'
        USING ERRCODE = '42501';
    END IF;
    NEW.auto_closed := false;
    IF NEW.clock_out IS NOT NULL AND NEW.clock_in IS NULL THEN
      RAISE EXCEPTION '%', live_only USING ERRCODE = '42501';
    END IF;
    IF NEW.clock_in IS NOT NULL THEN
      PERFORM public.check_crew_clock_tap(NEW.date, NEW.clock_in, NULL, 'in', v_now);
    END IF;
    IF NEW.clock_out IS NOT NULL THEN
      v := public.check_crew_clock_tap(NEW.date, NEW.clock_out, NEW.clock_in, 'out', v_now);
      IF v = 'cap' THEN
        NEW.clock_out := '20:00';
        NEW.auto_closed := true;
      END IF;
    END IF;
    IF NEW.clock_in IS NOT NULL AND public.timesheet_crew_overlap(
         NEW.company_id, NEW.crew_id, NEW.id, NEW.date, NEW.clock_in, NEW.clock_out) THEN
      RAISE EXCEPTION 'These hours overlap another of your time entries and couldn''t be saved. Tell the office the time you tapped: % at %.',
        NEW.date, left(COALESCE(NEW.clock_out, NEW.clock_in), 5)
        USING ERRCODE = 'CT001';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.hours IS DISTINCT FROM OLD.hours THEN
    RAISE EXCEPTION 'Hours can only be typed by the office, or by someone allowed to enter hours by hand.'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.date IS DISTINCT FROM OLD.date THEN
    RAISE EXCEPTION '%', live_only USING ERRCODE = '42501';
  END IF;
  -- A tap never changes an entry's clock-in (clocking in makes a new
  -- entry), and clocks out only an open entry.
  IF NEW.clock_in IS DISTINCT FROM OLD.clock_in THEN
    RAISE EXCEPTION '%', live_only USING ERRCODE = '42501';
  END IF;
  IF NEW.clock_out IS DISTINCT FROM OLD.clock_out THEN
    -- A clock-out tap that arrives after the 8 PM rule closed the entry
    -- (the phone had no signal): a real tap from that day replaces the
    -- 20:00; a tap at 8 PM or later changes nothing.
    IF OLD.clock_out IS NOT NULL AND OLD.auto_closed AND left(OLD.clock_out, 5) = '20:00'
       AND NEW.clock_out ~ '^\d{2}:\d{2}' THEN
      IF left(NEW.clock_out, 5) >= '20:00' THEN
        NEW.clock_out := OLD.clock_out;
        NEW.auto_closed := true;
        RETURN NEW;
      END IF;
      v := public.check_crew_clock_tap(NEW.date, NEW.clock_out, NEW.clock_in, 'out', v_now);
      IF v = 'ok' THEN
        NEW.auto_closed := false;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'This clock-out couldn''t be saved: the entry was already closed at 8 PM. Tell the office the time you tapped: % at %.',
        NEW.date, left(NEW.clock_out, 5)
        USING ERRCODE = 'CT001';
    END IF;
    IF OLD.clock_out IS NOT NULL OR NEW.clock_out IS NULL THEN
      RAISE EXCEPTION '%', live_only USING ERRCODE = '42501';
    END IF;
    v := public.check_crew_clock_tap(NEW.date, NEW.clock_out, NEW.clock_in, 'out', v_now);
    IF v = 'cap' THEN
      NEW.clock_out := '20:00';
      NEW.auto_closed := true;
    ELSE
      NEW.auto_closed := false;
    END IF;
  ELSE
    NEW.auto_closed := OLD.auto_closed;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.limit_crew_job_edits() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  job_role text;
BEGIN
  -- Only signed-in app users are limited; migrations, the dashboard
  -- and the service role are not.
  IF COALESCE(auth.role(), '') <> 'authenticated' OR public.is_company_staff(OLD.company_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'A job''s id and company cannot be changed.' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('scheduled', 'in_progress', 'done') THEN
    RAISE EXCEPTION 'A job''s status can only be scheduled, in progress or done.' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO job_role FROM public.crew
    WHERE auth_user_id = auth.uid() AND company_id = OLD.company_id LIMIT 1;
  IF job_role = 'Climber' THEN
    -- Climbers edit the work on their jobs, prices included (with a
    -- reason, through change_job_price; the costs only with "see
    -- money"), but the office decides when and for whom a job is, and
    -- how it is billed.
    IF NEW.date IS DISTINCT FROM OLD.date
       OR NEW.end_date IS DISTINCT FROM OLD.end_date
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.address_id IS DISTINCT FROM OLD.address_id
       OR NEW.estimate_id IS DISTINCT FROM OLD.estimate_id THEN
      RAISE EXCEPTION 'Only the office can change a job''s date, customer, address or estimate.'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
       OR NEW.recurring IS DISTINCT FROM OLD.recurring
       OR NEW.recurring_until IS DISTINCT FROM OLD.recurring_until THEN
      RAISE EXCEPTION 'Only the office can change a job''s invoice or repeat settings.'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.office_notes IS DISTINCT FROM OLD.office_notes THEN
      RAISE EXCEPTION 'Only the office can change office notes.' USING ERRCODE = '42501';
    END IF;
    IF (NEW.value IS DISTINCT FROM OLD.value
        OR NEW.hourly_rate IS DISTINCT FROM OLD.hourly_rate
        OR NEW.billing_type IS DISTINCT FROM OLD.billing_type
        OR NEW.replaced_price IS DISTINCT FROM OLD.replaced_price)
       AND COALESCE(current_setting('app.job_price_change', true), '') IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'A price change needs a reason: use "Change the price" on the job.'
        USING ERRCODE = '42501';
    END IF;
    IF (NEW.labor_rate IS DISTINCT FROM OLD.labor_rate
        OR NEW.materials_cost IS DISTINCT FROM OLD.materials_cost
        OR NEW.other_cost IS DISTINCT FROM OLD.other_cost)
       AND NOT public.job_money_visible(OLD.company_id, OLD.crew_ids, OLD.date, OLD.estimate_id, OLD.customer_id) THEN
      RAISE EXCEPTION 'Only people who can see money can change a job''s costs.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'Crew can only change the status of a job.' USING ERRCODE = '42501';
  END IF;
  -- Any crew member on the job may mark it done or take done off
  -- (business rule); the app asks
  -- groundsmen to confirm with a second tap.
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.limit_crew_self_edits() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'authenticated' OR public.is_company_admin(OLD.company_id) THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'message_intro') IS DISTINCT FROM (to_jsonb(OLD) - 'message_intro') THEN
    RAISE EXCEPTION 'Only an owner or manager can change this. You can change your own message intro.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.limit_member_audit_entries() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_sales boolean;
BEGIN
  NEW.actor_user := auth.uid();
  IF current_user <> 'authenticated' OR public.is_company_staff(NEW.company_id) THEN
    RETURN NEW;
  END IF;
  v_sales := public.is_sales_person(NEW.company_id);
  NEW.actor := public.audit_actor_name(NEW.company_id);
  IF char_length(coalesce(NEW.id, '')) > 200
     OR char_length(coalesce(NEW.timestamp, '')) > 64
     OR char_length(coalesce(NEW.entity, '')) > 100
     OR char_length(coalesce(NEW.entity_id, '')) > 200
     OR char_length(coalesce(NEW.entity_label, '')) > 500
     OR char_length(coalesce(NEW.field, '')) > 200
     OR char_length(coalesce(NEW.old_value, '')) > 20000
     OR char_length(coalesce(NEW.new_value, '')) > 20000
     OR char_length(coalesce(NEW.customer_id, '')) > 200
     OR char_length(coalesce(NEW.job_id, '')) > 200 THEN
    RAISE EXCEPTION 'This history entry is too long.' USING ERRCODE = '42501';
  END IF;
  IF NEW.entity = 'Job' THEN
    -- A job's history is about that job, and only someone who may
    -- change the job writes it ("see all jobs" is not enough).
    NEW.job_id := COALESCE(NULLIF(NEW.job_id, ''), NEW.entity_id);
    IF NEW.job_id IS DISTINCT FROM NEW.entity_id
       OR NOT public.can_change_job(NEW.company_id, NEW.job_id) THEN
      RAISE EXCEPTION 'You can only add history for jobs you can change.' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.entity = 'User' THEN
    IF NEW.entity_id IS DISTINCT FROM public.current_crew_id(NEW.company_id) THEN
      RAISE EXCEPTION 'You can only add history for your own card.' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.entity IN ('Invoice', 'Estimate', 'Customer')
        AND NOT v_sales AND NOT public.crew_perm(NEW.company_id, 'seeMoney') THEN
    RAISE EXCEPTION 'Only the office can add this history.' USING ERRCODE = '42501';
  END IF;
  IF NEW.job_id IS NOT NULL AND NEW.job_id <> '' AND NOT v_sales
     AND NOT public.can_read_job(NEW.company_id, NEW.job_id) THEN
    RAISE EXCEPTION 'You can only add history for jobs you can see.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.limit_sales_estimate_edits() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'authenticated' OR public.is_company_staff(OLD.company_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.created_date IS DISTINCT FROM OLD.created_date THEN
    RAISE EXCEPTION 'An estimate''s id, company, customer and created date cannot be changed here.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.link_old_personal_notes() RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.private_notes p
     SET author_user = m.auth_user_id
    FROM (SELECT company_id, name, min(auth_user_id::text)::uuid AS auth_user_id
            FROM public.crew
           WHERE auth_user_id IS NOT NULL
           GROUP BY company_id, name
          HAVING count(*) = 1) m
   WHERE p.kind = 'personal' AND p.author_user IS NULL
     AND m.company_id = p.company_id AND m.name = p.author;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE FUNCTION public.mark_job_price_change_seen(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  r public.job_price_changes;
BEGIN
  SELECT * INTO r FROM public.job_price_changes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_staff(r.company_id) THEN
    RAISE EXCEPTION 'Only the office can mark a price change seen.' USING ERRCODE = '42501';
  END IF;
  IF r.seen_at IS NOT NULL THEN
    RETURN;
  END IF;
  UPDATE public.job_price_changes
     SET seen_at = now(), seen_user = auth.uid(),
         seen_by = coalesce(nullif(public.current_crew_name(r.company_id), ''), 'Owner')
   WHERE id = r.id;
END $$;

CREATE FUNCTION public.may_enter_hours_by_hand(p_company_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT public.is_company_staff(p_company_id)
    OR EXISTS (
      SELECT 1 FROM public.crew c
      WHERE c.company_id = p_company_id
        AND c.id = public.current_crew_id(p_company_id)
        AND c.permissions -> 'canManualClockIn' = 'true'::jsonb
    );
$$;

CREATE FUNCTION public.mfa_satisfied() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(auth.jwt() ->> 'aal', '') = 'aal2'
    OR NOT EXISTS (
      SELECT 1 FROM auth.mfa_factors f
      WHERE f.user_id = auth.uid() AND f.status = 'verified'
    );
$$;

CREATE FUNCTION public.next_invoice_number(p_company_id uuid) RETURNS text
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
  SELECT 'INV-' || (coalesce(max(n), 1000) + 1)::text
    FROM (SELECT regexp_replace(number, '\D', '', 'g') AS d FROM public.invoices WHERE company_id = p_company_id) x,
         LATERAL (SELECT CASE WHEN d <> '' AND length(d) <= 15 THEN d::bigint END AS n) y;
$$;

CREATE FUNCTION public.on_job_deleted_invoice() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.invoices
     SET auto_send_status = 'stopped', auto_send_note = 'job-deleted'
   WHERE company_id = OLD.company_id AND job_id = OLD.id AND auto_send_status = 'waiting';
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.on_job_status_invoice() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_invoice text;
  v_removed text[];
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
    v_invoice := public.invoice_for_done_job(NEW);
    IF v_invoice IS NOT NULL THEN
      NEW.invoice_id := v_invoice;
      UPDATE public.invoices SET auto_undo_until = now() + interval '2 hours' WHERE id = v_invoice;
    END IF;
  ELSIF OLD.status = 'done' AND NEW.status IS DISTINCT FROM 'done' THEN
    -- Done taken back within the grace period: an invoice nothing has
    -- happened to yet goes away, so the next Done makes it again.
    WITH gone AS (
      DELETE FROM public.invoices
       WHERE company_id = NEW.company_id AND job_id = NEW.id
         AND auto_created
         AND auto_undo_until > now()
         AND coalesce(auto_send_status, 'waiting') = 'waiting'
         AND auto_sent_at IS NULL
         AND coalesce(email_queued_at, '') = ''
         AND coalesce(paid_date, '') = ''
         AND status = 'unpaid'
         AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(splits) = 'array' THEN splits END), 0) = 0
      RETURNING id, number),
    logged AS (
      INSERT INTO public.audit_log
        (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id)
      SELECT gen_random_uuid()::text, NEW.company_id, v_now, 'Automatic (job no longer done)', 'Invoice', g.id,
             g.number, '(deleted)', g.number, '', NEW.customer_id, NEW.id
        FROM gone g)
    SELECT array_agg(id) INTO v_removed FROM gone;
    IF v_removed IS NOT NULL AND NEW.invoice_id = ANY (v_removed) THEN
      NEW.invoice_id := NULL;
    END IF;
    -- Reopened: any other automatic email waits for the office, and the
    -- job is no longer waiting for an invoice.
    UPDATE public.invoices
       SET auto_send_status = 'stopped', auto_send_note = 'reopened', auto_undo_until = NULL
     WHERE company_id = NEW.company_id AND job_id = NEW.id AND auto_send_status = 'waiting';
    DELETE FROM public.invoice_reviews WHERE company_id = NEW.company_id AND job_id = NEW.id;
  END IF;
  -- An invoice linked by hand also settles the review, when it is real.
  IF NEW.invoice_id IS NOT NULL AND NEW.invoice_id <> '' AND OLD.invoice_id IS DISTINCT FROM NEW.invoice_id
     AND (COALESCE(auth.role(), '') <> 'authenticated'
          OR public.is_company_staff(NEW.company_id)
          OR EXISTS (SELECT 1 FROM public.invoices i
                      WHERE i.company_id = NEW.company_id AND i.id = NEW.invoice_id
                        AND i.job_id = NEW.id)) THEN
    DELETE FROM public.invoice_reviews WHERE company_id = NEW.company_id AND job_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.process_confirmed_signup(p_user_id uuid, p_email text, p_meta jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  cfg public.app_config%ROWTYPE;
  crew_name text;
  is_owner boolean;
BEGIN
  SELECT * INTO cfg FROM public.app_config WHERE id;
  IF NOT FOUND OR p_email IS NULL OR p_email = '' THEN
    RETURN;
  END IF;

  crew_name := COALESCE(NULLIF(p_meta ->> 'full_name', ''), split_part(p_email, '@', 1));
  is_owner := lower(p_email) = cfg.owner_email
    OR lower(p_email) = ANY (cfg.extra_owner_emails);

  UPDATE public.crew
    SET auth_user_id = p_user_id
    WHERE company_id = cfg.company_id
      AND lower(email) = lower(p_email)
      AND auth_user_id IS NULL;

  IF is_owner THEN
    INSERT INTO public.crew
      (id, company_id, name, role, phone, color, app_role, email,
       message_intro, auth_user_id, status)
    SELECT
      p_user_id::text, cfg.company_id, crew_name, 'Owner', '', '#16a34a',
      'owner', p_email, '', p_user_id, 'active'
    WHERE NOT EXISTS (
      SELECT 1 FROM public.crew
      WHERE company_id = cfg.company_id AND auth_user_id = p_user_id
    );
    UPDATE public.crew
      SET app_role = 'owner', status = 'active'
      WHERE company_id = cfg.company_id AND auth_user_id = p_user_id;

    INSERT INTO public.company_members (user_id, company_id, role)
    VALUES (p_user_id, cfg.company_id, 'owner')
    ON CONFLICT (user_id, company_id) DO UPDATE SET role = 'owner';
    RETURN;
  END IF;

  INSERT INTO public.crew
    (id, company_id, name, role, phone, color, app_role, email,
     message_intro, auth_user_id, status)
  SELECT
    p_user_id::text, cfg.company_id, crew_name, 'Groundsman', '', '#475569',
    'crew', p_email, '', p_user_id, 'pending'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.crew
    WHERE company_id = cfg.company_id
      AND (lower(email) = lower(p_email) OR auth_user_id = p_user_id)
  );
END;
$$;

CREATE FUNCTION public.protect_last_owner() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF OLD.role = 'owner'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'owner' OR NEW.company_id <> OLD.company_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.company_members
       WHERE company_id = OLD.company_id
         AND role = 'owner'
         AND user_id <> OLD.user_id
     )
     -- Allow the cascade when the whole company is being deleted.
     AND EXISTS (SELECT 1 FROM public.companies WHERE id = OLD.company_id)
  THEN
    RAISE EXCEPTION 'The last owner of a company cannot be removed or demoted. Make someone else an owner first.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.public_rate_limit_take(p_bucket text, p_key_hash text, p_max integer, p_window_seconds integer DEFAULT 3600) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  recent int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('public-rate:' || p_bucket || ':' || p_key_hash));
  DELETE FROM public.public_rate_limits
   WHERE bucket = p_bucket AND created_at < now() - interval '1 day';
  SELECT count(*) INTO recent FROM public.public_rate_limits
   WHERE bucket = p_bucket AND key_hash = p_key_hash
     AND created_at > now() - make_interval(secs => greatest(p_window_seconds, 1));
  IF recent >= p_max THEN
    RETURN false;
  END IF;
  INSERT INTO public.public_rate_limits (bucket, key_hash) VALUES (p_bucket, p_key_hash);
  RETURN true;
END;
$$;

CREATE FUNCTION public.reclaim_invoice_email(p_company_id uuid, p_dedupe_key text) RETURNS uuid
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
  UPDATE public.automation_sends
     SET attempts = attempts + 1, created_at = now()
   WHERE company_id = p_company_id AND dedupe_key = p_dedupe_key
     AND rule_kind = 'invoice_emailed' AND status = 'sending'
     AND created_at < now() - interval '30 minutes'
  RETURNING id;
$$;

CREATE FUNCTION public.release_automation_send(p_send_id uuid) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  s public.automation_sends%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.automation_sends WHERE id = p_send_id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'sending' THEN
    RETURN false;
  END IF;
  IF s.attempts <= 1 THEN
    DELETE FROM public.automation_sends WHERE id = p_send_id;
  ELSE
    UPDATE public.automation_sends SET status = 'failed', attempts = s.attempts - 1 WHERE id = p_send_id;
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION public.reset_two_step_login(p_company_id uuid, p_user_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  target_role text;
  removed integer;
BEGIN
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Turn off your own two-step login in the app instead.'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_company_admin(p_company_id) THEN
    RAISE EXCEPTION 'Only an owner or manager can reset two-step login.'
      USING ERRCODE = '42501';
  END IF;
  SELECT role INTO target_role FROM public.company_members
  WHERE user_id = p_user_id AND company_id = p_company_id;
  IF target_role IS NULL THEN
    RAISE EXCEPTION 'That login is not on this team.' USING ERRCODE = '42501';
  END IF;
  IF target_role = 'owner' AND NOT public.is_company_owner(p_company_id) THEN
    RAISE EXCEPTION 'Only an owner can reset an owner''s two-step login.'
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM auth.mfa_factors WHERE user_id = p_user_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  -- Ends every session of that login (refresh tokens and two-step
  -- markers go with them), including the lost phone's.
  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  RETURN removed;
END;
$$;

CREATE FUNCTION public.resolve_equipment_problem(p_problem_id uuid, p_action text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  r public.equipment_problems;
BEGIN
  IF p_action NOT IN ('fixed', 'shop') THEN
    RAISE EXCEPTION 'Unknown action %.', p_action USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM public.equipment_problems WHERE id = p_problem_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_staff(r.company_id) THEN
    RAISE EXCEPTION 'Only the office can close an equipment problem.' USING ERRCODE = '42501';
  END IF;
  IF p_action = 'shop' THEN
    UPDATE public.equipment_problems SET status = 'in_shop' WHERE id = r.id;
    UPDATE public.equipment SET status = 'in_shop'
      WHERE id = r.equipment_id AND company_id = r.company_id AND status <> 'retired';
  ELSE
    UPDATE public.equipment_problems SET status = 'fixed' WHERE id = r.id;
    IF NOT EXISTS (SELECT 1 FROM public.equipment_problems p
                   WHERE p.equipment_id = r.equipment_id AND p.company_id = r.company_id
                     AND p.status IN ('open', 'in_shop')) THEN
      UPDATE public.equipment
        SET status = CASE WHEN status = 'in_shop' THEN 'available' ELSE status END,
            down = CASE WHEN down IS TRUE THEN false ELSE down END
        WHERE id = r.equipment_id AND company_id = r.company_id;
    END IF;
  END IF;
END $$;

CREATE FUNCTION public.sales_can_read_estimate(p_company_id uuid, p_customer_id text, p_created_by_crew_id text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT public.is_sales_person(p_company_id) THEN
    RETURN false;
  END IF;
  IF p_created_by_crew_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.crew c
    WHERE c.id = p_created_by_crew_id AND c.company_id = p_company_id
      AND c.auth_user_id = auth.uid()
  ) THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.customers c
    WHERE c.company_id = p_company_id AND c.id = p_customer_id
      AND lower(btrim(coalesce(c.customer_type, ''))) <> 'commercial'
  );
END $$;

CREATE FUNCTION public.set_estimate_author() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF COALESCE(auth.role(), '') = 'authenticated' THEN
    NEW.created_by_crew_id := public.estimate_author_card(NEW.company_id);
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.settings_auto_emails_since() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  today text := to_char(now() AT TIME ZONE public.business_time_zone(), 'YYYY-MM-DD');
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.auto_emails_since := CASE WHEN NEW.auto_emails THEN today END;
  ELSIF NEW.auto_emails AND NOT OLD.auto_emails THEN
    NEW.auto_emails_since := today;
  ELSE
    NEW.auto_emails_since := OLD.auto_emails_since;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.stamp_customer_edit_request() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.requested_user := auth.uid();
    NEW.requested_by := public.current_crew_id(NEW.company_id);
    NEW.requested_name := coalesce(nullif(public.current_crew_name(NEW.company_id), ''), 'Sales');
    NEW.created_at := now();
    IF (SELECT count(*) FROM public.customer_edit_requests r
        WHERE r.requested_user = auth.uid() AND r.status = 'pending') >= 200 THEN
      RAISE EXCEPTION 'Too many suggestions are waiting for the office already.'
        USING ERRCODE = '54000';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.stamp_equipment_problem() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.has_photo := false;
    NEW.status_by_name := NULL;
    NEW.status_at := NULL;
    IF auth.uid() IS NOT NULL THEN
      NEW.reported_user := auth.uid();
      NEW.reported_by := public.current_crew_id(NEW.company_id);
      NEW.reported_name := coalesce(nullif(public.current_crew_name(NEW.company_id), ''), 'Team member');
      NEW.created_at := now();
      IF (SELECT count(*) FROM public.equipment_problems p
          WHERE p.reported_user = auth.uid() AND p.status = 'open') >= 50 THEN
        RAISE EXCEPTION 'You already have 50 open problem reports. The office needs to deal with those first.'
          USING ERRCODE = '54000';
      END IF;
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_at := now();
    NEW.status_by_name := coalesce(nullif(public.current_crew_name(NEW.company_id), ''), 'Office');
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.stamp_private_note_author() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.author_user := auth.uid();
  ELSE
    NEW.author_user := OLD.author_user;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.stamp_week_approval() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.approved_user := auth.uid();
    NEW.approved_by := coalesce(nullif(public.current_crew_name(NEW.company_id), ''), 'Owner');
  END IF;
  NEW.approved_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.timesheet_clock_in_check(p_date text, p_in text, p_now timestamp with time zone) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v text := public.timesheet_tap_check(p_date, p_in, NULL, interval '12 hours', p_now);
BEGIN
  IF v = 'ok' AND left(p_in, 5) >= '20:00' THEN
    RETURN 'after_8';
  END IF;
  RETURN v;
END;
$$;

CREATE FUNCTION public.timesheet_clock_out_check(p_date text, p_out text, p_in text, p_now timestamp with time zone DEFAULT now()) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $_$
DECLARE
  today date := (p_now AT TIME ZONE public.business_time_zone())::date;
  d date;
  v text;
BEGIN
  IF p_date IS NULL OR p_date !~ '^\d{4}-\d{2}-\d{2}$'
     OR p_in IS NULL OR p_in !~ '^\d{2}:\d{2}'
     OR p_out IS NULL OR p_out !~ '^\d{2}:\d{2}' THEN
    RETURN 'bad';
  END IF;
  BEGIN
    d := p_date::date;
  EXCEPTION WHEN others THEN
    RETURN 'bad';
  END;
  IF d > today OR left(p_in, 5) >= '20:00' THEN
    RETURN 'bad';
  END IF;
  IF d < today THEN
    IF left(p_out, 5) >= left(p_in, 5) AND left(p_out, 5) < '20:00'
       AND public.timesheet_tap_check(p_date, p_out, NULL, interval '24 hours', p_now) = 'ok' THEN
      RETURN 'ok';
    END IF;
    RETURN 'cap';
  END IF;
  IF left(p_out, 5) < left(p_in, 5) THEN
    RETURN 'before_in';
  END IF;
  v := public.timesheet_tap_check(p_date, p_out, NULL, interval '24 hours', p_now);
  IF v <> 'ok' THEN
    RETURN v;
  END IF;
  IF left(p_out, 5) >= '20:00' THEN
    RETURN 'cap';
  END IF;
  RETURN 'ok';
END;
$_$;

CREATE FUNCTION public.timesheet_crew_overlap(p_company_id uuid, p_crew_id text, p_id text, p_date text, p_in text, p_out text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT left(b.clock_in, 5) AS b_in,
             CASE
               WHEN b.clock_out IS NULL THEN NULL
               WHEN left(b.clock_out, 5) < left(b.clock_in, 5) THEN '24:00'
               ELSE left(b.clock_out, 5)
             END AS b_end
      FROM public.timesheets b
      WHERE b.company_id = p_company_id
        AND b.crew_id = p_crew_id
        AND b.date = p_date
        AND b.id <> p_id
        AND b.clock_in ~ '^\d{2}:\d{2}'
    ) o
    WHERE CASE
      WHEN p_out IS NULL THEN
        (o.b_end IS NOT NULL AND o.b_end > left(p_in, 5))
        OR (o.b_end IS NULL AND o.b_in > left(p_in, 5))
      ELSE
        (o.b_end IS NOT NULL AND o.b_in < left(p_out, 5) AND o.b_end > left(p_in, 5))
        OR (o.b_end IS NULL AND o.b_in > left(p_in, 5) AND o.b_in < left(p_out, 5))
    END
  );
$$;

CREATE FUNCTION public.timesheet_may_auto_close(p_company_id uuid, p_date text, p_now timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  d date;
  today date := (p_now AT TIME ZONE public.business_time_zone())::date;
BEGIN
  IF COALESCE(auth.role(), '') = 'authenticated' AND NOT public.is_company_member(p_company_id) THEN
    RETURN false;
  END IF;
  IF p_date IS NULL OR p_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN false;
  END IF;
  BEGIN
    d := p_date::date;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  IF d < today - 2 OR d > today THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM public.timesheet_week_approvals a
    WHERE a.company_id = p_company_id
      AND a.week_start = date_trunc('week', d)::date);
END;
$_$;

CREATE FUNCTION public.timesheet_tap_check(p_date text, p_time text, p_after_in text, p_max_age interval, p_now timestamp with time zone DEFAULT now()) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
    WHEN bool_or(m <= p_now + interval '5 minutes' AND m >= p_now - p_max_age) THEN 'ok'
    WHEN bool_or(m < p_now - p_max_age) THEN 'old'
    ELSE 'bad'
  END
  FROM public.timesheet_tap_moments(public.timesheet_tap_local(p_date, p_time, p_after_in)) AS m;
$$;

CREATE FUNCTION public.timesheet_tap_local(p_date text, p_time text, p_after_in text DEFAULT NULL::text) RETURNS timestamp without time zone
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $_$
DECLARE
  v timestamp;
BEGIN
  IF p_date IS NULL OR p_time IS NULL
     OR p_date !~ '^\d{4}-\d{2}-\d{2}$' OR p_time !~ '^\d{2}:\d{2}(:\d{2})?$' THEN
    RETURN NULL;
  END IF;
  BEGIN
    v := (p_date || ' ' || p_time)::timestamp;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF p_after_in IS NOT NULL AND p_after_in ~ '^\d{2}:\d{2}' AND left(p_time, 5) < left(p_after_in, 5) THEN
    v := v + interval '1 day';
  END IF;
  RETURN v;
END;
$_$;

CREATE FUNCTION public.timesheet_tap_moments(p_local timestamp without time zone) RETURNS SETOF timestamp with time zone
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT DISTINCT m FROM (
    SELECT (p_local AT TIME ZONE public.business_time_zone()) + o AS m
    FROM unnest(ARRAY[interval '-1 hour', interval '0', interval '1 hour']) AS o
  ) c
  WHERE p_local IS NOT NULL AND (m AT TIME ZONE public.business_time_zone()) = p_local;
$$;

CREATE FUNCTION public.timesheets_auto_closed_reset() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.clock_out IS DISTINCT FROM OLD.clock_out AND NEW.auto_closed IS NOT DISTINCT FROM OLD.auto_closed THEN
    NEW.auto_closed := false;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.two_step_logins(p_company_id uuid) RETURNS TABLE(user_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT DISTINCT f.user_id
  FROM auth.mfa_factors f
  JOIN public.company_members m
    ON m.user_id = f.user_id AND m.company_id = p_company_id
  WHERE f.status = 'verified'
    AND public.is_company_admin(p_company_id);
$$;

CREATE TABLE public.app_config (
    id boolean DEFAULT true NOT NULL,
    owner_email text NOT NULL,
    company_id uuid NOT NULL,
    extra_owner_emails text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT app_config_id_check CHECK (id),
    CONSTRAINT app_config_owner_email_check CHECK (((owner_email = lower(TRIM(BOTH FROM owner_email))) AND (owner_email <> ''::text)))
);

CREATE TABLE public.audit_log (
    id text NOT NULL,
    company_id uuid NOT NULL,
    "timestamp" text NOT NULL,
    actor text DEFAULT ''::text NOT NULL,
    entity text NOT NULL,
    entity_id text NOT NULL,
    entity_label text DEFAULT ''::text NOT NULL,
    field text NOT NULL,
    old_value text DEFAULT ''::text NOT NULL,
    new_value text DEFAULT ''::text NOT NULL,
    customer_id text,
    job_id text,
    actor_user uuid
);

CREATE TABLE public.automation_batch_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    batch_id uuid NOT NULL,
    company_id uuid NOT NULL,
    rule_kind text NOT NULL,
    dedupe_key text NOT NULL,
    target_id text DEFAULT ''::text NOT NULL,
    customer_id text NOT NULL,
    customer_name text DEFAULT ''::text NOT NULL,
    due_day text,
    status text DEFAULT 'waiting'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT automation_batch_items_customer_name_check CHECK ((char_length(customer_name) <= 200)),
    CONSTRAINT automation_batch_items_dedupe_key_check CHECK (((char_length(dedupe_key) >= 1) AND (char_length(dedupe_key) <= 300))),
    CONSTRAINT automation_batch_items_due_day_check CHECK (((due_day IS NULL) OR (due_day ~ '^\d{4}-\d{2}-\d{2}$'::text))),
    CONSTRAINT automation_batch_items_rule_kind_check CHECK ((rule_kind = ANY (ARRAY['invoice_reminder'::text, 'review_request'::text, 'estimate_reminder'::text, 'thank_you'::text, 'job_reminder'::text, 'overdue_escalation'::text, 'phc_renewal'::text, 'invoice_send'::text]))),
    CONSTRAINT automation_batch_items_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'sent'::text, 'failed'::text, 'skipped'::text, 'discarded'::text])))
);

CREATE TABLE public.automation_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    decided_by uuid,
    decided_at timestamp with time zone,
    CONSTRAINT automation_batches_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'sending'::text, 'done'::text, 'discarded'::text])))
);

CREATE TABLE public.automation_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    kind text DEFAULT 'scheduled'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    gmail_ready boolean DEFAULT false NOT NULL,
    switched_on boolean DEFAULT false NOT NULL,
    outcome text DEFAULT ''::text NOT NULL,
    sent integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    skipped integer DEFAULT 0 NOT NULL,
    waiting integer DEFAULT 0 NOT NULL,
    blocked integer DEFAULT 0 NOT NULL,
    CONSTRAINT automation_runs_blocked_check CHECK ((blocked >= 0)),
    CONSTRAINT automation_runs_kind_check CHECK ((kind = ANY (ARRAY['scheduled'::text, 'test'::text, 'approved'::text]))),
    CONSTRAINT automation_runs_outcome_check CHECK ((char_length(outcome) <= 40))
);

CREATE TABLE public.automation_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    rule_kind text NOT NULL,
    dedupe_key text NOT NULL,
    target_id text DEFAULT ''::text NOT NULL,
    customer_id text NOT NULL,
    customer_name text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'sending'::text NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    message_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT automation_sends_customer_name_check CHECK ((char_length(customer_name) <= 200)),
    CONSTRAINT automation_sends_dedupe_key_check CHECK (((char_length(dedupe_key) >= 1) AND (char_length(dedupe_key) <= 300))),
    CONSTRAINT automation_sends_rule_kind_check CHECK ((rule_kind = ANY (ARRAY['invoice_reminder'::text, 'review_request'::text, 'estimate_reminder'::text, 'thank_you'::text, 'job_reminder'::text, 'overdue_escalation'::text, 'phc_renewal'::text, 'estimate_sent'::text, 'estimate_accepted'::text, 'invoice_send'::text, 'invoice_emailed'::text, 'customer_edit_suggested'::text, 'day_plan'::text, 'payment_receipt'::text]))),
    CONSTRAINT automation_sends_status_check CHECK ((status = ANY (ARRAY['sending'::text, 'sent'::text, 'failed'::text])))
);

CREATE TABLE public.automations (
    id text NOT NULL,
    company_id uuid NOT NULL,
    kind text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    timing_days integer DEFAULT 0 NOT NULL,
    template text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.booking_rate_limits (
    id bigint NOT NULL,
    ip_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    contact_hash text
);

ALTER TABLE public.booking_rate_limits ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.booking_rate_limits_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.booking_requests (
    id text NOT NULL,
    company_id uuid NOT NULL,
    date date NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    email text,
    address text DEFAULT ''::text NOT NULL,
    details text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_at date NOT NULL,
    estimate_id text
);

CREATE TABLE public.chemical_records (
    id text NOT NULL,
    company_id uuid NOT NULL,
    program_id text NOT NULL,
    date text NOT NULL,
    product text DEFAULT ''::text NOT NULL,
    rate text DEFAULT ''::text NOT NULL,
    applicator text DEFAULT ''::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.closed_days (
    id text NOT NULL,
    company_id uuid NOT NULL,
    reason text,
    created_by text
);

CREATE TABLE public.companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.company_document_files (
    id text NOT NULL,
    company_id uuid NOT NULL,
    file_name text DEFAULT ''::text NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    data_base64 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_document_files_base64 CHECK ((data_base64 ~ '^[A-Za-z0-9+/]*={0,2}$'::text)),
    CONSTRAINT company_document_files_file_name_check CHECK ((char_length(file_name) <= 200)),
    CONSTRAINT company_document_files_mime_type_check CHECK ((mime_type = ANY (ARRAY['application/pdf'::text, 'image/jpeg'::text, 'image/png'::text]))),
    CONSTRAINT company_document_files_size_bytes_check CHECK (((size_bytes >= 1) AND (size_bytes <= 5242880))),
    CONSTRAINT company_document_files_size_matches CHECK ((char_length(data_base64) = (((size_bytes + 2) / 3) * 4))),
    CONSTRAINT company_document_files_type_matches CHECK (
CASE mime_type
    WHEN 'application/pdf'::text THEN ("left"(data_base64, 7) = 'JVBERi0'::text)
    WHEN 'image/jpeg'::text THEN ("left"(data_base64, 4) = '/9j/'::text)
    WHEN 'image/png'::text THEN ("left"(data_base64, 11) = 'iVBORw0KGgo'::text)
    ELSE false
END)
);

CREATE TABLE public.company_documents (
    id text NOT NULL,
    company_id uuid NOT NULL,
    kind text DEFAULT 'other'::text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    crew_id text,
    issuer text DEFAULT ''::text NOT NULL,
    start_date date,
    expiry_date date,
    notes text DEFAULT ''::text NOT NULL,
    file_id text,
    file_name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_documents_check CHECK (((expiry_date IS NULL) OR (start_date IS NULL) OR (expiry_date >= start_date))),
    CONSTRAINT company_documents_crew_id_check CHECK (((crew_id IS NULL) OR (char_length(crew_id) <= 100))),
    CONSTRAINT company_documents_file_name_check CHECK ((char_length(file_name) <= 200)),
    CONSTRAINT company_documents_issuer_check CHECK ((char_length(issuer) <= 200)),
    CONSTRAINT company_documents_kind_check CHECK ((kind = ANY (ARRAY['business_licence'::text, 'arborist_certification'::text, 'liability_insurance'::text, 'workers_comp'::text, 'auto_insurance'::text, 'other'::text]))),
    CONSTRAINT company_documents_name_check CHECK ((char_length(name) <= 200)),
    CONSTRAINT company_documents_notes_check CHECK ((char_length(notes) <= 4000))
);

CREATE TABLE public.company_members (
    user_id uuid NOT NULL,
    company_id uuid NOT NULL,
    role text DEFAULT 'crew'::text NOT NULL
);

CREATE TABLE public.settings (
    company_id uuid NOT NULL,
    auto_clock boolean DEFAULT false NOT NULL,
    daily_target numeric DEFAULT 0 NOT NULL,
    suggest_days boolean DEFAULT true NOT NULL,
    suggest_max_minutes integer DEFAULT 30 NOT NULL,
    suggest_max_miles numeric DEFAULT 5 NOT NULL,
    suggest_max_over numeric DEFAULT 0 NOT NULL,
    suggest_skip_weekends boolean DEFAULT true NOT NULL,
    suggest_skip_holidays boolean DEFAULT true NOT NULL,
    hover_route boolean DEFAULT true NOT NULL,
    show_day_totals boolean DEFAULT true NOT NULL,
    commercial_terms_days integer DEFAULT 30 NOT NULL,
    residential_terms_days integer DEFAULT 0 NOT NULL,
    crew_rules jsonb,
    company_profile jsonb,
    planner jsonb,
    auto_emails boolean DEFAULT false NOT NULL,
    auto_emails_since text
);

CREATE VIEW public.company_public WITH (security_invoker='false') AS
 SELECT company_id,
    (company_profile ->> 'name'::text) AS name,
    (company_profile ->> 'phone'::text) AS phone
   FROM public.settings;

CREATE TABLE public.crew (
    id text NOT NULL,
    company_id uuid NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    role text DEFAULT ''::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    color text DEFAULT ''::text NOT NULL,
    app_role text DEFAULT 'crew'::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    message_intro text DEFAULT ''::text NOT NULL,
    employment_type text,
    pay_type text,
    pay_amount numeric,
    available_weekdays integer[],
    can_drive_equipment text[],
    works_well_with text[],
    permissions jsonb,
    auth_user_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    skills text[] DEFAULT '{}'::text[] NOT NULL,
    driver_licensed boolean DEFAULT false NOT NULL,
    company_insured boolean DEFAULT false NOT NULL,
    cdl_class text DEFAULT 'none'::text NOT NULL,
    last_resort boolean DEFAULT false NOT NULL,
    prefers_own_truck boolean DEFAULT false NOT NULL,
    own_truck_id text,
    fixed_weekly_hours numeric,
    counted_on_every_job boolean DEFAULT false NOT NULL,
    CONSTRAINT crew_cdl_class_check CHECK ((cdl_class = ANY (ARRAY['none'::text, 'B'::text, 'A'::text]))),
    CONSTRAINT crew_fixed_weekly_hours_range CHECK (((fixed_weekly_hours IS NULL) OR ((fixed_weekly_hours >= (0)::numeric) AND (fixed_weekly_hours <= (80)::numeric))))
);

CREATE TABLE public.crew_locations (
    id text NOT NULL,
    company_id uuid NOT NULL,
    crew_id text NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    recorded_at text NOT NULL,
    request_id text,
    job_id text
);

CREATE TABLE public.crew_unavailability (
    id text NOT NULL,
    company_id uuid NOT NULL,
    crew_id text NOT NULL,
    start_date text NOT NULL,
    end_date text NOT NULL
);

CREATE TABLE public.customer_addresses (
    id text NOT NULL,
    company_id uuid NOT NULL,
    customer_id text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    street text DEFAULT ''::text NOT NULL,
    city text DEFAULT ''::text NOT NULL,
    state text DEFAULT 'CO'::text NOT NULL,
    zip text DEFAULT ''::text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL
);

CREATE TABLE public.customer_edit_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    customer_id text NOT NULL,
    requested_by text,
    requested_user uuid,
    requested_name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    changes jsonb NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    decided_by text,
    decided_user uuid,
    decided_at timestamp with time zone,
    decline_reason text DEFAULT ''::text NOT NULL,
    applied_changes jsonb,
    CONSTRAINT customer_edit_requests_applied_changes_check CHECK (((applied_changes IS NULL) OR (jsonb_typeof(applied_changes) = 'object'::text))),
    CONSTRAINT customer_edit_requests_applied_only_approved CHECK (((applied_changes IS NULL) OR (status = 'approved'::text))),
    CONSTRAINT customer_edit_requests_changes_check CHECK (public.customer_edit_changes_ok(changes)),
    CONSTRAINT customer_edit_requests_check CHECK (((status = 'pending'::text) = (decided_at IS NULL))),
    CONSTRAINT customer_edit_requests_decline_reason_check CHECK ((char_length(decline_reason) <= 500)),
    CONSTRAINT customer_edit_requests_note_check CHECK ((length(note) <= 1000)),
    CONSTRAINT customer_edit_requests_reason_only_declined CHECK (((decline_reason = ''::text) OR (status = 'declined'::text))),
    CONSTRAINT customer_edit_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text])))
);

CREATE TABLE public.customers (
    id text NOT NULL,
    company_id uuid NOT NULL,
    first_name text DEFAULT ''::text NOT NULL,
    last_name text DEFAULT ''::text NOT NULL,
    company text DEFAULT ''::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    address text DEFAULT ''::text NOT NULL,
    city text DEFAULT ''::text NOT NULL,
    zip text DEFAULT ''::text NOT NULL,
    property_notes text DEFAULT ''::text NOT NULL,
    gate_code text DEFAULT ''::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    map_lat double precision,
    map_lng double precision,
    boundary jsonb,
    customer_type text DEFAULT 'residential'::text NOT NULL,
    company_name text,
    project_name text,
    project_number text,
    po_number text,
    contract_number text,
    job_site_address text,
    billing_terms text,
    contacts jsonb DEFAULT '[]'::jsonb NOT NULL,
    no_auto_emails boolean DEFAULT false NOT NULL
);

CREATE TABLE public.day_crews (
    id text NOT NULL,
    company_id uuid NOT NULL,
    date text NOT NULL,
    name text DEFAULT 'Crew 1'::text NOT NULL,
    member_ids text[] DEFAULT '{}'::text[] NOT NULL
);

CREATE TABLE public.email_threads (
    id text NOT NULL,
    company_id uuid NOT NULL,
    customer_id text NOT NULL,
    created_at text NOT NULL
);

CREATE TABLE public.equipment (
    id text NOT NULL,
    company_id uuid NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    kind text DEFAULT 'Other'::text NOT NULL,
    details text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'available'::text NOT NULL,
    down boolean,
    tows text[],
    seats integer,
    weight_lbs integer,
    weekly_driver_limit integer,
    home_site text,
    CONSTRAINT equipment_seats_check CHECK ((seats >= 0)),
    CONSTRAINT equipment_weekly_driver_limit_check CHECK ((weekly_driver_limit >= 0)),
    CONSTRAINT equipment_weight_lbs_check CHECK ((weight_lbs >= 0))
);

CREATE TABLE public.equipment_notes (
    id text NOT NULL,
    company_id uuid NOT NULL,
    equipment_id text NOT NULL,
    author_id text DEFAULT ''::text NOT NULL,
    author_name text DEFAULT ''::text NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.equipment_problem_photos (
    problem_id uuid NOT NULL,
    company_id uuid NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    data_base64 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT equipment_problem_photos_base64 CHECK ((data_base64 ~ '^[A-Za-z0-9+/]*={0,2}$'::text)),
    CONSTRAINT equipment_problem_photos_mime_type_check CHECK ((mime_type = ANY (ARRAY['image/jpeg'::text, 'image/png'::text]))),
    CONSTRAINT equipment_problem_photos_size_bytes_check CHECK (((size_bytes >= 1) AND (size_bytes <= 2097152))),
    CONSTRAINT equipment_problem_photos_size_matches CHECK ((char_length(data_base64) = (((size_bytes + 2) / 3) * 4))),
    CONSTRAINT equipment_problem_photos_type_matches CHECK (
CASE mime_type
    WHEN 'image/jpeg'::text THEN ("left"(data_base64, 4) = '/9j/'::text)
    WHEN 'image/png'::text THEN ("left"(data_base64, 11) = 'iVBORw0KGgo'::text)
    ELSE false
END)
);

CREATE TABLE public.equipment_problems (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    equipment_id text NOT NULL,
    note text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    has_photo boolean DEFAULT false NOT NULL,
    reported_by text,
    reported_user uuid,
    reported_name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status_by_name text,
    status_at timestamp with time zone,
    CONSTRAINT equipment_problems_note_check CHECK (((char_length(btrim(note)) >= 1) AND (char_length(btrim(note)) <= 1000))),
    CONSTRAINT equipment_problems_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_shop'::text, 'fixed'::text])))
);

CREATE TABLE public.gps_pings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    job_id text NOT NULL,
    crew_id text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL
);

CREATE TABLE public.invoice_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    job_id text NOT NULL,
    customer_id text DEFAULT ''::text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invoice_reviews_reason_check CHECK ((reason = ANY (ARRAY['has_invoice'::text, 'hourly'::text, 'extra_costs'::text, 'multi_day'::text, 'recurring'::text, 'no_estimate'::text, 'no_price'::text, 'split_invoice'::text])))
);

CREATE TABLE public.invoices (
    id text NOT NULL,
    company_id uuid NOT NULL,
    number text NOT NULL,
    customer_id text NOT NULL,
    job_id text,
    estimate_id text,
    lines jsonb DEFAULT '[]'::jsonb NOT NULL,
    tax_rate numeric DEFAULT 0 NOT NULL,
    discount_type text DEFAULT 'none'::text NOT NULL,
    discount_value numeric DEFAULT 0 NOT NULL,
    status text NOT NULL,
    issued_date text NOT NULL,
    due_date text NOT NULL,
    paid_date text,
    email_queued_at text,
    splits jsonb DEFAULT '[]'::jsonb NOT NULL,
    payment_method text,
    auto_created boolean DEFAULT false NOT NULL,
    auto_send_at timestamp with time zone,
    auto_send_status text,
    auto_send_note text,
    auto_sent_at timestamp with time zone,
    auto_send_claimed_at timestamp with time zone,
    auto_undo_until timestamp with time zone,
    emailed_at timestamp with time zone,
    CONSTRAINT invoices_auto_send_note_check CHECK ((auto_send_note = ANY (ARRAY['stopped'::text, 'edited'::text, 'reopened'::text, 'job-deleted'::text, 'another-invoice'::text, 'switched-off'::text, 'too-late'::text, 'no-email'::text, 'opted-out'::text, 'failed'::text, 'not-approved'::text, 'sent-by-hand'::text, 'split'::text]))),
    CONSTRAINT invoices_auto_send_status_check CHECK ((auto_send_status = ANY (ARRAY['waiting'::text, 'sending'::text, 'sent'::text, 'stopped'::text])))
);

CREATE TABLE public.job_price_changes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    job_id text NOT NULL,
    changed_by text,
    changed_user uuid,
    changed_by_name text DEFAULT ''::text NOT NULL,
    by_office boolean DEFAULT false NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    old_value numeric,
    new_value numeric,
    old_hourly_rate numeric,
    new_hourly_rate numeric,
    old_billing_type text,
    new_billing_type text,
    reason text DEFAULT ''::text NOT NULL,
    seen_by text,
    seen_user uuid,
    seen_at timestamp with time zone,
    CONSTRAINT job_price_changes_check CHECK (((char_length(reason) <= 1000) AND (by_office OR (char_length(btrim(reason)) >= 3))))
);

CREATE TABLE public.location_requests (
    id text NOT NULL,
    company_id uuid NOT NULL,
    requested_by text NOT NULL,
    requested_at text NOT NULL,
    target_crew_id text
);

CREATE TABLE public.maintenance_records (
    id text NOT NULL,
    company_id uuid NOT NULL,
    task_id text NOT NULL,
    date date NOT NULL,
    hours numeric,
    notes text DEFAULT ''::text NOT NULL,
    done_by text
);

CREATE TABLE public.maintenance_tasks (
    id text NOT NULL,
    company_id uuid NOT NULL,
    equipment_id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    interval_days integer DEFAULT 90 NOT NULL
);

CREATE TABLE public.messages (
    id text NOT NULL,
    company_id uuid NOT NULL,
    customer_id text NOT NULL,
    job_id text,
    estimate_id text,
    channel text NOT NULL,
    direction text NOT NULL,
    sender_crew_id text DEFAULT ''::text NOT NULL,
    sender_name text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    created_at text NOT NULL,
    from_number text,
    thread_id text,
    automatic boolean DEFAULT false NOT NULL
);

CREATE TABLE public.phc_programs (
    id text NOT NULL,
    company_id uuid NOT NULL,
    customer_id text NOT NULL,
    tree_id text,
    name text DEFAULT ''::text NOT NULL,
    type text DEFAULT 'Other'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    start_date text NOT NULL,
    renewal_date text NOT NULL,
    visit_interval_months integer DEFAULT 6 NOT NULL,
    notes text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.phc_visits (
    id text NOT NULL,
    company_id uuid NOT NULL,
    program_id text NOT NULL,
    date text NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.private_notes (
    id text NOT NULL,
    company_id uuid NOT NULL,
    customer_id text NOT NULL,
    kind text NOT NULL,
    author text DEFAULT ''::text NOT NULL,
    created_at text NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    author_user uuid
);

CREATE TABLE public.public_rate_limits (
    id bigint NOT NULL,
    bucket text NOT NULL,
    key_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_rate_limits_bucket_check CHECK (((char_length(bucket) >= 1) AND (char_length(bucket) <= 40))),
    CONSTRAINT public_rate_limits_key_hash_check CHECK (((char_length(key_hash) >= 1) AND (char_length(key_hash) <= 100)))
);

ALTER TABLE public.public_rate_limits ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.public_rate_limits_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.time_off_requests (
    id text NOT NULL,
    company_id uuid NOT NULL,
    crew_id text NOT NULL,
    start_date text NOT NULL,
    end_date text NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_at text NOT NULL,
    decided_by text,
    decided_at text
);

CREATE TABLE public.timesheets (
    id text NOT NULL,
    company_id uuid NOT NULL,
    crew_id text NOT NULL,
    job_id text,
    date text NOT NULL,
    clock_in text,
    clock_out text,
    hours numeric,
    notes text DEFAULT ''::text NOT NULL,
    location text DEFAULT ''::text NOT NULL,
    auto_closed boolean DEFAULT false NOT NULL
);

COMMENT ON COLUMN public.timesheets.auto_closed IS 'The clock-out was set to 20:00 by the 8 PM rule, not tapped. Set by the database only.';

CREATE TABLE public.trees (
    id text NOT NULL,
    company_id uuid NOT NULL,
    customer_id text NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    species text DEFAULT ''::text NOT NULL,
    dbh text DEFAULT ''::text NOT NULL,
    height text DEFAULT ''::text NOT NULL,
    condition text DEFAULT 'Good'::text NOT NULL,
    status text DEFAULT ''::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    dbh_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    condition_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    risk_rating text DEFAULT ''::text NOT NULL,
    risk_notes text DEFAULT ''::text NOT NULL,
    photos jsonb DEFAULT '[]'::jsonb NOT NULL,
    next_inspection_date text,
    source text DEFAULT 'manual'::text NOT NULL,
    site_id text
);

ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.automation_batch_items
    ADD CONSTRAINT automation_batch_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.automation_batches
    ADD CONSTRAINT automation_batches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.automation_runs
    ADD CONSTRAINT automation_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.automation_sends
    ADD CONSTRAINT automation_sends_company_id_dedupe_key_key UNIQUE (company_id, dedupe_key);

ALTER TABLE ONLY public.automation_sends
    ADD CONSTRAINT automation_sends_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.booking_rate_limits
    ADD CONSTRAINT booking_rate_limits_pkey PRIMARY KEY (id);

ALTER TABLE public.booking_requests
    ADD CONSTRAINT booking_requests_address_len CHECK ((char_length(address) <= 300)) NOT VALID;

ALTER TABLE public.booking_requests
    ADD CONSTRAINT booking_requests_details_len CHECK ((char_length(details) <= 2000)) NOT VALID;

ALTER TABLE public.booking_requests
    ADD CONSTRAINT booking_requests_email_len CHECK (((email IS NULL) OR (char_length(email) <= 254))) NOT VALID;

ALTER TABLE public.booking_requests
    ADD CONSTRAINT booking_requests_name_len CHECK ((char_length(name) <= 100)) NOT VALID;

ALTER TABLE public.booking_requests
    ADD CONSTRAINT booking_requests_phone_len CHECK ((char_length(phone) <= 30)) NOT VALID;

ALTER TABLE ONLY public.booking_requests
    ADD CONSTRAINT booking_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.chemical_records
    ADD CONSTRAINT chemical_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.closed_days
    ADD CONSTRAINT closed_days_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.company_document_files
    ADD CONSTRAINT company_document_files_company_id_id_key UNIQUE (company_id, id);

ALTER TABLE ONLY public.company_document_files
    ADD CONSTRAINT company_document_files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.company_documents
    ADD CONSTRAINT company_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.company_members
    ADD CONSTRAINT company_members_pkey PRIMARY KEY (user_id, company_id);

ALTER TABLE ONLY public.crew_locations
    ADD CONSTRAINT crew_locations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.crew
    ADD CONSTRAINT crew_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.crew_unavailability
    ADD CONSTRAINT crew_unavailability_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customer_addresses
    ADD CONSTRAINT customer_addresses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customer_edit_requests
    ADD CONSTRAINT customer_edit_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.day_crews
    ADD CONSTRAINT day_crews_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.email_threads
    ADD CONSTRAINT email_threads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.equipment_notes
    ADD CONSTRAINT equipment_notes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.equipment
    ADD CONSTRAINT equipment_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.equipment_problem_photos
    ADD CONSTRAINT equipment_problem_photos_pkey PRIMARY KEY (problem_id);

ALTER TABLE ONLY public.equipment_problems
    ADD CONSTRAINT equipment_problems_company_id_id_key UNIQUE (company_id, id);

ALTER TABLE ONLY public.equipment_problems
    ADD CONSTRAINT equipment_problems_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.estimate_accept_links
    ADD CONSTRAINT estimate_accept_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.estimate_accept_links
    ADD CONSTRAINT estimate_accept_links_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gps_pings
    ADD CONSTRAINT gps_pings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoice_reviews
    ADD CONSTRAINT invoice_reviews_company_id_job_id_key UNIQUE (company_id, job_id);

ALTER TABLE ONLY public.invoice_reviews
    ADD CONSTRAINT invoice_reviews_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.job_price_changes
    ADD CONSTRAINT job_price_changes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.location_requests
    ADD CONSTRAINT location_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.maintenance_records
    ADD CONSTRAINT maintenance_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.maintenance_tasks
    ADD CONSTRAINT maintenance_tasks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.phc_programs
    ADD CONSTRAINT phc_programs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.phc_visits
    ADD CONSTRAINT phc_visits_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.private_notes
    ADD CONSTRAINT private_notes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.public_rate_limits
    ADD CONSTRAINT public_rate_limits_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (company_id);

ALTER TABLE ONLY public.time_off_requests
    ADD CONSTRAINT time_off_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.timesheet_week_approvals
    ADD CONSTRAINT timesheet_week_approvals_pkey PRIMARY KEY (company_id, week_start);

ALTER TABLE ONLY public.timesheets
    ADD CONSTRAINT timesheets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.trees
    ADD CONSTRAINT trees_pkey PRIMARY KEY (id);

CREATE INDEX automation_batch_items_batch ON public.automation_batch_items USING btree (batch_id);

CREATE INDEX automation_batch_items_company_key ON public.automation_batch_items USING btree (company_id, dedupe_key);

CREATE UNIQUE INDEX automation_batch_items_one_waiting ON public.automation_batch_items USING btree (company_id, dedupe_key) WHERE (status = 'waiting'::text);

CREATE INDEX automation_batches_company_time ON public.automation_batches USING btree (company_id, created_at DESC);

CREATE UNIQUE INDEX automation_batches_one_open ON public.automation_batches USING btree (company_id) WHERE (status = ANY (ARRAY['waiting'::text, 'sending'::text]));

CREATE INDEX automation_runs_company_time ON public.automation_runs USING btree (company_id, started_at DESC);

CREATE INDEX automation_sends_company_time ON public.automation_sends USING btree (company_id, created_at DESC);

CREATE INDEX automation_sends_customer ON public.automation_sends USING btree (company_id, customer_id, created_at DESC);

CREATE INDEX booking_rate_limits_contact_time ON public.booking_rate_limits USING btree (contact_hash, created_at) WHERE (contact_hash IS NOT NULL);

CREATE INDEX booking_rate_limits_ip_time ON public.booking_rate_limits USING btree (ip_hash, created_at);

CREATE INDEX booking_rate_limits_time ON public.booking_rate_limits USING btree (created_at);

CREATE INDEX company_documents_company ON public.company_documents USING btree (company_id);

CREATE INDEX company_documents_file ON public.company_documents USING btree (file_id) WHERE (file_id IS NOT NULL);

CREATE INDEX customer_edit_requests_company_status ON public.customer_edit_requests USING btree (company_id, status);

CREATE INDEX customer_edit_requests_customer ON public.customer_edit_requests USING btree (customer_id);

CREATE INDEX equipment_problems_company_status ON public.equipment_problems USING btree (company_id, status);

CREATE INDEX equipment_problems_equipment ON public.equipment_problems USING btree (equipment_id);

CREATE INDEX equipment_problems_reporter ON public.equipment_problems USING btree (reported_user);

CREATE INDEX estimate_accept_links_estimate ON public.estimate_accept_links USING btree (estimate_id);

CREATE INDEX idx_audit_log_company_customer_job ON public.audit_log USING btree (company_id, customer_id, job_id);

CREATE INDEX idx_automations_company ON public.automations USING btree (company_id);

CREATE INDEX idx_booking_requests_company_date ON public.booking_requests USING btree (company_id, date);

CREATE INDEX idx_chemical_records_program ON public.chemical_records USING btree (company_id, program_id);

CREATE INDEX idx_crew_company ON public.crew USING btree (company_id);

CREATE INDEX idx_crew_unavailability_company_crew ON public.crew_unavailability USING btree (company_id, crew_id);

CREATE INDEX idx_customers_company ON public.customers USING btree (company_id);

CREATE INDEX idx_day_crews_company_date ON public.day_crews USING btree (company_id, date);

CREATE INDEX idx_email_threads_customer ON public.email_threads USING btree (company_id, customer_id);

CREATE INDEX idx_equipment_company ON public.equipment USING btree (company_id);

CREATE INDEX idx_equipment_notes_equipment_created ON public.equipment_notes USING btree (company_id, equipment_id, created_at);

CREATE INDEX idx_estimates_company_customer ON public.estimates USING btree (company_id, customer_id);

CREATE INDEX idx_estimates_job ON public.estimates USING btree (job_id);

CREATE INDEX idx_gps_pings_crew_time ON public.gps_pings USING btree (company_id, crew_id, recorded_at);

CREATE INDEX idx_gps_pings_job_time ON public.gps_pings USING btree (company_id, job_id, recorded_at);

CREATE INDEX idx_invoices_company_customer ON public.invoices USING btree (company_id, customer_id);

CREATE INDEX idx_invoices_job ON public.invoices USING btree (job_id);

CREATE INDEX idx_jobs_company_customer_date ON public.jobs USING btree (company_id, customer_id, date);

CREATE INDEX idx_jobs_company_date ON public.jobs USING btree (company_id, date);

CREATE INDEX idx_jobs_crew ON public.jobs USING gin (crew_ids);

CREATE INDEX idx_jobs_equipment ON public.jobs USING gin (equipment_ids);

CREATE INDEX idx_jobs_tree ON public.jobs USING gin (tree_ids);

CREATE INDEX idx_maintenance_records_task ON public.maintenance_records USING btree (task_id);

CREATE INDEX idx_maintenance_tasks_equipment ON public.maintenance_tasks USING btree (equipment_id);

CREATE INDEX idx_messages_company_customer ON public.messages USING btree (company_id, customer_id);

CREATE INDEX idx_messages_customer_time ON public.messages USING btree (company_id, customer_id, created_at);

CREATE INDEX idx_messages_job ON public.messages USING btree (job_id);

CREATE INDEX idx_phc_programs_company_customer ON public.phc_programs USING btree (company_id, customer_id);

CREATE INDEX idx_phc_programs_renewal ON public.phc_programs USING btree (company_id, renewal_date);

CREATE INDEX idx_phc_visits_program ON public.phc_visits USING btree (company_id, program_id);

CREATE INDEX idx_private_notes_customer ON public.private_notes USING btree (company_id, customer_id);

CREATE INDEX idx_timesheets_company_crew_date ON public.timesheets USING btree (company_id, crew_id, date);

CREATE INDEX idx_timesheets_job ON public.timesheets USING btree (job_id);

CREATE INDEX idx_trees_customer ON public.trees USING btree (company_id, customer_id);

CREATE INDEX idx_trees_source ON public.trees USING btree (company_id, source);

CREATE INDEX invoice_reviews_company_time ON public.invoice_reviews USING btree (company_id, created_at DESC);

CREATE INDEX invoices_auto_send_sending ON public.invoices USING btree (company_id, auto_send_claimed_at) WHERE (auto_send_status = 'sending'::text);

CREATE INDEX invoices_auto_send_waiting ON public.invoices USING btree (company_id, auto_send_at) WHERE (auto_send_status = 'waiting'::text);

CREATE UNIQUE INDEX invoices_company_number ON public.invoices USING btree (company_id, number);

CREATE INDEX job_price_changes_company_seen ON public.job_price_changes USING btree (company_id, seen_at);

CREATE INDEX job_price_changes_job ON public.job_price_changes USING btree (job_id);

CREATE INDEX public_rate_limits_lookup ON public.public_rate_limits USING btree (bucket, key_hash, created_at);

CREATE TRIGGER close_other_open_clocks AFTER INSERT ON public.timesheets FOR EACH ROW WHEN ((new.clock_in IS NOT NULL)) EXECUTE FUNCTION public.close_other_open_clocks();

CREATE TRIGGER drop_replaced_document_file AFTER DELETE OR UPDATE OF file_id ON public.company_documents FOR EACH ROW EXECUTE FUNCTION public.drop_replaced_document_file();

CREATE TRIGGER equipment_problem_has_photo AFTER INSERT OR DELETE ON public.equipment_problem_photos FOR EACH ROW EXECUTE FUNCTION public.equipment_problem_has_photo();

CREATE TRIGGER estimate_accept_links_revoke_on_change AFTER UPDATE ON public.estimates FOR EACH ROW EXECUTE FUNCTION public.estimate_accept_links_revoke_on_change();

CREATE TRIGGER estimate_author_keep BEFORE UPDATE ON public.estimates FOR EACH ROW EXECUTE FUNCTION public.keep_estimate_author();

CREATE TRIGGER estimate_author_on_insert BEFORE INSERT ON public.estimates FOR EACH ROW EXECUTE FUNCTION public.set_estimate_author();

CREATE TRIGGER invoices_after_insert AFTER INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.invoices_after_insert();

CREATE TRIGGER invoices_auto_send_guard BEFORE INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.invoices_auto_send_guard();

CREATE TRIGGER invoices_unique_number BEFORE INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.invoices_unique_number();

CREATE TRIGGER limit_crew_clock_times BEFORE INSERT OR UPDATE ON public.timesheets FOR EACH ROW EXECUTE FUNCTION public.limit_crew_clock_times();

CREATE TRIGGER limit_crew_job_edits BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.limit_crew_job_edits();

CREATE TRIGGER limit_crew_self_edits BEFORE UPDATE ON public.crew FOR EACH ROW EXECUTE FUNCTION public.limit_crew_self_edits();

CREATE TRIGGER limit_member_audit_entries BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.limit_member_audit_entries();

CREATE TRIGGER limit_sales_estimate_edits BEFORE UPDATE ON public.estimates FOR EACH ROW EXECUTE FUNCTION public.limit_sales_estimate_edits();

CREATE TRIGGER on_job_deleted_invoice AFTER DELETE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.on_job_deleted_invoice();

CREATE TRIGGER on_job_status_invoice BEFORE UPDATE ON public.jobs FOR EACH ROW WHEN (((old.status IS DISTINCT FROM new.status) OR (old.invoice_id IS DISTINCT FROM new.invoice_id))) EXECUTE FUNCTION public.on_job_status_invoice();

CREATE TRIGGER protect_last_owner BEFORE DELETE OR UPDATE ON public.company_members FOR EACH ROW EXECUTE FUNCTION public.protect_last_owner();

CREATE TRIGGER settings_auto_emails_since BEFORE INSERT OR UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION public.settings_auto_emails_since();

CREATE TRIGGER stamp_customer_edit_request BEFORE INSERT ON public.customer_edit_requests FOR EACH ROW EXECUTE FUNCTION public.stamp_customer_edit_request();

CREATE TRIGGER stamp_equipment_problem BEFORE INSERT OR UPDATE ON public.equipment_problems FOR EACH ROW EXECUTE FUNCTION public.stamp_equipment_problem();

CREATE TRIGGER stamp_private_note_author BEFORE INSERT OR UPDATE ON public.private_notes FOR EACH ROW EXECUTE FUNCTION public.stamp_private_note_author();

CREATE TRIGGER stamp_week_approval BEFORE INSERT ON public.timesheet_week_approvals FOR EACH ROW EXECUTE FUNCTION public.stamp_week_approval();

CREATE TRIGGER timesheets_auto_closed_reset BEFORE UPDATE ON public.timesheets FOR EACH ROW EXECUTE FUNCTION public.timesheets_auto_closed_reset();

ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.automation_batch_items
    ADD CONSTRAINT automation_batch_items_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.automation_batches(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.automation_batch_items
    ADD CONSTRAINT automation_batch_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.automation_batches
    ADD CONSTRAINT automation_batches_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.automation_runs
    ADD CONSTRAINT automation_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.automation_sends
    ADD CONSTRAINT automation_sends_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.booking_requests
    ADD CONSTRAINT booking_requests_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.chemical_records
    ADD CONSTRAINT chemical_records_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.closed_days
    ADD CONSTRAINT closed_days_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.company_document_files
    ADD CONSTRAINT company_document_files_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.company_documents
    ADD CONSTRAINT company_documents_company_id_file_id_fkey FOREIGN KEY (company_id, file_id) REFERENCES public.company_document_files(company_id, id) ON DELETE SET NULL (file_id);

ALTER TABLE ONLY public.company_documents
    ADD CONSTRAINT company_documents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.company_members
    ADD CONSTRAINT company_members_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.company_members
    ADD CONSTRAINT company_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.crew
    ADD CONSTRAINT crew_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.crew
    ADD CONSTRAINT crew_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.crew_locations
    ADD CONSTRAINT crew_locations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.crew_unavailability
    ADD CONSTRAINT crew_unavailability_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.customer_addresses
    ADD CONSTRAINT customer_addresses_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.customer_addresses
    ADD CONSTRAINT customer_addresses_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.customer_edit_requests
    ADD CONSTRAINT customer_edit_requests_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.customer_edit_requests
    ADD CONSTRAINT customer_edit_requests_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.day_crews
    ADD CONSTRAINT day_crews_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.email_threads
    ADD CONSTRAINT email_threads_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.equipment
    ADD CONSTRAINT equipment_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.equipment_notes
    ADD CONSTRAINT equipment_notes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.equipment_problem_photos
    ADD CONSTRAINT equipment_problem_photos_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.equipment_problem_photos
    ADD CONSTRAINT equipment_problem_photos_company_id_problem_id_fkey FOREIGN KEY (company_id, problem_id) REFERENCES public.equipment_problems(company_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.equipment_problems
    ADD CONSTRAINT equipment_problems_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.equipment_problems
    ADD CONSTRAINT equipment_problems_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES public.equipment(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.estimate_accept_links
    ADD CONSTRAINT estimate_accept_links_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.estimate_accept_links
    ADD CONSTRAINT estimate_accept_links_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES public.estimates(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.gps_pings
    ADD CONSTRAINT gps_pings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invoice_reviews
    ADD CONSTRAINT invoice_reviews_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invoice_reviews
    ADD CONSTRAINT invoice_reviews_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.job_price_changes
    ADD CONSTRAINT job_price_changes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.job_price_changes
    ADD CONSTRAINT job_price_changes_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.location_requests
    ADD CONSTRAINT location_requests_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.maintenance_records
    ADD CONSTRAINT maintenance_records_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.maintenance_records
    ADD CONSTRAINT maintenance_records_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.maintenance_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.maintenance_tasks
    ADD CONSTRAINT maintenance_tasks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.maintenance_tasks
    ADD CONSTRAINT maintenance_tasks_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES public.equipment(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.phc_programs
    ADD CONSTRAINT phc_programs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.phc_visits
    ADD CONSTRAINT phc_visits_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.private_notes
    ADD CONSTRAINT private_notes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.time_off_requests
    ADD CONSTRAINT time_off_requests_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.timesheet_week_approvals
    ADD CONSTRAINT timesheet_week_approvals_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.timesheets
    ADD CONSTRAINT timesheets_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.trees
    ADD CONSTRAINT trees_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

CREATE POLICY "admins add company memberships" ON public.company_members FOR INSERT TO authenticated WITH CHECK ((public.is_company_admin(company_id) AND ((role <> 'owner'::text) OR public.is_company_owner(company_id))));

CREATE POLICY "admins approve weeks" ON public.timesheet_week_approvals FOR INSERT TO authenticated WITH CHECK (public.is_company_admin(company_id));

CREATE POLICY "admins change company memberships" ON public.company_members FOR UPDATE TO authenticated USING ((public.is_company_admin(company_id) AND ((role <> 'owner'::text) OR public.is_company_owner(company_id)))) WITH CHECK ((public.is_company_admin(company_id) AND ((role <> 'owner'::text) OR public.is_company_owner(company_id))));

CREATE POLICY "admins delete closed_days" ON public.closed_days FOR DELETE TO authenticated USING (public.is_company_admin(company_id));

CREATE POLICY "admins delete crew" ON public.crew FOR DELETE TO authenticated USING (public.is_company_admin(company_id));

CREATE POLICY "admins delete settings" ON public.settings FOR DELETE TO authenticated USING (public.is_company_admin(company_id));

CREATE POLICY "admins insert closed_days" ON public.closed_days FOR INSERT TO authenticated WITH CHECK (public.is_company_admin(company_id));

CREATE POLICY "admins insert crew" ON public.crew FOR INSERT TO authenticated WITH CHECK (public.is_company_admin(company_id));

CREATE POLICY "admins insert settings" ON public.settings FOR INSERT TO authenticated WITH CHECK (public.is_company_admin(company_id));

CREATE POLICY "admins read company memberships" ON public.company_members FOR SELECT TO authenticated USING (public.is_company_admin(company_id));

CREATE POLICY "admins read week approvals" ON public.timesheet_week_approvals FOR SELECT TO authenticated USING (public.is_company_admin(company_id));

CREATE POLICY "admins remove company memberships" ON public.company_members FOR DELETE TO authenticated USING ((public.is_company_admin(company_id) AND ((role <> 'owner'::text) OR public.is_company_owner(company_id))));

CREATE POLICY "admins undo week approvals" ON public.timesheet_week_approvals FOR DELETE TO authenticated USING (public.is_company_admin(company_id));

CREATE POLICY "admins update closed_days" ON public.closed_days FOR UPDATE TO authenticated USING (public.is_company_admin(company_id)) WITH CHECK (public.is_company_admin(company_id));

CREATE POLICY "admins update own company" ON public.companies FOR UPDATE TO authenticated USING (public.is_company_admin(id)) WITH CHECK (public.is_company_admin(id));

CREATE POLICY "admins update settings" ON public.settings FOR UPDATE TO authenticated USING (public.is_company_admin(company_id)) WITH CHECK (public.is_company_admin(company_id));

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authors delete own equipment_notes" ON public.equipment_notes FOR DELETE TO authenticated USING ((author_id = public.current_crew_id(company_id)));

ALTER TABLE public.automation_batch_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.automation_batches ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.automation_sends ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.automations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.booking_rate_limits ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.booking_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.chemical_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "climbers read their jobs' price changes" ON public.job_price_changes FOR SELECT TO authenticated USING ((public.is_climber(company_id) AND (EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = job_price_changes.job_id) AND (j.company_id = job_price_changes.company_id) AND public.job_row_assigned(j.company_id, j.crew_ids, j.date))))));

ALTER TABLE public.closed_days ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.company_document_files ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.company_documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.company_members ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.crew ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crew delete own pending time_off_requests" ON public.time_off_requests FOR DELETE TO authenticated USING (((crew_id = public.current_crew_id(company_id)) AND (status = 'pending'::text)));

ALTER TABLE public.crew_locations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.crew_unavailability ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customer_addresses ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customer_edit_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.day_crews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "delete private_notes" ON public.private_notes FOR DELETE TO authenticated USING ((((kind = 'admin'::text) AND public.is_company_admin(company_id)) OR ((kind = 'personal'::text) AND public.is_company_member(company_id) AND (author_user = auth.uid()))));

CREATE POLICY "delete team notes" ON public.private_notes FOR DELETE TO authenticated USING (((kind = 'team'::text) AND (public.is_company_admin(company_id) OR (public.is_company_staff(company_id) AND (author = public.current_crew_name(company_id))))));

ALTER TABLE public.email_threads ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.equipment ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.equipment_notes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.equipment_problem_photos ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.equipment_problems ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.estimate_accept_links ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.gps_pings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "insert crew_locations" ON public.crew_locations FOR INSERT TO authenticated WITH CHECK ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id))));

CREATE POLICY "insert crew_unavailability" ON public.crew_unavailability FOR INSERT TO authenticated WITH CHECK ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id))));

CREATE POLICY "insert email_threads" ON public.email_threads FOR INSERT TO authenticated WITH CHECK ((public.is_company_staff(company_id) OR (public.crew_perm(company_id, 'canMessageCustomers'::text) AND public.can_read_customer(company_id, customer_id))));

CREATE POLICY "insert equipment_notes" ON public.equipment_notes FOR INSERT TO authenticated WITH CHECK ((public.is_company_staff(company_id) OR (public.is_company_member(company_id) AND (author_id = public.current_crew_id(company_id)))));

CREATE POLICY "insert gps_pings" ON public.gps_pings FOR INSERT TO authenticated WITH CHECK ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id))));

CREATE POLICY "insert messages" ON public.messages FOR INSERT TO authenticated WITH CHECK ((public.is_company_staff(company_id) OR (public.crew_perm(company_id, 'canMessageCustomers'::text) AND public.can_read_customer(company_id, customer_id) AND (sender_crew_id = public.current_crew_id(company_id)))));

CREATE POLICY "insert private_notes" ON public.private_notes FOR INSERT TO authenticated WITH CHECK ((((kind = 'admin'::text) AND public.is_company_admin(company_id)) OR ((kind = 'personal'::text) AND public.is_company_member(company_id) AND (author_user = auth.uid()) AND (author = public.current_crew_name(company_id)) AND public.can_read_customer(company_id, customer_id))));

CREATE POLICY "insert time_off_requests" ON public.time_off_requests FOR INSERT TO authenticated WITH CHECK ((public.is_company_staff(company_id) OR ((crew_id = public.current_crew_id(company_id)) AND (status = 'pending'::text) AND (decided_by IS NULL))));

CREATE POLICY "insert timesheets" ON public.timesheets FOR INSERT TO authenticated WITH CHECK ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id))));

ALTER TABLE public.invoice_reviews ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.job_price_changes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.location_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.maintenance_records ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.maintenance_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members insert audit_log" ON public.audit_log FOR INSERT TO authenticated WITH CHECK (public.is_company_member(company_id));

CREATE POLICY "members read closed_days" ON public.closed_days FOR SELECT TO authenticated USING (public.is_company_member(company_id));

CREATE POLICY "members read day_crews" ON public.day_crews FOR SELECT TO authenticated USING (public.is_company_member(company_id));

CREATE POLICY "members read equipment" ON public.equipment FOR SELECT TO authenticated USING (public.is_company_member(company_id));

CREATE POLICY "members read equipment_notes" ON public.equipment_notes FOR SELECT TO authenticated USING (public.is_company_member(company_id));

CREATE POLICY "members read maintenance_records" ON public.maintenance_records FOR SELECT TO authenticated USING (public.is_company_member(company_id));

CREATE POLICY "members read maintenance_tasks" ON public.maintenance_tasks FOR SELECT TO authenticated USING (public.is_company_member(company_id));

CREATE POLICY "members read own company" ON public.companies FOR SELECT TO authenticated USING ((id IN ( SELECT company_members.company_id
   FROM public.company_members
  WHERE (company_members.user_id = auth.uid()))));

CREATE POLICY "members read own membership" ON public.company_members FOR SELECT TO authenticated USING ((user_id = auth.uid()));

CREATE POLICY "members read settings" ON public.settings FOR SELECT TO authenticated USING (public.is_company_member(company_id));

CREATE POLICY "members report equipment problems" ON public.equipment_problems FOR INSERT TO authenticated WITH CHECK ((public.is_company_member(company_id) AND (reported_user = auth.uid()) AND (status = 'open'::text) AND (EXISTS ( SELECT 1
   FROM public.equipment e
  WHERE ((e.id = equipment_problems.equipment_id) AND (e.company_id = equipment_problems.company_id))))));

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.phc_programs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.phc_visits ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.private_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read closed_days" ON public.closed_days FOR SELECT TO anon USING (true);

ALTER TABLE public.public_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read audit_log" ON public.audit_log FOR SELECT TO authenticated USING (public.audit_entry_visible(company_id, job_id, entity, entity_id, field));

CREATE POLICY "read crew" ON public.crew FOR SELECT TO authenticated USING ((public.is_company_staff(company_id) OR ((auth_user_id = auth.uid()) AND public.is_company_member(company_id))));

CREATE POLICY "read crew_locations" ON public.crew_locations FOR SELECT TO authenticated USING ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id))));

CREATE POLICY "read crew_unavailability" ON public.crew_unavailability FOR SELECT TO authenticated USING ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id))));

CREATE POLICY "read customer_addresses" ON public.customer_addresses FOR SELECT TO authenticated USING (public.can_read_customer(company_id, customer_id));

CREATE POLICY "read customers" ON public.customers FOR SELECT TO authenticated USING (public.can_read_customer(company_id, id));

CREATE POLICY "read email_threads" ON public.email_threads FOR SELECT TO authenticated USING (public.can_read_customer(company_id, customer_id));

CREATE POLICY "read estimates" ON public.estimates FOR SELECT TO authenticated USING ((public.is_company_staff(company_id) OR (public.crew_perm(company_id, 'seeMoney'::text) AND public.can_read_customer(company_id, customer_id))));

CREATE POLICY "read gps_pings" ON public.gps_pings FOR SELECT TO authenticated USING ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id))));

CREATE POLICY "read invoices" ON public.invoices FOR SELECT TO authenticated USING ((public.is_company_staff(company_id) OR (public.crew_perm(company_id, 'seeMoney'::text) AND public.can_read_customer(company_id, customer_id))));

CREATE POLICY "read jobs" ON public.jobs FOR SELECT TO authenticated USING (public.job_row_visible(company_id, crew_ids, date));

CREATE POLICY "read location_requests" ON public.location_requests FOR SELECT TO authenticated USING ((public.is_company_staff(company_id) OR (public.is_company_member(company_id) AND ((target_crew_id IS NULL) OR (target_crew_id = public.current_crew_id(company_id))))));

CREATE POLICY "read messages" ON public.messages FOR SELECT TO authenticated USING ((public.can_read_customer(company_id, customer_id) AND ((NOT automatic) OR public.is_company_staff(company_id) OR public.crew_perm(company_id, 'seeMoney'::text))));

CREATE POLICY "read private_notes" ON public.private_notes FOR SELECT TO authenticated USING ((((kind = 'admin'::text) AND public.is_company_admin(company_id)) OR ((kind = 'personal'::text) AND public.is_company_member(company_id) AND (author_user = auth.uid()))));

CREATE POLICY "read team notes" ON public.private_notes FOR SELECT TO authenticated USING (((kind = 'team'::text) AND public.can_read_customer(company_id, customer_id)));

CREATE POLICY "read time_off_requests" ON public.time_off_requests FOR SELECT TO authenticated USING ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id))));

CREATE POLICY "read timesheets" ON public.timesheets FOR SELECT TO authenticated USING ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id))));

CREATE POLICY "read trees" ON public.trees FOR SELECT TO authenticated USING (public.can_read_customer(company_id, customer_id));

CREATE POLICY "reporters add problem photos" ON public.equipment_problem_photos FOR INSERT TO authenticated WITH CHECK ((public.is_company_member(company_id) AND (EXISTS ( SELECT 1
   FROM public.equipment_problems p
  WHERE ((p.id = equipment_problem_photos.problem_id) AND (p.company_id = equipment_problem_photos.company_id) AND ((p.reported_user = auth.uid()) OR public.is_company_staff(p.company_id)))))));

CREATE POLICY "reporters read own equipment problems" ON public.equipment_problems FOR SELECT TO authenticated USING ((public.is_company_member(company_id) AND (reported_user = auth.uid())));

CREATE POLICY "reporters read own problem photos" ON public.equipment_problem_photos FOR SELECT TO authenticated USING ((public.is_company_member(company_id) AND (EXISTS ( SELECT 1
   FROM public.equipment_problems p
  WHERE ((p.id = equipment_problem_photos.problem_id) AND (p.reported_user = auth.uid()))))));

CREATE POLICY "sales estimates ceiling" ON public.estimates AS RESTRICTIVE FOR SELECT TO authenticated USING ((public.is_company_staff(company_id) OR (NOT public.is_sales_person(company_id)) OR public.sales_can_read_estimate(company_id, customer_id, created_by_crew_id)));

CREATE POLICY "sales insert customers" ON public.customers FOR INSERT TO authenticated WITH CHECK (public.is_sales_person(company_id));

CREATE POLICY "sales insert draft estimates" ON public.estimates FOR INSERT TO authenticated WITH CHECK ((public.is_sales_person(company_id) AND (status = 'draft'::text) AND (job_id IS NULL) AND (accepted_option_id IS NULL) AND (accepted_at IS NULL) AND (accepted_by IS NULL) AND (email_queued_at IS NULL) AND (EXISTS ( SELECT 1
   FROM public.customers c
  WHERE ((c.id = estimates.customer_id) AND (c.company_id = estimates.company_id))))));

CREATE POLICY "sales read customer_addresses" ON public.customer_addresses FOR SELECT TO authenticated USING (public.is_sales_person(company_id));

CREATE POLICY "sales read customers" ON public.customers FOR SELECT TO authenticated USING (public.is_sales_person(company_id));

CREATE POLICY "sales read estimates" ON public.estimates FOR SELECT TO authenticated USING (public.sales_can_read_estimate(company_id, customer_id, created_by_crew_id));

CREATE POLICY "sales read own customer edits" ON public.customer_edit_requests FOR SELECT TO authenticated USING ((public.is_sales_person(company_id) AND (requested_user = auth.uid())));

CREATE POLICY "sales see no invoices" ON public.invoices AS RESTRICTIVE FOR SELECT TO authenticated USING ((public.is_company_staff(company_id) OR (NOT public.is_sales_person(company_id))));

CREATE POLICY "sales suggest customer edits" ON public.customer_edit_requests FOR INSERT TO authenticated WITH CHECK ((public.is_sales_person(company_id) AND (status = 'pending'::text) AND (decided_by IS NULL) AND (decided_user IS NULL) AND (decided_at IS NULL) AND (requested_user = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.customers c
  WHERE ((c.id = customer_edit_requests.customer_id) AND (c.company_id = customer_edit_requests.company_id))))));

CREATE POLICY "sales update draft estimates" ON public.estimates FOR UPDATE TO authenticated USING ((public.sales_can_read_estimate(company_id, customer_id, created_by_crew_id) AND (status = 'draft'::text) AND (job_id IS NULL))) WITH CHECK ((public.sales_can_read_estimate(company_id, customer_id, created_by_crew_id) AND (status = 'draft'::text) AND (job_id IS NULL) AND (accepted_option_id IS NULL) AND (accepted_at IS NULL) AND (accepted_by IS NULL) AND (email_queued_at IS NULL)));

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff add documents" ON public.company_documents FOR INSERT TO authenticated WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff add team notes" ON public.private_notes FOR INSERT TO authenticated WITH CHECK (((kind = 'team'::text) AND public.is_company_staff(company_id) AND (author = public.current_crew_name(company_id))));

CREATE POLICY "staff all automations" ON public.automations TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff all booking_requests" ON public.booking_requests TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff all chemical_records" ON public.chemical_records TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff all phc_programs" ON public.phc_programs TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff all phc_visits" ON public.phc_visits TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff change documents" ON public.company_documents FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff change equipment problems" ON public.equipment_problems FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff delete crew_locations" ON public.crew_locations FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete crew_unavailability" ON public.crew_unavailability FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete customer edits" ON public.customer_edit_requests FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete customer_addresses" ON public.customer_addresses FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete customers" ON public.customers FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete day_crews" ON public.day_crews FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete document files" ON public.company_document_files FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete documents" ON public.company_documents FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete email_threads" ON public.email_threads FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete equipment" ON public.equipment FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete equipment problems" ON public.equipment_problems FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete equipment_notes" ON public.equipment_notes FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete estimates" ON public.estimates FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete gps_pings" ON public.gps_pings FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete invoice_reviews" ON public.invoice_reviews FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete invoices" ON public.invoices FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete jobs" ON public.jobs FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete location_requests" ON public.location_requests FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete maintenance_records" ON public.maintenance_records FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete maintenance_tasks" ON public.maintenance_tasks FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete messages" ON public.messages FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete problem photos" ON public.equipment_problem_photos FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete time_off_requests" ON public.time_off_requests FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete timesheets" ON public.timesheets FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff delete trees" ON public.trees FOR DELETE TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff insert customer_addresses" ON public.customer_addresses FOR INSERT TO authenticated WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff insert customers" ON public.customers FOR INSERT TO authenticated WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff insert day_crews" ON public.day_crews FOR INSERT TO authenticated WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff insert equipment" ON public.equipment FOR INSERT TO authenticated WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff insert estimates" ON public.estimates FOR INSERT TO authenticated WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff insert invoices" ON public.invoices FOR INSERT TO authenticated WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff insert jobs" ON public.jobs FOR INSERT TO authenticated WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff insert location_requests" ON public.location_requests FOR INSERT TO authenticated WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff insert maintenance_records" ON public.maintenance_records FOR INSERT TO authenticated WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff insert maintenance_tasks" ON public.maintenance_tasks FOR INSERT TO authenticated WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff insert trees" ON public.trees FOR INSERT TO authenticated WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff read automation_batch_items" ON public.automation_batch_items FOR SELECT TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff read automation_batches" ON public.automation_batches FOR SELECT TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff read automation_runs" ON public.automation_runs FOR SELECT TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff read automation_sends" ON public.automation_sends FOR SELECT TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff read customer edits" ON public.customer_edit_requests FOR SELECT TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff read document files" ON public.company_document_files FOR SELECT TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff read documents" ON public.company_documents FOR SELECT TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff read equipment problems" ON public.equipment_problems FOR SELECT TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff read invoice_reviews" ON public.invoice_reviews FOR SELECT TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff read job price changes" ON public.job_price_changes FOR SELECT TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff read problem photos" ON public.equipment_problem_photos FOR SELECT TO authenticated USING (public.is_company_staff(company_id));

CREATE POLICY "staff update customer_addresses" ON public.customer_addresses FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff update customers" ON public.customers FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff update day_crews" ON public.day_crews FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff update email_threads" ON public.email_threads FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff update equipment" ON public.equipment FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff update equipment_notes" ON public.equipment_notes FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff update estimates" ON public.estimates FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff update invoices" ON public.invoices FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff update location_requests" ON public.location_requests FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff update maintenance_records" ON public.maintenance_records FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff update maintenance_tasks" ON public.maintenance_tasks FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff update messages" ON public.messages FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff update trees" ON public.trees FOR UPDATE TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY "staff upload document files" ON public.company_document_files FOR INSERT TO authenticated WITH CHECK (public.is_company_staff(company_id));

ALTER TABLE public.time_off_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.timesheet_week_approvals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.timesheets ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.trees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "update assigned jobs" ON public.jobs FOR UPDATE TO authenticated USING (public.job_row_assigned(company_id, crew_ids, date)) WITH CHECK (public.job_row_assigned(company_id, crew_ids, date));

CREATE POLICY "update crew" ON public.crew FOR UPDATE TO authenticated USING ((public.is_company_admin(company_id) OR ((auth_user_id = auth.uid()) AND public.is_company_member(company_id)))) WITH CHECK ((public.is_company_admin(company_id) OR ((auth_user_id = auth.uid()) AND public.is_company_member(company_id))));

CREATE POLICY "update crew_locations" ON public.crew_locations FOR UPDATE TO authenticated USING ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id)))) WITH CHECK ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id))));

CREATE POLICY "update crew_unavailability" ON public.crew_unavailability FOR UPDATE TO authenticated USING ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id)))) WITH CHECK ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id))));

CREATE POLICY "update gps_pings" ON public.gps_pings FOR UPDATE TO authenticated USING ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id)))) WITH CHECK ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id))));

CREATE POLICY "update private_notes" ON public.private_notes FOR UPDATE TO authenticated USING ((((kind = 'admin'::text) AND public.is_company_admin(company_id)) OR ((kind = 'personal'::text) AND (author_user = auth.uid())))) WITH CHECK ((((kind = 'admin'::text) AND public.is_company_admin(company_id)) OR ((kind = 'personal'::text) AND public.is_company_member(company_id) AND (author_user = auth.uid()) AND (author = public.current_crew_name(company_id)))));

CREATE POLICY "update team notes" ON public.private_notes FOR UPDATE TO authenticated USING (((kind = 'team'::text) AND (public.is_company_admin(company_id) OR (public.is_company_staff(company_id) AND (author = public.current_crew_name(company_id)))))) WITH CHECK (((kind = 'team'::text) AND (public.is_company_admin(company_id) OR (public.is_company_staff(company_id) AND (author = public.current_crew_name(company_id))))));

CREATE POLICY "update time_off_requests" ON public.time_off_requests FOR UPDATE TO authenticated USING ((public.is_company_staff(company_id) OR ((crew_id = public.current_crew_id(company_id)) AND (status = 'pending'::text)))) WITH CHECK ((public.is_company_staff(company_id) OR ((crew_id = public.current_crew_id(company_id)) AND (status = 'pending'::text) AND (decided_by IS NULL))));

CREATE POLICY "update timesheets" ON public.timesheets FOR UPDATE TO authenticated USING ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id)))) WITH CHECK ((public.is_company_staff(company_id) OR (crew_id = public.current_crew_id(company_id))));

-- ---------- Privileges ----------
-- Supabase's default privileges hand anon, authenticated and service_role
-- everything on new objects. Start from nothing, then grant exactly what
-- the app needs (row-level security still applies on top of these).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, service_role;

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;

REVOKE ALL ON FUNCTION public.accept_estimate_by_link(p_token_hash text, p_option_id text, p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.accept_estimate_by_link(p_token_hash text, p_option_id text, p_name text) TO service_role;

GRANT ALL ON TABLE public.jobs TO anon;
GRANT ALL ON TABLE public.jobs TO authenticated;
GRANT ALL ON TABLE public.jobs TO service_role;

REVOKE ALL ON FUNCTION public.app_jobs(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_jobs(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.app_jobs(p_company_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.approve_customer_edit(p_request_id uuid, p_changes jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.approve_customer_edit(p_request_id uuid, p_changes jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.approve_customer_edit(p_request_id uuid, p_changes jsonb) TO service_role;

GRANT ALL ON TABLE public.timesheet_week_approvals TO service_role;
GRANT SELECT,INSERT,DELETE ON TABLE public.timesheet_week_approvals TO authenticated;

REVOKE ALL ON FUNCTION public.approve_timesheet_week(p_company uuid, p_week date, p_hours numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.approve_timesheet_week(p_company uuid, p_week date, p_hours numeric) TO authenticated;
GRANT ALL ON FUNCTION public.approve_timesheet_week(p_company uuid, p_week date, p_hours numeric) TO service_role;

REVOKE ALL ON FUNCTION public.audit_actor_name(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.audit_actor_name(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.audit_actor_name(p_company_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.audit_entry_visible(p_company_id uuid, p_job_id text, p_entity text, p_entity_id text, p_field text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.audit_entry_visible(p_company_id uuid, p_job_id text, p_entity text, p_entity_id text, p_field text) TO authenticated;
GRANT ALL ON FUNCTION public.audit_entry_visible(p_company_id uuid, p_job_id text, p_entity text, p_entity_id text, p_field text) TO service_role;

REVOKE ALL ON FUNCTION public.auto_invoice_restore_hand_stops(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.auto_invoice_restore_hand_stops(p_company_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.auto_invoice_send_claim(p_invoice_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.auto_invoice_send_claim(p_invoice_id text) TO service_role;

REVOKE ALL ON FUNCTION public.auto_invoice_send_finish(p_invoice_id text, p_status text, p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.auto_invoice_send_finish(p_invoice_id text, p_status text, p_note text) TO service_role;

REVOKE ALL ON FUNCTION public.auto_invoice_stop_split(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.auto_invoice_stop_split(p_company_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.auto_invoice_stop_unsendable(p_company_id uuid, p_allowed boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.auto_invoice_stop_unsendable(p_company_id uuid, p_allowed boolean) TO service_role;

REVOKE ALL ON FUNCTION public.automation_batch_claim(p_batch_id uuid, p_company_id uuid, p_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.automation_batch_claim(p_batch_id uuid, p_company_id uuid, p_user uuid) TO service_role;

REVOKE ALL ON FUNCTION public.automation_batch_item_finish(p_item_id uuid, p_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.automation_batch_item_finish(p_item_id uuid, p_status text) TO service_role;

REVOKE ALL ON FUNCTION public.automation_batch_release(p_batch_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.automation_batch_release(p_batch_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.booking_limits_take(p_ip_hash text, p_contact_hash text, p_max_visitor_hour integer, p_max_contact_day integer, p_max_day integer, p_max_pending integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.booking_limits_take(p_ip_hash text, p_contact_hash text, p_max_visitor_hour integer, p_max_contact_day integer, p_max_day integer, p_max_pending integer) TO service_role;

REVOKE ALL ON FUNCTION public.booking_rate_limit_take(p_ip_hash text, p_max integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.booking_rate_limit_take(p_ip_hash text, p_max integer) TO service_role;

REVOKE ALL ON FUNCTION public.calendar_jobs(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.calendar_jobs(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.calendar_jobs(p_company_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.can_change_job(p_company_id uuid, p_job_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.can_change_job(p_company_id uuid, p_job_id text) TO authenticated;
GRANT ALL ON FUNCTION public.can_change_job(p_company_id uuid, p_job_id text) TO service_role;

GRANT ALL ON FUNCTION public.can_read_customer(p_company_id uuid, p_customer_id text) TO anon;
GRANT ALL ON FUNCTION public.can_read_customer(p_company_id uuid, p_customer_id text) TO authenticated;
GRANT ALL ON FUNCTION public.can_read_customer(p_company_id uuid, p_customer_id text) TO service_role;

GRANT ALL ON FUNCTION public.can_read_job(p_company_id uuid, p_job_id text) TO anon;
GRANT ALL ON FUNCTION public.can_read_job(p_company_id uuid, p_job_id text) TO authenticated;
GRANT ALL ON FUNCTION public.can_read_job(p_company_id uuid, p_job_id text) TO service_role;

REVOKE ALL ON FUNCTION public.change_job_price(p_job_id text, p_value numeric, p_hourly_rate numeric, p_billing_type text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.change_job_price(p_job_id text, p_value numeric, p_hourly_rate numeric, p_billing_type text, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.change_job_price(p_job_id text, p_value numeric, p_hourly_rate numeric, p_billing_type text, p_reason text) TO service_role;

REVOKE ALL ON FUNCTION public.check_crew_clock_tap(p_date text, p_time text, p_in text, p_kind text, p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.check_crew_clock_tap(p_date text, p_time text, p_in text, p_kind text, p_now timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.claim_automation_send(p_company_id uuid, p_rule_kind text, p_dedupe_key text, p_target_id text, p_customer_id text, p_customer_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_automation_send(p_company_id uuid, p_rule_kind text, p_dedupe_key text, p_target_id text, p_customer_id text, p_customer_name text) TO service_role;

REVOKE ALL ON FUNCTION public.claim_day_plan_sends(p_company_id uuid, p_items jsonb, p_per_hour integer, p_per_day integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_day_plan_sends(p_company_id uuid, p_items jsonb, p_per_hour integer, p_per_day integer) TO service_role;

REVOKE ALL ON FUNCTION public.claim_invoice_payer_sends(p_company_id uuid, p_invoice_id text, p_customer_id text, p_items jsonb, p_per_hour integer, p_per_day integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_invoice_payer_sends(p_company_id uuid, p_invoice_id text, p_customer_id text, p_items jsonb, p_per_hour integer, p_per_day integer) TO service_role;

REVOKE ALL ON FUNCTION public.claim_payment_receipts(p_company_id uuid, p_invoice_id text, p_customer_id text, p_items jsonb, p_per_hour integer, p_per_day integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_payment_receipts(p_company_id uuid, p_invoice_id text, p_customer_id text, p_items jsonb, p_per_hour integer, p_per_day integer) TO service_role;

REVOKE ALL ON FUNCTION public.clear_replaced_price(p_job_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.clear_replaced_price(p_job_id text) TO authenticated;
GRANT ALL ON FUNCTION public.clear_replaced_price(p_job_id text) TO service_role;

REVOKE ALL ON FUNCTION public.clock_now() FROM PUBLIC;
GRANT ALL ON FUNCTION public.clock_now() TO authenticated;
GRANT ALL ON FUNCTION public.clock_now() TO service_role;

REVOKE ALL ON FUNCTION public.close_open_clocks_at_8pm(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.close_open_clocks_at_8pm(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.close_open_clocks_at_8pm(p_company_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.close_other_open_clocks() FROM PUBLIC;
GRANT ALL ON FUNCTION public.close_other_open_clocks() TO service_role;

REVOKE ALL ON FUNCTION public.company_for_customer(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.company_for_customer(p_company_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.create_estimate_accept_link(p_company_id uuid, p_estimate_id text, p_token_hash text, p_again boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_estimate_accept_link(p_company_id uuid, p_estimate_id text, p_token_hash text, p_again boolean) TO service_role;

REVOKE ALL ON FUNCTION public.crew_directory(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crew_directory(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.crew_directory(p_company_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.crew_job_price_before_change(p_job_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crew_job_price_before_change(p_job_id text) TO authenticated;
GRANT ALL ON FUNCTION public.crew_job_price_before_change(p_job_id text) TO service_role;

REVOKE ALL ON FUNCTION public.crew_job_prices(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crew_job_prices(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.crew_job_prices(p_company_id uuid) TO service_role;

GRANT ALL ON FUNCTION public.crew_perm(p_company_id uuid, p_flag text) TO anon;
GRANT ALL ON FUNCTION public.crew_perm(p_company_id uuid, p_flag text) TO authenticated;
GRANT ALL ON FUNCTION public.crew_perm(p_company_id uuid, p_flag text) TO service_role;

GRANT ALL ON FUNCTION public.current_crew_id(p_company_id uuid) TO anon;
GRANT ALL ON FUNCTION public.current_crew_id(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.current_crew_id(p_company_id uuid) TO service_role;

GRANT ALL ON FUNCTION public.current_crew_name(p_company_id uuid) TO anon;
GRANT ALL ON FUNCTION public.current_crew_name(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.current_crew_name(p_company_id uuid) TO service_role;

GRANT ALL ON FUNCTION public.current_member_role(p_company_id uuid) TO anon;
GRANT ALL ON FUNCTION public.current_member_role(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.current_member_role(p_company_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.customer_edit_allowed(p jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_edit_allowed(p jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.customer_edit_allowed(p jsonb) TO service_role;

GRANT ALL ON FUNCTION public.customer_edit_changes_ok(p jsonb) TO anon;
GRANT ALL ON FUNCTION public.customer_edit_changes_ok(p jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.customer_edit_changes_ok(p jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.customer_edit_describe(p jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_edit_describe(p jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.customer_edit_describe(p jsonb) TO service_role;

GRANT ALL ON FUNCTION public.customer_edit_fields() TO anon;
GRANT ALL ON FUNCTION public.customer_edit_fields() TO authenticated;
GRANT ALL ON FUNCTION public.customer_edit_fields() TO service_role;

REVOKE ALL ON FUNCTION public.customer_email_thread(p_company_id uuid, p_customer_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_email_thread(p_company_id uuid, p_customer_id text) TO service_role;

REVOKE ALL ON FUNCTION public.decline_customer_edit(p_request_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.decline_customer_edit(p_request_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.decline_customer_edit(p_request_id uuid, p_reason text) TO service_role;

REVOKE ALL ON FUNCTION public.discard_automation_batch(p_batch_id uuid, p_item_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.discard_automation_batch(p_batch_id uuid, p_item_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.discard_automation_batch(p_batch_id uuid, p_item_ids uuid[]) TO service_role;

GRANT ALL ON TABLE public.estimates TO anon;
GRANT ALL ON TABLE public.estimates TO authenticated;
GRANT ALL ON TABLE public.estimates TO service_role;

REVOKE ALL ON FUNCTION public.done_job_review_reason(j public.jobs, e public.estimates) FROM PUBLIC;
GRANT ALL ON FUNCTION public.done_job_review_reason(j public.jobs, e public.estimates) TO service_role;

REVOKE ALL ON FUNCTION public.drop_replaced_document_file() FROM PUBLIC;
GRANT ALL ON FUNCTION public.drop_replaced_document_file() TO service_role;

REVOKE ALL ON FUNCTION public.equipment_problem_has_photo() FROM PUBLIC;
GRANT ALL ON FUNCTION public.equipment_problem_has_photo() TO service_role;

REVOKE ALL ON FUNCTION public.estimate_accept_links_revoke_on_change() FROM PUBLIC;
GRANT ALL ON FUNCTION public.estimate_accept_links_revoke_on_change() TO service_role;

REVOKE ALL ON FUNCTION public.estimate_accept_view(p_token_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.estimate_accept_view(p_token_hash text) TO service_role;

REVOKE ALL ON FUNCTION public.estimate_active_total(e public.estimates) FROM PUBLIC;
GRANT ALL ON FUNCTION public.estimate_active_total(e public.estimates) TO service_role;

REVOKE ALL ON FUNCTION public.estimate_author_card(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.estimate_author_card(p_company_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.estimate_content_hash(e public.estimates) FROM PUBLIC;
GRANT ALL ON FUNCTION public.estimate_content_hash(e public.estimates) TO service_role;

REVOKE ALL ON FUNCTION public.estimate_for_customer(e public.estimates) FROM PUBLIC;
GRANT ALL ON FUNCTION public.estimate_for_customer(e public.estimates) TO service_role;

REVOKE ALL ON FUNCTION public.estimate_heads_up_recipients(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.estimate_heads_up_recipients(p_company_id uuid) TO service_role;

GRANT ALL ON TABLE public.estimate_accept_links TO service_role;

REVOKE ALL ON FUNCTION public.estimate_link_state(l public.estimate_accept_links, e public.estimates) FROM PUBLIC;
GRANT ALL ON FUNCTION public.estimate_link_state(l public.estimate_accept_links, e public.estimates) TO service_role;

REVOKE ALL ON FUNCTION public.finish_automation_send(p_send_id uuid, p_ok boolean, p_body text, p_job_id text, p_estimate_id text, p_sender_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_automation_send(p_send_id uuid, p_ok boolean, p_body text, p_job_id text, p_estimate_id text, p_sender_name text) TO service_role;

REVOKE ALL ON FUNCTION public.finish_day_plan_send(p_send_id uuid, p_ok boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_day_plan_send(p_send_id uuid, p_ok boolean) TO service_role;

REVOKE ALL ON FUNCTION public.handle_crew_email_confirmed() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_crew_email_confirmed() TO service_role;

REVOKE ALL ON FUNCTION public.handle_new_crew_signup() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_new_crew_signup() TO service_role;

REVOKE ALL ON FUNCTION public.hold_automation_emails(p_company_id uuid, p_items jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hold_automation_emails(p_company_id uuid, p_items jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.invoice_for_done_job(j public.jobs) FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoice_for_done_job(j public.jobs) TO service_role;

REVOKE ALL ON FUNCTION public.invoice_is_split(p_splits jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoice_is_split(p_splits jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.invoices_after_insert() FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoices_after_insert() TO service_role;

REVOKE ALL ON FUNCTION public.invoices_auto_send_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoices_auto_send_guard() TO service_role;

REVOKE ALL ON FUNCTION public.invoices_unique_number() FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoices_unique_number() TO service_role;

REVOKE ALL ON FUNCTION public.is_climber(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_climber(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_climber(p_company_id uuid) TO service_role;

GRANT ALL ON FUNCTION public.is_company_admin(p_company_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_company_admin(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_company_admin(p_company_id uuid) TO service_role;

GRANT ALL ON FUNCTION public.is_company_member(p_company_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_company_member(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_company_member(p_company_id uuid) TO service_role;

GRANT ALL ON FUNCTION public.is_company_owner(p_company_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_company_owner(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_company_owner(p_company_id uuid) TO service_role;

GRANT ALL ON FUNCTION public.is_company_staff(p_company_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_company_staff(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_company_staff(p_company_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.is_sales_person(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_sales_person(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_sales_person(p_company_id uuid) TO service_role;

GRANT ALL ON FUNCTION public.job_cost_columns() TO anon;
GRANT ALL ON FUNCTION public.job_cost_columns() TO authenticated;
GRANT ALL ON FUNCTION public.job_cost_columns() TO service_role;

GRANT ALL ON FUNCTION public.job_money_columns() TO anon;
GRANT ALL ON FUNCTION public.job_money_columns() TO authenticated;
GRANT ALL ON FUNCTION public.job_money_columns() TO service_role;

REVOKE ALL ON FUNCTION public.job_money_visible(p_company_id uuid, p_crew_ids text[], p_date text, p_estimate_id text, p_customer_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.job_money_visible(p_company_id uuid, p_crew_ids text[], p_date text, p_estimate_id text, p_customer_id text) TO authenticated;
GRANT ALL ON FUNCTION public.job_money_visible(p_company_id uuid, p_crew_ids text[], p_date text, p_estimate_id text, p_customer_id text) TO service_role;

GRANT ALL ON FUNCTION public.job_office_columns() TO anon;
GRANT ALL ON FUNCTION public.job_office_columns() TO authenticated;
GRANT ALL ON FUNCTION public.job_office_columns() TO service_role;

REVOKE ALL ON FUNCTION public.job_price_before_change(j public.jobs) FROM PUBLIC;
GRANT ALL ON FUNCTION public.job_price_before_change(j public.jobs) TO service_role;

REVOKE ALL ON FUNCTION public.job_row_assigned(p_company_id uuid, p_crew_ids text[], p_date text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.job_row_assigned(p_company_id uuid, p_crew_ids text[], p_date text) TO authenticated;
GRANT ALL ON FUNCTION public.job_row_assigned(p_company_id uuid, p_crew_ids text[], p_date text) TO service_role;

REVOKE ALL ON FUNCTION public.job_row_visible(p_company_id uuid, p_crew_ids text[], p_date text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.job_row_visible(p_company_id uuid, p_crew_ids text[], p_date text) TO authenticated;
GRANT ALL ON FUNCTION public.job_row_visible(p_company_id uuid, p_crew_ids text[], p_date text) TO service_role;

REVOKE ALL ON FUNCTION public.keep_estimate_author() FROM PUBLIC;
GRANT ALL ON FUNCTION public.keep_estimate_author() TO service_role;

REVOKE ALL ON FUNCTION public.limit_crew_clock_times() FROM PUBLIC;
GRANT ALL ON FUNCTION public.limit_crew_clock_times() TO service_role;

REVOKE ALL ON FUNCTION public.limit_crew_job_edits() FROM PUBLIC;
GRANT ALL ON FUNCTION public.limit_crew_job_edits() TO service_role;

REVOKE ALL ON FUNCTION public.limit_crew_self_edits() FROM PUBLIC;
GRANT ALL ON FUNCTION public.limit_crew_self_edits() TO service_role;

REVOKE ALL ON FUNCTION public.limit_member_audit_entries() FROM PUBLIC;
GRANT ALL ON FUNCTION public.limit_member_audit_entries() TO service_role;

REVOKE ALL ON FUNCTION public.limit_sales_estimate_edits() FROM PUBLIC;
GRANT ALL ON FUNCTION public.limit_sales_estimate_edits() TO service_role;

REVOKE ALL ON FUNCTION public.link_old_personal_notes() FROM PUBLIC;
GRANT ALL ON FUNCTION public.link_old_personal_notes() TO service_role;

REVOKE ALL ON FUNCTION public.mark_job_price_change_seen(p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_job_price_change_seen(p_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.mark_job_price_change_seen(p_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.may_enter_hours_by_hand(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.may_enter_hours_by_hand(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.may_enter_hours_by_hand(p_company_id uuid) TO service_role;

GRANT ALL ON FUNCTION public.mfa_satisfied() TO anon;
GRANT ALL ON FUNCTION public.mfa_satisfied() TO authenticated;
GRANT ALL ON FUNCTION public.mfa_satisfied() TO service_role;

REVOKE ALL ON FUNCTION public.next_invoice_number(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.next_invoice_number(p_company_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.on_job_deleted_invoice() FROM PUBLIC;
GRANT ALL ON FUNCTION public.on_job_deleted_invoice() TO service_role;

REVOKE ALL ON FUNCTION public.on_job_status_invoice() FROM PUBLIC;
GRANT ALL ON FUNCTION public.on_job_status_invoice() TO service_role;

REVOKE ALL ON FUNCTION public.process_confirmed_signup(p_user_id uuid, p_email text, p_meta jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.process_confirmed_signup(p_user_id uuid, p_email text, p_meta jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.protect_last_owner() FROM PUBLIC;
GRANT ALL ON FUNCTION public.protect_last_owner() TO service_role;

REVOKE ALL ON FUNCTION public.public_rate_limit_take(p_bucket text, p_key_hash text, p_max integer, p_window_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.public_rate_limit_take(p_bucket text, p_key_hash text, p_max integer, p_window_seconds integer) TO service_role;

REVOKE ALL ON FUNCTION public.reclaim_invoice_email(p_company_id uuid, p_dedupe_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reclaim_invoice_email(p_company_id uuid, p_dedupe_key text) TO service_role;

REVOKE ALL ON FUNCTION public.release_automation_send(p_send_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_automation_send(p_send_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.reset_two_step_login(p_company_id uuid, p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reset_two_step_login(p_company_id uuid, p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.reset_two_step_login(p_company_id uuid, p_user_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.resolve_equipment_problem(p_problem_id uuid, p_action text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.resolve_equipment_problem(p_problem_id uuid, p_action text) TO authenticated;
GRANT ALL ON FUNCTION public.resolve_equipment_problem(p_problem_id uuid, p_action text) TO service_role;

REVOKE ALL ON FUNCTION public.sales_can_read_estimate(p_company_id uuid, p_customer_id text, p_created_by_crew_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.sales_can_read_estimate(p_company_id uuid, p_customer_id text, p_created_by_crew_id text) TO authenticated;
GRANT ALL ON FUNCTION public.sales_can_read_estimate(p_company_id uuid, p_customer_id text, p_created_by_crew_id text) TO service_role;

REVOKE ALL ON FUNCTION public.set_estimate_author() FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_estimate_author() TO service_role;

REVOKE ALL ON FUNCTION public.settings_auto_emails_since() FROM PUBLIC;
GRANT ALL ON FUNCTION public.settings_auto_emails_since() TO service_role;

REVOKE ALL ON FUNCTION public.stamp_customer_edit_request() FROM PUBLIC;
GRANT ALL ON FUNCTION public.stamp_customer_edit_request() TO service_role;

REVOKE ALL ON FUNCTION public.stamp_equipment_problem() FROM PUBLIC;
GRANT ALL ON FUNCTION public.stamp_equipment_problem() TO service_role;

REVOKE ALL ON FUNCTION public.stamp_private_note_author() FROM PUBLIC;
GRANT ALL ON FUNCTION public.stamp_private_note_author() TO service_role;

REVOKE ALL ON FUNCTION public.stamp_week_approval() FROM PUBLIC;
GRANT ALL ON FUNCTION public.stamp_week_approval() TO service_role;

REVOKE ALL ON FUNCTION public.timesheet_clock_in_check(p_date text, p_in text, p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.timesheet_clock_in_check(p_date text, p_in text, p_now timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.timesheet_clock_in_check(p_date text, p_in text, p_now timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.timesheet_clock_out_check(p_date text, p_out text, p_in text, p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.timesheet_clock_out_check(p_date text, p_out text, p_in text, p_now timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.timesheet_clock_out_check(p_date text, p_out text, p_in text, p_now timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.timesheet_crew_overlap(p_company_id uuid, p_crew_id text, p_id text, p_date text, p_in text, p_out text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.timesheet_crew_overlap(p_company_id uuid, p_crew_id text, p_id text, p_date text, p_in text, p_out text) TO service_role;

REVOKE ALL ON FUNCTION public.timesheet_may_auto_close(p_company_id uuid, p_date text, p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.timesheet_may_auto_close(p_company_id uuid, p_date text, p_now timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.timesheet_may_auto_close(p_company_id uuid, p_date text, p_now timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.timesheet_tap_check(p_date text, p_time text, p_after_in text, p_max_age interval, p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.timesheet_tap_check(p_date text, p_time text, p_after_in text, p_max_age interval, p_now timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.timesheet_tap_check(p_date text, p_time text, p_after_in text, p_max_age interval, p_now timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.timesheet_tap_local(p_date text, p_time text, p_after_in text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.timesheet_tap_local(p_date text, p_time text, p_after_in text) TO authenticated;
GRANT ALL ON FUNCTION public.timesheet_tap_local(p_date text, p_time text, p_after_in text) TO service_role;

REVOKE ALL ON FUNCTION public.timesheet_tap_moments(p_local timestamp without time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.timesheet_tap_moments(p_local timestamp without time zone) TO authenticated;
GRANT ALL ON FUNCTION public.timesheet_tap_moments(p_local timestamp without time zone) TO service_role;

REVOKE ALL ON FUNCTION public.timesheets_auto_closed_reset() FROM PUBLIC;
GRANT ALL ON FUNCTION public.timesheets_auto_closed_reset() TO service_role;

REVOKE ALL ON FUNCTION public.two_step_logins(p_company_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.two_step_logins(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.two_step_logins(p_company_id uuid) TO service_role;

GRANT ALL ON TABLE public.app_config TO service_role;

GRANT ALL ON TABLE public.audit_log TO anon;
GRANT ALL ON TABLE public.audit_log TO authenticated;
GRANT ALL ON TABLE public.audit_log TO service_role;

GRANT ALL ON TABLE public.automation_batch_items TO service_role;
GRANT SELECT ON TABLE public.automation_batch_items TO authenticated;

GRANT ALL ON TABLE public.automation_batches TO service_role;
GRANT SELECT ON TABLE public.automation_batches TO authenticated;

GRANT ALL ON TABLE public.automation_runs TO service_role;
GRANT SELECT ON TABLE public.automation_runs TO authenticated;

GRANT ALL ON TABLE public.automation_sends TO service_role;
GRANT SELECT ON TABLE public.automation_sends TO authenticated;

GRANT ALL ON TABLE public.automations TO anon;
GRANT ALL ON TABLE public.automations TO authenticated;
GRANT ALL ON TABLE public.automations TO service_role;

GRANT ALL ON TABLE public.booking_rate_limits TO service_role;

GRANT ALL ON SEQUENCE public.booking_rate_limits_id_seq TO anon;
GRANT ALL ON SEQUENCE public.booking_rate_limits_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.booking_rate_limits_id_seq TO service_role;

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.booking_requests TO anon;
GRANT ALL ON TABLE public.booking_requests TO authenticated;
GRANT ALL ON TABLE public.booking_requests TO service_role;

GRANT ALL ON TABLE public.chemical_records TO anon;
GRANT ALL ON TABLE public.chemical_records TO authenticated;
GRANT ALL ON TABLE public.chemical_records TO service_role;

GRANT ALL ON TABLE public.closed_days TO anon;
GRANT ALL ON TABLE public.closed_days TO authenticated;
GRANT ALL ON TABLE public.closed_days TO service_role;

GRANT ALL ON TABLE public.companies TO anon;
GRANT ALL ON TABLE public.companies TO authenticated;
GRANT ALL ON TABLE public.companies TO service_role;

GRANT ALL ON TABLE public.company_document_files TO service_role;
GRANT SELECT,INSERT,DELETE ON TABLE public.company_document_files TO authenticated;

GRANT ALL ON TABLE public.company_documents TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.company_documents TO authenticated;

GRANT ALL ON TABLE public.company_members TO anon;
GRANT ALL ON TABLE public.company_members TO authenticated;
GRANT ALL ON TABLE public.company_members TO service_role;

GRANT ALL ON TABLE public.settings TO anon;
GRANT ALL ON TABLE public.settings TO authenticated;
GRANT ALL ON TABLE public.settings TO service_role;

GRANT ALL ON TABLE public.company_public TO anon;
GRANT ALL ON TABLE public.company_public TO authenticated;
GRANT ALL ON TABLE public.company_public TO service_role;

GRANT ALL ON TABLE public.crew TO anon;
GRANT ALL ON TABLE public.crew TO authenticated;
GRANT ALL ON TABLE public.crew TO service_role;

GRANT ALL ON TABLE public.crew_locations TO anon;
GRANT ALL ON TABLE public.crew_locations TO authenticated;
GRANT ALL ON TABLE public.crew_locations TO service_role;

GRANT ALL ON TABLE public.crew_unavailability TO anon;
GRANT ALL ON TABLE public.crew_unavailability TO authenticated;
GRANT ALL ON TABLE public.crew_unavailability TO service_role;

GRANT ALL ON TABLE public.customer_addresses TO anon;
GRANT ALL ON TABLE public.customer_addresses TO authenticated;
GRANT ALL ON TABLE public.customer_addresses TO service_role;

GRANT ALL ON TABLE public.customer_edit_requests TO service_role;
GRANT SELECT,INSERT,DELETE ON TABLE public.customer_edit_requests TO authenticated;

GRANT ALL ON TABLE public.customers TO anon;
GRANT ALL ON TABLE public.customers TO authenticated;
GRANT ALL ON TABLE public.customers TO service_role;

GRANT ALL ON TABLE public.day_crews TO anon;
GRANT ALL ON TABLE public.day_crews TO authenticated;
GRANT ALL ON TABLE public.day_crews TO service_role;

GRANT ALL ON TABLE public.email_threads TO anon;
GRANT ALL ON TABLE public.email_threads TO authenticated;
GRANT ALL ON TABLE public.email_threads TO service_role;

GRANT ALL ON TABLE public.equipment TO anon;
GRANT ALL ON TABLE public.equipment TO authenticated;
GRANT ALL ON TABLE public.equipment TO service_role;

GRANT ALL ON TABLE public.equipment_notes TO anon;
GRANT ALL ON TABLE public.equipment_notes TO authenticated;
GRANT ALL ON TABLE public.equipment_notes TO service_role;

GRANT ALL ON TABLE public.equipment_problem_photos TO service_role;
GRANT SELECT,INSERT,DELETE ON TABLE public.equipment_problem_photos TO authenticated;

GRANT ALL ON TABLE public.equipment_problems TO service_role;
GRANT SELECT,INSERT,DELETE ON TABLE public.equipment_problems TO authenticated;

GRANT UPDATE(status) ON TABLE public.equipment_problems TO authenticated;

GRANT ALL ON TABLE public.gps_pings TO anon;
GRANT ALL ON TABLE public.gps_pings TO authenticated;
GRANT ALL ON TABLE public.gps_pings TO service_role;

GRANT ALL ON TABLE public.invoice_reviews TO service_role;
GRANT SELECT,DELETE ON TABLE public.invoice_reviews TO authenticated;

GRANT ALL ON TABLE public.invoices TO anon;
GRANT ALL ON TABLE public.invoices TO authenticated;
GRANT ALL ON TABLE public.invoices TO service_role;

GRANT ALL ON TABLE public.job_price_changes TO service_role;
GRANT SELECT ON TABLE public.job_price_changes TO authenticated;

GRANT ALL ON TABLE public.location_requests TO anon;
GRANT ALL ON TABLE public.location_requests TO authenticated;
GRANT ALL ON TABLE public.location_requests TO service_role;

GRANT ALL ON TABLE public.maintenance_records TO anon;
GRANT ALL ON TABLE public.maintenance_records TO authenticated;
GRANT ALL ON TABLE public.maintenance_records TO service_role;

GRANT ALL ON TABLE public.maintenance_tasks TO anon;
GRANT ALL ON TABLE public.maintenance_tasks TO authenticated;
GRANT ALL ON TABLE public.maintenance_tasks TO service_role;

GRANT ALL ON TABLE public.messages TO anon;
GRANT ALL ON TABLE public.messages TO authenticated;
GRANT ALL ON TABLE public.messages TO service_role;

GRANT ALL ON TABLE public.phc_programs TO anon;
GRANT ALL ON TABLE public.phc_programs TO authenticated;
GRANT ALL ON TABLE public.phc_programs TO service_role;

GRANT ALL ON TABLE public.phc_visits TO anon;
GRANT ALL ON TABLE public.phc_visits TO authenticated;
GRANT ALL ON TABLE public.phc_visits TO service_role;

GRANT ALL ON TABLE public.private_notes TO anon;
GRANT ALL ON TABLE public.private_notes TO authenticated;
GRANT ALL ON TABLE public.private_notes TO service_role;

GRANT ALL ON TABLE public.public_rate_limits TO service_role;

GRANT ALL ON SEQUENCE public.public_rate_limits_id_seq TO anon;
GRANT ALL ON SEQUENCE public.public_rate_limits_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.public_rate_limits_id_seq TO service_role;

GRANT ALL ON TABLE public.time_off_requests TO anon;
GRANT ALL ON TABLE public.time_off_requests TO authenticated;
GRANT ALL ON TABLE public.time_off_requests TO service_role;

GRANT ALL ON TABLE public.timesheets TO anon;
GRANT ALL ON TABLE public.timesheets TO authenticated;
GRANT ALL ON TABLE public.timesheets TO service_role;

GRANT ALL ON TABLE public.trees TO anon;
GRANT ALL ON TABLE public.trees TO authenticated;
GRANT ALL ON TABLE public.trees TO service_role;

-- ---------- Sign-up triggers on auth.users ----------
-- Nothing happens until an email is confirmed: the owner email (and any
-- extra owner emails) become owner; anyone else waits for approval.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_crew_signup();

DROP TRIGGER IF EXISTS on_auth_user_email_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_email_confirmed
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_crew_email_confirmed();

-- ---------- Live updates (Supabase Realtime) ----------
DO $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'no supabase_realtime publication; live updates are skipped';
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['closed_days', 'crew', 'crew_locations', 'crew_unavailability',
    'customer_edit_requests', 'day_crews', 'equipment_problems', 'job_price_changes', 'jobs',
    'location_requests', 'settings', 'time_off_requests', 'timesheets']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ---------- The one company this install serves ----------
-- The id must equal companyId in src/config.ts. The name and every other
-- business detail are filled in by the owner in the app's setup wizard.
INSERT INTO public.companies (id, name)
VALUES ('11111111-1111-4111-8111-111111111111', 'Your Tree Company')
ON CONFLICT (id) DO NOTHING;

-- owner@example.com is a placeholder that nobody can confirm. The deploy
-- workflow replaces it with the GitHub variable OWNER_EMAIL.
INSERT INTO public.app_config (owner_email, company_id)
SELECT 'owner@example.com', '11111111-1111-4111-8111-111111111111'
WHERE NOT EXISTS (SELECT 1 FROM public.app_config);

RESET check_function_bodies;
