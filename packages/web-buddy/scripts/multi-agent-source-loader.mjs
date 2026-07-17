import { access } from 'node:fs/promises'

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (!specifier.startsWith('.') || !specifier.endsWith('.js')) throw error
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
    await access(candidate)
    return nextResolve(candidate.href, context)
  }
}
