import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { CARD, CARD_SHADOW, EASE, EDITORIAL_SERIF, GOLD, INPUT, MOTION } from '../../lib/design-patterns'
import { api } from '../../lib/api'
import * as session from '../../lib/session'
import { type AppRole } from '../../lib/accounts'
import { analytics } from '../../lib/analytics'

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
      // The browser holds no Supabase key. Credentials go to OUR backend, which
      // signs in against Supabase, reads the role, and returns tokens. The
      // username-to-email mapping and the profile lookup both moved server-side.
      const s = await api.login(trimmed, password)
      session.save(s)

      analytics.identify(s.accountId, { role: s.role })
      analytics.capture('login', { role: s.role })

      const destination = ROLE_DESTINATION[s.role as AppRole] ?? '/terminal'
      navigate(destination, { replace: true })
    } catch (err) {
      // The backend answers a bad credential with 401 + { error: 'invalid
      // credentials' }, which post() rethrows as that message. Anything else is
      // a genuine fault. Both render the same generic copy to the user; only
      // the fallback wording differs.
      const msg = err instanceof Error ? err.message : ''
      setError(/invalid credentials|username and password/i.test(msg) ? INVALID_MESSAGE : 'Something went wrong. Please try again.')
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
