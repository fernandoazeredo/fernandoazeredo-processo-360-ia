import { getGenerativeModel, Schema } from 'firebase/ai'
import { addDoc, collection, getDocs, query, serverTimestamp, where } from 'firebase/firestore'
import { PDFDocument } from 'pdf-lib'
import { aiClient, auth, db } from './firebase'
import { MOTOR_B_BASE_GLOBAL, MOTOR_B_PURPOSES, MOTOR_B_REVIEWER, MOTOR_B_TRABALHISTA_RECLAMADA, MOTOR_B_TRABALHISTA_RECLAMANTE, MOTOR_B_VALIDATOR } from './piecePrompts'
import type { AnalysisReport } from './ai'

const PIECE_MODEL = 'gemini-3.8-flash'
const PIECE_FALLBACK_MODELS = [PIECE_MODEL, 'gemini-3.5-flash', 'gemini-3.5-flash-lite'] as const
const REQUEST_TIMEOUT_MS = 90_000
const PLACEHOLDER = '[DADO A CONFIRMAR]'
const MOTOR_B_LOCAL_VERSION = 9

async function recordPieceUsage(context: string, model: string, usage: any) {
  if (!db || !auth?.currentUser || !usage) return
  try {
    await addDoc(collection(db, 'aiUsage'), {
      uid: auth.currentUser.uid,
      operation: 'piece',
      context,
      model,
      promptTokenCount: Number(usage.promptTokenCount || 0),
      candidatesTokenCount: Number(usage.candidatesTokenCount || 0),
      thoughtsTokenCount: Number(usage.thoughtsTokenCount || 0),
      totalTokenCount: Number(usage.totalTokenCount || 0),
      createdAt: serverTimestamp()
    })
  } catch (error) {
    console.warn('[Processo 360 IA][Uso IA] Não foi possível registrar tokens da peça.', error)
  }
}

export type ClaimStatus = 'CONFIRMADA' | 'PARCIALMENTE CONFIRMADA' | 'NÃO CONFIRMADA' | 'CORRIGIDA' | 'CONFLITANTE'
export type PieceSection = { title: string; content: string }
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
  validation: { confirmed: number; partiallyConfirmed: number; unconfirmed: number; corrected: number; conflicting: number }
  model: string
  promptVersion: string
}

export type ProfessionalProfile = {
  name: string
  oab: string
  address: string
  email: string
}

type MotorBPromptDoc = {
  area?: string
  perspective?: string
  purpose?: string
  content?: string
  version?: number
  status?: string
}

type LoadedPrompt = { content: string; version: number; source: 'firestore' | 'local-v8' }

const pieceMapping: Record<string, Record<string, string>> = {
  Trabalhista: { Reclamante: 'Petição Inicial', Reclamada: 'Contestação' },
  Cível: { Autor: 'Petição Inicial', Réu: 'Contestação' },
  Criminal: { Acusação: 'Denúncia', Defesa: 'Defesa Prévia / Resposta à Acusação' },
  Ambiental: { 'Autuado / Réu': 'Defesa / Impugnação', 'Órgão Ambiental / MP': 'Auto de Infração / Petição' },
  Tributário: { Contribuinte: 'Impugnação / Defesa', 'Fazenda Pública': 'Petição de Execução' },
  Administrativo: { Administrado: 'Defesa / Recurso', 'Administração Pública': 'Petição' },
  Previdenciário: { Segurado: 'Petição Inicial', INSS: 'Contestação' },
  Consumidor: { Consumidor: 'Petição Inicial', 'Fornecedor / Empresa': 'Contestação' },
  Família: { Requerente: 'Petição Inicial', Requerido: 'Contestação' },
  Empresarial: { 'Parte Autora': 'Petição Inicial', 'Parte Ré': 'Contestação' }
}

export function suggestPieceType(area: string, perspective: string) {
  return pieceMapping[area]?.[perspective] || 'Petição / Manifestação'
}

export function pieceTypeOptions(area: string, perspective: string) {
  const suggested = suggestPieceType(area, perspective)
  const byArea: Record<string, Record<string, string[]>> = {
    Trabalhista: {
      Reclamante: ['Petição Inicial', 'Réplica / Manifestação', 'Petição / Manifestação'],
      Reclamada: ['Contestação', 'Contestação / Defesa', 'Petição / Manifestação']
    },
    Cível: { Autor: ['Petição Inicial', 'Réplica / Manifestação', 'Petição / Manifestação'], Réu: ['Contestação', 'Petição / Manifestação'] },
    Criminal: {
      Acusação: ['Denúncia', 'Petição / Manifestação'],
      Defesa: ['Defesa Prévia / Resposta à Acusação', 'Petição / Manifestação'],
      'Assistente de acusação': ['Petição / Manifestação'],
      Querelante: ['Petição / Manifestação']
    },
    Ambiental: { 'Autuado / Réu': ['Defesa / Impugnação', 'Petição / Manifestação'], 'Órgão Ambiental / MP': ['Petição / Manifestação'] },
    Tributário: { Contribuinte: ['Defesa / Impugnação', 'Embargos à Execução Fiscal', 'Petição / Manifestação'], 'Fazenda Pública': ['Petição de Execução', 'Impugnação aos Embargos', 'Petição / Manifestação'] },
    Administrativo: { Administrado: ['Defesa / Recurso', 'Petição / Manifestação'], 'Administração Pública': ['Petição / Manifestação'] },
    Previdenciário: { Segurado: ['Petição Inicial', 'Réplica / Manifestação', 'Quesitos Periciais', 'Petição / Manifestação'], INSS: ['Contestação', 'Quesitos Periciais', 'Petição / Manifestação'] },
    Consumidor: { Consumidor: ['Petição Inicial', 'Petição / Manifestação'], 'Fornecedor / Empresa': ['Contestação', 'Petição / Manifestação'] },
    Família: { Requerente: ['Petição Inicial', 'Petição / Manifestação'], Requerido: ['Contestação', 'Petição / Manifestação'] },
    Empresarial: { 'Parte Autora': ['Petição Inicial', 'Petição / Manifestação'], 'Parte Ré': ['Contestação', 'Petição / Manifestação'] }
  }
  return Array.from(new Set([suggested, ...(byArea[area]?.[perspective] || ['Petição / Manifestação'])]))
}

const draftSchema = Schema.object({ properties: {
  title: Schema.string(),
  sections: Schema.array({ items: Schema.object({ properties: { title: Schema.string(), content: Schema.string() } }) })
} })

const validationSchema = Schema.object({ properties: {
  claims: Schema.array({ items: Schema.object({ properties: {
    id: Schema.string(), text: Schema.string(), type: Schema.string(),
    status: Schema.enumString({ enum: ['CONFIRMADA', 'PARCIALMENTE CONFIRMADA', 'NÃO CONFIRMADA', 'CORRIGIDA', 'CONFLITANTE'] }),
    sourceReference: Schema.string(), treatment: Schema.string()
  } }) }),
  correctedSections: Schema.array({ items: Schema.object({ properties: { title: Schema.string(), content: Schema.string() } }) })
} })

const reviewSchema = Schema.object({ properties: {
  title: Schema.string(),
  sections: Schema.array({ items: Schema.object({ properties: { title: Schema.string(), content: Schema.string() } }) })
} })

const confirmationSchema = Schema.object({ properties: {
  status: Schema.enumString({ enum: ['CONFIRMADO', 'NÃO LOCALIZADO', 'DIVERGENTE'] }),
  evidence: Schema.string(), pages: Schema.string(), note: Schema.string()
} })

async function loadMotorBPrompt(area: string, perspective: string, purpose: string, localPrompt: string): Promise<LoadedPrompt> {
  if (!db) return { content: localPrompt, version: MOTOR_B_LOCAL_VERSION, source: 'local-v8' }
  try {
    const snap = await getDocs(query(collection(db, 'prompts'), where('status', '==', 'publicado')))
    const candidates = snap.docs
      .map(doc => doc.data() as MotorBPromptDoc)
      .filter(item => item.purpose === purpose && item.content?.trim() && (
        (item.area === area && item.perspective === perspective) ||
        (item.area === 'Global' && item.perspective === 'Global')
      ))
      .sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0))
    const selected = candidates[0]
    // V8 local é o piso de qualidade. Prompt publicado só substitui quando for v8 ou superior.
    if (selected && (Number(selected.version) || 0) >= MOTOR_B_LOCAL_VERSION) {
      return { content: String(selected.content || '').trim(), version: Number(selected.version), source: 'firestore' }
    }
    return { content: localPrompt, version: MOTOR_B_LOCAL_VERSION, source: 'local-v8' }
  } catch (error) {
    console.warn('[Processo 360 IA][Motor B] Prompt publicado indisponível; usando Motor B local v8.', purpose, error)
    return { content: localPrompt, version: MOTOR_B_LOCAL_VERSION, source: 'local-v8' }
  }
}

function specificPiecePrompt(area: string, perspective: string, pieceType: string) {
  if (area === 'Trabalhista' && perspective === 'Reclamada' && /contestação|defesa/i.test(pieceType)) {
    return { purpose: MOTOR_B_PURPOSES.trabalhistaReclamada, fallback: MOTOR_B_TRABALHISTA_RECLAMADA }
  }
  if (area === 'Trabalhista' && perspective === 'Reclamante' && /petição inicial|réplica|manifestação/i.test(pieceType)) {
    return { purpose: MOTOR_B_PURPOSES.trabalhistaReclamante, fallback: MOTOR_B_TRABALHISTA_RECLAMANTE }
  }
  return {
    purpose: 'Motor B — Peça Jurídica Genérica',
    fallback: 'Elabore a peça solicitada com técnica jurídica, fidelidade factual e texto exportável limpo. Mantenha rastreabilidade exclusivamente no painel de auditoria.'
  }
}

function reportToDiagnostic(report: AnalysisReport) {
  return JSON.stringify({ globalAnalysis: report.globalAnalysis, risks: report.risks, conclusionStrategy: report.conclusionStrategy }, null, 2)
}

function reportToSource(report: AnalysisReport) {
  return JSON.stringify({
    analysisId: report.analysisId,
    fileName: report.fileName,
    area: report.area,
    perspective: report.perspective,
    processNumber: report.processNumber,
    processNumberWarning: report.processNumberWarning,
    parties: report.parties,
    executiveSummary: report.executiveSummary,
    timeline: report.timeline,
    claimsEvidenceDecisions: report.claimsEvidenceDecisions,
    globalAnalysis: report.globalAnalysis,
    risks: report.risks,
    conclusionStrategy: report.conclusionStrategy,
    sources: report.sources
  }, null, 2)
}

function reportText(report: AnalysisReport) {
  return `${report.executiveSummary}\n${report.claimsEvidenceDecisions}\n${report.globalAnalysis}\n${report.conclusionStrategy}\n${report.timeline.map(item => `${item.event} ${item.reference}`).join('\n')}`.toLowerCase()
}

function hasDefenseInRecord(report: AnalysisReport) {
  const text = reportText(report)
  const explicitAbsence = /(?:não|nao)\s+(?:há|ha|consta|existe|foi\s+(?:localizada|identificada|apresentada|juntada))[^.\n]{0,80}(?:contestação|contestacao|defesa)/i.test(text)
    || /(?:contestação|contestacao|defesa)[^.\n]{0,80}(?:não|nao)\s+(?:consta|foi\s+(?:localizada|identificada|apresentada|juntada))/i.test(text)
  if (explicitAbsence) return false
  const timelineText = report.timeline.map(item => `${item.event} ${item.reference}`).join(' ').toLowerCase()
  return /(?:contestação|contestacao|defesa)[^.;]{0,60}(?:apresentad|protocolad|juntad|oferecid)/i.test(timelineText)
    || /(?:apresentad|protocolad|juntad|oferecid)[^.;]{0,60}(?:contestação|contestacao|defesa)/i.test(timelineText)
}

function inferProceduralPhase(report: AnalysisReport) {
  const haystack = `${report.executiveSummary}\n${report.claimsEvidenceDecisions}\n${report.globalAnalysis}\n${report.timeline.map(item => `${item.event} ${item.reference}`).join('\n')}`.toLowerCase()
  const hasProcessNumber = Boolean(report.processNumber && !/informação não constante/i.test(report.processNumber))
  if (/contestação|defesa apresentada|audiência|sentença|decisão|réplica|manifestação do reclamante/.test(haystack)) return 'PROCESSO EM CURSO — identificar o último ato antes de escolher a próxima peça'
  if (hasProcessNumber) return 'PROCESSO APARENTEMENTE JÁ AJUIZADO — confirmar fase antes de gerar nova petição inicial'
  return 'FASE PRÉ-PROCESSUAL OU NÃO IDENTIFICADA — confirmar antes do protocolo'
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeoutId = 0
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(`PIECE_REQUEST_TIMEOUT: ${label}`)), REQUEST_TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => { if (timeoutId) window.clearTimeout(timeoutId) })
}

async function generateJson(prompt: string, schema: any, context: string, contents?: any[]): Promise<{ parsed: any; model: string }> {
  if (!aiClient) throw new Error('FIREBASE_AI_NOT_READY')
  let lastError: unknown
  for (const modelName of PIECE_FALLBACK_MODELS) {
    try {
      const model = getGenerativeModel(aiClient, {
        model: modelName,
        systemInstruction: [
          'PROCESSO 360 IA — MOTOR B V9 — INTEGRIDADE FACTUAL.',
          'Nunca invente fatos, datas, valores, documentos, decisões, números, pessoas, juntadas, cumprimento de decisões, regularizações, treinamentos ou resultados periciais.',
          'A existência de uma alegação confirma somente que ela foi alegada; não confirma que seu conteúdo seja verdadeiro.',
          'Separe fato documentado, alegação, ponto controvertido, inferência, cálculo derivado e conclusão jurídica.',
          'Confronte narrativa com prova documental específica; não repita erro do relatório quando o documento original o contradisser.',
          'Ausência de informação não é prova de inexistência. Redija de forma condicional quando a confirmação documental faltar.',
          'Nunca escreva como certeza no corpo algo que será tratado como pendência ou não confirmado na auditoria.',
          'Rastreabilidade técnica pertence ao painel/anexo de auditoria, não deve ser confundida com narrativa factual da peça.'
        ].join('\n'),
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 16384 }
      })
      const result = await withTimeout(model.generateContent(contents?.length ? [prompt, ...contents] : prompt), context)
      const raw = result.response.text()
      if (!raw?.trim()) throw new Error(`PIECE_EMPTY_RESPONSE: ${context}`)
      await recordPieceUsage(context, modelName, (result.response as any).usageMetadata)
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
    corrected: claims.filter(item => item.status === 'CORRIGIDA').length,
    conflicting: claims.filter(item => item.status === 'CONFLITANTE').length
  }
}

function cleanExportableText(input: string) {
  return String(input || '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\[(?:lote\s*\d+[^\]]*|fls?\.?\s*[^\]]*|p(?:á|a)ginas?\s*pdf\s*[^\]]*)\]/gi, '')
    .replace(/\[RELATÓRIO CONSOLIDADO[^\]]*\]/gi, '')
    .replace(/\[DIVERGÊNCIA JURÍDICA A SER REVISADA PELO ADVOGADO\]/gi, '⚠ REVISAR')
    .replace(/\[INFORMAÇÃO A SER CONFIRMADA PELO ADVOGADO\]/gi, PLACEHOLDER)
    .replace(/RASCUNHO DE PEÇA PROCESSUAL[^\n.]*(?:\.|\n)?/gi, '')
    .replace(/REVISÃO JURÍDICA POR ADVOGADO É OBRIGATÓRIA[^\n.]*(?:\.|\n)?/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim()
}

function cleanSections(sections: PieceSection[]) {
  return sections.map(section => ({ title: cleanExportableText(section.title), content: cleanExportableText(section.content) }))
    .filter(section => section.title || section.content)
}

function hardenCorrectedSections(sections: PieceSection[], claims: PieceClaim[]) {
  const unsafe = claims.filter(item => item.status === 'NÃO CONFIRMADA' || item.status === 'CONFLITANTE')
  const hardened = sections.map(section => {
    let content = String(section.content || '')
    for (const claim of unsafe) {
      const exact = String(claim.text || '').trim()
      if (exact.length >= 12 && content.includes(exact)) content = content.split(exact).join(PLACEHOLDER)
    }
    return { ...section, content }
  })
  return cleanSections(hardened)
}


function inferInitialFilingDate(report: AnalysisReport) {
  const filingEvent = report.timeline.find(item => {
    const context = `${item.event || ''} ${item.reference || ''}`
    return /ajuiz|distribu|protocol|propositura/i.test(context) && /^\d{2}\/\d{2}\/\d{4}$/.test(String(item.date || '').trim())
  })
  return filingEvent ? String(filingEvent.date).trim() : '[DATA]'
}

function applyDefenseSafeguards(sections: PieceSection[], pieceType: string) {
  if (!/contesta|defesa/i.test(pieceType)) return sections
  return cleanSections(sections.map(section => ({
    ...section,
    content: section.content
      .replace(/(?:a\s+)?reclamada\s+reconhece\s+expressamente\s+a\s+incidência\s+da\s+Súmula\s+338(?:,\s*III)?(?:,?\s+do\s+TST)?/gi,
        'a Reclamada sustenta, subsidiariamente, que eventual presunção relacionada à Súmula 338, III, do TST é relativa e deve ser apreciada em conjunto com a prova produzida')
      .replace(/(?:a\s+)?reclamada\s+(?:admite|reconhece)\s+a\s+incidência\s+da\s+Súmula\s+338(?:,\s*III)?(?:,?\s+do\s+TST)?/gi,
        'a Reclamada sustenta, subsidiariamente, que eventual presunção relacionada à Súmula 338, III, do TST é relativa e pode ser afastada pelo conjunto probatório')
  })))
}

function ensureProvisionalCauseReviewMarker(sections: PieceSection[]) {
  return sections.map(section => {
    const content = String(section.content || '').replace(
      /(valor[^.\n]{0,180}(?:parcial|provisóri)[^.\n]{0,180}R\$\s*[\d.]+,\d{2})(?!\s*⚠\s*REVISAR)/gi,
      '$1 ⚠ REVISAR'
    )
    return { ...section, content }
  })
}

function usesPublicRepresentation(area: string, perspective: string) {
  return (area === 'Criminal' && perspective === 'Acusação')
    || (area === 'Ambiental' && /Órgão Ambiental|MP/i.test(perspective))
    || (area === 'Tributário' && /Fazenda Pública/i.test(perspective))
    || (area === 'Administrativo' && /Administração Pública/i.test(perspective))
    || (area === 'Previdenciário' && perspective === 'INSS')
}

function applyDeterministicPieceFields(sections: PieceSection[], professionalProfile: ProfessionalProfile | undefined, pieceDate: string, publicRepresentation = false) {
  const profile = publicRepresentation
    ? { name: '[REPRESENTAÇÃO PÚBLICA A CONFIRMAR]', oab: '', address: '', email: '' }
    : (professionalProfile || { name: '', oab: '', address: '', email: '' })
  const replacements: Array<[RegExp, string]> = [
    [/\[(?:NOME DO )?ADVOGADO(?:\(A\))?\]/gi, profile.name],
    [/\[OAB(?:\/UF)?\]/gi, profile.oab],
    [/\[ENDEREÇO (?:PROFISSIONAL|DO ADVOGADO)\]/gi, profile.address],
    [/\[E-?MAIL (?:PROFISSIONAL|DO ADVOGADO)\]/gi, profile.email],
    [/\[DATA\]/gi, pieceDate]
  ]

  const filled = sections.map(section => {
    let title = section.title
    let content = section.content
    for (const [pattern, value] of replacements) {
      if (!value) continue
      title = title.replace(pattern, value)
      content = content.replace(pattern, value)
    }
    return { title, content }
  })

  // A assinatura é dado cadastral determinístico: não pode desaparecer porque o revisor da IA
  // omitiu o placeholder. Se houver endereço cadastrado e ele ainda não estiver na peça,
  // anexa-o ao último bloco que contém nome/OAB do profissional (normalmente o fecho/assinatura).
  const address = String(profile.address || '').trim()
  if (address && !filled.some(section => section.content.toLowerCase().includes(address.toLowerCase()))) {
    const name = String(profile.name || '').trim().toLowerCase()
    const oab = String(profile.oab || '').trim().toLowerCase()
    let signatureIndex = -1
    for (let index = filled.length - 1; index >= 0; index -= 1) {
      const content = String(filled[index].content || '').toLowerCase()
      if ((oab && content.includes(oab)) || (name && content.includes(name))) {
        signatureIndex = index
        break
      }
    }
    if (signatureIndex >= 0) {
      filled[signatureIndex] = {
        ...filled[signatureIndex],
        content: `${filled[signatureIndex].content.trim()}\n${address}`
      }
    }
  }

  return cleanSections(filled)
}

export async function generateLegalPiece(report: AnalysisReport, pieceType: string, professionalProfile?: ProfessionalProfile, originalFile?: File): Promise<LegalPieceDraft> {
  if (/réplica|replica/i.test(pieceType) && !hasDefenseInRecord(report)) {
    throw new Error('PIECE_REPLICA_WITHOUT_DEFENSE')
  }
  const source = reportToSource(report)
  const diagnostic = reportToDiagnostic(report)
  const phase = inferProceduralPhase(report)
  const specific = specificPiecePrompt(report.area, report.perspective, pieceType)
  const currentDate = new Intl.DateTimeFormat('pt-BR').format(new Date())
  const isInitialPiece = /petição inicial/i.test(pieceType)
  const pieceDate = isInitialPiece ? inferInitialFilingDate(report) : currentDate
  const publicRepresentation = usesPublicRepresentation(report.area, report.perspective)
  const professional = publicRepresentation
    ? 'REPRESENTAÇÃO PÚBLICA: não reutilize assinatura privada. Identifique o órgão/cargo somente se constar dos autos; caso contrário use [REPRESENTAÇÃO PÚBLICA A CONFIRMAR].'
    : (professionalProfile ? JSON.stringify(professionalProfile, null, 2) : 'PROFISSIONAL NÃO CADASTRADO')

  const [basePromptDoc, specificPromptDoc, validatorPromptDoc, reviewerPromptDoc] = await Promise.all([
    loadMotorBPrompt(report.area, report.perspective, MOTOR_B_PURPOSES.base, MOTOR_B_BASE_GLOBAL),
    loadMotorBPrompt(report.area, report.perspective, specific.purpose, specific.fallback),
    loadMotorBPrompt(report.area, report.perspective, MOTOR_B_PURPOSES.validator, MOTOR_B_VALIDATOR),
    loadMotorBPrompt(report.area, report.perspective, MOTOR_B_PURPOSES.reviewer, MOTOR_B_REVIEWER)
  ])

  const draftPrompt = `${basePromptDoc.content}\n\n${specificPromptDoc.content}\n\nÁREA: ${report.area}\nPERSPECTIVA: ${report.perspective}\nTIPO SOLICITADO: ${pieceType}\nFASE PROCESSUAL INFERIDA: ${phase}\nDATA ATUAL DO SISTEMA: ${currentDate}\nDATA A UTILIZAR NA PEÇA: ${pieceDate}\nREGRA DE DATA: em Petição Inicial, use a data de ajuizamento/distribuição expressamente identificada; se ela não estiver identificada, preserve [DATA]. Nunca use a data atual como se fosse a data histórica de ajuizamento.\n\n[DADOS_PROFISSIONAIS_DO_ADVOGADO]\n${professional}\n\n[DADOS_CONSOLIDADOS_DO_PROCESSO]\n${source}\n\n[DIAGNOSTICO_JURIDICO]\n${diagnostic}\n\nINSTRUÇÃO DE INTEGRIDADE FACTUAL: a perspectiva define argumentação, não os acontecimentos. Não converta alegação em fato. Frases como "cumpriu", "juntou", "preservou", "regularizou", "não realizou", "restou comprovado" e equivalentes só podem ser categóricas com suporte documental específico; sem suporte, use formulação condicional/controvertida.
INSTRUÇÃO DE SAÍDA: JSON do schema. A peça em sections deve estar LIMPA, sem referências de lote/página/folha e sem avisos internos do sistema. Use a DATA A UTILIZAR NA PEÇA no fecho e os DADOS PROFISSIONAIS no bloco de assinatura; em Petição Inicial nunca substitua a data histórica de ajuizamento pela data atual. Não substitua dados existentes por placeholders.`

  const draftResult = await generateJson(draftPrompt, draftSchema, 'geração do rascunho especializado v3')
  const rawSections = cleanSections(Array.isArray(draftResult.parsed.sections) ? draftResult.parsed.sections.map((item: any) => ({ title: String(item.title || ''), content: String(item.content || '') })) : [])

  const validationPrompt = `${validatorPromptDoc.content}\n\nFASE PROCESSUAL INFERIDA: ${phase}\nDATA ATUAL DO SISTEMA: ${currentDate}\nDATA A UTILIZAR NA PEÇA: ${pieceDate}\nREGRA DE DATA: em Petição Inicial, use a data de ajuizamento/distribuição expressamente identificada; se ela não estiver identificada, preserve [DATA]. Nunca use a data atual como se fosse a data histórica de ajuizamento.\n\n[DADOS_PROFISSIONAIS_DO_ADVOGADO]\n${professional}\n\n[DADOS_CONSOLIDADOS_DO_PROCESSO]\n${source}\n\n[DIAGNOSTICO_JURIDICO]\n${diagnostic}\n\n[MINUTA_GERADA]\n${JSON.stringify(rawSections, null, 2)}\n\nINSTRUÇÃO: esta é a primeira validação. claims deve cobrir TODAS as afirmações materiais, não apenas nomes/datas/valores. A existência de uma alegação não confirma seu conteúdo. Se a fonte específica não estiver identificada, marque NÃO CONFIRMADA ou PARCIALMENTE CONFIRMADA e reescreva de modo condicional. claims guarda a auditoria e sourceReference. correctedSections deve permanecer limpa e exportável.`
  const validationResult = await generateJson(validationPrompt, validationSchema, 'validação factual v3')

  const claims: PieceClaim[] = Array.isArray(validationResult.parsed.claims) ? validationResult.parsed.claims.map((item: any, index: number) => ({
    id: String(item.id || `claim-${index + 1}`), text: String(item.text || ''), type: String(item.type || 'fato'),
    status: item.status as ClaimStatus, sourceReference: String(item.sourceReference || ''), treatment: String(item.treatment || '')
  })) : []

  const corrected = Array.isArray(validationResult.parsed.correctedSections)
    ? validationResult.parsed.correctedSections.map((item: any) => ({ title: String(item.title || ''), content: String(item.content || '') }))
    : rawSections
  const factSafeSections = hardenCorrectedSections(corrected, claims)

  const reviewPrompt = `${reviewerPromptDoc.content}\n\nÁREA: ${report.area}\nPERSPECTIVA: ${report.perspective}\nTIPO: ${pieceType}\nFASE: ${phase}\nDATA ATUAL DO SISTEMA: ${currentDate}\nDATA A UTILIZAR NA PEÇA: ${pieceDate}\nREGRA DE DATA: em Petição Inicial, use a data de ajuizamento/distribuição expressamente identificada; se ela não estiver identificada, preserve [DATA]. Nunca use a data atual como se fosse a data histórica de ajuizamento.\n\n[DADOS_PROFISSIONAIS_DO_ADVOGADO]\n${professional}\n\n[DADOS_CONSOLIDADOS_DO_PROCESSO]\n${source}\n\n[DIAGNOSTICO_JURIDICO]\n${diagnostic}\n\n[VALIDACAO]\n${JSON.stringify({ claims, validation: countValidation(claims) }, null, 2)}\n\n[MINUTA_CORRIGIDA]\n${JSON.stringify(factSafeSections, null, 2)}\n\nINSTRUÇÃO: devolva title e sections. Não reinsira referências técnicas ou avisos internos.`
  const reviewResult = await generateJson(reviewPrompt, reviewSchema, 'revisão jurídica final v3')

  const reviewed = Array.isArray(reviewResult.parsed.sections)
    ? reviewResult.parsed.sections.map((item: any) => ({ title: String(item.title || ''), content: String(item.content || '') }))
    : factSafeSections

  let finalClaims = claims
  let finalSections = reviewed
  let finalValidationModel = reviewResult.model

  if (originalFile) {
    const originalAttachment = await buildValidationAttachment(originalFile, claims)
    const finalValidationPrompt = `${validatorPromptDoc.content}

[VALIDAÇÃO FINAL CONTRA O DOCUMENTO ORIGINAL]
ÁREA: ${report.area}
PERSPECTIVA: ${report.perspective}
TIPO: ${pieceType}

[MINUTA APÓS REVISÃO]
${JSON.stringify(reviewed, null, 2)}

[CLAIMS DA PRIMEIRA VALIDAÇÃO]
${JSON.stringify(claims, null, 2)}

REGRAS:
1. Revalide novamente todas as afirmações materiais APÓS as alterações do revisor.
2. Use o PDF original anexado como fonte primária. O relatório consolidado não substitui o documento original.
3. Confirmar que uma parte alegou algo não confirma que o conteúdo alegado seja verdadeiro.
4. Não transforme ausência de informação em prova de inexistência.
5. Se o PDF anexado for apenas um recorte de páginas referenciadas, não confirme fato que dependa de página não presente.
6. Toda afirmação material categórica sem suporte específico deve ser marcada NÃO CONFIRMADA/PARCIALMENTE CONFIRMADA e reescrita de modo condicional.
7. correctedSections deve refletir exatamente essa validação final.`

    const finalValidationResult = await generateJson(
      finalValidationPrompt,
      validationSchema,
      'validação factual final no documento original v9',
      [{ inlineData: { data: bytesToBase64(originalAttachment.bytes), mimeType: 'application/pdf' } }]
    )

    finalClaims = Array.isArray(finalValidationResult.parsed.claims)
      ? finalValidationResult.parsed.claims.map((item: any, index: number) => ({
          id: String(item.id || `claim-final-${index + 1}`),
          text: String(item.text || ''),
          type: String(item.type || 'fato'),
          status: item.status as ClaimStatus,
          sourceReference: String(item.sourceReference || ''),
          treatment: String(item.treatment || '')
        }))
      : claims
    finalSections = Array.isArray(finalValidationResult.parsed.correctedSections)
      ? finalValidationResult.parsed.correctedSections.map((item: any) => ({ title: String(item.title || ''), content: String(item.content || '') }))
      : reviewed
    finalValidationModel = finalValidationResult.model || reviewResult.model
  } else {
    finalClaims = claims.map(item => item.status === 'CONFIRMADA'
      ? { ...item, status: 'PARCIALMENTE CONFIRMADA' as ClaimStatus, treatment: `${item.treatment || ''} Documento original não disponível na validação final.`.trim() }
      : item)
  }

  const safeSections = ensureProvisionalCauseReviewMarker(
    applyDeterministicPieceFields(
      applyDefenseSafeguards(hardenCorrectedSections(finalSections, finalClaims), pieceType),
      publicRepresentation ? undefined : professionalProfile,
      pieceDate,
      publicRepresentation
    )
  )

  const promptVersion = [
    `motor-b-v9:base-${basePromptDoc.source}-v${basePromptDoc.version}`,
    `piece-${specificPromptDoc.source}-v${specificPromptDoc.version}`,
    `validator-${validatorPromptDoc.source}-v${validatorPromptDoc.version}`,
    `reviewer-${reviewerPromptDoc.source}-v${reviewerPromptDoc.version}`,
    originalFile ? 'final-original-v9' : 'final-original-unavailable'
  ].join('+')

  return {
    pieceType,
    title: cleanExportableText(String(reviewResult.parsed.title || draftResult.parsed.title || pieceType)),
    sections: safeSections,
    claims: finalClaims,
    validation: countValidation(finalClaims),
    model: finalValidationModel || validationResult.model || draftResult.model,
    promptVersion
  }
}

function extractPageIndexes(reference: string, pageCount: number) {
  const refs = String(reference || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const indexes = new Set<number>()

  const rangeRegex = /paginas?\s*(\d+)\s*(?:-|–|a)\s*(\d+)/gi
  let rangeMatch: RegExpExecArray | null
  while ((rangeMatch = rangeRegex.exec(refs))) {
    let start = Math.max(1, Math.min(Number(rangeMatch[1]), pageCount))
    let end = Math.max(start, Math.min(Number(rangeMatch[2]), pageCount))
    if (end - start > 12) end = start + 12
    for (let page = start; page <= end; page += 1) indexes.add(page - 1)
  }

  const pageListMatch = refs.match(/paginas?\s+([\d,; e]+)(?=$|\]|\)|\.|\n)/i)
  if (pageListMatch) {
    for (const token of pageListMatch[1].match(/\d+/g) || []) {
      const page = Number(token)
      if (page >= 1 && page <= pageCount) indexes.add(page - 1)
    }
  }

  const singleRegex = /(?:pagina|p\.)\s*[:#]?\s*(\d+)/gi
  let singleMatch: RegExpExecArray | null
  while ((singleMatch = singleRegex.exec(refs))) {
    const page = Number(singleMatch[1])
    if (page >= 1 && page <= pageCount) indexes.add(page - 1)
  }

  return [...indexes].sort((a,b)=>a-b)
}

async function buildValidationAttachment(file: File, claims: PieceClaim[]) {
  const sourceBytes = await file.arrayBuffer()
  const source = await PDFDocument.load(sourceBytes, { ignoreEncryption: true })
  const pageCount = source.getPageCount()

  if (file.size <= 8 * 1024 * 1024 && pageCount <= 60) {
    return { bytes: new Uint8Array(sourceBytes), pages: `1-${pageCount}`, complete: true }
  }

  const selected = new Set<number>()
  for (const claim of claims) {
    for (const index of extractPageIndexes(claim.sourceReference, pageCount)) selected.add(index)
  }

  // Para PDFs extensos, a validação final usa somente páginas efetivamente referenciadas.
  // Sem referência, não inventamos confirmação: incluímos no máximo as 6 primeiras páginas
  // para identificação básica e o validador deve manter o restante como pendente.
  if (!selected.size) {
    for (let i = 0; i < Math.min(6, pageCount); i += 1) selected.add(i)
  }

  const indexes = [...selected].sort((a,b)=>a-b).slice(0, 24)
  const target = await PDFDocument.create()
  const pages = await target.copyPages(source, indexes)
  pages.forEach(page => target.addPage(page))
  return {
    bytes: new Uint8Array(await target.save()),
    pages: indexes.map(index=>index+1).join(', '),
    complete: indexes.length === pageCount
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
  return btoa(binary)
}

export async function confirmClaimInOriginal(file: File, claim: PieceClaim): Promise<{ status: string; evidence: string; pages: string; note: string }> {
  const sourceBytes = await file.arrayBuffer()
  const source = await PDFDocument.load(sourceBytes, { ignoreEncryption: true })
  const indexes = extractPageIndexes(claim.sourceReference, source.getPageCount())
  if (!indexes.length) throw new Error('PIECE_TARGETED_SOURCE_NOT_AVAILABLE')

  const target = await PDFDocument.create()
  const pages = await target.copyPages(source, indexes.slice(0, 12))
  pages.forEach(page => target.addPage(page))
  const bytes = new Uint8Array(await target.save())
  const pageLabel = indexes.slice(0, 12).map(index=>index+1).join(', ')
  const prompt = `CONFIRMAÇÃO PONTUAL NO DOCUMENTO ORIGINAL.
AFIRMAÇÃO: ${claim.text}
REFERÊNCIA INFORMADA: ${claim.sourceReference}
PÁGINAS EFETIVAMENTE ANEXADAS: ${pageLabel}

Analise SOMENTE o PDF anexado.
- A existência de uma alegação confirma apenas que ela foi alegada; não confirma o conteúdo.
- Não transforme ausência de informação em prova de inexistência.
- Informe CONFIRMADO somente com suporte específico.
- Informe NÃO LOCALIZADO quando o suporte não estiver nas páginas.
- Informe DIVERGENTE quando o documento contrariar a afirmação.`
  const result = await generateJson(prompt, confirmationSchema, 'confirmação pontual no original v9', [{ inlineData: { data: bytesToBase64(bytes), mimeType: 'application/pdf' } }])
  return {
    status: String(result.parsed.status || 'NÃO LOCALIZADO'),
    evidence: String(result.parsed.evidence || ''),
    pages: String(result.parsed.pages || pageLabel),
    note: String(result.parsed.note || '')
  }
}
