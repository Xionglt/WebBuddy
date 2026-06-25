import type { PageSnapshot } from '../types.js'
import { getActiveTrace } from '../agent-trace/index.js'
import { buildFormState, type RawFormSnapshot } from './form-state-builder.js'
import type { FormState } from './form-state.js'
import { buildPageState, type PageState } from './page-state.js'
import { detectPageType } from './page-type-detector.js'

export class ObservationManager {
  private pageStates = new Map<string, PageState>()
  private formStates = new Map<string, FormState>()

  refreshPageState(input: { sessionId: string; snapshot: PageSnapshot }): PageState {
    const base = buildPageState(input.snapshot, 'unknown')
    const pageType = detectPageType(base)
    const state = { ...base, pageType }
    this.pageStates.set(input.sessionId, state)
    this.writeArtifact('page-state-latest.json', state)
    const existingFormState = this.formStates.get(input.sessionId)
    if (!existingFormState || existingFormState.url !== input.snapshot.url) {
      this.refreshFormState({
        sessionId: input.sessionId,
        formSnapshot: formSnapshotFromPageSnapshot(input.snapshot),
      })
    }
    return state
  }

  refreshFormState(input: { sessionId: string; formSnapshot: RawFormSnapshot }): FormState {
    const state = buildFormState(input.formSnapshot)
    this.formStates.set(input.sessionId, state)
    this.writeArtifact('form-state-latest.json', state)

    const pageState = this.pageStates.get(input.sessionId)
    if (pageState) {
      const pageType = detectPageType({ ...pageState, formState: state })
      const updatedPageState = { ...pageState, pageType, updatedAt: state.updatedAt }
      this.pageStates.set(input.sessionId, updatedPageState)
      this.writeArtifact('page-state-latest.json', updatedPageState)
    }

    return state
  }

  getPageState(sessionId: string): PageState | undefined {
    return this.pageStates.get(sessionId)
  }

  getFormState(sessionId: string): FormState | undefined {
    return this.formStates.get(sessionId)
  }

  private writeArtifact(name: string, value: unknown): void {
    try {
      const trace = getActiveTrace()
      if (!trace) return
      const path = trace.writeArtifact(name, `${JSON.stringify(value, null, 2)}\n`)
      trace.recordEvent('observation_artifact', { name, path })
    } catch {
      // Observation artifacts are diagnostics and must not affect tool flow.
    }
  }
}

export const observationManager = new ObservationManager()

function formSnapshotFromPageSnapshot(snapshot: PageSnapshot): RawFormSnapshot {
  const isField = (tag: string, role?: string) =>
    ['input', 'textarea', 'select'].includes(tag) || /textbox|combobox|searchbox/.test(role || '')
  return {
    url: snapshot.url,
    fields: snapshot.elements
      .filter((element) => isField(element.tag, element.role))
      .map((element, index) => ({
        index,
        tag: element.tag,
        role: element.role,
        label: element.name || element.text || element.locatorHints.text,
        value: element.value,
        disabled: element.disabled,
        required: false,
      })),
    submitCandidates: snapshot.elements
      .filter((element) => element.tag === 'button' || element.role === 'button')
      .map((element) => ({
        tag: element.tag,
        role: element.role,
        text: element.name || element.text || element.locatorHints.text,
        risk: element.risk,
        visible: element.visible,
      })),
  }
}
