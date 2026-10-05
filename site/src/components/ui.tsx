/**
 * Small shared UI pieces, in the brand tokens (globals.css). No hex here.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-card border border-line bg-card p-5 shadow-card', className)}>{children}</div>
}

type ButtonTone = 'primary' | 'secondary' | 'danger' | 'ghost'

const TONES: Record<ButtonTone, string> = {
  primary: 'bg-primary text-on-primary hover:opacity-90',
  secondary: 'border border-line-2 bg-card text-ink hover:bg-bg-mint',
  danger: 'border border-danger/40 bg-card text-danger hover:bg-danger-soft',
  ghost: 'text-ink-soft hover:bg-bg-mint hover:text-ink',
}

export function Button({
  tone = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50',
        TONES[tone],
        className
      )}
    />
  )
}

type BadgeTone = 'neutral' | 'accent' | 'gold' | 'danger' | 'warn'

const BADGES: Record<BadgeTone, string> = {
  neutral: 'bg-bg-soft text-ink-soft border border-line',
  accent: 'bg-accent-soft text-accent-dark',
  gold: 'bg-gold-soft text-ink',
  danger: 'bg-danger-soft text-danger',
  warn: 'bg-warn-soft text-warn',
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold', BADGES[tone])}>
      {children}
    </span>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: ReactNode
  error?: string | null
  children: ReactNode
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-semibold text-ink">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-ink-soft">{hint}</span> : null}
      {error ? <span className="block text-xs font-semibold text-danger">{error}</span> : null}
    </label>
  )
}

export const inputClass =
  'w-full rounded-lg border border-line-2 bg-bg px-3 py-2 text-sm text-ink placeholder:text-ink-soft/70 focus:border-accent focus:outline-none'

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-extrabold text-ink">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-ink-soft">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-line-2 bg-bg-soft p-10 text-center">
      <p className="text-base font-bold text-ink">{title}</p>
      {children ? <div className="mx-auto mt-2 max-w-md text-sm text-ink-soft">{children}</div> : null}
    </div>
  )
}
