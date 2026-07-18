const MESSAGE = '[deprecated] job-agent is a recruiting compatibility alias. Use web-agent and the public runWebTask() SDK for new integrations.'

console.warn(MESSAGE)
await import('./demo.js')
