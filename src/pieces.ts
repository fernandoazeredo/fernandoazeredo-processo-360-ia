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

export function suggestPieceTypeForReport(report: AnalysisReport) {
  const phase = inferProceduralPhase(report)

  if (report.area === 'Criminal' && /INSTRUÇÃO ENCERRADA|CONCLUSO PARA SENTENÇA/.test(phase)) {
    return 'Alegações Finais'
  }

  if (/INSTRUÇÃO ENCERRADA|CONCLUSO PARA SENTENÇA/.test(phase) && ['Consumidor','Tributário','Família','Previdenciário','Ambiental','Administrativo'].includes(report.area)) {
    return 'Memoriais / Alegações Finais'
  }

  if (report.area === 'Tributário' && /EMBARGOS JÁ OPOSTOS/.test(phase)) {
    return 'Memoriais / Alegações Finais'
  }

  if (report.area === 'Previdenciário' && report.perspective === 'Segurado' && hasDefenseInRecord(report) && hasJudicialExpertEvidence(report)) {
    return 'Réplica / Manifestação'
  }

  return suggestPieceType(report.area, report.perspective)
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
      Acusação: ['Denúncia', 'Alegações Finais', 'Petição / Manifestação'],
      Defesa: ['Defesa Prévia / Resposta à Acusação', 'Alegações Finais', 'Petição / Manifestação'],
      'Assistente de acusação': ['Petição / Manifestação'],
      Querelante: ['Petição / Manifestação']
    },
    Ambiental: { 'Autuado / Réu': ['Defesa / Impugnação', 'Memoriais / Alegações Finais', 'Petição / Manifestação'], 'Órgão Ambiental / MP': ['Memoriais / Alegações Finais', 'Petição / Manifestação'] },
    Tributário: { Contribuinte: ['Defesa / Impugnação', 'Embargos à Execução Fiscal', 'Memoriais / Alegações Finais', 'Petição / Manifestação'], 'Fazenda Pública': ['Petição de Execução', 'Impugnação aos Embargos', 'Memoriais / Alegações Finais', 'Petição / Manifestação'] },
    Administrativo: { Administrado: ['Defesa / Recurso', 'Memoriais / Alegações Finais', 'Petição / Manifestação'], 'Administração Pública': ['Memoriais / Alegações Finais', 'Petição / Manifestação'] },
    Previdenciário: { Segurado: ['Petição Inicial', 'Réplica / Manifestação', 'Memoriais / Alegações Finais', 'Quesitos Periciais', 'Petição / Manifestação'], INSS: ['Contestação', 'Memoriais / Alegações Finais', 'Quesitos Periciais', 'Petição / Manifestação'] },
    Consumidor: { Consumidor: ['Petição Inicial', 'Memoriais / Alegações Finais', 'Petição / Manifestação'], 'Fornecedor / Empresa': ['Contestação', 'Memoriais / Alegações Finais', 'Petição / Manifestação'] },
    Família: { Requerente: ['Petição Inicial', 'Memoriais / Alegações Finais', 'Petição / Manifestação'], Requerido: ['Contestação', 'Memoriais / Alegações Finais', 'Petição / Manifestação'] },
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

  const common = `
PROCESSO 360 IA — MOTOR B V9 — ${area.toUpperCase()} / ${perspective.toUpperCase()}
TIPO SOLICITADO: ${pieceType}

A perspectiva altera a tese e a estratégia, nunca a base factual. Não transforme alegação em fato, recomendação em acontecimento ocorrido nem ausência de informação em prova negativa. Toda afirmação material categórica exige suporte documental específico. Sem suporte, use linguagem condicional e registre a pendência. Identifique a fase processual antes de estruturar pedidos e não declare tempestividade sem os marcos necessários. Não preencha foro, vara, representante ou assinatura por inferência. Em representação pública, use fecho institucional compatível e não reutilize OAB privada.
`.trim()

  const rules: Record<string,string> = {
    Criminal: `
CRIMINAL:
- Primariedade e bons antecedentes exigem certidão/registro de antecedentes efetivamente presente. Sem esse documento, NÃO afirmar que o acusado é primário ou possui bons antecedentes; usar [DADO A CONFIRMAR] quando o ponto for relevante. O validador nunca pode classificar essa afirmação como CONFIRMADA sem a certidão correspondente.
- Não inferir ausência de flagrante apenas pela ausência de apreensão.
- Não inventar qualificadora, causa de aumento, laudo/corpo de delito, conteúdo de câmera, depoimento futuro, testemunho ainda não prestado, procuração anexa ou qualquer documento não localizado.
- Não afirmar "ausência de laudo", "inexistência de laudo" ou equivalente como FATO apenas porque o documento não foi localizado. Quando a ausência não estiver expressamente documentada, usar "não foi localizado laudo nos dados fornecidos" ou formulação equivalente que preserve a limitação da fonte.
- Não afirmar que testemunha depôs "sob compromisso legal", "compromissada" ou equivalente sem suporte textual específico no termo/ata/depoimento. Na dúvida, dizer apenas que a testemunha prestou depoimento.
- Absolvição sumária exige enquadramento em hipótese legal pertinente; insuficiência probatória genérica não deve ser tratada automaticamente como art. 397 do CPP.
- Se a instrução estiver encerrada, Defesa Prévia / Resposta à Acusação é incompatível: produzir/sugerir Alegações Finais e fundamentar a absolvição conforme a fase, inclusive art. 386 quando pertinente aos dados, sem importar automaticamente o art. 397.
- Em Alegações Finais da Defesa, quando juridicamente pertinentes aos fatos e à imputação documentada, examinar pedidos subsidiários de pena no mínimo legal, substituição por penas restritivas de direitos e desclassificação; não criar requisito fático ausente.
- Distinguir falta de justa causa, absolvição sumária e absolvição após instrução.
- Na Acusação/MP, usar representação institucional efetivamente identificada nos autos.`,
    Ambiental: `
AMBIENTAL:
- Distinguir responsabilidade administrativa sancionadora de responsabilidade civil ambiental.
- Localização/proximidade da fábrica não comprova nexo causal.
- Paralisação de produção, tubulação de terceiro e origem do efluente permanecem alegação/hipótese conforme a fonte.
- Não inventar procedimento administrativo, ponto de coleta, lançamento contínuo ou resultado de perícia.
- Pedidos de prova técnica devem investigar a origem sem antecipar conclusão.
- Se os autos contiverem proposta de TAC, acordo ou composição ambiental, a peça deve enfrentá-la expressamente, preservando valor, data, condições e autoria exatamente como documentados. Se constar proposta de TAC de R$ 600.000,00, mencionar esse valor e contextualizar juridicamente sem tratá-lo como acordo firmado ou confissão, salvo se houver prova específica disso.`,
    Tributário: `
TRIBUTÁRIO:
- Separar principal, multa, juros, total, depósito e valor da causa.
- Não deslocar pagamento entre competências sem prova. Pagamento de R$ 10.000,00 com alocação controvertida deve permanecer controvertido.
- Abatimentos e saldos derivados devem mostrar fórmula e ser condicionados ao reconhecimento jurídico da imputação do pagamento.
- Distinguir ausência de efeito suspensivo dos embargos da suspensão da exigibilidade por depósito integral, quando juridicamente pertinente.
- Não afirmar requisitos/capitulação da CDA sem acesso aos campos correspondentes.`,
    Administrativo: `
ADMINISTRATIVO:
- Identificar o ente e verificar se a legislação aplicável é municipal/estadual/federal; não aplicar automaticamente a Lei 9.784/1999 a Município.
- Se houver referência à Lei 9.784/1999, explicitar eventual aplicação subsidiária e a base fornecida.
- Protocolo de renovação não equivale a licença vigente.
- Não atribuir automaticamente pendência documental à empresa sem fonte.
- Distinguir campo de motivação vazio, conteúdo desconhecido e nulidade efetivamente reconhecida.
- Quando houver discussão de "direito líquido e certo", a peça deve enfrentá-la expressamente: identificar qual direito é alegado, qual prova pré-constituída o sustentaria e quais controvérsias ou lacunas impedem tratá-lo automaticamente como demonstrado.
- Se houver atestados, laudos ou documentos médicos apresentados somente depois do processo administrativo, a peça deve confrontar expressamente a cronologia e a força probatória desses documentos, sem fingir que integravam o processo administrativo desde o início.
- Não concluir nulidade insanável ou regularidade integral sem suporte suficiente.`,
    Previdenciário: `
PREVIDENCIÁRIO:
- Avaliar incapacidade em relação à atividade habitual e às exigências concretas da função.
- Capacidade para tarefa leve não equivale automaticamente à capacidade para movimentar caixas de 20 kg.
- Separar DID, DII, DER, DIB e DCB; não criar datas automáticas.
- Não antecipar conclusão pericial.
- Abatimentos de salários/remunerações dependem de fundamento jurídico e dados do período; não usar fórmula genérica sem suporte.
- Na perspectiva INSS, usar representação institucional, não assinatura privada.`,
    Consumidor: `
CONSUMIDOR:
- Não afirmar cumprimento/descumprimento de liminar sem prova posterior específica.
- Não inventar termo de comodato, relatório de triagem, prova de serial ou documento não disponível.
- Divergência de serial permanece controvérsia até comprovação.
- Recebimento postal não prova, sozinho, identidade do aparelho.
- Baixa provisória de negativação não equivale a decisão definitiva sobre a dívida.
- Ordem de exibição não significa automaticamente inversão do ônus da prova.`,
    Família: `
FAMÍLIA:
- Planilha de despesas não equivale a recibos/comprovantes.
- Amostra curta de holerites não permite afirmar com certeza habitualidade ou excepcionalidade de horas extras.
- Transferência de R$ 500,00 sem finalidade identificada permanece controvertida.
- Não inventar acordo de material escolar ou destinação alimentar comprovada.
- Distinguir pedido, alimentos provisórios e oferta.
- Capacidade dos dois genitores, necessidades da criança e cuidados cotidianos devem ser analisados sem presumir fatos ausentes.`,
    Empresarial: `
EMPRESARIAL:
- Cláusula contratual que prevê treinamento não comprova sua realização nem sua ausência.
- Não inventar juntada de planilha, logs, procuração, preservação concluída ou falha técnica comprovada.
- Preservação para eventual perícia não equivale a perícia realizada.
- A origem da duplicidade dos 120 itens permanece controvertida sem prova técnica.
- Distinguir disponibilização do módulo, aceite e cumprimento integral.
- Não antecipar o que eventual perícia demonstrará.`,
    Cível: `
CÍVEL:
- Identifique contrato, inadimplemento, prova do fato constitutivo/impeditivo e fase processual sem presumir documentos.
- Não transforme alegação de dano, pagamento, entrega ou mora em fato comprovado sem suporte específico.
- Réplica só deve ser sugerida quando houver defesa efetivamente apresentada.`
  }

  return {
    purpose: `Motor B — ${area} — ${perspective} — ${pieceType}`,
    fallback: `${common}\n\n${rules[area] || 'Aplique rigor factual, fase processual correta, representação compatível e pedidos limitados ao suporte documental.'}`
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
  const factualFindings = Array.isArray(report.factualFindings)
    ? report.factualFindings.map(item => `${item.classification || ''} ${item.statement || ''} ${item.source || ''} ${item.excerpt || ''}`).join('\n')
    : ''
  const pendingItems = Array.isArray(report.pendingItems)
    ? report.pendingItems.map(item => `${item.item || ''} ${item.reason || ''} ${item.evidenceNeeded || ''}`).join('\n')
    : ''
  const sources = Array.isArray(report.sources)
    ? report.sources.map(item => `${item.note || ''} ${item.pages || ''}`).join('\n')
    : ''

  return `${report.executiveSummary}\n${report.claimsEvidenceDecisions}\n${report.globalAnalysis}\n${report.conclusionStrategy}\n${report.timeline.map(item => `${item.event} ${item.reference}`).join('\n')}\n${factualFindings}\n${pendingItems}\n${sources}`.toLowerCase()
}

function hasDefenseInRecord(report: AnalysisReport) {
  const text = reportText(report)
  const explicitAbsence = /(?:não|nao)\s+(?:há|ha|consta|existe|foi\s+(?:localizada|identificada|apresentada|juntada))[^.\n]{0,100}(?:contestação|contestacao|defesa)/i.test(text)
    || /(?:contestação|contestacao|defesa)[^.\n]{0,100}(?:não|nao)\s+(?:consta|foi\s+(?:localizada|identificada|apresentada|juntada))/i.test(text)
  if (explicitAbsence) return false

  return /(?:contestação|contestacao|defesa)(?:\s+do\s+inss)?[^.;\n]{0,120}(?:apresentad|protocolad|juntad|oferecid|consta|exist)/i.test(text)
    || /(?:apresentad|protocolad|juntad|oferecid|consta|exist)[^.;\n]{0,120}(?:contestação|contestacao|defesa)(?:\s+do\s+inss)?/i.test(text)
    || /\bcontestação\s+do\s+inss\b/i.test(text)
    || /\bdefesa\s+do\s+inss\b/i.test(text)
}

function hasJudicialExpertEvidence(report: AnalysisReport) {
  const text = reportText(report)
  const explicitAbsence = /(?:não|nao)\s+(?:há|ha|consta|existe|foi\s+(?:realizada|produzida|juntada|localizada|identificada))[^.\n]{0,100}(?:perícia|pericia|laudo\s+pericial)/i.test(text)
    || /(?:perícia|pericia|laudo\s+pericial)[^.\n]{0,100}(?:não|nao)\s+(?:consta|existe|foi\s+(?:realizada|produzida|juntada|localizada|identificada))/i.test(text)
  if (explicitAbsence) return false

  return /(?:perícia|pericia)\s+judicial/i.test(text)
    || /(?:laudo|parecer)\s+pericial/i.test(text)
    || /(?:perícia|pericia)[^.\n]{0,160}(?:realizad|produzid|juntad|concluíd|concluid|apresentad|dii|incapacid)/i.test(text)
    || /(?:realizad|produzid|juntad|concluíd|concluid|apresentad|dii|incapacid)[^.\n]{0,160}(?:perícia|pericia)/i.test(text)
    || /perito[^.\n]{0,160}(?:conclu|apur|atest|inform|dii|incapacid)/i.test(text)
}

function inferProceduralPhase(report: AnalysisReport) {
  const haystack = `${report.executiveSummary}\n${report.claimsEvidenceDecisions}\n${report.globalAnalysis}\n${report.timeline.map(item => `${item.event} ${item.reference}`).join('\n')}`.toLowerCase()
  const hasProcessNumber = Boolean(report.processNumber && !/informação não constante/i.test(report.processNumber))
  const instructionClosed = /(?:instrução|instrucao)[^\.\n]{0,120}(?:encerrad|concluíd|concluid)|(?:encerrad|concluíd|concluid)[^\.\n]{0,120}(?:instrução|instrucao)|alegações finais|alegacoes finais|memoriais|razões finais|razoes finais|art\.\s*403\b/.test(haystack)
  if (instructionClosed) {
    return 'INSTRUÇÃO ENCERRADA — fase de Memoriais / Alegações Finais'
  }
  if (/conclus(?:o|os|a|as)[^\.\n]{0,80}(?:sentença|sentenca)|(?:sentença|sentenca)[^\.\n]{0,80}conclus(?:o|os|a|as)/.test(haystack)) {
    return 'CONCLUSO PARA SENTENÇA — fase compatível com Memoriais / Alegações Finais'
  }
  if (report.area === 'Tributário' && /embargos[^\.\n]{0,100}(?:opost|ajuizad|apresentad)|(?:opost|ajuizad|apresentad)[^\.\n]{0,100}embargos/.test(haystack)) {
    return 'EMBARGOS JÁ OPOSTOS — identificar fase posterior antes de nova defesa inicial'
  }
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

function criticalAssertionsFromSections(sections: PieceSection[]) {
  const pattern = /(primariedade|sem antecedentes|junta(?:-se)? aos autos|juntou aos autos|acosta(?:ndo)? aos autos|cumpr(?:iu|imento|ida|ido)|preserv(?:ou|ado|ação)|manteve\s+(?:intact|intocad)|regulariz(?:ou|ado)|restou demonstrad|comprovou-se|comprovad[oa]|perícia[^.]{0,100}(?:confirmou|comprovou|ratificará|demonstrará)|decorrido o prazo|tempestiv[ao]|efetivação da baixa|retirada do gravame)/i
  const results: string[] = []
  for (const section of sections) {
    const sentences = String(section.content || '').split(/(?<=[.!?;])\s+|\n+/)
    for (const sentence of sentences) {
      const clean = sentence.trim()
      if (clean.length >= 18 && pattern.test(clean)) results.push(clean.slice(0, 700))
    }
  }
  return Array.from(new Set(results)).slice(0, 24)
}

async function applyCriticalFactualGate(
  report: AnalysisReport,
  pieceType: string,
  sections: PieceSection[],
  claims: PieceClaim[],
  originalFile: File,
  validatorPromptDoc: LoadedPrompt
): Promise<{ sections: PieceSection[]; claims: PieceClaim[]; model?: string }> {
  const critical = criticalAssertionsFromSections(sections)
  if (!critical.length) return { sections, claims }

  const attachment = await buildValidationAttachment(originalFile, claims)
  const prompt = `${validatorPromptDoc.content}

[BARREIRA FACTUAL CRÍTICA — V9]
ÁREA: ${report.area}
PERSPECTIVA: ${report.perspective}
TIPO: ${pieceType}

[MINUTA A CONFERIR]
${JSON.stringify(sections, null, 2)}

[AFIRMAÇÕES CRÍTICAS DETECTADAS PELO SISTEMA]
${JSON.stringify(critical, null, 2)}

[CLAIMS ATUAIS — NÃO SÃO FONTE DE VERDADE]
${JSON.stringify(claims, null, 2)}

Use SOMENTE o PDF original anexado como fonte primária.

REGRAS OBRIGATÓRIAS:
1. Confira individualmente TODAS as afirmações críticas listadas.
2. Para cada uma, gere claim específico. CONFIRMADA/CORRIGIDA exige sourceReference com página e treatment com trecho curto de suporte do PDF.
3. A mera alegação de uma parte confirma apenas que a alegação existe, não o conteúdo alegado.
4. "Junta aos autos", "acosta", "cumpriu", "preservou", "regularizou", "primariedade", "sem antecedentes", "tempestiva", "decurso de prazo", "perícia confirmou/demonstrará" e equivalentes NÃO podem permanecer categóricos sem suporte documental específico.
5. Se a prova não estiver no PDF anexado, reescreva a frase de modo condicional, como pedido, alegação ou pendência; ou remova a afirmação.
6. Não invente documento a ser juntado, cumprimento de decisão, evento posterior, certidão, antecedentes, resultado pericial ou confirmação técnica.
7. correctedSections deve conter a peça integral já corrigida, não apenas os trechos alterados.
8. Se houver dúvida, prefira PARCIALMENTE CONFIRMADA ou NÃO CONFIRMADA e linguagem conservadora.`

  const result = await generateJson(
    prompt,
    validationSchema,
    'barreira factual crítica v9',
    [{ inlineData: { data: bytesToBase64(attachment.bytes), mimeType: 'application/pdf' } }]
  )

  const nextClaims: PieceClaim[] = Array.isArray(result.parsed.claims)
    ? result.parsed.claims.map((item: any, index: number) => ({
        id: String(item.id || `claim-gate-${index + 1}`),
        text: String(item.text || ''),
        type: String(item.type || 'fato crítico'),
        status: item.status as ClaimStatus,
        sourceReference: String(item.sourceReference || ''),
        treatment: String(item.treatment || '')
      }))
    : claims

  const nextSections: PieceSection[] = Array.isArray(result.parsed.correctedSections)
    ? result.parsed.correctedSections.map((item: any) => ({
        title: String(item.title || ''),
        content: String(item.content || '')
      }))
    : sections

  return { sections: nextSections, claims: nextClaims, model: result.model }
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
  const effectivePieceType = report.area === 'Criminal' && /INSTRUÇÃO ENCERRADA/.test(phase) && /Defesa Prévia|Resposta à Acusação|Denúncia/i.test(pieceType)
    ? 'Alegações Finais'
    : pieceType
  const specific = specificPiecePrompt(report.area, report.perspective, effectivePieceType)
  const currentDate = new Intl.DateTimeFormat('pt-BR').format(new Date())
  const isInitialPiece = /petição inicial/i.test(effectivePieceType)
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

  const draftPrompt = `${basePromptDoc.content}\n\n${specificPromptDoc.content}\n\nÁREA: ${report.area}\nPERSPECTIVA: ${report.perspective}\nTIPO SOLICITADO: ${effectivePieceType}\nFASE PROCESSUAL INFERIDA: ${phase}\nDATA ATUAL DO SISTEMA: ${currentDate}\nDATA A UTILIZAR NA PEÇA: ${pieceDate}\nREGRA DE DATA: em Petição Inicial, use a data de ajuizamento/distribuição expressamente identificada; se ela não estiver identificada, preserve [DATA]. Nunca use a data atual como se fosse a data histórica de ajuizamento.\n\n[DADOS_PROFISSIONAIS_DO_ADVOGADO]\n${professional}\n\n[DADOS_CONSOLIDADOS_DO_PROCESSO]\n${source}\n\n[DIAGNOSTICO_JURIDICO]\n${diagnostic}\n\nINSTRUÇÃO DE INTEGRIDADE FACTUAL: a perspectiva define argumentação, não os acontecimentos. Não converta alegação em fato. Frases como "cumpriu", "juntou", "preservou", "regularizou", "não realizou", "restou comprovado" e equivalentes só podem ser categóricas com suporte documental específico; sem suporte, use formulação condicional/controvertida.
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

  const reviewPrompt = `${reviewerPromptDoc.content}\n\nÁREA: ${report.area}\nPERSPECTIVA: ${report.perspective}\nTIPO: ${effectivePieceType}\nFASE: ${phase}\nDATA ATUAL DO SISTEMA: ${currentDate}\nDATA A UTILIZAR NA PEÇA: ${pieceDate}\nREGRA DE DATA: em Petição Inicial, use a data de ajuizamento/distribuição expressamente identificada; se ela não estiver identificada, preserve [DATA]. Nunca use a data atual como se fosse a data histórica de ajuizamento.\n\n[DADOS_PROFISSIONAIS_DO_ADVOGADO]\n${professional}\n\n[DADOS_CONSOLIDADOS_DO_PROCESSO]\n${source}\n\n[DIAGNOSTICO_JURIDICO]\n${diagnostic}\n\n[VALIDACAO]\n${JSON.stringify({ claims, validation: countValidation(claims) }, null, 2)}\n\n[MINUTA_CORRIGIDA]\n${JSON.stringify(factSafeSections, null, 2)}\n\nINSTRUÇÃO: devolva title e sections. Não reinsira referências técnicas ou avisos internos.`
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
TIPO: ${effectivePieceType}

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

  if (originalFile) {
    const gated = await applyCriticalFactualGate(
      report,
      pieceType,
      finalSections,
      finalClaims,
      originalFile,
      validatorPromptDoc
    )
    finalSections = gated.sections
    finalClaims = gated.claims
    finalValidationModel = gated.model || finalValidationModel
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
    pieceType: effectivePieceType,
    title: cleanExportableText(String(reviewResult.parsed.title || draftResult.parsed.title || pieceType)),
    sections: safeSections,
    claims: finalClaims,
    validation: countValidation(finalClaims),
    model: finalValidationModel || validationResult.model || draftResult.model,
    promptVersion
  }
}


export async function revalidateLegalPiece(
  report: AnalysisReport,
  piece: LegalPieceDraft,
  originalFile: File,
  professionalProfile?: ProfessionalProfile
): Promise<LegalPieceDraft> {
  const validatorPromptDoc = await loadMotorBPrompt(
    report.area,
    report.perspective,
    MOTOR_B_PURPOSES.validator,
    MOTOR_B_VALIDATOR
  )
  const attachment = await buildValidationAttachment(originalFile, piece.claims)
  const publicRepresentation = usesPublicRepresentation(report.area, report.perspective)
  const currentDate = new Intl.DateTimeFormat('pt-BR').format(new Date())
  const pieceDate = /petição inicial/i.test(piece.pieceType) ? inferInitialFilingDate(report) : currentDate

  const prompt = `${validatorPromptDoc.content}

[REVALIDAÇÃO APÓS EDIÇÃO MANUAL]
ÁREA: ${report.area}
PERSPECTIVA: ${report.perspective}
TIPO: ${piece.pieceType}

[MINUTA EDITADA]
${JSON.stringify(piece.sections, null, 2)}

[VALIDAÇÃO ANTERIOR — APENAS REFERÊNCIA, NÃO FONTE DE VERDADE]
${JSON.stringify(piece.claims, null, 2)}

REGRAS OBRIGATÓRIAS:
1. A edição manual INVALIDOU a validação anterior.
2. Reavalie todas as afirmações materiais da versão editada contra o PDF original anexado.
3. Não confirme fato apenas porque estava confirmado antes ou porque consta do relatório da IA.
4. Para CONFIRMADA, sourceReference deve indicar página(s) e treatment deve incluir um trecho curto de suporte do documento.
5. Se o trecho não estiver disponível nas páginas anexadas, use NÃO CONFIRMADA ou PARCIALMENTE CONFIRMADA.
6. Alegação de parte deve permanecer alegação; sua existência não comprova seu conteúdo.
7. correctedSections deve conter exatamente a versão revalidada, com linguagem condicional onde faltar prova.
8. Não crie fato novo, documento, juntada, cumprimento, depoimento, preservação, perícia ou evento posterior.`

  const result = await generateJson(
    prompt,
    validationSchema,
    'revalidação factual após edição v9',
    [{ inlineData: { data: bytesToBase64(attachment.bytes), mimeType: 'application/pdf' } }]
  )

  const claims: PieceClaim[] = Array.isArray(result.parsed.claims)
    ? result.parsed.claims.map((item: any, index: number) => ({
        id: String(item.id || `claim-revalidado-${index + 1}`),
        text: String(item.text || ''),
        type: String(item.type || 'fato'),
        status: item.status as ClaimStatus,
        sourceReference: String(item.sourceReference || ''),
        treatment: String(item.treatment || '')
      }))
    : piece.claims

  const corrected = Array.isArray(result.parsed.correctedSections)
    ? result.parsed.correctedSections.map((item: any) => ({
        title: String(item.title || ''),
        content: String(item.content || '')
      }))
    : piece.sections

  const gated = await applyCriticalFactualGate(
    report,
    piece.pieceType,
    corrected,
    claims,
    originalFile,
    validatorPromptDoc
  )

  const safeSections = ensureProvisionalCauseReviewMarker(
    applyDeterministicPieceFields(
      applyDefenseSafeguards(hardenCorrectedSections(gated.sections, gated.claims), piece.pieceType),
      publicRepresentation ? undefined : professionalProfile,
      pieceDate,
      publicRepresentation
    )
  )

  return {
    ...piece,
    sections: safeSections,
    claims: gated.claims,
    validation: countValidation(gated.claims),
    model: gated.model || result.model || piece.model,
    promptVersion: `${piece.promptVersion}+manual-revalidation-v9`
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
