import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

/**
 * The app's dropdown.
 *
 * A native <select> hands its open list to the operating system, which paints
 * it in the OS's own idiom: square corners, a hard blue highlight, a 1px grey
 * frame — none of which follow the app's surfaces, radii, or theme. Every other
 * floating panel here (the card menus) is drawn by the app, so the one control
 * that wasn't looked like it came from somewhere else.
 *
 * This draws the list itself, reusing the menu's surface, and keeps the parts a
 * native select gives away for free: keyboard navigation, a labelled trigger,
 * and the listbox roles a screen reader expects.
 */

export type SelectOption = {
  value: string
  label: string
  /** Painted on the option and, when selected, on the trigger. */
  color?: string
  disabled?: boolean
}

export default function Select({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  id,
  disabled = false,
  /** `bare` drops the control chrome for use inline in running text. */
  variant = 'field',
  align = 'start',
  title
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
  id?: string
  disabled?: boolean
  variant?: 'field' | 'bare'
  align?: 'start' | 'end'
  title?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Which option the keyboard is on, which is not the same as the chosen one.
  const [activeIndex, setActiveIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listId = useId()

  const selected = options.find((o) => o.value === value)
  const label = selected?.label ?? placeholder ?? ''

  // Clicking away closes it — the same rule the card menus follow.
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  /**
   * Flip the list above the trigger when there is no room below.
   *
   * A speaker dropdown on the last line of a transcript would otherwise open
   * past the bottom of the window, which is exactly where a native select
   * would have been clever for us.
   */
  useLayoutEffect(() => {
    if (!open || !listRef.current || !triggerRef.current) return
    const list = listRef.current
    list.classList.remove('select__list--above')
    const trigger = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - trigger.bottom
    if (list.offsetHeight > spaceBelow - 12 && trigger.top > spaceBelow) {
      list.classList.add('select__list--above')
    }
    list.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  function openList(from: number): void {
    if (disabled) return
    setActiveIndex(from)
    setOpen(true)
  }

  function choose(index: number): void {
    const option = options[index]
    if (!option || option.disabled) return
    setOpen(false)
    triggerRef.current?.focus()
    if (option.value !== value) onChange(option.value)
  }

  /** Next selectable option in `step` direction, skipping disabled ones. */
  function step(from: number, direction: 1 | -1): number {
    for (let i = from + direction; i >= 0 && i < options.length; i += direction) {
      if (!options[i].disabled) return i
    }
    return from
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    const current = activeIndex >= 0 ? activeIndex : options.findIndex((o) => o.value === value)
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault()
        const direction = e.key === 'ArrowDown' ? 1 : -1
        if (!open) openList(current >= 0 ? current : 0)
        else setActiveIndex(step(current < 0 ? (direction === 1 ? -1 : options.length) : current, direction))
        break
      }
      case 'Home':
      case 'End':
        if (open) {
          e.preventDefault()
          setActiveIndex(e.key === 'Home' ? step(-1, 1) : step(options.length, -1))
        }
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (open) choose(activeIndex)
        else openList(current >= 0 ? current : 0)
        break
      case 'Escape':
        if (open) {
          e.preventDefault()
          setOpen(false)
        }
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  return (
    <div
      ref={rootRef}
      className={variant === 'bare' ? 'select select--bare' : 'select'}
      data-open={open || undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className="select__trigger"
        style={selected?.color ? ({ '--speaker': selected.color } as React.CSSProperties) : undefined}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? setOpen(false) : openList(options.findIndex((o) => o.value === value)))}
        onKeyDown={onKeyDown}
      >
        <span className={selected ? 'select__value' : 'select__value select__value--empty'}>
          {label}
        </span>
        <svg className="select__caret" viewBox="0 0 12 8" aria-hidden="true">
          <path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          id={listId}
          className={align === 'end' ? 'menu select__list select__list--end' : 'menu select__list'}
          role="listbox"
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          {options.map((option, i) => (
            <button
              key={option.value}
              type="button"
              id={`${listId}-${i}`}
              role="option"
              aria-selected={option.value === value}
              data-active={i === activeIndex || undefined}
              className="select__option"
              style={option.color ? ({ '--speaker': option.color } as React.CSSProperties) : undefined}
              disabled={option.disabled}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => choose(i)}
            >
              <span className="select__tick" aria-hidden="true">
                {option.value === value ? '✓' : ''}
              </span>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
