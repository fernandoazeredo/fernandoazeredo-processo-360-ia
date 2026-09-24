import { getGenerativeModel, Schema } from 'firebase/ai'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { PDFDocument } from 'pdf-lib'
import { aiClient, db } from './firebase'

export const FREE_TIER_MODEL = 'gemini-3.8-flash'
const ARCHITECTURE_VERSION = 'free-tier-browser-lots-v1'
const MAX_LOT_PAGES = 80
const MAX_LOT_BYTES = 8 * 1024 * 1024
const RETRY_DELAYS_MS = [15000, 30000, 60000, 120000]

export type GeminiAnalysisReport = {
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
`.trim()

const extractionSchema = Schema.object({
  properties: {
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

function classifyGeminiError(error: any) {
  const message = String(error?.message || error || '')

  if (/prepayment credits are depleted|billing|payment|account.*not active/i.test(message)) {
    return new Error(
      'GEMINI_FREE_TIER_NOT_ACTIVE: este projeto ainda está vinculado a faturamento pago. Para usar a faixa gratuita, deixe o projeto Firebase no plano Spark sem conta de faturamento vinculada.'
    )
  }

  if (/500|503|high demand|temporarily unavailable|service unavailable|internal error/i.test(message)) {
    return new Error(
      'GEMINI_TEMPORARILY_BUSY: o serviço Gemini está temporariamente sobrecarregado. A análise pode ser retomada sem perder os lotes já concluídos.'
    )
  }

  if (/429|resource.?exhausted|rate.?limit|quota/i.test(message)) {
    return new Error(
      'GEMINI_FREE_TIER_LIMIT: o limite gratuito do Gemini foi atingido temporariamente. Aguarde a renovação da cota e retome a análise; os lotes já concluídos permanecem salvos neste navegador.'
    )
  }

  return error instanceof Error ? error : new Error(message || 'Falha desconhecida no Gemini.')
}

async function withFreeTierRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: any

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await operation()
    } catch (error: any) {
      lastError = error
      const message = String(error?.message || error || '')

      if (/prepayment credits are depleted|billing|payment|account.*not active/i.test(message)) {
        throw classifyGeminiError(error)
      }

      const retryable =
        /429|resource.?exhausted|rate.?limit|quota|500|503|high demand|temporarily unavailable|service unavailable|internal error/i.test(message)
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
        throw classifyGeminiError(error)
      }

      await sleep(RETRY_DELAYS_MS[attempt])
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
    FREE_TIER_MODEL,
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

function initialResumeState(file: File, area: string, perspective: string): ResumeState {
  return {
    version: ARCHITECTURE_VERSION,
    model: FREE_TIER_MODEL,
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
  prompts: PromptDoc[]
): Promise<LotExtraction> {
  if (!aiClient) throw new Error('FIREBASE_AI_NOT_READY')

  const model = getGenerativeModel(aiClient, {
    model: FREE_TIER_MODEL,
    systemInstruction: GLOBAL_RIGOR,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: extractionSchema,
      maxOutputTokens: 8192
    }
  })

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
O JSON deve respeitar exatamente o schema solicitado.
`.trim()

  const pdfPart = {
    inlineData: {
      data: bytesToBase64(lot.bytes),
      mimeType: 'application/pdf'
    }
  }

  const result = await withFreeTierRetry(() => model.generateContent([instruction, pdfPart]))
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
    typeof value.executiveSummary === 'string' &&
    Array.isArray(value.timeline) &&
    typeof value.claimsEvidenceDecisions === 'string' &&
    typeof value.globalAnalysis === 'string' &&
    Array.isArray(value.risks) &&
    typeof value.conclusionStrategy === 'string' &&
    Array.isArray(value.sources)
  )
}

async function consolidateLots(
  lotResults: LotExtraction[],
  lots: LotMeta[],
  file: File,
  pageCount: number,
  area: string,
  perspective: string,
  prompts: PromptDoc[]
): Promise<GeminiAnalysisReport> {
  if (!aiClient) throw new Error('FIREBASE_AI_NOT_READY')

  const model = getGenerativeModel(aiClient, {
    model: FREE_TIER_MODEL,
    systemInstruction: GLOBAL_RIGOR,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: reportSchema,
      maxOutputTokens: 32768
    }
  })

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
- Entregue exatamente as 7 seções representadas no JSON.
- Em sources, haverá uma entrada por lote efetivamente considerado.

DADOS ESTRUTURADOS DE TODOS OS LOTES:
${JSON.stringify(lotResults)}
`.trim()

  const result = await withFreeTierRetry(() => model.generateContent(instruction))
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

  parsed.sources = lots.map(lot => ({
    lot: lot.number,
    pages: `${lot.start}-${lot.end}`,
    note: `Lote ${lot.number} de ${lots.length} efetivamente processado na consolidação.`
  }))

  return parsed
}

export async function analyzePdfWithGeminiFreeTier(
  file: File,
  area: string,
  perspective: string,
  onProgress?: (value: number, stage: string) => void
): Promise<GeminiAnalysisReport> {
  if (!aiClient) throw new Error('FIREBASE_AI_NOT_READY')

  onProgress?.(3, 'Preparando análise gratuita no navegador')
  const prompts = await loadPublishedPrompts(area, perspective)

  const { pageCount, lots } = await splitPdfInBrowser(file, onProgress)
  if (!lots.length) throw new Error('PDF_SEM_PAGINAS')

  const resumeKey = makeResumeKey(file, area, perspective)
  const existing = readResumeState(resumeKey)
  const resume =
    existing &&
    existing.version === ARCHITECTURE_VERSION &&
    existing.model === FREE_TIER_MODEL &&
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
      `Analisando lote ${lot.number} de ${lots.length} com ${FREE_TIER_MODEL}`
    )

    const extraction = await analyzeLot(
      lot,
      lots.length,
      area,
      perspective,
      prompts
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
    prompts
  )

  onProgress?.(100, 'Relatório jurídico consolidado concluído')
  return report
}
