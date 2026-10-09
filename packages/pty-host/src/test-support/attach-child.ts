// Runs as its own process in the SIGKILL test: attaches to a session and prints "attached" once it holds a snapshot.
import { PtyClient } from '../client.js'

async function main(): Promise<void> {
  const [socketPath, id] = process.argv.slice(2)
  if (!socketPath || !id) throw new Error('usage: attach-child <socket> <session id>')
  const client = await PtyClient.connect({ socketPath, clientName: 'attach-child' })
  await client.attach(id, () => {})
  process.stdout.write('attached\n')
  setInterval(() => {}, 1000)
}

void main()
