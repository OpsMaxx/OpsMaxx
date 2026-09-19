import { Loader2 } from 'lucide-react'

/**
 * A read that is happening, shown as something that moves.
 *
 * Every surface in this module used to say `Reading...` as a static line of
 * text. A word that does not move cannot be told apart from a word that is
 * stuck, and this module's reads are the slowest in the app — GitHub discovery
 * walks repositories, then each repository's workflows, then each workflow's
 * YAML, which is tens of seconds during which the only thing on screen was a
 * full stop. The user report was exactly that: "the loader isn't animated, it's
 * just 'Reading...'".
 *
 * `Loader2` with `.spin` is the app's existing indicator (BackupPanel,
 * UpdatePanel, DatabaseView and five others), so this borrows it rather than
 * inventing a second one. `.spin` already slows itself under
 * `prefers-reduced-motion` in global.css rather than stopping, because stopping
 * would remove the one signal that says the read is alive.
 *
 * `children` is for the paragraph that explains WHY a read is slow. That prose
 * is genuinely useful and it is not an indicator, so it sits under the moving
 * part at note weight rather than standing in for it.
 *
 * `role="status"` because the appearance and disappearance of this is the only
 * announcement a screen reader gets that the panel is working.
 */
export function Reading({
  label,
  children
}: {
  /** What is being read, in the present tense. Written for the person reading it. */
  label: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="cicd-reading" role="status">
      <p className="cicd-reading-head">
        <Loader2 size={14} className="spin" aria-hidden />
        <span>{label}</span>
      </p>
      {children !== undefined && <p className="ui-note cicd-reading-detail">{children}</p>}
    </div>
  )
}
