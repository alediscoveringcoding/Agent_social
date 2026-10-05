'use client'

import { useActionState } from 'react'
import { signIn, type AuthResult } from '@/lib/auth/actions'
import { Field, inputClass } from '@/components/ui'

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<AuthResult | undefined, FormData>(signIn, undefined)
  return (
    <form action={action} className="mt-6 space-y-4">
      <input type="hidden" name="next" value={next} />
      <Field label="Email">
        <input name="email" type="email" autoComplete="username" required className={inputClass} />
      </Field>
      <Field label="Parola">
        <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
      </Field>
      {state?.error ? <p className="text-sm font-semibold text-danger">{state.error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-primary px-3.5 py-2.5 text-sm font-bold text-on-primary disabled:opacity-60"
      >
        {pending ? 'Se verifica...' : 'Continua'}
      </button>
    </form>
  )
}
