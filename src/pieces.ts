import { getGenerativeModel, Schema } from 'firebase/ai'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { PDFDocument } from 'pdf-lib'
import { aiClient, db } from './firebase'
import { MOTOR_B_BASE_GLOBAL, MOTOR_B_PURPOSES, MOTOR_B_REVIEWER, MOTOR_B_TRABALHISTA_RECLAMADA, MOTOR_B_TRABALHISTA_RECLAMANTE, MOTOR_B_VALIDATOR } from './piecePrompts'
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


type MotorBPromptDoc = {
  area?: string
  perspective?: string
  purpose?: string
  content?: string
  version?: number
  status?: string
}

const DRAFT_PROMPT_VERSION = '2026-09-27-motor-b-piece-v2'
const VALIDATION_PROMPT_VERSION = '2026-09-27-motor-b-fact-validation-v2'
const REVIEW_PROMPT_VERSION = '2026-09-27-motor-b-legal-review-v1'

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

const reviewSchema = Schema.object({
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

const confirmationSchema = Schema.object({
  properties: {
    status: Schema.enumString({ enum: ['CONFIRMADO', 'NÃO LOCALIZADO', 'DIVERGENTE'] }),
    evidence: Schema.string(),
    pages: Schema.string(),
    note: Schema.string()
  }
})

async function loadMotorBPrompt(
  area: string,
  perspective: string,
  purpose: string,
  fallback: string
) {
  if (!db) return { content: fallback, version: 0 }

  try {
    const snap = await getDocs(query(collection(db, 'prompts'), where('status', '==', 'publicado')))
    const candidates = snap.docs
      .map(doc => doc.data() as MotorBPromptDoc)
      .filter(item =>
        item.purpose === purpose &&
        item.content?.trim() &&
        (
          (item.area === area && item.perspective === perspective) ||
          (item.area === 'Global' && item.perspective === 'Global')
        )
      )
      .sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0))

    const selected = candidates[0]
    return selected
      ? { content: String(selected.content || '').trim(), version: Number(selected.version) || 1 }
      : { content: fallback, version: 0 }
  } catch (error) {
    console.warn('[Processo 360 IA][Motor B] Falha ao carregar prompt publicado; usando fallback local.', purpose, error)
    return { content: fallback, version: 0 }
  }
}

function specificPiecePrompt(area: string, perspective: string, pieceType: string) {
  if (area === 'Trabalhista' && perspective === 'Reclamada' && /contestação|defesa/i.test(pieceType)) {
    return {
      purpose: MOTOR_B_PURPOSES.trabalhistaReclamada,
      fallback: MOTOR_B_TRABALHISTA_RECLAMADA
    }
  }

  if (area === 'Trabalhista' && perspective === 'Reclamante' && /petição inicial/i.test(pieceType)) {
    return {
      purpose: MOTOR_B_PURPOSES.trabalhistaReclamante,
      fallback: MOTOR_B_TRABALHISTA_RECLAMANTE
    }
  }

  return {
    purpose: 'Motor B — Peça Jurídica Genérica',
    fallback: 'Elabore a peça solicitada com técnica jurídica, fidelidade factual, rastreabilidade e observância integral do Prompt Base Global.'
  }
}

function reportToDiagnostic(report: AnalysisReport) {
  return JSON.stringify({
    globalAnalysis: report.globalAnalysis,
    risks: report.risks,
    conclusionStrategy: report.conclusionStrategy
  }, null, 2)
}

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
  const diagnostic = reportToDiagnostic(report)
  const specific = specificPiecePrompt(report.area, report.perspective, pieceType)

  const [basePromptDoc, specificPromptDoc, validatorPromptDoc, reviewerPromptDoc] = await Promise.all([
    loadMotorBPrompt(report.area, report.perspective, MOTOR_B_PURPOSES.base, MOTOR_B_BASE_GLOBAL),
    loadMotorBPrompt(report.area, report.perspective, specific.purpose, specific.fallback),
    loadMotorBPrompt(report.area, report.perspective, MOTOR_B_PURPOSES.validator, MOTOR_B_VALIDATOR),
    loadMotorBPrompt(report.area, report.perspective, MOTOR_B_PURPOSES.reviewer, MOTOR_B_REVIEWER)
  ])

  const draftPrompt = `
${basePromptDoc.content}

${specificPromptDoc.content}

ÁREA: ${report.area}
PERSPECTIVA: ${report.perspective}
TIPO DE PEÇA: ${pieceType}

[DADOS_CONSOLIDADOS_DO_PROCESSO]
${source}

[DIAGNOSTICO_JURIDICO]
${diagnostic}

[CHECKLIST_PRE_PETICIONAMENTO]
NÃO FORNECIDO NESTA VERSÃO DO SISTEMA.

INSTRUÇÃO DE SAÍDA:
Responda exclusivamente no JSON exigido pelo schema. Em title, informe o título da peça. Em sections, devolva a peça integral organizada em seções.
`.trim()

  const draftResult = await generateJson(
    draftPrompt,
    draftSchema,
    'geração do rascunho especializado'
  )

  const rawSections = Array.isArray(draftResult.parsed.sections)
    ? draftResult.parsed.sections.map((item: any) => ({
        title: String(item.title || ''),
        content: String(item.content || '')
      }))
    : []

  const validationPrompt = `
${validatorPromptDoc.content}

[DADOS_CONSOLIDADOS_DO_PROCESSO]
${source}

[DIAGNOSTICO_JURIDICO]
${diagnostic}

[MINUTA_GERADA]
${JSON.stringify(rawSections, null, 2)}

INSTRUÇÃO DE SAÍDA:
Responda exclusivamente no JSON exigido pelo schema.
- claims representa a tabela de auditoria factual em formato estruturado.
- correctedSections deve conter a minuta corrigida integralmente.
`.trim()

  const validationResult = await generateJson(
    validationPrompt,
    validationSchema,
    'validação factual especializada'
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

  const factSafeSections = hardenCorrectedSections(correctedSections, claims)

  const reviewPrompt = `
${reviewerPromptDoc.content}

ÁREA: ${report.area}
PERSPECTIVA: ${report.perspective}
TIPO DE PEÇA: ${pieceType}

[DADOS_CONSOLIDADOS_DO_PROCESSO]
${source}

[DIAGNOSTICO_JURIDICO]
${diagnostic}

[CHECKLIST_PRE_PETICIONAMENTO]
NÃO FORNECIDO NESTA VERSÃO DO SISTEMA.

[RELATORIO_DE_VALIDACAO_FACTUAL]
${JSON.stringify({ claims, validation: countValidation(claims) }, null, 2)}

[MINUTA_CORRIGIDA]
${JSON.stringify(factSafeSections, null, 2)}

INSTRUÇÃO DE SAÍDA:
Responda exclusivamente no JSON exigido pelo schema. Não acrescente nenhum fato novo. Em sections, devolva a versão integral final revisada.
`.trim()

  const reviewResult = await generateJson(
    reviewPrompt,
    reviewSchema,
    'revisão jurídica final'
  )

  const reviewedSections: PieceSection[] = Array.isArray(reviewResult.parsed.sections)
    ? reviewResult.parsed.sections.map((item: any) => ({
        title: String(item.title || ''),
        content: String(item.content || '')
      }))
    : factSafeSections

  const safeSections = hardenCorrectedSections(reviewedSections, claims)

  const promptVersion = [
    `${DRAFT_PROMPT_VERSION}:base-v${basePromptDoc.version || 'fallback'}`,
    `piece-v${specificPromptDoc.version || 'fallback'}`,
    `${VALIDATION_PROMPT_VERSION}:v${validatorPromptDoc.version || 'fallback'}`,
    `${REVIEW_PROMPT_VERSION}:v${reviewerPromptDoc.version || 'fallback'}`
  ].join('+')

  return {
    pieceType,
    title: String(reviewResult.parsed.title || draftResult.parsed.title || pieceType),
    sections: safeSections,
    claims,
    validation: countValidation(claims),
    model: reviewResult.model || validationResult.model || draftResult.model,
    promptVersion
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
