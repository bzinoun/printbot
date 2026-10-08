#!/usr/bin/env node
// Faux `claude -p` pour les tests d'intégration : même contrat que le vrai
// (prompt sur stdin, JSON sur stdout, fichiers dans out/), aperçu PNG réaliste.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'

let prompt = ''
process.stdin.on('data', (d) => (prompt += d))
process.stdin.on('end', async () => {
  const args = process.argv.slice(2)
  if (process.env.FAKE_CLAUDE_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt, cwd: process.cwd(), hasInput: existsSync('input.jpg') }) + '\n')
  }
  mkdirSync('out', { recursive: true })
  let result
  if (prompt.startsWith('CONFIRMATION')) {
    const fail = process.env.FAKE_PRINT_FAIL === '1'
    writeFileSync(
      'out/print.json',
      JSON.stringify(fail ? { status: 'error', message: 'Imprimante hors ligne' } : { status: 'sent', message: 'Impression lancée sur l’A1 mini', est_minutes: 12 }),
    )
    result = fail ? 'Échec.' : 'Impression lancée.'
  } else {
    const big = /plus grand/i.test(prompt)
    // Aperçu comme OpenSCAD : PNG 1080×1080 opaque
    const png = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: '#1d1f21' } })
      .composite([{ input: { create: { width: big ? 700 : 500, height: 200, channels: 3, background: '#81a2be' } }, gravity: 'center' }])
      .png()
      .toBuffer()
    writeFileSync('out/preview.png', png)
    writeFileSync('out/model.scad', `cube([${big ? 70 : 50},20,4]);\n`)
    writeFileSync(
      'out/job.json',
      JSON.stringify({
        title: 'Porte-clé AUSIM',
        summary: 'Plaque arrondie avec AUSIM en relief',
        size_mm: big ? [70, 28, 4] : [50, 20, 4],
        est_print_minutes: 12,
        say: big ? 'Voilà, je l’ai agrandi. Je lance ?' : 'Voici ton porte-clé AUSIM. Je lance ?',
      }),
    )
    result = 'Voici ton porte-clé.'
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: 'sess-int-1', total_cost_usd: 0.01 }))
})
