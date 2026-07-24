import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { CARD, CARD_SHADOW, EASE, EDITORIAL_SERIF, GOLD, INPUT, MOTION } from '../../lib/design-patterns'

function Login() {
  const navigate = useNavigate()
  const [teamName, setTeamName] = useState('')
  const [accessCode, setAccessCode] = useState('')

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    navigate('/terminal')
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
              htmlFor="teamName"
              className="mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-subtle"
            >
              Team Name
            </label>
            <input
              id="teamName"
              type="text"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="e.g. Alpha Traders"
              autoComplete="off"
              className={INPUT}
            />
          </div>

          <div>
            <label
              htmlFor="accessCode"
              className="mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-subtle"
            >
              Access Code
            </label>
            <input
              id="accessCode"
              type="text"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
              placeholder="Enter your code"
              autoComplete="off"
              className={INPUT}
            />
          </div>

          <button
            type="submit"
            className="group relative mt-3 rounded-full p-px transition-transform duration-300 active:scale-[0.99]"
            style={{ background: GOLD.gradient, backgroundSize: '250% 250%' }}
          >
            <span className="relative flex items-center justify-center rounded-full bg-[rgba(8,7,6,0.96)] px-6 py-3 text-sm font-medium text-bright transition-colors duration-300 group-hover:bg-[rgba(20,17,14,0.88)]">
              Enter Competition
            </span>
          </button>
        </form>
      </motion.div>
    </main>
  )
}

export default Login
