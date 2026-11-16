// Agent Board: fail-open, provable (0.7.0, decisions.md "Workstreams and the work
// journal", build decision B3.4). Pure: no `$`. Every check that could refuse
// something (the spawn gate, the Agent tool's fork refusal, the spec check and
// the context resolution) runs through `failOpen`, so an error inside one never
// refuses anything: it reads as "no refusal".

export type Checked<T> = { ok: true; value: T | null } | { ok: false; error: string }

/**
 * Runs `check`: ok with its value (or the value its promise resolves to), or
 * not ok with the error's message (`String(err)` for a non-Error). Never rejects.
 */
export async function runCheck<T>(check: () => T | null | Promise<T | null>): Promise<Checked<T>> {
  try {
    return { ok: true, value: await check() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Runs `check` and resolves to what it gives (its value, or the value its
 * promise resolves to); resolves to `null` when it throws or its promise
 * rejects. Never rejects.
 */
export async function failOpen<T>(check: () => T | null | Promise<T | null>): Promise<T | null> {
  const r = await runCheck(check)
  return r.ok ? r.value : null
}
