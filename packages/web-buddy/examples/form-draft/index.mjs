import {
  createFormDraftStarter,
  runWebTask,
} from '@multi-functional-agent/web-buddy'

export const input = createFormDraftStarter({
  schemaVersion: 'form-draft-starter/v1',
  goal: 'Prepare a complete draft, but do not submit the form.',
  startUrl: process.env.START_URL ?? 'https://example.com/contact',
  fields: [
    {
      schemaVersion: 'form-draft-field/v1',
      field: 'name',
      value: 'Ada Example',
      sensitivity: 'personal',
    },
    {
      schemaVersion: 'form-draft-field/v1',
      field: 'topic',
      value: 'Product information',
      sensitivity: 'public',
    },
  ],
})

if (process.env.WEB_BUDDY_STARTER_RUN === '1') {
  console.log(JSON.stringify(await runWebTask(input), null, 2))
}
