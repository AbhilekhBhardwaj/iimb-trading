import type { Notification } from '../../lib/api'

/**
 * Persistent bottom strip: Announcement · Daily News · Data, newest-first.
 * Shared across the terminal and the News page.
 */
export function NotificationStrip({ notifications }: { notifications: Notification[] }) {
  const sections = [
    { kind: 'announcement', label: 'Announcement', accent: 'text-[#E8C46A]' },
    { kind: 'daily_news', label: 'Daily News', accent: 'text-zinc-200' },
    { kind: 'data', label: 'Data', accent: 'text-up' },
  ] as const
  return (
    <footer className="grid shrink-0 grid-cols-3 gap-px border-t border-white/[0.07] bg-white/[0.04]">
      {sections.map((s) => {
        const items = notifications.filter((n) => n.kind === s.kind) // already newest-first
        return (
          <div key={s.kind} className="min-w-0 bg-background px-4 py-2">
            <div className={`text-[9px] font-semibold uppercase tracking-[0.16em] ${s.accent}`}>{s.label}</div>
            <div className="mt-0.5 flex gap-3 overflow-x-auto whitespace-nowrap text-[11px] text-muted">
              {items.length === 0 ? (
                <span className="text-subtle">—</span>
              ) : (
                items.slice(0, 6).map((n) => (
                  <span key={n.id} className="shrink-0">
                    <span className="text-zinc-300">{n.title}</span>
                    {n.body ? <span className="text-subtle"> · {n.body}</span> : null}
                  </span>
                ))
              )}
            </div>
          </div>
        )
      })}
    </footer>
  )
}
