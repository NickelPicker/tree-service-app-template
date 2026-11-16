/**
 * Plain-English wording for changing someone's app role on the Users
 * page: the "are you sure?" question and what each role can do. The
 * descriptions follow the database's access tiers (migration
 * the "role based rls" rules): owner/manager = everything incl.
 * pay and logins; office = all business data but not pay or logins;
 * crew = only their own work.
 */
import type { Role } from "./types";

export const ROLE_NAMES: Record<Role, string> = {
  owner: "Owner",
  manager: "Manager",
  office: "Office",
  crew: "Crew",
};

const WHAT_THEY_CAN_DO: Record<Role, string> = {
  owner:
    "Owners can see and change everything: pay, customer notes, invoices, logins, and who else is an owner.",
  manager:
    "Managers can see and change everything an owner can, including pay and customer notes, and can approve or remove logins. Only an owner can make or remove owners.",
  office:
    "Office staff see all customers, jobs, estimates and invoices, but not pay or logins.",
  crew:
    "Crew see only their own jobs and those customers. They see prices only if “see money” is on for them.",
};

export function roleName(r: Role | string | undefined | null): string {
  return (r && ROLE_NAMES[r as Role]) || "No access";
}

/** "a Manager", "an Owner", "Office", "Crew". */
function asRole(r: Role): string {
  if (r === "owner") return "an Owner";
  if (r === "manager") return "a Manager";
  return ROLE_NAMES[r];
}

/** The question shown before a role change, and what it means. */
export function roleChangeQuestion(
  name: string,
  from: Role | undefined,
  to: Role,
): { title: string; detail: string; warning: string | null } {
  const first = name.trim().split(/\s+/)[0] || name;
  const losing =
    (from === "owner" || from === "manager") && (to === "office" || to === "crew")
      ? `${first} will no longer see pay or manage logins.`
      : from === "office" && to === "crew"
        ? `${first} will no longer see other customers, estimates or invoices.`
        : null;
  return {
    title: `Make ${first} ${asRole(to)}?`,
    detail: WHAT_THEY_CAN_DO[to],
    warning:
      to === "owner" || to === "manager"
        ? `Only do this if you trust ${first} with the whole business.`
        : losing,
  };
}

/** The line shown after the change, next to Undo. */
export function roleChangedNotice(name: string, to: Role): string {
  const first = name.trim().split(/\s+/)[0] || name;
  return `${first} is now ${asRole(to)}.`;
}
