import {
  createResearchStarter,
  runWebTask,
} from '@multi-functional-agent/web-buddy'

export const input = createResearchStarter({
  schemaVersion: 'research-starter/v1',
  goal: 'Summarize the plan and FAQ with source evidence.',
  startUrl: process.env.START_URL ?? 'https://example.com/',
})

if (process.env.WEB_BUDDY_STARTER_RUN === '1') {
  console.log(JSON.stringify(await runWebTask(input), null, 2))
}
