import { useState } from 'react'
import { AuthProvider, useAuth } from './auth'
import Login from './screens/Login'
import Assign from './screens/Assign'
import Roster from './screens/Roster'
import Admin from './screens/Admin'
import Log from './screens/Log'
import Reports from './screens/Reports'

// Admin is supervisor-only (role-gated below). Every other tab is open to any
// authenticated user (clerk or supervisor).
const TABS = [
  { id: 'assign', label: 'Assign' },
  { id: 'roster', label: 'Roster' },
  { id: 'admin', label: 'Admin', supervisorOnly: true },
  { id: 'log', label: 'Log' },
  { id: 'reports', label: 'Reports' },
]

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}

function AppShell() {
  const { user, loading, authError, signOut } = useAuth()
  const [activeTab, setActiveTab] = useState('assign')

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    )
  }

  if (!user) return <Login authError={authError} />

  const isSupervisor = user.role === 'supervisor'
  const visibleTabs = TABS.filter((t) => !t.supervisorOnly || isSupervisor)
  // Defensive: a non-supervisor can never land on Admin even via stale state.
  const effectiveTab = activeTab === 'admin' && !isSupervisor ? 'assign' : activeTab

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col">
      <header className="bg-slate-900 text-white">
        <div className="mx-auto max-w-3xl px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-300">
                Texas HHSC · Benefits Office
              </p>
              <h1 className="mt-0.5 text-xl font-semibold">Lobby Assignment System</h1>
            </div>
            <div className="flex items-center gap-3 pt-0.5">
              <div className="text-right">
                <p className="text-sm font-medium leading-tight">{user.name}</p>
                <p className="text-xs capitalize text-slate-300">{user.role}</p>
              </div>
              <button
                type="button"
                onClick={signOut}
                className="rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-100 transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>

        <nav className="mx-auto max-w-3xl px-3" aria-label="Sections">
          <ul className="flex gap-1">
            {visibleTabs.map((tab) => {
              const active = tab.id === effectiveTab
              return (
                <li key={tab.id}>
                  <button
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    aria-current={active ? 'page' : undefined}
                    className={[
                      'relative rounded-sm px-4 py-2.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900',
                      active ? 'text-white' : 'text-slate-300 hover:text-white',
                    ].join(' ')}
                  >
                    {tab.label}
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

      <main className="flex-1">
        <div className="mx-auto max-w-3xl px-6 py-10">
          {/* All screens stay mounted (visibility-toggled) so a clerk's
              in-progress case survives a peek at another tab — unmounting Assign
              would tear down its live claim state. Admin is mounted ONLY for a
              supervisor, so a clerk cannot reach it even via stale tab state; the
              Firestore rules deny clerk writes to workers/unavailability regardless. */}
          <div className={effectiveTab === 'assign' ? undefined : 'hidden'}>
            <Assign clerkId={user.uid} />
          </div>
          <div className={effectiveTab === 'roster' ? undefined : 'hidden'}>
            <Roster />
          </div>
          {isSupervisor && (
            <div className={effectiveTab === 'admin' ? undefined : 'hidden'}>
              <Admin />
            </div>
          )}
          <div className={effectiveTab === 'log' ? undefined : 'hidden'}>
            <Log />
          </div>
          <div className={effectiveTab === 'reports' ? undefined : 'hidden'}>
            <Reports />
          </div>
        </div>
      </main>

      <footer className="mx-auto w-full max-w-3xl px-6 pb-8">
        <p className="text-xs text-slate-600">
          Standalone tool · stores no client PII · connects to no external case system.
        </p>
      </footer>
    </div>
  )
}
