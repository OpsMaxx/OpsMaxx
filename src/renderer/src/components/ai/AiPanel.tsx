import { useEffect, useState } from 'react'
import { LayoutDashboard, Users, ShieldCheck, Radio, CircleCheck, ScrollText, Lock } from 'lucide-react'
import { clsx } from '../../lib/format'
import { AiAgents } from './AiAgents'
import { AiAccessGroups } from './AiAccessGroups'
import { AiApprovals } from './AiApprovals'
import { AiAuthorizations } from './AiAuthorizations'
import { AiAuditLog } from './AiAuditLog'
import { AiSecurity } from './AiSecurity'
import { ConnectAgent } from './ConnectAgent'
import { useNav, AI_SECTIONS, AI_SECTION_LABEL_KEYS } from '../../store/nav'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { AiSection } from '../../store/nav'
import type { McpAgentSession, ApprovalRequest } from '../../../../shared/mcp'

// Keyed by the nav store's union, so a page added there without an icon here
// fails the build. The labels come from nav.ts, which is where the command
// palette reads them too — a second copy of them here is how these seven pages
// were nameable in the panel and unreachable from Ctrl+K.
const SECTION_ICONS: Record<AiSection, React.JSX.Element> = {
  overview: <LayoutDashboard size={16} />,
  agents: <Users size={16} />,
  groups: <ShieldCheck size={16} />,
  sessions: <Radio size={16} />,
  approvals: <CircleCheck size={16} />,
  audit: <ScrollText size={16} />,
  security: <Lock size={16} />
}

function Overview(): React.JSX.Element {
  const [sessions, setSessions] = useState<McpAgentSession[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [status, setStatus] = useState<{ running: boolean; port: number | null }>({ running: false, port: null })
  const t = useT()

  const load = (): void => {
    void window.opsmaxx?.aiMcp.listSessions().then((s) => setSessions(s ?? []))
    void window.opsmaxx?.aiMcp.listApprovals().then((a) => setApprovals(a ?? []))
    void window.opsmaxx?.aiMcp.status().then((s) => s && setStatus(s))
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [])

  const active = sessions.filter((s) => !s.revoked && (!s.expiresAt || new Date(s.expiresAt) > new Date()))

  return (
    <div className="settings-section">
      <h2>{t('layout.activity.ai')}</h2>
      <div className="sub">{t('ai.overview.intro')}</div>

      <div className="card-grid" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="s-title">{t('ai.overview.bridgeStatus')}</div>
          <div className="s-desc">
            {status.running ? t('ai.overview.runningOn', { address: `127.0.0.1:${status.port}` }) : t('common.disabled')}
          </div>
        </div>
        <div className="card">
          <div className="s-title">{t('ai.overview.activeSessions')}</div>
          <div className="s-desc">{t('ai.overview.sessionCount', { active: active.length, count: sessions.length })}</div>
        </div>
        <div className="card">
          <div className="s-title">{t('ai.overview.pendingApprovals')}</div>
          <div className="s-desc">{t('ai.overview.approvalCount', { count: approvals.length })}</div>
        </div>
      </div>

      <ConnectAgent onConnected={load} />

      <h3 style={{ marginTop: 24 }}>{t('ai.overview.howItWorks')}</h3>
      <ol className="s-desc" style={{ lineHeight: 1.8 }}>
        <li>{t('ai.overview.step1')}</li>
        <li>{t('ai.overview.step2')}</li>
        <li>{t('ai.overview.step3')}</li>
        <li>{t('ai.overview.step4')}</li>
      </ol>
      <div className="s-desc">{t('ai.overview.optional')}</div>
      <div className="s-desc">
        <Trans
          i18nKey="ai.overview.connectHint"
          values={{ command: 'opsmaxx codex' }}
          components={{ b: <b />, code: <code className="mono" /> }}
        />
      </div>
    </div>
  )
}

export function AiPanel(): React.JSX.Element {
  // Held in the nav store rather than locally so a message elsewhere in the app
  // can send the user straight to the page that fixes it.
  const section = useNav((s) => s.aiSection)
  const setSection = useNav((s) => s.setAiSection)
  const t = useT()

  return (
    <div className="main">
      <div className="settings">
        <nav className="settings-nav">
          {AI_SECTIONS.map((id) => (
            <button
              key={id}
              className={clsx('nav-item', section === id && 'active')}
              onClick={() => setSection(id)}
            >
              {SECTION_ICONS[id]}
              {t(AI_SECTION_LABEL_KEYS[id])}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === 'overview' && <Overview />}
          {section === 'agents' && <AiAgents />}
          {section === 'groups' && <AiAccessGroups />}
          {section === 'sessions' && <AiAgents sessionsOnly />}
          {/* Both are "something is blocked on your decision", so they share a
              page rather than hiding one behind a nav item nobody opens. An
              authorization request expires in minutes; a tab of its own is how
              it would time out unseen. */}
          {section === 'approvals' && (
            <>
              <AiAuthorizations />
              <AiApprovals />
            </>
          )}
          {section === 'audit' && <AiAuditLog />}
          {section === 'security' && <AiSecurity />}
        </div>
      </div>
    </div>
  )
}
