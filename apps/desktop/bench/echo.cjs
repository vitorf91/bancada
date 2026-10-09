// A tiny raw-mode echo program for the terminal-grid bench: every key typed comes straight back, like a shell
// echoing at its prompt. Every 40 characters it clears the line first, so the echoed glyph is always the last
// character before the cursor on the same row (the bench finds it there). Runs under Electron's node mode.
const stdin = process.stdin
const stdout = process.stdout

if (stdin.isTTY) stdin.setRawMode(true)
stdin.resume()
stdout.write('echo ready\r\n')

let count = 0
stdin.on('data', (chunk) => {
  let out = ''
  for (const ch of chunk.toString('utf8')) {
    if (ch === '\x03' || ch === '\x04') process.exit(0)
    if (count % 40 === 0) out += '\x1b[2K\r'
    out += ch
    count++
  }
  stdout.write(out)
})
