from pathlib import Path


def patch(path, old, new, count=1):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if text.count(old) < count:
        raise SystemExit(f'{path}: trecho não encontrado: {old[:140]}')
    p.write_text(text.replace(old, new, count), encoding='utf-8')

# ===== Gemini: lotes menores, timeout maior e somente modelo comprovadamente funcional =====
patch('src/gemini.ts', "const EXTRACTION_MODELS = [\n  EXTRACTION_MODEL,\n  'gemini-3.5-flash',\n  'gemini-3.5-flash-lite'\n] as const", "const EXTRACTION_MODELS = [EXTRACTION_MODEL] as const")
patch('src/gemini.ts', "const CONSOLIDATION_MODELS = [\n  CONSOLIDATION_MODEL,\n  'gemini-3.5-flash',\n  'gemini-3.5-flash-lite'\n] as const", "const CONSOLIDATION_MODELS = [CONSOLIDATION_MODEL] as const")
patch('src/gemini.ts', "const ARCHITECTURE_VERSION = 'blaze-browser-lots-v7-json-retry'", "const ARCHITECTURE_VERSION = 'blaze-browser-lots-v8-timeout-model-errors-values'")
patch('src/gemini.ts', 'const MAX_LOT_PAGES = 80', 'const MAX_LOT_PAGES = 60')
patch('src/gemini.ts', 'const REQUEST_TIMEOUT_MS = 90_000', 'const REQUEST_TIMEOUT_MS = 210_000')

# ===== Erros: transformar objetos do SDK em texto legível =====
patch('src/gemini.ts', "function isQuotaError(message: string) {", '''function errorToText(error: any) {
  const raw = error?.message ?? error
  if (typeof raw === 'string') return raw
  if (raw == null) return ''
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

function isQuotaError(message: string) {''')

# Faturamento/crédito esgotado precisa ser distinguido de 429 genérico.
patch('src/gemini.ts', '''function isBillingError(message: string) {
  if (isQuotaError(message)) return false

  return /prepayment credits are depleted|account.*not active|payment required|billing account required|billing (?:is )?not enabled|no billing account|billing.*(?:disabled|inactive)/i.test(message)
}''', '''function isBillingError(message: string) {
  return /prepayment credits are depleted|credits? (?:are )?depleted|insufficient credits?|account.*not active|payment required|billing account required|billing (?:is )?not enabled|no billing account|billing.*(?:disabled|inactive)/i.test(message)
}''')
patch('src/gemini.ts', "  const message = String(error?.message || error || '')\n\n  // Quota/rate-limit must be checked before any billing wording because\n  // Google's 429 message can also contain \"billing details\".\n  if (isQuotaError(message)) {", "  const message = errorToText(error)\n\n  // Crédito/faturamento explicitamente esgotado deve ser separado de 429/rate-limit.\n  if (isBillingError(message)) {\n    return new Error(\n      'GEMINI_CREDIT_DEPLETED: o provedor informou falta de crédito ou faturamento indisponível para novas chamadas.'\n    )\n  }\n\n  if (isQuotaError(message)) {")
# Remove o bloco billing antigo que ficou abaixo do quota.
patch('src/gemini.ts', '''
  if (isBillingError(message)) {
    return new Error(
      'GEMINI_BILLING_STATE_MISMATCH: o Google retornou um erro específico de faturamento sem indicação de quota/rate-limit.'
    )
  }
''', '\n')
patch('src/gemini.ts', "        `GEMINI_REQUEST_TIMEOUT: ${context} excedeu 90 segundos no modelo ${modelName}.`", "        `GEMINI_REQUEST_TIMEOUT: ${context} excedeu 210 segundos no modelo ${modelName}.`")
patch('src/gemini.ts', "      const message = String(error?.message || error || '')", "      const message = errorToText(error)")

# Não usar fallback incompatível. 403 de credencial/configuração deve virar erro claro.
patch('src/gemini.ts', "  if (/401|app check token is invalid|appcheck/i.test(message)) {", "  if (/403|valid api key|gcp project is required|permission denied/i.test(message)) {\n    return new Error(\n      'GEMINI_PROJECT_CONFIGURATION: o modelo/chamada foi recusado pela configuração do projeto Firebase/Google Cloud.'\n    )\n  }\n\n  if (/401|app check token is invalid|appcheck/i.test(message)) {")
patch('src/gemini.ts', "        /401|app check token is invalid|appcheck/i.test(message) ||\n        isBillingError(message) ||\n        isQuotaError(message)", "        /401|403|app check token is invalid|appcheck|valid api key|gcp project is required|permission denied/i.test(message) ||\n        isBillingError(message) ||\n        isQuotaError(message)")

# ===== Relatório: barreira determinística contra valores/percentuais derivados =====
insert_anchor = "function getProcessNumberConsensus(lotResults: LotExtraction[]) {"
insert = r'''function normalizeQuantityToken(value: string) {
  return value.toLowerCase().replace(/\s+/g, '').replace(/\./g, '').replace(',', '.')
}

function literalQuantityTokens(lotResults: LotExtraction[]) {
  const source = JSON.stringify(lotResults)
  const matches = source.match(/R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\b\d+(?:[.,]\d+)?\s*%/gi) || []
  return new Set(matches.map(normalizeQuantityToken))
}

function removeUnsupportedDerivedQuantities(report: GeminiAnalysisReport, lotResults: LotExtraction[]) {
  const allowed = literalQuantityTokens(lotResults)
  const quantityPattern = /R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\b\d+(?:[.,]\d+)?\s*%/gi
  const clean = (value: string) => String(value || '').replace(quantityPattern, token =>
    allowed.has(normalizeQuantityToken(token))
      ? token
      : '[QUANTIA DERIVADA REMOVIDA — não consta literalmente nos lotes]'
  )

  report.executiveSummary = clean(report.executiveSummary)
  report.claimsEvidenceDecisions = clean(report.claimsEvidenceDecisions)
  report.globalAnalysis = clean(report.globalAnalysis)
  report.conclusionStrategy = clean(report.conclusionStrategy)
  report.timeline = report.timeline.map(item => ({ ...item, event: clean(item.event), reference: clean(item.reference) }))
  report.risks = report.risks.map(item => ({ ...item, item: clean(item.item), basis: clean(item.basis) }))
  return report
}

'''
patch('src/gemini.ts', insert_anchor, insert + insert_anchor)
patch('src/gemini.ts', "  parsed.processNumber = consolidatedProcessNumber\n  parsed.processNumberWarning = processNumberWarning", "  parsed.processNumber = consolidatedProcessNumber\n  parsed.processNumberWarning = processNumberWarning\n  removeUnsupportedDerivedQuantities(parsed, lotResults)")

# ===== Tela: mensagens específicas, sem [object Object] =====
patch('src/App.tsx', "      const message = String(error?.message || '')\n      console.error('[Processo 360 IA] Falha na análise', error)", '''      const rawMessage = error?.message ?? error
      let message = ''
      if (typeof rawMessage === 'string') message = rawMessage
      else {
        try { message = JSON.stringify(rawMessage) }
        catch { message = String(rawMessage || '') }
      }
      console.error('[Processo 360 IA] Falha na análise', message, error)''')
patch('src/App.tsx', "      } else if (message.includes('GEMINI_BILLING_STATE_MISMATCH')) {\n        setAnalysisError('O Google retornou um estado de faturamento inconsistente para o projeto. Verifique o faturamento do Firebase/Google Cloud e tente novamente.')", "      } else if (message.includes('GEMINI_CREDIT_DEPLETED')) {\n        setAnalysisError('O crédito/faturamento do provedor de IA não está disponível para concluir a análise. Regularize ou renove o crédito do Google/Firebase antes de tentar novamente.')\n      } else if (message.includes('GEMINI_BILLING_STATE_MISMATCH')) {\n        setAnalysisError('O Google retornou um estado de faturamento inconsistente para o projeto. Verifique o faturamento do Firebase/Google Cloud e tente novamente.')")
patch('src/App.tsx', "        setAnalysisError('O Gemini está temporariamente com alta demanda. Foram feitas tentativas com os modelos de fallback configurados. Tente novamente; os lotes concluídos ficaram salvos para retomada.')", "        setAnalysisError('O Gemini está temporariamente com alta demanda. Tente novamente mais tarde; os lotes concluídos ficaram salvos para retomada.')")
patch('src/App.tsx', "        setAnalysisError('O Gemini não respondeu dentro do limite de 90 segundos por tentativa. Tente novamente; os lotes já concluídos foram preservados.')", "        setAnalysisError('O Gemini não respondeu dentro do limite de 210 segundos. O lote em andamento não foi concluído; os lotes anteriores já finalizados permanecem salvos para retomada.')")
patch('src/App.tsx', "      } else if (message.includes('GEMINI_MODEL_UNAVAILABLE')) {", "      } else if (message.includes('GEMINI_PROJECT_CONFIGURATION')) {\n        setAnalysisError('A chamada ao Gemini foi recusada pela configuração do projeto Firebase/Google Cloud. Nenhum modelo alternativo incompatível será usado automaticamente.')\n      } else if (message.includes('GEMINI_MODEL_UNAVAILABLE')) {")

# Temporários não seguem para main.
Path('scripts/apply_v8.py').unlink(missing_ok=True)
Path('.github/workflows/apply-v8.yml').unlink(missing_ok=True)
