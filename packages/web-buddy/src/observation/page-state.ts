import type { PageSnapshot } from '../types.js'

export type PageType = 'unknown' | 'login' | 'list' | 'detail' | 'form' | 'confirmation' | 'captcha'

export interface PageState {
  schemaVersion: 'page-state/v1'
  url: string
  title: string
  pageType: PageType
  interactiveCount: number
  formCount: number
  linkCount: number
  buttonCount: number
  inputCount: number
  textSummary: string
  updatedAt: string
}

export function buildPageState(snapshot: PageSnapshot, pageType: PageType, updatedAt = new Date().toISOString()): PageState {
  const elements = snapshot.elements ?? []
  return {
    schemaVersion: 'page-state/v1',
    url: snapshot.url,
    title: snapshot.title,
    pageType,
    interactiveCount: snapshot.stats.interactiveCount,
    formCount: snapshot.stats.formCount ?? 0,
    linkCount: snapshot.stats.linkCount ?? elements.filter((el) => el.tag === 'a' || el.role === 'link').length,
    buttonCount:
      snapshot.stats.buttonCount ??
      elements.filter((el) => el.tag === 'button' || el.role === 'button' || el.tag === 'summary').length,
    inputCount:
      snapshot.stats.inputCount ??
      elements.filter((el) => ['input', 'textarea', 'select'].includes(el.tag) || /textbox|combobox|searchbox/.test(el.role || '')).length,
    textSummary: snapshot.textSummary,
    updatedAt,
  }
}
