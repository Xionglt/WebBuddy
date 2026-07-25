export interface MemoryEvalFormField {
  key: string
  label: string
  controlKind: 'text' | 'select_native' | 'radio'
  required: boolean
}

export interface MemoryEvalFormDefinition {
  fields: MemoryEvalFormField[]
}

export const MEMORY_EVAL_FORM_DEFINITION: MemoryEvalFormDefinition = {
  fields: [
    { key: 'city', label: 'City', controlKind: 'text', required: true },
    { key: 'language', label: 'Language', controlKind: 'select_native', required: true },
    { key: 'workMode', label: 'Work mode', controlKind: 'radio', required: true },
    { key: 'timezone', label: 'Timezone', controlKind: 'text', required: true },
    { key: 'notificationChannel', label: 'Notification channel', controlKind: 'radio', required: true },
  ],
}
