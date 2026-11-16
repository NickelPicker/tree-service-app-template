import { useStore } from "../store";
import CustomerOverview from "./CustomerOverview";
import { secondaryBtn } from "./ui";

/**
 * Customer side panel, opened from any page that names a customer.
 * The same page as on the Customers tab (CustomerOverview): contact
 * details and next actions on top, then jobs, estimates and invoices,
 * the rest folded. Editing a customer's details still happens on the
 * Customers page.
 */
export default function CustomerDrawer({
  customerId,
}: {
  customerId: string;
}) {
  const { state, canEdit, setView, setCustomerFocusId, closeDrawer } =
    useStore();
  if (!state) return null;
  const customer = state.customers.find((c) => c.id === customerId) ?? null;
  if (!customer) {
    return <p className="text-sm text-slate-500">Customer not found.</p>;
  }
  const goToCustomers = () => {
    setCustomerFocusId(customer.id);
    setView("customers");
    closeDrawer();
  };
  const trees = state.trees.filter((t) => t.customerId === customer.id);

  return (
    <CustomerOverview
      customer={customer}
      headerActions={
        canEdit ? (
          <button onClick={goToCustomers} className={`${secondaryBtn()} min-h-11`}>
            Edit in Customers
          </button>
        ) : undefined
      }
      treeMap={
        <>
          <p className="text-sm text-slate-700">
            {trees.length === 0
              ? "No trees mapped yet."
              : `${trees.length} tree${trees.length === 1 ? "" : "s"} mapped: ${trees
                  .map((t) => `${t.label}${t.species ? ` (${t.species})` : ""}`)
                  .join(", ")}`}
          </p>
          <button onClick={goToCustomers} className={`${secondaryBtn()} mt-2 min-h-11`}>
            Open tree map
          </button>
        </>
      }
    />
  );
}
