// Agent Board: fail-open, provable (0.7.0, decisions.md "Workstreams and the work
// journal", build decision B3.4). Pure: no `$`. Every check that could refuse
// something (the spawn gate, the Agent tool's fork refusal, the spec check and
// the context resolution) runs through `failOpen`, so an error inside one never
// refuses anything: it reads as "no refusal".

/**
 * Runs `check` and resolves to what it gives (its value, or the value its
 * promise resolves to); resolves to `null` when it throws or its promise
 * rejects. Never rejects.
 */
export async function failOpen<T>(check: () => T | null | Promise<T | null>): Promise<T | null> {
  try {
    return await check()
  } catch {
    return null
  }
}
