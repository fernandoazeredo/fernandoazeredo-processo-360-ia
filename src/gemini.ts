import { getGenerativeModel, Schema } from 'firebase/ai'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { PDFDocument } from 'pdf-lib'
import { aiClient, db } from './firebase'

export const CONSOLIDATION_MODEL = 'gemini-3.8-flash'
export const EXTRACTION_MODEL = 'gemini-3.5-flash-lite'
const EXTRACTION_MODELS = [
  EXTRACTION_MODEL,
  CONSOLIDATION_MODEL,
  'gemini-3.5-flash'
] as const
const CONSOLIDATION_MODELS = [
  CONSOLIDATION_MODEL,
  'gemini-3.5-flash',
  EXTRACTION_MODEL
] as const
const ARCHITECTURE_VERSION = 'blaze-browser-lots-v4-quality-prompts'
const MAX_LOT_PAGES = 80
const MAX_LOT_BYTES = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 90_000
const RETRY_DELAYS_MS = [3000, 7000]

export type GeminiAnalysisReport = {
  processNumber: string
  processNumberWarning?: string
  executiveSummary: string
  timeline: Array<{ date: string; event: string; reference: string }>
  claimsEvidenceDecisions: string
  globalAnalysis: string
  risks: Array<{ item: string; level: 'Alta' | 'Média' | 'Baixa'; basis: string }>
  conclusionStrategy: string
  sources: Array<{ lot: number; pages: string; note: string }>
}

type PromptDoc = {
  title?: string
  area?: string
  perspective?: string
  purpose?: string
  content?: string
  version?: number
  status?: string
}

type LotMeta = {
  number: number
  start: number
  end: number
  bytes: Uint8Array
}

type LotExtraction = {
  processNumber: string
  lotNumber: number
  pages: string
  synopsis: string
  timeline: Array<{ date: string; event: string; reference: string }>
  claims: string[]
  evidence: string[]
  decisions: string[]
  monetaryValues: string[]
  proceduralIssues: string[]
  favorablePoints: string[]
  adversePoints: string[]
  unresolvedQuestions: string[]
}

type ResumeState = {
  version: string
  model: string
  fileName: string
  fileSize: number
  lastModified: number
  area: string
  perspective: string
  lots: Record<string, LotExtraction>
}

const GLOBAL_RIGOR = `
PROCESSO 360 IA — PADRÃO GLOBAL DE RIGOR

1. Siga integralmente a estrutura e o formato exigidos pelo prompt específico.
2. Não inclua introdução, saudação, disclaimer genérico ou conteúdo fora do solicitado.
3. Baseie toda afirmação factual exclusivamente no material fornecido na chamada.
4. Nunca invente fatos, datas, valores, documentos, páginas, provas, decisões, precedentes ou probabilidades.
5. Preserve a área jurídica e a perspectiva informadas durante toda a execução.
6. Vincule cada fato, prova, data, valor ou decisão à referência de origem disponível.
7. Em lote isolado, extraia e catalogue; não antecipe conclusão global do processo.
8. Na consolidação, considere todos os lotes antes de concluir.
9. Sempre que um fato, folha, data, valor ou documento necessário não constar nos dados fornecidos, escreva exatamente: "Informação não constante nos dados fornecidos".
10. Para risco, probabilidade de êxito, solidez ou classificação equivalente, use exclusivamente: "Alta", "Média" ou "Baixa".
11. Identifique contradições, lacunas, duplicidades e limitações de prova.
12. Antes de entregar, verifique internamente completude, rastreabilidade e ausência de invenções.
13. Quando a data exata de um evento não constar, não invente a data. Use no campo date exatamente "Informação não constante nos dados fornecidos" e, somente se a relação temporal estiver claramente sustentada pelo contexto, registre no evento ou na referência uma "Inferência cronológica" objetiva (ex.: posterior à contestação de 12/03/2026), deixando explícito que se trata de inferência.
14. Valores monetários devem ser transcritos exatamente como constam no material, com sua natureza e referência sempre que identificáveis. Não calcule, complete ou estime valores ausentes.
15. Não invente súmulas, OJs, precedentes, números de julgados ou entendimentos jurisprudenciais. Só cite referência jurisprudencial específica quando ela constar nos dados fornecidos ou nos prompts jurídicos publicados.
`.trim()

const extractionSchema = Schema.object({
  properties: {
    processNumber: Schema.string(),
    lotNumber: Schema.integer(),
    pages: Schema.string(),
    synopsis: Schema.string(),
    timeline: Schema.array({
      items: Schema.object({
        properties: {
          date: Schema.string(),
          event: Schema.string(),
          reference: Schema.string()
        }
      })
    }),
    claims: Schema.array({ items: Schema.string() }),
    evidence: Schema.array({ items: Schema.string() }),
    decisions: Schema.array({ items: Schema.string() }),
    monetaryValues: Schema.array({ items: Schema.string() }),
    proceduralIssues: Schema.array({ items: Schema.string() }),
    favorablePoints: Schema.array({ items: Schema.string() }),
    adversePoints: Schema.array({ items: Schema.string() }),
    unresolvedQuestions: Schema.array({ items: Schema.string() })
  }
})

const reportSchema = Schema.object({
  properties: {
    processNumber: Schema.string(),
    executiveSummary: Schema.string(),
    timeline: Schema.array({
      items: Schema.object({
        properties: {
          date: Schema.string(),
          event: Schema.string(),
          reference: Schema.string()
        }
      })
    }),
    claimsEvidenceDecisions: Schema.string(),
    globalAnalysis: Schema.string(),
    risks: Schema.array({
      items: Schema.object({
        properties: {
          item: Schema.string(),
          level: Schema.enumString({ enum: ['Alta', 'Média', 'Baixa'] }),
          basis: Schema.string()
        }
      })
    }),
    conclusionStrategy: Schema.string(),
    sources: Schema.array({
      items: Schema.object({
        properties: {
          lot: Schema.integer(),
          pages: Schema.string(),
          note: Schema.string()
        }
      })
    })
  }
})

function sleep(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function isQuotaError(message: string) {
  return /429|resource.?exhausted|rate.?limit|quota|generate_content_free_tier_requests/i.test(message)
}

function isBillingError(message: string) {
  if (isQuotaError(message)) return false

  return /prepayment credits are depleted|account.*not active|payment required|billing account required|billing (?:is )?not enabled|no billing account|billing.*(?:disabled|inactive)/i.test(message)
}

function classifyGeminiError(error: any) {
  const message = String(error?.message || error || '')

  // Quota/rate-limit must be checked before any billing wording because
  // Google's 429 message can also contain "billing details".
  if (isQuotaError(message)) {
    return new Error(
      'GEMINI_RATE_LIMIT: o Gemini atingiu temporariamente um limite de requisições ou cota do serviço. Aguarde a liberação e retome a análise; os lotes já concluídos permanecem salvos neste navegador.'
    )
  }

  if (isBillingError(message)) {
    return new Error(
      'GEMINI_BILLING_STATE_MISMATCH: o Google retornou um erro específico de faturamento sem indicação de quota/rate-limit.'
    )
  }

  if (/401|app check token is invalid|appcheck/i.test(message)) {
    return new Error(
      'GEMINI_APP_CHECK_INVALID: o Firebase App Check rejeitou a chamada ao Gemini.'
    )
  }

  if (/GEMINI_REQUEST_TIMEOUT/i.test(message)) {
    return new Error(
      'GEMINI_REQUEST_TIMEOUT: o Gemini não respondeu dentro de 90 segundos. A análise foi interrompida sem perder os lotes já concluídos.'
    )
  }

  if (/404|model.*not.*(found|available)|unsupported model/i.test(message)) {
    return new Error(
      'GEMINI_MODEL_UNAVAILABLE: os modelos Gemini configurados não estão disponíveis para esta chamada no momento.'
    )
  }

  if (/500|503|high demand|temporarily unavailable|service unavailable|internal error/i.test(message)) {
    return new Error(
      'GEMINI_TEMPORARILY_BUSY: o serviço Gemini está temporariamente sobrecarregado. A análise pode ser retomada sem perder os lotes já concluídos.'
    )
  }

  return error instanceof Error ? error : new Error(message || 'Falha desconhecida no Gemini.')
}

function withTimeout<T>(promise: Promise<T>, modelName: string, context: string): Promise<T> {
  let timeoutId = 0

  const timeout = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(
        `GEMINI_REQUEST_TIMEOUT: ${context} excedeu 90 segundos no modelo ${modelName}.`
      ))
    }, REQUEST_TIMEOUT_MS)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId)
  })
}

async function generateContentWithFallback(
  contents: any,
  responseSchema: any,
  maxOutputTokens: number,
  context: string,
  models: readonly string[],
  onAttempt?: (modelName: string, attempt: number, total: number) => void
) {
  if (!aiClient) throw new Error('FIREBASE_AI_NOT_READY')

  let lastError: any

  for (let index = 0; index < models.length; index++) {
    const modelName = models[index]
    const attempt = index + 1
    onAttempt?.(modelName, attempt, models.length)

    const model = getGenerativeModel(aiClient, {
      model: modelName,
      systemInstruction: GLOBAL_RIGOR,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema,
        maxOutputTokens
      }
    })

    try {
      return await withTimeout(
        model.generateContent(contents),
        modelName,
        context
      )
    } catch (error: any) {
      lastError = error
      const message = String(error?.message || error || '')

      console.error('[Processo 360 IA][Gemini]', {
        context,
        model: modelName,
        attempt,
        totalAttempts: models.length,
        message,
        error
      })

      if (
        /401|app check token is invalid|appcheck/i.test(message) ||
        isBillingError(message) ||
        isQuotaError(message)
      ) {
        // 429/quota is not retried automatically: additional calls only
        // consume more of the Free Tier. Completed lots stay saved and
        // the user can resume later from the next unfinished lot.
        throw classifyGeminiError(error)
      }

      const retryable =
        /500|503|high demand|temporarily unavailable|service unavailable|internal error|GEMINI_REQUEST_TIMEOUT|404|model.*not.*(found|available)|unsupported model/i.test(message)

      if (!retryable || index >= models.length - 1) {
        throw classifyGeminiError(error)
      }

      await sleep(RETRY_DELAYS_MS[index] ?? 0)
    }
  }

  throw classifyGeminiError(lastError)
}

async function loadPublishedPrompts(area: string, perspective: string) {
  if (!db) return [] as PromptDoc[]

  const snap = await getDocs(query(collection(db, 'prompts'), where('status', '==', 'publicado')))
  const matching = snap.docs
    .map(item => item.data() as PromptDoc)
    .filter(item => item.area === area && item.perspective === perspective && item.content?.trim())

  const latestByPurpose = new Map<string, PromptDoc>()
  for (const prompt of matching) {
    const purpose = prompt.purpose || 'Prompt jurídico'
    const current = latestByPurpose.get(purpose)
    if (!current || (prompt.version || 0) > (current.version || 0)) {
      latestByPurpose.set(purpose, prompt)
    }
  }

  return [...latestByPurpose.values()]
}

function promptsToText(prompts: PromptDoc[], purposes?: string[]) {
  const selected = purposes?.length
    ? prompts.filter(prompt => prompt.purpose && purposes.includes(prompt.purpose))
    : prompts

  if (!selected.length) {
    return 'Execute análise jurídica conservadora, rastreável e estritamente limitada aos dados fornecidos.'
  }

  return selected
    .map(prompt => `### ${prompt.purpose || 'Prompt jurídico'} — ${prompt.title || 'Prompt'} — v${prompt.version || 1}\n${prompt.content}`)
    .join('\n\n')
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

async function createPdfLot(source: PDFDocument, start: number, endExclusive: number) {
  const target = await PDFDocument.create()
  const indexes = Array.from({ length: endExclusive - start }, (_, index) => start + index)
  const pages = await target.copyPages(source, indexes)
  pages.forEach(page => target.addPage(page))
  return new Uint8Array(await target.save())
}

async function splitPdfInBrowser(
  file: File,
  onProgress?: (value: number, stage: string) => void
): Promise<{ pageCount: number; lots: LotMeta[] }> {
  onProgress?.(6, 'Lendo o PDF localmente no navegador')
  const sourceBytes = await file.arrayBuffer()
  const source = await PDFDocument.load(sourceBytes, { ignoreEncryption: true })
  const pageCount = source.getPageCount()
  const lots: LotMeta[] = []

  let start = 0
  let lotNumber = 1

  while (start < pageCount) {
    let endExclusive = Math.min(start + MAX_LOT_PAGES, pageCount)
    let lotBytes = await createPdfLot(source, start, endExclusive)

    while (lotBytes.byteLength > MAX_LOT_BYTES && endExclusive - start > 1) {
      const currentPages = endExclusive - start
      const reducedPages = Math.max(1, Math.floor(currentPages * 0.7))
      endExclusive = start + reducedPages
      lotBytes = await createPdfLot(source, start, endExclusive)
    }

    lots.push({
      number: lotNumber,
      start: start + 1,
      end: endExclusive,
      bytes: lotBytes
    })

    start = endExclusive
    lotNumber += 1

    const splitProgress = 6 + Math.round((start / pageCount) * 8)
    onProgress?.(
      Math.min(14, splitProgress),
      `Dividindo o PDF localmente: ${Math.min(start, pageCount)} de ${pageCount} páginas preparadas`
    )
  }

  return { pageCount, lots }
}

function makeResumeKey(file: File, area: string, perspective: string) {
  return [
    'processo360',
    ARCHITECTURE_VERSION,
    CONSOLIDATION_MODEL,
    file.name,
    file.size,
    file.lastModified,
    area,
    perspective
  ].join('|')
}

function readResumeState(key: string): ResumeState | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as ResumeState : null
  } catch {
    return null
  }
}

function writeResumeState(key: string, state: ResumeState) {
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch (error) {
    console.warn('Processo 360 IA - não foi possível salvar retomada local', error)
  }
}

function clearResumeState(key: string) {
  try {
    localStorage.removeItem(key)
  } catch (error) {
    console.warn('Processo 360 IA - não foi possível limpar retomada local', error)
  }
}

function initialResumeState(file: File, area: string, perspective: string): ResumeState {
  return {
    version: ARCHITECTURE_VERSION,
    model: CONSOLIDATION_MODEL,
    fileName: file.name,
    fileSize: file.size,
    lastModified: file.lastModified,
    area,
    perspective,
    lots: {}
  }
}

function isValidLotExtraction(value: any): value is LotExtraction {
  return Boolean(
    value &&
    typeof value.processNumber === 'string' &&
    Number.isFinite(Number(value.lotNumber)) &&
    typeof value.pages === 'string' &&
    typeof value.synopsis === 'string' &&
    Array.isArray(value.timeline) &&
    Array.isArray(value.claims) &&
    Array.isArray(value.evidence) &&
    Array.isArray(value.decisions) &&
    Array.isArray(value.monetaryValues) &&
    Array.isArray(value.proceduralIssues) &&
    Array.isArray(value.favorablePoints) &&
    Array.isArray(value.adversePoints) &&
    Array.isArray(value.unresolvedQuestions)
  )
}

async function analyzeLot(
  lot: LotMeta,
  lotCount: number,
  area: string,
  perspective: string,
  prompts: PromptDoc[],
  onAttempt?: (stage: string) => void
): Promise<LotExtraction> {
  if (!aiClient) throw new Error('FIREBASE_AI_NOT_READY')

  const extractionInstructions = promptsToText(
    prompts,
    ['Preparação e leitura inicial', 'Extração por lote', 'Catalogação documental']
  )

  const instruction = `
Você está analisando um lote de um processo jurídico muito maior.

ÁREA: ${area}
PERSPECTIVA: ${perspective}
LOTE: ${lot.number} de ${lotCount}
PÁGINAS DO PDF ORIGINAL: ${lot.start}-${lot.end}

PROMPTS JURÍDICOS:
${extractionInstructions}

OBJETIVO:
Extraia e catalogue somente o que está efetivamente presente neste lote.
Não produza diagnóstico global, probabilidade final ou estratégia definitiva antes da consolidação de todos os lotes.
Mantenha referências de página/peça sempre que identificáveis.
- Em processNumber, extraia o número do processo (padrão CNJ, ex: 0000000-00.0000.0.00.0000) exatamente como consta neste lote. Se não constar neste lote, use exatamente: "Informação não constante nos dados fornecidos".
- Em timeline, use data exata apenas quando ela estiver expressamente identificada. Se a data exata não constar, use em date exatamente "Informação não constante nos dados fornecidos". Quando o contexto permitir estabelecer com segurança uma posição relativa, registre no event ou reference "Inferência cronológica: ..." e indique o evento/data que sustenta essa ordenação.
- Em monetaryValues, capture de forma individualizada todos os valores expressamente identificados, especialmente valor da causa, valor de cada pedido, condenação, acordo, depósito, custas, honorários e demais quantias relevantes. Para cada valor, informe sua natureza, a parte ou pedido relacionado e a referência de página/peça quando identificável. Não some, estime ou complete valores que não estejam expressos.
- Em claims, catalogue cada pedido ou pretensão separadamente quando isso for possível, preservando o vínculo com os respectivos valores, fundamentos, provas e decisões encontrados no lote.
- Se houver súmula, OJ, precedente ou entendimento jurisprudencial expressamente citado no lote ou nos prompts jurídicos fornecidos, preserve a referência com exatidão. Não crie nem complete referência jurisprudencial ausente.
O JSON deve respeitar exatamente o schema solicitado.
`.trim()

  const pdfPart = {
    inlineData: {
      data: bytesToBase64(lot.bytes),
      mimeType: 'application/pdf'
    }
  }

  const result = await generateContentWithFallback(
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
}

function isValidReport(value: any): value is GeminiAnalysisReport {
  return Boolean(
    value &&
    typeof value.processNumber === 'string' &&
    typeof value.executiveSummary === 'string' &&
    Array.isArray(value.timeline) &&
    typeof value.claimsEvidenceDecisions === 'string' &&
    typeof value.globalAnalysis === 'string' &&
    Array.isArray(value.risks) &&
    typeof value.conclusionStrategy === 'string' &&
    Array.isArray(value.sources)
  )
}

function getProcessNumberConsensus(lotResults: LotExtraction[]) {
  const missing = 'Informação não constante nos dados fornecidos'
  const values = lotResults
    .map(lot => lot.processNumber?.trim())
    .filter((value): value is string => Boolean(value && value !== missing))

  if (!values.length) {
    return {
      processNumber: missing,
      warning: undefined as string | undefined
    }
  }

  const counts = new Map<string, number>()
  const firstIndex = new Map<string, number>()

  values.forEach((value, index) => {
    counts.set(value, (counts.get(value) || 0) + 1)
    if (!firstIndex.has(value)) firstIndex.set(value, index)
  })

  const ranked = [...counts.entries()].sort((a, b) => {
    const countDiff = b[1] - a[1]
    if (countDiff !== 0) return countDiff
    return (firstIndex.get(a[0]) || 0) - (firstIndex.get(b[0]) || 0)
  })

  const processNumber = ranked[0][0]
  const warning = ranked.length > 1
    ? `Atenção: foram identificadas divergências no número do processo entre os lotes. Foi adotado o valor mais frequente: ${processNumber}. Valores encontrados: ${ranked.map(([value, count]) => `${value} (${count} lote${count === 1 ? '' : 's'})`).join('; ')}.`
    : undefined

  return { processNumber, warning }
}

async function consolidateLots(
  lotResults: LotExtraction[],
  lots: LotMeta[],
  file: File,
  pageCount: number,
  area: string,
  perspective: string,
  prompts: PromptDoc[],
  onAttempt?: (stage: string) => void
): Promise<GeminiAnalysisReport> {
  if (!aiClient) throw new Error('FIREBASE_AI_NOT_READY')

  const finalInstructions = promptsToText(
    prompts,
    [
      'Linha do tempo processual',
      'Confronto de alegações e provas',
      'Análise jurídica global',
      'Cenário percentual de risco',
      'Relatório final'
    ]
  )

  const {
    processNumber: consolidatedProcessNumber,
    warning: processNumberWarning
  } = getProcessNumberConsensus(lotResults)

  const instruction = `
Produza o RELATÓRIO JURÍDICO FINAL do Processo 360 IA somente após considerar TODOS os lotes abaixo.

ARQUIVO: ${file.name}
ÁREA: ${area}
PERSPECTIVA: ${perspective}
TOTAL DE PÁGINAS: ${pageCount}
TOTAL DE LOTES: ${lots.length}

PROMPTS JURÍDICOS DE CONSOLIDAÇÃO:
${finalInstructions}

REGRAS OBRIGATÓRIAS:
- Considere todos os ${lots.length} lotes antes de concluir.
- Confronte alegações, provas, decisões, valores e eventos entre lotes.
- Identifique contradições, duplicidades, lacunas e pontos não comprovados.
- Não invente fatos, páginas, documentos, datas, valores ou precedentes.
- Quando faltar informação necessária, use exatamente: "Informação não constante nos dados fornecidos".
- Em risks.level use exclusivamente Alta, Média ou Baixa.
- Em risks.basis, justifique cada risco com elementos concretos dos lotes: prova existente ou ausente, distribuição do ônus probatório, decisão já proferida, contradição, documento faltante e exposição monetária expressamente identificada. Não crie percentual numérico de êxito ou condenação.
- Na linha do tempo final, não invente datas. Quando um evento não tiver data exata, mantenha em date exatamente "Informação não constante nos dados fornecidos" e utilize relações temporais inferidas apenas quando sustentadas pelos lotes, identificando-as expressamente como "Inferência cronológica".
- Em claimsEvidenceDecisions, consolide separadamente o valor da causa e o valor de cada pedido quando constarem dos lotes, eliminando duplicidades e preservando a referência documental. Não estime quantias ausentes.
- Ao mencionar legislação, súmulas, OJs ou jurisprudência, utilize somente referências específicas presentes nos lotes ou nos prompts jurídicos publicados. Não invente número, tribunal, enunciado ou precedente. Se a referência específica não estiver disponível, exponha a questão jurídica sem fabricar citação.
- Em conclusionStrategy, além da conclusão jurídica, apresente de 2 a 3 próximos passos práticos e objetivos coerentes com a perspectiva informada, vinculando cada ação a uma lacuna, prova, pedido ou risco identificado nos lotes (por exemplo: juntar documento já mencionado, requerer prova/perícia pertinente ou impugnar ponto documentalmente identificado). Não recomende medida sem suporte nos dados processados.
- Entregue exatamente as 8 seções representadas no JSON.
- Em processNumber, use o valor consolidado já determinado pelo sistema a partir do número mais frequente entre os lotes válidos. Em caso de empate, prevalece o valor que apareceu primeiro. Se nenhum lote tiver essa informação, use exatamente: "Informação não constante nos dados fornecidos".
- O valor consolidado já determinado pelo sistema é: "${consolidatedProcessNumber}".
- Em sources, haverá uma entrada por lote efetivamente considerado.

DADOS ESTRUTURADOS DE TODOS OS LOTES:
${JSON.stringify(lotResults)}
`.trim()

  const result = await generateContentWithFallback(
    instruction,
    reportSchema,
    24576,
    'consolidação final',
    CONSOLIDATION_MODELS,
    (_modelName, attempt, total) => {
      onAttempt?.(
        `Consolidação final — tentativa ${attempt} de ${total}`
      )
    }
  )
  const text = result.response.text()

  if (!text?.trim()) throw new Error('GEMINI_EMPTY_FINAL_RESPONSE')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('GEMINI_INVALID_FINAL_JSON')
  }

  if (!isValidReport(parsed)) {
    throw new Error('GEMINI_INVALID_FINAL_SCHEMA')
  }

  parsed.processNumber = consolidatedProcessNumber
  parsed.processNumberWarning = processNumberWarning

  parsed.sources = lots.map(lot => ({
    lot: lot.number,
    pages: `${lot.start}-${lot.end}`,
    note: `Lote ${lot.number} de ${lots.length} efetivamente processado na consolidação.`
  }))

  return parsed
}

export async function analyzePdfWithGemini(
  file: File,
  area: string,
  perspective: string,
  onProgress?: (value: number, stage: string) => void
): Promise<GeminiAnalysisReport> {
  if (!aiClient) throw new Error('FIREBASE_AI_NOT_READY')

  onProgress?.(3, 'Preparando análise no navegador')
  const prompts = await loadPublishedPrompts(area, perspective)

  const { pageCount, lots } = await splitPdfInBrowser(file, onProgress)
  if (!lots.length) throw new Error('PDF_SEM_PAGINAS')

  const resumeKey = makeResumeKey(file, area, perspective)
  const existing = readResumeState(resumeKey)
  const resume =
    existing &&
    existing.version === ARCHITECTURE_VERSION &&
    existing.model === CONSOLIDATION_MODEL &&
    existing.fileSize === file.size &&
    existing.lastModified === file.lastModified
      ? existing
      : initialResumeState(file, area, perspective)

  const lotResults: LotExtraction[] = new Array(lots.length)

  for (const lot of lots) {
    const saved = resume.lots[String(lot.number)]
    if (saved && saved.pages === `${lot.start}-${lot.end}` && isValidLotExtraction(saved)) {
      lotResults[lot.number - 1] = saved
      const restoredProgress = 15 + Math.round((lot.number / lots.length) * 65)
      onProgress?.(
        restoredProgress,
        `Retomando análise: lote ${lot.number} de ${lots.length} recuperado do navegador`
      )
      continue
    }

    const beforeProgress = 15 + Math.round(((lot.number - 1) / lots.length) * 65)
    onProgress?.(
      beforeProgress,
      `Analisando lote ${lot.number} de ${lots.length}`
    )

    const extraction = await analyzeLot(
      lot,
      lots.length,
      area,
      perspective,
      prompts,
      stage => onProgress?.(beforeProgress, stage)
    )

    lotResults[lot.number - 1] = extraction
    resume.lots[String(lot.number)] = extraction
    writeResumeState(resumeKey, resume)

    const afterProgress = 15 + Math.round((lot.number / lots.length) * 65)
    onProgress?.(
      afterProgress,
      `Lote ${lot.number} de ${lots.length} concluído e salvo para retomada`
    )
  }

  onProgress?.(84, `Consolidando os ${lots.length} lotes do processo`)
  const report = await consolidateLots(
    lotResults,
    lots,
    file,
    pageCount,
    area,
    perspective,
    prompts,
    stage => onProgress?.(84, stage)
  )

  clearResumeState(resumeKey)
  onProgress?.(100, 'Relatório jurídico consolidado concluído')
  return report
}
