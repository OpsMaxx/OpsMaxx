import { ReactNode } from 'react'
import { clsx } from '../../lib/format'

interface EmptyStateProps {
  /** Omitted by `compact`, which has no tile to put one in. */
  icon?: ReactNode
  title: string
  message: string
  action?: ReactNode
  /**
   * For a slot inside a screen rather than a whole screen.
   *
   * The full variant centres a 56px glyph tile in the height of a pane, which
   * is right when the pane is the emptiness and wrong when it is one shelf of
   * a screen that has other things on it. Without this variant those shelves
   * each grew a grammar of their own — a left-aligned line with an inline icon
   * in one, a bare uncontained sentence in another — so the product read as
   * assembled rather than designed at precisely the moment a new user is
   * looking at it. Same component, same three parts, no tile.
   */
  compact?: boolean
}

export function EmptyState({
  icon,
  title,
  message,
  action,
  compact
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className={clsx('empty', compact && 'compact')}>
      {!compact && icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      <p>{message}</p>
      {action}
    </div>
  )
}
