from pathlib import Path

path = Path('src/gemini.ts')
text = path.read_text(encoding='utf-8')

old = '''function errorToText(error: any) {
  const raw = error?.message ?? error
  if (typeof raw === 'string') return raw
  if (raw == null) return ''
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}
'''
new = '''function errorToText(error: any) {
  if (error == null) return ''
  if (typeof error === 'string') return error

  const parts: string[] = []
  const append = (value: any) => {
    if (value == null) return
    if (typeof value === 'string') {
      if (value.trim()) parts.push(value.trim())
      return
    }
    try {
      const serialized = JSON.stringify(value)
      if (serialized && serialized !== '{}') parts.push(serialized)
    } catch {
      const fallback = String(value)
      if (fallback && fallback !== '[object Object]') parts.push(fallback)
    }
  }

  append(error?.message)
  append(error?.code)
  append(error?.status)
  append(error?.statusText)
  append(error?.customData?.message)
  append(error?.customData?.serverResponse)
  append(error?.details)
  append(error?.cause?.message)
  append(error?.cause)

  if (!parts.length) {
    try {
      append(JSON.parse(JSON.stringify(error, Object.getOwnPropertyNames(error))))
    } catch {
      append(error)
    }
  }

  return [...new Set(parts)].join(' | ') || 'Falha desconhecida no Gemini.'
}
'''
if old not in text:
    raise SystemExit('errorToText block not found')
text = text.replace(old, new, 1)

old = '''function isBillingError(message: string) {
  return /prepayment credits are depleted|credits? (?:are )?depleted|insufficient credits?|account.*not active|payment required|billing account required|billing (?:is )?not enabled|no billing account|billing.*(?:disabled|inactive)/i.test(message)
}
'''
new = '''function isSpendCapError(message: string) {
  return /spend.?cap(?:\s+is)?\s+(?:breached|exceeded|reached)|spending.?limit.*(?:exceeded|reached)|generated spend cap|gasto máximo.*(?:atingido|excedido)|limite de gastos.*(?:atingido|excedido)/i.test(message)
}

function isBillingError(message: string) {
  return isSpendCapError(message) || /prepayment credits are depleted|credits? (?:are )?depleted|insufficient credits?|account.*not active|payment required|billing account required|billing (?:is )?not enabled|no billing account|billing.*(?:disabled|inactive)|billing.*limit.*(?:exceeded|reached)/i.test(message)
}
'''
if old not in text:
    raise SystemExit('isBillingError block not found')
text = text.replace(old, new, 1)

old = '''  // Crédito/faturamento explicitamente esgotado deve ser separado de 429/rate-limit.
  if (isBillingError(message)) {
    return new Error(
      'GEMINI_CREDIT_DEPLETED: o provedor informou falta de crédito ou faturamento indisponível para novas chamadas.'
    )
  }
'''
new = '''  // Spend cap é faturamento/limite financeiro, não configuração técnica do projeto.
  if (isSpendCapError(message)) {
    return new Error(
      'GEMINI_SPEND_CAP_REACHED: o limite de gastos da Gemini API/Firebase foi atingido. Aumente ou suspenda o spend cap no faturamento do projeto antes de tentar novamente.'
    )
  }

  // Crédito/faturamento explicitamente esgotado deve ser separado de 429/rate-limit.
  if (isBillingError(message)) {
    return new Error(
      'GEMINI_CREDIT_DEPLETED: o provedor informou falta de crédito ou faturamento indisponível para novas chamadas.'
    )
  }
'''
if old not in text:
    raise SystemExit('billing classification block not found')
text = text.replace(old, new, 1)

old = '''      console.error('[Processo 360 IA][Gemini]', {
        context,
        model: modelName,
        attempt,
        totalAttempts: models.length,
        message,
        error
      })
'''
new = '''      // Log textual para diagnóstico: evita o console exibir apenas "Object".
      console.error(
        `[Processo 360 IA][Gemini] context=${context} model=${modelName} attempt=${attempt}/${models.length} message=${message}`
      )
'''
if old not in text:
    raise SystemExit('console error block not found')
text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
print('v11 Gemini error patch applied')
