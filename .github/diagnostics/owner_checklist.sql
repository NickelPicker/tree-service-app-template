-- Owner set-up checklist (read-only). Run by the deploy workflow in
-- "check" mode. Prints counts, team names, equipment names and yes/no
-- answers only: never customer names, addresses, emails or job titles.
with co as (select id from public.companies order by created_at limit 1),
field as (
  select c.* from public.crew c, co
  where c.company_id = co.id and c.status = 'active'
    and coalesce(c.permissions->>'hideFromSchedule', 'false') <> 'true'
),
s as (select st.* from public.settings st, co where st.company_id = co.id),
upcoming as (
  select j.* from public.jobs j, co
  where j.company_id = co.id and j.status <> 'done'
    and coalesce(j.end_date, j.date) >= to_char(current_date, 'YYYY-MM-DD')
)
select * from (
  select 1 n, 'Business name, phone and email filled in' item,
    case when (select coalesce(company_profile->>'name','') <> '' and coalesce(company_profile->>'phone','') <> '' and coalesce(company_profile->>'email','') <> '' from s) then 'done' else 'TO DO' end status,
    '' detail
  union all
  select 2, 'Shop addresses entered and found on the map',
    case when (select count(*) from s, jsonb_array_elements(coalesce(company_profile->'sites','[]')) x where x->>'lat' is not null) >= 1 then 'done' else 'TO DO' end,
    (select count(*) || ' entered, ' || count(*) filter (where x->>'lat' is not null) || ' found on the map' from s, jsonb_array_elements(coalesce(company_profile->'sites','[]')) x)
  union all
  select 3, 'Planning shop chosen',
    case when (select coalesce(planner->>'yardSite','') <> '' from s) then 'done' else 'TO DO' end, ''
  union all
  select 4, 'Skills ticked for every field person',
    case when exists (select 1 from field where cardinality(coalesce(skills,'{}')) = 0) then 'TO DO' else 'done' end,
    coalesce((select 'missing: ' || string_agg(name, ', ' order by name) from field where cardinality(coalesce(skills,'{}')) = 0), '')
  union all
  select 5, 'Licence + company insurance ticked for drivers',
    case when (select count(*) from field where driver_licensed and company_insured) = 0 then 'TO DO' else 'check' end,
    (select count(*) filter (where driver_licensed and company_insured) || ' drivers; not ticked: ' || coalesce(string_agg(name, ', ' order by name) filter (where not (coalesce(driver_licensed,false) and coalesce(company_insured,false))), 'nobody') from field)
  union all
  select 6, 'Every piece of equipment has "Parked at"',
    case when exists (select 1 from public.equipment e, co where e.company_id = co.id and e.status <> 'retired' and coalesce(e.home_site,'') = '') then 'TO DO' else 'done' end,
    coalesce((select 'missing: ' || string_agg(e.name, ', ' order by e.name) from public.equipment e, co where e.company_id = co.id and e.status <> 'retired' and coalesce(e.home_site,'') = ''), '')
  union all
  select 7, 'Trucks: what each can tow, and weights',
    case when exists (select 1 from public.equipment e, co where e.company_id = co.id and e.kind = 'Truck' and e.status <> 'retired' and (e.tows is null or e.weight_lbs is null)) then 'check' else 'done' end,
    coalesce((select 'not filled in: ' || string_agg(e.name, ', ' order by e.name) from public.equipment e, co where e.company_id = co.id and e.kind = 'Truck' and e.status <> 'retired' and (e.tows is null or e.weight_lbs is null)), '')
  union all
  select 8, 'Upcoming jobs have a dollar value (plan times come from it)',
    case when exists (select 1 from upcoming where coalesce(value,0) = 0 and estimate_id is null and invoice_id is null) then 'TO DO' else 'done' end,
    (select count(*) filter (where coalesce(value,0) = 0 and estimate_id is null and invoice_id is null) || ' of ' || count(*) || ' upcoming jobs have no value, estimate or invoice' from upcoming)
  union all
  select 9, 'Jobs with a time promised to the customer are ticked',
    'check',
    (select count(*) filter (where time_promised) || ' of ' || count(*) || ' upcoming jobs are ticked "Customer was promised this time" (the planner will not move those)' from upcoming)
  union all
  select 10, 'General liability insurance uploaded (More -> Licences & insurance)',
    case when exists (select 1 from public.company_documents d, co where d.company_id = co.id and d.kind = 'liability_insurance' and (d.expiry_date is null or d.expiry_date >= current_date)) then 'done' else 'TO DO' end,
    (select count(*) || ' documents on file, ' || count(*) filter (where expiry_date < current_date) || ' expired, ' || count(*) filter (where expiry_date between current_date and current_date + 30) || ' expiring within 30 days' from public.company_documents d, co where d.company_id = co.id)
) t order by n;
