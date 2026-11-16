import type {
  AppState,
  Equipment,
  EquipmentKind,
  MaintenanceRecord,
  MaintenanceTask,
} from "./types";
import { addDaysISO, daysBetweenISO } from "./utils";

export type MaintenanceStatus = "ok" | "due-soon" | "overdue" | "never";

/** Days before the due date a task counts as "due soon". */
export const DUE_SOON_DAYS = 7;

/** Latest logged service for a task, or null when never serviced. */
export function lastRecordForTask(
  records: MaintenanceRecord[],
  taskId: string,
): MaintenanceRecord | null {
  const done = records
    .filter((r) => r.taskId === taskId)
    .sort((a, b) => b.date.localeCompare(a.date));
  return done[0] ?? null;
}

/**
 * One task's maintenance standing: last done date, next due date, and
 * status. "never" when no service has ever been logged (no due date
 * yet — it needs a first log, not an overdue flag).
 */
export function taskDue(
  task: MaintenanceTask,
  records: MaintenanceRecord[],
  today: string,
): {
  lastDone: string | null;
  due: string | null;
  status: MaintenanceStatus;
  daysOverdue: number;
} {
  const last = lastRecordForTask(records, task.id);
  if (!last) return { lastDone: null, due: null, status: "never", daysOverdue: 0 };
  const due = addDaysISO(last.date, task.intervalDays);
  if (due < today)
    return {
      lastDone: last.date,
      due,
      status: "overdue",
      daysOverdue: daysBetweenISO(due, today),
    };
  if (daysBetweenISO(today, due) <= DUE_SOON_DAYS)
    return { lastDone: last.date, due, status: "due-soon", daysOverdue: 0 };
  return { lastDone: last.date, due, status: "ok", daysOverdue: 0 };
}

export interface OverdueItem {
  task: MaintenanceTask;
  equipment: Equipment;
  lastDone: string | null;
  due: string | null;
  daysOverdue: number;
}

/** Every task past its due date, worst first. */
export function overdueTasks(state: AppState, today: string): OverdueItem[] {
  const out: OverdueItem[] = [];
  for (const task of state.maintenanceTasks) {
    const equipment = state.equipment.find((e) => e.id === task.equipmentId);
    if (!equipment) continue;
    const d = taskDue(task, state.maintenanceRecords, today);
    if (d.status === "overdue") {
      out.push({
        task,
        equipment,
        lastDone: d.lastDone,
        due: d.due,
        daysOverdue: d.daysOverdue,
      });
    }
  }
  return out.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

/** Standard maintenance tasks for a newly added piece of equipment, by kind. Intervals are starting points — changeable in Equipment → Settings. */
export function defaultTasksForKind(
  kind: EquipmentKind,
): Array<{ name: string; intervalDays: number }> {
  switch (kind) {
    case "Chipper":
      return [
        { name: "Oil change", intervalDays: 90 },
        { name: "Blade flip", intervalDays: 60 },
        { name: "100-hour service", intervalDays: 180 },
      ];
    case "Truck":
      return [
        { name: "Oil change", intervalDays: 90 },
        { name: "Annual inspection", intervalDays: 365 },
      ];
    case "Trailer":
    case "Dump trailer":
    case "Equipment trailer":
      return [{ name: "Inspection", intervalDays: 180 }];
    case "Mini skid":
    case "Stump grinder":
      return [
        { name: "Oil change", intervalDays: 90 },
        { name: "Grease", intervalDays: 30 },
      ];
    default:
      return [];
  }
}
