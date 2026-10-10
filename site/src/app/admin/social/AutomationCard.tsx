import { Badge, Card, Empty } from '@/components/ui'
import {
  automationRunTime,
  automationStatusLabel,
  automationStatusTone,
  automationWorkflowLabel,
  summarizeRunDetails,
  type AutomationRunLike,
} from '@/lib/social/news-ui'
import { formatBucharest } from '@/lib/social/time'

/**
 * Amendment 07: the last runs n8n reported (social_automation_runs).
 * `runs` is null when they could not be read; the rest of the overview still shows.
 */
export function AutomationCard({ runs }: { runs: AutomationRunLike[] | null }) {
  return (
    <Card>
      <h2 className="mb-1 font-bold">Automatizari</h2>
      <p className="mb-3 text-xs text-ink-soft">Ultimele rulari raportate de n8n. Ora e in Europe/Bucharest.</p>
      {runs === null ? (
        <p className="text-sm text-warn">Nu am putut citi rularile n8n. Verifica jurnalul serverului.</p>
      ) : runs.length === 0 ? (
        <Empty title="Nicio rulare n8n inca." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-ink-soft">
              <tr>
                <th className="p-2">Automatizare</th>
                <th className="p-2">Stare</th>
                <th className="p-2">Ora</th>
                <th className="p-2">Detalii</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t border-line align-top">
                  <td className="p-2 font-semibold" title={run.workflow}>
                    {automationWorkflowLabel(run.workflow)}
                  </td>
                  <td className="p-2">
                    <Badge tone={automationStatusTone(run.status)}>{automationStatusLabel(run.status)}</Badge>
                  </td>
                  <td className="whitespace-nowrap p-2">{formatBucharest(automationRunTime(run))}</td>
                  <td className="break-words p-2 text-ink-soft">{summarizeRunDetails(run.details) || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
