import { describe, expect, it } from "vitest";
import { roleChangeQuestion, roleChangedNotice, roleName } from "../roleChange";

describe("role change wording", () => {
  it("asks in plain words before making someone a Manager", () => {
    const q = roleChangeQuestion("Gus Ground", "crew", "manager");
    expect(q.title).toBe("Make Gus a Manager?");
    expect(q.detail).toMatch(/pay and customer notes/);
    expect(q.warning).toMatch(/trust Gus/);
  });
  it("says what someone loses when moved down", () => {
    expect(roleChangeQuestion("Sam Manager", "manager", "crew").warning).toBe(
      "Sam will no longer see pay or manage logins.",
    );
    expect(roleChangeQuestion("Olive Office", "office", "crew").title).toBe("Make Olive Crew?");
  });
  it("confirms the change for the Undo bar", () => {
    expect(roleChangedNotice("Otto", "owner")).toBe("Otto is now an Owner.");
    expect(roleName("office")).toBe("Office");
    expect(roleName(undefined)).toBe("No access");
  });
});
