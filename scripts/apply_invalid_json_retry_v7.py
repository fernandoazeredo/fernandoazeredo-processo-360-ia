from pathlib import Path

p = Path('src/gemini.ts')
text = p.read_text(encoding='utf-8')

text = text.replace(
"const ARCHITECTURE_VERSION = 'blaze-browser-lots-v6-legal-finish'",
"const ARCHITECTURE_VERSION = 'blaze-browser-lots-v7-json-retry'"
)

old = '''  const result = await generateContentWithFallback(
    [instruction, pdfPart],
    extractionSchema,
    8192,
    `lote ${lot.number} de ${lotCount}`,
    EXTRACTION_MODELS,
    (_modelName, attempt, total) => {
      onAttempt?.(
        `Lote ${lot.number} de ${lotCount} — tentativa ${attempt} de ${total}`
      )
    }
  )
  const text = result.response.text()

  if (!text?.trim()) throw new Error(`GEMINI_EMPTY_RESPONSE_LOT_${lot.number}`)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`GEMINI_INVALID_JSON_LOT_${lot.number}`)
  }

  if (!isValidLotExtraction(parsed)) {
    throw new Error(`GEMINI_INVALID_SCHEMA_LOT_${lot.number}`)
  }

  parsed.lotNumber = lot.number
  parsed.pages = `${lot.start}-${lot.end}`
  return parsed
'''

new = '''  const structuredAttempts = 2
  let lastStructuredError: Error | null = null

  for (let structuredAttempt = 1; structuredAttempt <= structuredAttempts; structuredAttempt++) {
    const retryInstruction = structuredAttempt === 1
      ? instruction
      : `${instruction}\\n\\nCORREÇÃO DE FORMATO — TENTATIVA FINAL:\\nA resposta anterior não pôde ser interpretada como JSON válido. Responda novamente de forma mais concisa, SOMENTE com o objeto JSON exigido pelo schema, sem markdown, sem cercas de código, sem comentários antes/depois e sem texto fora do JSON. Preserve os fatos relevantes, mas evite repetição textual dentro dos arrays.`

    const result = await generateContentWithFallback(
      [retryInstruction, pdfPart],
      extractionSchema,
      16384,
      `lote ${lot.number} de ${lotCount} — formato ${structuredAttempt}/${structuredAttempts}`,
      EXTRACTION_MODELS,
      (_modelName, attempt, total) => {
        onAttempt?.(
          `Lote ${lot.number} de ${lotCount} — formato ${structuredAttempt}/${structuredAttempts} — tentativa ${attempt} de ${total}`
        )
      }
    )
    const responseText = result.response.text()

    if (!responseText?.trim()) {
      lastStructuredError = new Error(`GEMINI_EMPTY_RESPONSE_LOT_${lot.number}`)
      console.warn('[Processo 360 IA][Gemini][StructuredOutput]', {
        lot: lot.number,
        structuredAttempt,
        reason: 'empty-response'
      })
    } else {
      let parsed: unknown
      try {
        parsed = JSON.parse(responseText)
      } catch (parseError) {
        lastStructuredError = new Error(`GEMINI_INVALID_JSON_LOT_${lot.number}`)
        console.warn('[Processo 360 IA][Gemini][StructuredOutput]', {
          lot: lot.number,
          structuredAttempt,
          reason: 'invalid-json',
          responseLength: responseText.length,
          responseStart: responseText.slice(0, 500),
          responseEnd: responseText.slice(-500),
          parseError
        })
        parsed = undefined
      }

      if (parsed !== undefined) {
        if (isValidLotExtraction(parsed)) {
          parsed.lotNumber = lot.number
          parsed.pages = `${lot.start}-${lot.end}`
          return parsed
        }

        lastStructuredError = new Error(`GEMINI_INVALID_SCHEMA_LOT_${lot.number}`)
        console.warn('[Processo 360 IA][Gemini][StructuredOutput]', {
          lot: lot.number,
          structuredAttempt,
          reason: 'invalid-schema',
          responseLength: responseText.length,
          keys: parsed && typeof parsed === 'object' ? Object.keys(parsed as Record<string, unknown>) : []
        })
      }
    }

    if (structuredAttempt < structuredAttempts) {
      onAttempt?.(`Lote ${lot.number} de ${lotCount} — resposta estruturada inválida; nova tentativa automática`)
      await sleep(1200)
    }
  }

  throw lastStructuredError || new Error(`GEMINI_INVALID_JSON_LOT_${lot.number}`)
'''

if old not in text:
    raise SystemExit('Trecho analyzeLot esperado não foi encontrado; patch abortado.')
text = text.replace(old, new, 1)
p.write_text(text, encoding='utf-8')

Path('scripts/apply_invalid_json_retry_v7.py').unlink(missing_ok=True)
Path('.github/workflows/apply-invalid-json-retry-v7.yml').unlink(missing_ok=True)
