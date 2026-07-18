const MESSAGE = '[deprecated] job-agent-web is a recruiting compatibility alias. Use web-agent-web and the generic Web Task API for new integrations.'

console.warn(MESSAGE)

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log('Usage: job-agent-web (deprecated compatibility alias for web-agent-web)')
} else {
  process.env.WEB_BUDDY_COMPAT_WRAPPER = '1'
  const { startWebControlServer } = await import('./server.js')
  delete process.env.WEB_BUDDY_COMPAT_WRAPPER
  const explicitPort = Boolean(process.env.PORT)
  const initialPort = Number(process.env.PORT || 5178)
  let control: Awaited<ReturnType<typeof startWebControlServer>> | undefined
  void startWebControlServer(initialPort, explicitPort ? 0 : 20).then((started) => {
    control = started
  })
  const shutdown = () => {
    if (!control) return process.exit(0)
    void control.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
