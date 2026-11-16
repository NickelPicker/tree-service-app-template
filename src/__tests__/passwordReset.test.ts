import { describe, expect, it } from "vitest";
import {
  friendlyAuthError,
  newPasswordProblem,
  parseAuthHash,
  resetRedirectUrl,
} from "../passwordReset";

describe("forgot password", () => {
  it("sends the reset link back to the site's own address", () => {
    expect(resetRedirectUrl("https://your-site-name.netlify.app")).toBe(
      "https://your-site-name.netlify.app/",
    );
    expect(resetRedirectUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/");
  });

  it("knows when the person arrived from a reset link, or an expired one", () => {
    expect(parseAuthHash("#access_token=abc&refresh_token=x&type=recovery")).toEqual({
      recovery: true,
      linkExpired: false,
    });
    expect(parseAuthHash("#type=recovery").recovery).toBe(false); // no token, nothing to trust
    expect(parseAuthHash("#/book").recovery).toBe(false);
    expect(
      parseAuthHash("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid").linkExpired,
    ).toBe(true);
    expect(parseAuthHash("").linkExpired).toBe(false);
  });

  it("explains a wrong password in plain words", () => {
    expect(friendlyAuthError("Invalid login credentials")).toMatch(/don't match.*Forgot password/);
    expect(friendlyAuthError("Email not confirmed")).toMatch(/confirmation email/);
    expect(friendlyAuthError("Error sending recovery email")).toMatch(/couldn't send the email/);
    expect(friendlyAuthError("New password should be different from the old password.")).toMatch(/current password/);
    expect(friendlyAuthError(null)).toBeNull();
    expect(friendlyAuthError("Something odd")).toBe("Something odd");
  });

  it("checks the new password before saving", () => {
    expect(newPasswordProblem("short", "short")).toMatch(/at least 10/);
    expect(newPasswordProblem("long enough pw", "long enough pW")).toMatch(/don't match/);
    expect(newPasswordProblem("long enough pw", "long enough pw")).toBeNull();
  });
});
