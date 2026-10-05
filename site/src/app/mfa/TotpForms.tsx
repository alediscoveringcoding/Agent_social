'use client'

import { useActionState, useEffect, useState } from 'react'
import { startTotpEnroll, verifyTotp, type AuthResult, type EnrollResult } from '@/lib/auth/actions'
import { Field, inputClass } from '@/components/ui'

function CodeForm({ next, factorId }: { next: string; factorId?: string }) {
  const [state, action, pending] = useActionState<AuthResult | undefined, FormData>(verifyTotp, undefined)
  return (
    <form action={action} className="mt-5 space-y-4">
      <input type="hidden" name="next" value={next} />
      {factorId ? <input type="hidden" name="factorId" value={factorId} /> : null}
      <Field label="Cod">
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          required
          autoFocus
          className={`${inputClass} text-center font-mono text-lg tracking-[0.3em]`}
        />
      </Field>
      {state?.error ? <p className="text-sm font-semibold text-danger">{state.error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-primary px-3.5 py-2.5 text-sm font-bold text-on-primary disabled:opacity-60"
      >
        {pending ? 'Se verifica...' : 'Confirma'}
      </button>
    </form>
  )
}

export function VerifyTotp({ next }: { next: string }) {
  return <CodeForm next={next} />
}

export function EnrollTotp({ next }: { next: string }) {
  const [enroll, setEnroll] = useState<EnrollResult | null>(null)
  useEffect(() => {
    let live = true
    startTotpEnroll().then((r) => {
      if (live) setEnroll(r)
    })
    return () => {
      live = false
    }
  }, [])

  if (!enroll) return <p className="mt-5 text-sm text-ink-soft">Se pregateste codul QR...</p>
  if (enroll.error || !enroll.factorId) return <p className="mt-5 text-sm font-semibold text-danger">{enroll.error}</p>
  return (
    <div className="mt-5">
      {enroll.qrCode ? (
        <>
          <div className="flex justify-center rounded-lg border border-line bg-white p-3">
            {/* A data: SVG from Supabase; next/image adds nothing here. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={enroll.qrCode} alt="Cod QR pentru aplicatia de autentificare" width={180} height={180} />
          </div>
          <p className="mt-3 text-xs text-ink-soft">
            Nu poti scana? Introdu manual cheia: <span className="font-mono text-ink">{enroll.secret}</span>
          </p>
        </>
      ) : (
        // Local mode (DB_MODE=local) has no QR image: the key is typed in.
        <div className="rounded-lg border border-line bg-white p-4 text-sm text-ink">
          <p>In aplicatia de autentificare alege &quot;Adauga cont&quot;, apoi &quot;Introdu cheia manual&quot;, de tip bazat pe timp:</p>
          <p className="mt-2 break-all text-center font-mono text-base font-bold tracking-wider">{enroll.secret}</p>
        </div>
      )}
      <CodeForm next={next} factorId={enroll.factorId} />
    </div>
  )
}
