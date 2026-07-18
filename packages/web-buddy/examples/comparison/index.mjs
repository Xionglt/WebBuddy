import {
  createComparisonStarter,
  runWebTask,
} from '@multi-functional-agent/web-buddy'

export const input = createComparisonStarter({
  schemaVersion: 'comparison-starter/v1',
  goal: 'Compare the options using the supplied facts and produce a comparison report.',
  options: [
    {
      schemaVersion: 'comparison-option/v1',
      id: 'basic',
      label: 'Basic',
      facts: { price: 10, support: 'email' },
    },
    {
      schemaVersion: 'comparison-option/v1',
      id: 'pro',
      label: 'Pro',
      facts: { price: 25, support: 'priority' },
    },
  ],
})

if (process.env.WEB_BUDDY_STARTER_RUN === '1') {
  console.log(JSON.stringify(await runWebTask(input), null, 2))
}
