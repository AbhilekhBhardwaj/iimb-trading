import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { CARD, CARD_SHADOW, EASE, EDITORIAL_SERIF, GOLD, INPUT, MOTION } from '../../lib/design-patterns'
import { supabase } from '../../lib/supabase'
import { usernameToEmail, type AppRole } from '../../lib/accounts'

/** Where each role lands after a successful sign-in. */
const ROLE_DESTINATION: Record<AppRole, string> = {
  team: '/terminal',
  market_maker: '/terminal', // same terminal UI, more starting capital
  master: '/admin',
}

// Deliberately identical copy for every failure path. We never reveal whether a
// username exists — wrong username and wrong password look the same to the user.
const INVALID_MESSAGE = 'Invalid username or password.'

function Login() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (loading) return
    setError('')

    const trimmed = username.trim()
    if (!trimmed || !password) {
      setError(INVALID_MESSAGE)
      return
    }

    setLoading(true)
    try {
      // Accounts are pre-provisioned: convert the username to its synthetic
      // email and use Supabase's normal password sign-in.
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: usernameToEmail(trimmed),
        password,
      })
      if (signInError || !data.user) {
        setError(INVALID_MESSAGE)
        return
      }

      // Read the role to decide the destination. RLS lets a user read their own
      // profile row.
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', data.user.id)
        .single()

      if (profileError || !profile) {
        // Authenticated but no profile — treat as a bad login rather than
        // stranding the user in a half-signed-in state.
        await supabase.auth.signOut()
        setError(INVALID_MESSAGE)
        return
      }

      const destination = ROLE_DESTINATION[profile.role as AppRole] ?? '/terminal'
      navigate(destination, { replace: true })
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <motion.div
        initial={MOTION.hero.initial}
        animate={MOTION.hero.animate}
        transition={{ duration: 0.7, ease: EASE }}
        className={`${CARD} w-full max-w-sm p-8`}
        style={{ boxShadow: CARD_SHADOW }}
      >
        <div className="mb-8 text-center">
          <h1 className="text-bright" style={{ ...EDITORIAL_SERIF, fontSize: '1.85rem' }}>
            MochaTrade
          </h1>
          <p className="mt-2 text-sm text-muted">IIM Bangalore Trading Competition</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="username"
              className="mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-subtle"
            >
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. team01"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={INPUT}
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-subtle"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
              className={INPUT}
            />
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-[var(--radius)] border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="group relative mt-3 rounded-full p-px transition-transform duration-300 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70"
            style={{ background: GOLD.gradient, backgroundSize: '250% 250%' }}
          >
            <span className="relative flex items-center justify-center rounded-full bg-[rgba(8,7,6,0.96)] px-6 py-3 text-sm font-medium text-bright transition-colors duration-300 group-hover:bg-[rgba(20,17,14,0.88)]">
              {loading ? 'Signing in…' : 'Enter Competition'}
            </span>
          </button>
        </form>
      </motion.div>
    </main>
  )
}

export default Login
