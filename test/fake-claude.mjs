#!/usr/bin/env node
// Faux `claude -p` pour les tests : écrit les fichiers attendus et répond en JSON.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'

let prompt = ''
process.stdin.on('data', (d) => (prompt += d))
process.stdin.on('end', () => {
  const args = process.argv.slice(2)
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt }) + '\n')

  mkdirSync('out', { recursive: true })
  let result
  if (prompt.startsWith('CONFIRMATION')) {
    writeFileSync('out/print.json', JSON.stringify({ status: 'sent', message: 'Impression lancée sur la P1S, environ 12 min', est_minutes: 12 }))
    result = 'Impression lancée.'
  } else {
    const big = prompt.includes('plus grand')
    writeFileSync('out/model.scad', 'cube([50,20,4]);\n')
    // PNG 1×1 valide
    writeFileSync('out/preview.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
    writeFileSync('out/job.json', JSON.stringify({
      title: 'Porte-clé AUSIM',
      summary: 'Plaque arrondie avec AUSIM en relief',
      size_mm: big ? [70, 28, 4] : [50, 20, 4],
      est_print_minutes: big ? 16 : 12,
      say: 'Voici ton porte-clé AUSIM. Je lance ?',
    }))
    result = 'Voici ton porte-clé.'
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: 'fake-session-1', total_cost_usd: 0.01 }))
})
