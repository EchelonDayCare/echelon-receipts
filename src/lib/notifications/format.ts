/**
 * Small formatting helpers for notification categories.
 *
 * Lives in its own module (not `NotificationBell.tsx`) so that Vite/React
 * Fast Refresh doesn't have to invalidate the whole bell component when
 * this helper changes. Fast Refresh only preserves state across HMR when
 * a module's exports are all React components; mixing a component + a
 * plain function was breaking the bell's dropdown state on hot reload.
 */
export function prettifyCategory(c: string): string {
  return c.replace(/_/g, " ");
}
