import { useEffect, useRef, useState } from 'react'
import Icon, { type IconName } from './Icon'

export interface OverflowMenuItem {
  label: string
  /** Omitted when `children` turns this row into a submenu trigger instead of an action. */
  onClick?: () => void
  icon?: IconName
  /** Turns this row into a hover/click-revealed flyout of further items — for collapsing a run of related actions (export formats, copy variants) into one row so the menu doesn't grow tall. */
  children?: OverflowMenuItem[]
  /** Red, for a destructive action — mirrors `.menu__danger` elsewhere in the app. */
  danger?: boolean
  disabled?: boolean
}

/** How long a submenu stays open after the pointer leaves it, so crossing the small gap between a row and its flyout doesn't flicker it shut. */
const SUBMENU_CLOSE_DELAY_MS = 150

/**
 * A "⋯" button that opens a dropdown of secondary actions — for a page or
 * card with more actions than are worth a button each. `groups` are
 * rendered with a divider between each non-empty one, so related actions
 * (the copy variants, the export formats) read as one cluster rather than
 * one long undifferentiated list — an empty group is simply skipped, so a
 * caller can build its groups conditionally without filtering them all
 * down to one flat array itself. An item with `children` instead collapses
 * into a hover-revealed flyout rather than a row per option, keeping the
 * main list short. Reuses the same `.menu` surface (and click-away-to-close
 * behavior) `Select.tsx`'s open list and the card menus already draw from.
 */
export default function OverflowMenu({
  groups,
  ariaLabel = 'More actions',
  align = 'end'
}: {
  groups: OverflowMenuItem[][]
  ariaLabel?: string
  align?: 'start' | 'end'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null)
  const [listFlip, setListFlip] = useState(false)
  const [submenuFlip, setSubmenuFlip] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const closeSubmenuTimer = useRef<number | null>(null)

  // Which side the list is actually rendering toward, after any flip below —
  // 'end' (the usual case, a right-aligned trigger) extends leftward from
  // the trigger unless flipped, 'start' extends rightward unless flipped.
  const listExtendsLeft = (align === 'end') !== listFlip

  // The list opens toward whichever side has room by default — but flips to
  // the other side if that runs it past the window edge, which happens once
  // the trigger itself sits near an edge (e.g. a chip right after the
  // sidebar, or a page's top-right "⋯" button).
  function measureList(el: HTMLDivElement | null): void {
    if (!el) return
    const rect = el.getBoundingClientRect()
    setListFlip(align === 'start' ? rect.right > window.innerWidth : rect.left < 0)
  }

  // A submenu's default side follows the list's own actual side (a flipped
  // list has room on the opposite side from usual) — then flips again itself
  // if even that runs past the edge.
  function measureSubmenu(el: HTMLDivElement | null): void {
    if (!el) return
    const rect = el.getBoundingClientRect()
    setSubmenuFlip(listExtendsLeft ? rect.left < 0 : rect.right > window.innerWidth)
  }

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onEscape)
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      setOpenSubmenu(null)
      setListFlip(false)
    }
  }, [open])

  function openSub(key: string): void {
    if (closeSubmenuTimer.current != null) {
      window.clearTimeout(closeSubmenuTimer.current)
      closeSubmenuTimer.current = null
    }
    setSubmenuFlip(false)
    setOpenSubmenu(key)
  }

  function scheduleCloseSub(key: string): void {
    closeSubmenuTimer.current = window.setTimeout(() => {
      setOpenSubmenu((cur) => (cur === key ? null : cur))
    }, SUBMENU_CLOSE_DELAY_MS)
  }

  const nonEmptyGroups = groups.filter((g) => g.length > 0)

  return (
    <div ref={rootRef} className="overflow-menu">
      <button
        type="button"
        className="overflow-menu__trigger"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" className="overflow-menu__trigger-icon" />
      </button>
      {open && (
        <div
          ref={measureList}
          className={listExtendsLeft ? 'menu overflow-menu__list' : 'menu overflow-menu__list overflow-menu__list--start'}
          role="menu"
        >
          {nonEmptyGroups.map((group, gi) => (
            <div key={gi} className="overflow-menu__group">
              {gi > 0 && <div className="overflow-menu__divider" role="separator" />}
              {group.map((item) => {
                const key = `${gi}:${item.label}`
                return (
                  <div
                    key={key}
                    className="overflow-menu__item"
                    onMouseEnter={() => item.children && openSub(key)}
                    onMouseLeave={() => item.children && scheduleCloseSub(key)}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      aria-haspopup={item.children ? 'menu' : undefined}
                      aria-expanded={item.children ? openSubmenu === key : undefined}
                      className={item.danger ? 'menu__danger' : undefined}
                      disabled={item.disabled}
                      onClick={() => {
                        if (item.children) {
                          setSubmenuFlip(false)
                          setOpenSubmenu((cur) => (cur === key ? null : key))
                          return
                        }
                        setOpen(false)
                        item.onClick?.()
                      }}
                    >
                      {item.icon && <Icon name={item.icon} className="overflow-menu__icon" />}
                      {item.label}
                      {item.children && <Icon name="chevronRight" className="overflow-menu__chevron" />}
                    </button>
                    {item.children && openSubmenu === key && (
                      <div
                        ref={measureSubmenu}
                        className={
                          submenuFlip ? 'menu overflow-menu__submenu overflow-menu__submenu--flip' : 'menu overflow-menu__submenu'
                        }
                        role="menu"
                      >
                        {item.children.map((sub) => (
                          <button
                            key={sub.label}
                            type="button"
                            role="menuitem"
                            className={sub.danger ? 'menu__danger' : undefined}
                            disabled={sub.disabled}
                            onClick={() => {
                              setOpen(false)
                              setOpenSubmenu(null)
                              sub.onClick?.()
                            }}
                          >
                            {sub.icon && <Icon name={sub.icon} className="overflow-menu__icon" />}
                            {sub.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
