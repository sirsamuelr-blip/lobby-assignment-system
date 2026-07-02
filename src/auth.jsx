import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signOut as fbSignOut } from 'firebase/auth'
import { auth, db } from './firebase'
import { getUserProfile } from './lib/users'

// Auth context: exposes the resolved app user ({ uid, name, role } | null), a
// loading flag while the initial auth state resolves, an authError string, and a
// signOut fn. The user's ROLE comes from users/{uid} (not from Firebase Auth
// itself), loaded on every auth-state change.
const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState('')

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) {
        setUser(null)
        setLoading(false)
        return
      }
      try {
        const profile = await getUserProfile(db, fbUser.uid)
        if (!profile || (profile.role !== 'clerk' && profile.role !== 'supervisor')) {
          // Authenticated but no valid staff role doc — not an app user. Sign
          // back out and surface a clear message rather than a broken app.
          setAuthError('This account has no assigned role. Contact your supervisor.')
          setUser(null)
          await fbSignOut(auth)
        } else {
          setAuthError('')
          setUser({ uid: fbUser.uid, name: profile.name, role: profile.role })
        }
      } catch (err) {
        setAuthError(err?.message ?? String(err))
        setUser(null)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [])

  const signOut = () => fbSignOut(auth)

  return (
    <AuthContext.Provider value={{ user, loading, authError, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (ctx == null) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
