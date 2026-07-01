import { useState } from 'react'
import Assign from './screens/Assign'
import Roster from './screens/Roster'

// Assign + Roster are live. The rest are inert placeholders that arrive in later
// phases (no router yet — simple active-tab state is enough).
const TABS = [
  { id: 'assign', label: 'Assign', enabled: true },
  { id: 'roster', label: 'Roster', enabled: true },
  { id: 'admin', label: 'Admin', enabled: false, phase: 'Phase 5' },
  { id: 'log', label: 'Log', enabled: false, phase: 'Phase 7' },
  { id: 'reports', label: 'Reports', enabled: false, phase: 'Phase 7' },
]

export default function App() {
  const [activeTab, setActiveTab] = useState('assign')

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col">
      {/* Masthead */}
      <header className="bg-slate-900 text-white">
        <div className="mx-auto max-w-3xl px-6 py-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-300">
            Texas HHSC · Benefits Office
          </p>
          <h1 className="mt-0.5 text-xl font-semibold">Lobby Assignment System</h1>
        </div>

        {/* Tab bar */}
        <nav className="mx-auto max-w-3xl px-3" aria-label="Sections">
          <ul className="flex gap-1">
            {TABS.map((tab) => {
              const active = tab.id === activeTab
              return (
                <li key={tab.id}>
                  <button
                    type="button"
                    onClick={() => tab.enabled && setActiveTab(tab.id)}
                    disabled={!tab.enabled}
                    aria-current={active ? 'page' : undefined}
                    title={tab.enabled ? undefined : `Coming in ${tab.phase}`}
                    className={[
                      'relative px-4 py-2.5 text-sm font-medium transition focus:outline-none',
                      active
                        ? 'text-white'
                        : tab.enabled
                          ? 'text-slate-300 hover:text-white'
                          : 'cursor-not-allowed text-slate-500',
                    ].join(' ')}
                  >
                    {tab.label}
                    {!tab.enabled && (
                      <span className="ml-1.5 align-top text-[0.6rem] font-normal text-slate-500">
                        soon
                      </span>
                    )}
                    {active && (
                      <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-blue-500" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
        <div className="h-1 bg-blue-600" />
      </header>

      {/* Main */}
      <main className="flex-1">
        <div className="mx-auto max-w-3xl px-6 py-10">
          {/* Both screens stay mounted (visibility-toggled) so a clerk's
              in-progress case survives a peek at the Roster — unmounting Assign
              would otherwise tear down its live claim state. */}
          <div className={activeTab === 'assign' ? undefined : 'hidden'}>
            <Assign />
          </div>
          <div className={activeTab === 'roster' ? undefined : 'hidden'}>
            <Roster />
          </div>
        </div>
      </main>

      <footer className="mx-auto w-full max-w-3xl px-6 pb-8">
        <p className="text-xs text-slate-400">
          Standalone tool · stores no client PII · connects to no external case system.
        </p>
      </footer>
    </div>
  )
}
