/**
 * The on-disk filename for a screenshot, by id.
 *
 * Its own file, with zero other imports, so `services/export.ts` — which is
 * deliberately pure (no filesystem, no Electron) — can reference it without
 * pulling in `services/screenshots.ts` and everything that module touches.
 */
export function screenshotFileName(id: string): string {
  return `screenshot-${id}.png`
}
