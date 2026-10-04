/**
 * A minimal client for the worker API (PRD 10.3), the same calls Track B's
 * worker makes. Used by the fake worker and fake generator; `fetch` is
 * injectable so tests can route calls to the handlers in-process.
 */

export interface WorkerApiOptions {
  baseUrl: string
  token: string
  workerId: string
  version?: string
  fetch?: typeof fetch
}

export interface ApiResponse<T = Record<string, unknown>> {
  status: number
  body: T & { error?: { code: string; message: string } }
}

export class WorkerApi {
  readonly workerId: string
  private readonly opts: WorkerApiOptions

  constructor(opts: WorkerApiOptions) {
    this.opts = opts
    this.workerId = opts.workerId
  }

  withWorker(workerId: string): WorkerApi {
    return new WorkerApi({ ...this.opts, workerId })
  }

  async post<T = Record<string, unknown>>(path: string, body: unknown): Promise<ApiResponse<T>> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/api/worker/social/v1${path}`
    const res = await (this.opts.fetch ?? fetch)(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        'content-type': 'application/json',
        'x-worker-id': this.opts.workerId,
        'x-worker-version': this.opts.version ?? 'fake/0.1',
      },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    let parsed: unknown = {}
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      parsed = { error: { code: 'NOT_JSON', message: text.slice(0, 200) } }
    }
    return { status: res.status, body: parsed as ApiResponse<T>['body'] }
  }
}
