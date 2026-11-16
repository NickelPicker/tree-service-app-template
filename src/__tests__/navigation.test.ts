import { describe, expect, it } from "vitest";
import { directionsUrl, hasDestination } from "../navigation";

describe("directions links", () => {
  const pin = { lat: 39.74, lng: -104.99 };
  it("opens the chosen map app with driving directions", () => {
    expect(directionsUrl("google", pin)).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=39.74%2C-104.99&travelmode=driving",
    );
    expect(directionsUrl("apple", pin)).toBe("https://maps.apple.com/?daddr=39.74%2C-104.99&dirflg=d");
    expect(directionsUrl("waze", pin)).toBe("https://waze.com/ul?ll=39.74%2C-104.99&navigate=yes");
  });
  it("uses the address when there is no pin", () => {
    expect(directionsUrl("waze", { address: "123 Main St, Anytown" })).toBe(
      "https://waze.com/ul?q=123%20Main%20St%2C%20Anytown&navigate=yes",
    );
    expect(hasDestination({ address: "  " })).toBe(false);
  });
});
