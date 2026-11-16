import { describe, expect, it } from "vitest";
import type { AppState, BookingRequest, Customer } from "../types";
import {
  bookingCustomerDraft,
  bookingEstimate,
  bookingIsPending,
  bookingMatches,
  pendingBookingCount,
  salesQueue,
} from "../salesQueue";
import { bookedAddressDiffers } from "../addresses";
import {
  clearHandoff,
  handedSalesBookings,
  handedTimesheetsWeek,
  openSalesBookings,
  openTimesheetsOnWeek,
} from "../viewHandoff";

const req = (over: Partial<BookingRequest> = {}): BookingRequest => ({
  id: "b1",
  date: "2026-11-20",
  name: "Pat Q Example",
  phone: "(555) 555-0100",
  email: "pat@example.com",
  address: "1 Test Way",
  details: "Maple",
  status: "pending",
  requestedAt: "2026-11-16",
  estimateId: null,
  ...over,
});

const cust = (over: Partial<Customer>): Customer =>
  ({
    id: "c1",
    firstName: "Someone",
    lastName: "Else",
    company: "",
    phone: "",
    email: "",
    address: "",
    city: "",
    zip: "",
    contacts: [],
    ...over,
  }) as Customer;

describe("booking requests: the office sees them and spots returning customers", () => {
  it("counts only pending requests for the Sales badge", () => {
    expect(pendingBookingCount({ bookingRequests: [req(), req({ id: "b2", status: "accepted" })] })).toBe(1);
    expect(pendingBookingCount({ bookingRequests: [] })).toBe(0);
  });
  it("splits the name like the accept does", () => {
    expect(bookingCustomerDraft(req())).toMatchObject({ firstName: "Pat", lastName: "Q Example", email: "pat@example.com" });
    expect(bookingCustomerDraft(req({ name: "  " })).firstName).toBe("Website");
  });
  it("finds an existing customer by phone or email", () => {
    const byPhone = cust({ id: "p", phone: "555-555-0100" });
    const byEmail = cust({ id: "e", email: "PAT@example.com" });
    const other = cust({ id: "o", phone: "555-555-0999" });
    expect(bookingMatches([byPhone, byEmail, other], req()).map((m) => m.customer.id)).toEqual(["p", "e"]);
    expect(bookingMatches([other], req())).toEqual([]);
  });
});

describe("accepting a booking request", () => {
  const ids = { estimateId: "e1", customerId: "c1", lineId: "l1" };
  it("the draft waits in Needs a visit (not lost off both Sales lists)", () => {
    const est = bookingEstimate(req(), ids, "2026-11-16", null);
    expect(est).toMatchObject({ status: "draft", visitDate: null, visitTime: null, customerId: "c1" });
    expect(est.notes).toContain("Nov");
    const state = { customers: [], jobs: [], estimates: [est], bookingRequests: [] } as unknown as AppState;
    // The Sales page's "Needs a visit" list: drafts with no visit day.
    const needsVisit = salesQueue(state).draftEstimates.filter((e) => !e.visitDate);
    expect(needsVisit.map((e) => e.id)).toEqual(["e1"]);
  });
  it("for an existing customer at another address, the booked address is kept", () => {
    const onFile = cust({ id: "c1", phone: "555-555-0100", address: "9 Other Rd" });
    expect(bookedAddressDiffers(onFile, "1 Test Way")).toBe(true);
    const est = bookingEstimate(req(), ids, "2026-11-16", onFile);
    expect(est.notes).toContain("Booked for 1 Test Way (not the address on file)");
  });
  it("the same address (with city added, any case) is not a difference", () => {
    const home = cust({ id: "c1", address: "1 Test Way" });
    expect(bookedAddressDiffers(home, "1 test way, Anytown CO")).toBe(false);
    expect(bookedAddressDiffers(home, "1 Test Way.")).toBe(false);
    expect(bookedAddressDiffers(home, "")).toBe(false);
    expect(bookedAddressDiffers(home, "11 Test Way")).toBe(true);
    expect(bookingEstimate(req(), ids, "2026-11-16", home).notes).not.toContain("not the address on file");
  });
  it("a request already decided makes nothing (no 'estimate made' message)", () => {
    const s = { bookingRequests: [req(), req({ id: "b2", status: "accepted" })] };
    expect(bookingIsPending(s, "b1")).toBe(true);
    expect(bookingIsPending(s, "b2")).toBe(false);
    expect(bookingIsPending(s, "missing")).toBe(false);
    expect(bookingIsPending(null, "b1")).toBe(false);
  });
});

describe("To-do buttons open the right place", () => {
  it("Timesheets opens on the handed week, briefly", () => {
    clearHandoff();
    expect(handedTimesheetsWeek(1000)).toBeNull();
    openTimesheetsOnWeek("2026-11-09", 1000);
    expect(handedTimesheetsWeek(2000)).toBe("2026-11-09");
    // Read twice (React's double mount in development) still works.
    expect(handedTimesheetsWeek(2000)).toBe("2026-11-09");
    expect(handedTimesheetsWeek(10000)).toBeNull();
    expect(handedSalesBookings(2000)).toBe(false);
  });
  it("Sales opens with Booking requests open, until cleared", () => {
    openSalesBookings(1000);
    expect(handedSalesBookings(1500)).toBe(true);
    expect(handedTimesheetsWeek(1500)).toBeNull();
    clearHandoff();
    expect(handedSalesBookings(1500)).toBe(false);
  });
});
