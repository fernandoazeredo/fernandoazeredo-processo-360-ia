import { getGenerativeModel, Schema } from 'firebase/ai'
import { PDFDocument } from 'pdf-lib'
import { aiClient } from './firebase'
import type { AnalysisReport } from './ai'

const PIECE_MODEL = 'gemini-3.8-flash'
const PIECE_FALLBACK_MODELS = [PIECE_MODEL, 'gemini-3.5-flash', 'gemini-3.5-flash-lite'] as const
const REQUEST_TIMEOUT_MS = 90_000
const PLACEHOLDER = '[INFORMAÇÃO A SER CONFIRMADA PELO ADVOGADO]'

export type ClaimStatus = 'CONFIRMADA' | 'PARCIALMENTE CONFIRMADA' | 'NÃO CONFIRMADA' | 'CONFLITANTE'

export type PieceSection = {
  title: string
  content: string
}

export type PieceClaim = {
  id: string
  text: string
  type: string
  status: ClaimStatus
  sourceReference: string
  treatment: string
}

export type LegalPieceDraft = {
  pieceType: string
  title: string
  sections: PieceSection[]
  claims: PieceClaim[]
  validation: {
    confirmed: number
    partiallyConfirmed: number
    unconfirmed: number
    conflicting: number
  }
  model: string
  promptVersion: string
}

const DRAFT_PROMPT_VERSION = '2026-09-25-piece-v1'
const VALIDATION_PROMPT_VERSION = '2026-09-25-fact-validation-v1'

const pieceMapping: Record<string, Record<string, string>> = {
  Trabalhista: {
    Reclamante: 'Petição Inicial',
    Reclamada: 'Contestação / Defesa'
  },
  Cível: {
    Autor: 'Petição Inicial',
    Réu: 'Contestação'
  },
  Criminal: {
    Acusação: 'Denúncia',
    Defesa: 'Defesa Prévia / Resposta à Acusação'
  },
  Ambiental: {
    'Autuado / Réu': 'Defesa / Impugnação',
    'Órgão Ambiental / MP': 'Auto de Infração / Petição'
  },
  Tributário: {
    Contribuinte: 'Impugnação / Defesa',
    'Fazenda Pública': 'Petição de Execução'
  },
  Administrativo: {
    Administrado: 'Defesa / Recurso',
    'Administração Pública': 'Petição'
  },
  Previdenciário: {
    Segurado: 'Petição Inicial',
    INSS: 'Contestação'
  },
  Consumidor: {
    Consumidor: 'Petição Inicial',
    'Fornecedor / Empresa': 'Contestação'
  },
  Família: {
    Requerente: 'Petição Inicial',
    Requerido: 'Contestação'
  },
  Empresarial: {
    'Parte Autora': 'Petição Inicial',
    'Parte Ré': 'Contestação'
  }
}

export function suggestPieceType(area: string, perspective: string) {
  return pieceMapping[area]?.[perspective] || 'Petição / Manifestação'
}

export function pieceTypeOptions(area: string, perspective: string) {
  const suggested = suggestPieceType(area, perspective)
  const generic = ['Petição Inicial', 'Contestação', 'Contestação / Defesa', 'Defesa / Impugnação', 'Defesa / Recurso', 'Defesa Prévia / Resposta à Acusação', 'Denúncia', 'Petição de Execução', 'Petição / Manifestação']
  return Array.from(new Set([suggested, ...generic]))
}

const draftSchema = Schema.object({
  properties: {
    title: Schema.string(),
    sections: Schema.array({
      items: Schema.object({
        properties: {
          title: Schema.string(),
          content: Schema.string()
        }
      })
    })
  }
})

const validationSchema = Schema.object({
  properties: {
    claims: Schema.array({
      items: Schema.object({
        properties: {
          id: Schema.string(),
          text: Schema.string(),
          type: Schema.string(),
          status: Schema.enumString({ enum: ['CONFIRMADA', 'PARCIALMENTE CONFIRMADA', 'NÃO CONFIRMADA', 'CONFLITANTE'] }),
          sourceReference: Schema.string(),
          treatment: Schema.string()
        }
      })
    }),
    correctedSections: Schema.array({
      items: Schema.object({
        properties: {
          title: Schema.string(),
          content: Schema.string()
        }
      })
    })
  }
})

const confirmationSchema = Schema.object({
  properties: {
    status: Schema.enumString({ enum: ['CONFIRMADO', 'NÃO LOCALIZADO', 'DIVERGENTE'] }),
    evidence: Schema.string(),
    pages: Schema.string(),
    note: Schema.string()
  }
})

function reportToSource(report: AnalysisReport) {
  return JSON.stringify({
    analysisId: report.analysisId,
    fileName: report.fileName,
    area: report.area,
    perspective: report.perspective,
    processNumber: report.processNumber,
    processNumberWarning: report.processNumberWarning,
    executiveSummary: report.executiveSummary,
    timeline: report.timeline,
    claimsEvidenceDecisions: report.claimsEvidenceDecisions,
    globalAnalysis: report.globalAnalysis,
    risks: report.risks,
    conclusionStrategy: report.conclusionStrategy,
    sources: report.sources
  }, null, 2)
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeoutId = 0
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new Error(`PIECE_REQUEST_TIMEOUT: ${label}`)),
      REQUEST_TIMEOUT_MS
    )
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId)
  })
}

async function generateJson(
  prompt: string,
  schema: any,
  context: string,
  contents?: any[]
): Promise<{ parsed: any; model: string }> {
  if (!aiClient) throw new Error('FIREBASE_AI_NOT_READY')

  let lastError: unknown
  for (const modelName of PIECE_FALLBACK_MODELS) {
    try {
      const model = getGenerativeModel(aiClient, {
        model: modelName,
        systemInstruction: [
          'PROCESSO 360 IA — MOTOR B DE PEÇAS JURÍDICAS.',
          'Nunca invente fatos, datas, valores, documentos, decisões, números, pessoas ou eventos.',
          'O relatório consolidado é a fonte factual padrão e suficiente.',
          'Diferencie rigorosamente fato verificável de tese/argumentação jurídica.',
          'A saída é sempre rascunho sujeito a revisão obrigatória por advogado.'
        ].join('\n'),
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          maxOutputTokens: 16384
        }
      })

      const result = await withTimeout(
        model.generateContent(contents?.length ? [prompt, ...contents] : prompt),
        context
      )
      const raw = result.response.text()
      if (!raw?.trim()) throw new Error(`PIECE_EMPTY_RESPONSE: ${context}`)
      return { parsed: JSON.parse(raw), model: modelName }
    } catch (error) {
      lastError = error
      console.error('[Processo 360 IA][Motor B]', context, modelName, error)
    }
  }

  throw lastError instanceof Error ? lastError : new Error('PIECE_GENERATION_FAILED')
}

function countValidation(claims: PieceClaim[]) {
  return {
    confirmed: claims.filter(item => item.status === 'CONFIRMADA').length,
    partiallyConfirmed: claims.filter(item => item.status === 'PARCIALMENTE CONFIRMADA').length,
    unconfirmed: claims.filter(item => item.status === 'NÃO CONFIRMADA').length,
    conflicting: claims.filter(item => item.status === 'CONFLITANTE').length
  }
}

function hardenCorrectedSections(sections: PieceSection[], claims: PieceClaim[]) {
  const unsafe = claims.filter(item => item.status === 'NÃO CONFIRMADA' || item.status === 'CONFLITANTE')
  return sections.map(section => {
    let content = String(section.content || '')
    for (const claim of unsafe) {
      const exact = String(claim.text || '').trim()
      if (exact.length >= 12 && content.includes(exact)) {
        content = content.split(exact).join(PLACEHOLDER)
      }
    }
    return { ...section, content }
  })
}

export async function generateLegalPiece(
  report: AnalysisReport,
  pieceType: string
): Promise<LegalPieceDraft> {
  const source = reportToSource(report)

  const draftPrompt = `
ÁREA: ${report.area}
PERSPECTIVA: ${report.perspective}
TIPO DE PEÇA: ${pieceType}

TAREFA:
Produza um RASCUNHO ESTRUTURADO da peça indicada.
Use exclusivamente fatos constantes no RELATÓRIO CONSOLIDADO abaixo.
Não consulte nem pressuponha o PDF original.
Não complete lacunas factuais.
Quando um dado indispensável estiver ausente, use exatamente:
${PLACEHOLDER}

Você pode desenvolver livremente raciocínio, tese, organização e argumentação jurídica, desde que não crie premissas factuais novas.
Não diga que a peça está pronta para protocolo ou assinatura.

RELATÓRIO CONSOLIDADO:
${source}
`.trim()

  const draftResult = await generateJson(
    draftPrompt,
    draftSchema,
    'geração do rascunho'
  )

  const rawSections = Array.isArray(draftResult.parsed.sections)
    ? draftResult.parsed.sections.map((item: any) => ({
        title: String(item.title || ''),
        content: String(item.content || '')
      }))
    : []

  const validationPrompt = `
Você é o VALIDADOR FACTUAL do Processo 360 IA.

Compare TODAS as afirmações factuais verificáveis da minuta com o RELATÓRIO CONSOLIDADO.
Extraia claims de nomes, datas, valores, documentos, eventos, decisões, números de processo, obrigações e alegações atribuídas às partes.

Classifique cada claim EXATAMENTE como:
- CONFIRMADA
- PARCIALMENTE CONFIRMADA
- NÃO CONFIRMADA
- CONFLITANTE

REGRAS DURAS:
1. NÃO CONFIRMADA ou CONFLITANTE não pode permanecer silenciosamente em correctedSections.
2. Remova, reformule com apenas a parcela sustentada ou substitua por ${PLACEHOLDER}.
3. PARCIALMENTE CONFIRMADA deve perder detalhes não sustentados.
4. Não trate argumentação/tese jurídica como fato apenas porque não aparece literalmente no relatório.
5. sourceReference deve apontar a seção/referência do relatório que sustenta o claim; se inexistente, use "Sem lastro no relatório consolidado".
6. correctedSections deve conter a versão segura que será exibida ao advogado.

RELATÓRIO CONSOLIDADO:
${source}

MINUTA BRUTA:
${JSON.stringify(rawSections, null, 2)}
`.trim()

  const validationResult = await generateJson(
    validationPrompt,
    validationSchema,
    'validação factual'
  )

  const claims: PieceClaim[] = Array.isArray(validationResult.parsed.claims)
    ? validationResult.parsed.claims.map((item: any, index: number) => ({
        id: String(item.id || `claim-${index + 1}`),
        text: String(item.text || ''),
        type: String(item.type || 'fato'),
        status: item.status as ClaimStatus,
        sourceReference: String(item.sourceReference || ''),
        treatment: String(item.treatment || '')
      }))
    : []

  const correctedSections: PieceSection[] = Array.isArray(validationResult.parsed.correctedSections)
    ? validationResult.parsed.correctedSections.map((item: any) => ({
        title: String(item.title || ''),
        content: String(item.content || '')
      }))
    : rawSections

  const safeSections = hardenCorrectedSections(correctedSections, claims)

  return {
    pieceType,
    title: String(draftResult.parsed.title || pieceType),
    sections: safeSections,
    claims,
    validation: countValidation(claims),
    model: validationResult.model || draftResult.model,
    promptVersion: `${DRAFT_PROMPT_VERSION}+${VALIDATION_PROMPT_VERSION}`
  }
}

function extractPageRange(reference: string, pageCount: number) {
  const refs = String(reference || '')
  const range = refs.match(/p(?:á|a)ginas?\s*(\d+)\s*[-–a]\s*(\d+)/i)
  const single = refs.match(/(?:p(?:á|a)gina|p\.?)[\s:]*(\d+)/i)

  let start: number | null = null
  let end: number | null = null

  if (range) {
    start = Number(range[1])
    end = Number(range[2])
  } else if (single) {
    start = Number(single[1])
    end = Number(single[1])
  }

  if (!start || !end || start < 1) return null
  start = Math.max(1, Math.min(start, pageCount))
  end = Math.max(start, Math.min(end, pageCount))

  if (end - start > 4) end = start + 4
  return { start, end }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
  }
  return btoa(binary)
}

export async function confirmClaimInOriginal(
  file: File,
  claim: PieceClaim
): Promise<{ status: string; evidence: string; pages: string; note: string }> {
  const sourceBytes = await file.arrayBuffer()
  const source = await PDFDocument.load(sourceBytes, { ignoreEncryption: true })
  const range = extractPageRange(claim.sourceReference, source.getPageCount())

  if (!range) {
    throw new Error('PIECE_TARGETED_SOURCE_NOT_AVAILABLE')
  }

  const target = await PDFDocument.create()
  const indexes = Array.from(
    { length: range.end - range.start + 1 },
    (_, index) => range.start - 1 + index
  )
  const pages = await target.copyPages(source, indexes)
  pages.forEach(page => target.addPage(page))
  const bytes = new Uint8Array(await target.save())

  const prompt = `
CONFIRMAÇÃO PONTUAL NO DOCUMENTO ORIGINAL.

FATO A VERIFICAR:
${claim.text}

REFERÊNCIA DO RELATÓRIO:
${claim.sourceReference}

Analise SOMENTE o trecho de PDF anexado.
Não extrapole além dessas páginas.
Informe se o fato está confirmado, não localizado ou divergente.
Transcreva apenas uma síntese curta da evidência, sem inventar informação.
`.trim()

  const result = await generateJson(
    prompt,
    confirmationSchema,
    'confirmação pontual no documento original',
    [{
      inlineData: {
        data: bytesToBase64(bytes),
        mimeType: 'application/pdf'
      }
    }]
  )

  return {
    status: String(result.parsed.status || 'NÃO LOCALIZADO'),
    evidence: String(result.parsed.evidence || ''),
    pages: String(result.parsed.pages || `${range.start}-${range.end}`),
    note: String(result.parsed.note || '')
  }
}
