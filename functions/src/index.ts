import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, FieldValue, DocumentReference } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import OpenAI, { toFile } from 'openai'
import { PDFDocument } from 'pdf-lib'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

initializeApp()

const db = getFirestore()
const bucket = getStorage().bucket()
const LOT_SIZE = 170
const LOT_CONCURRENCY = 2
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY')
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-sol'
const GLOBAL_RIGOR_VERSION = 2
const OPENAI_POLL_MS = 5000

const GLOBAL_RIGOR = `
PROCESSO 360 IA — PADRÃO GLOBAL DE RIGOR

Você executará um prompt técnico específico em cada chamada. O prompt específico define O QUE fazer; estas regras definem COMO executar com rigor.

1. Siga integralmente a estrutura e o formato exigidos pelo prompt específico. Não pule itens, não funda blocos, não reordene e não acrescente seções não solicitadas.
2. Não inclua introdução, saudação, disclaimer genérico, opinião pessoal ou conteúdo fora do que foi pedido.
3. Formato de saída é obrigatório. Se o prompt exigir tabela, rótulo, ordem ou estrutura determinada, cumpra exatamente.
4. Baseie toda afirmação factual exclusivamente no material fornecido nesta chamada. Nunca invente fatos, datas, valores, documentos, páginas, provas, decisões, precedentes ou probabilidades.
5. Preserve a área jurídica e a perspectiva informadas durante toda a execução. Considere a posição contrária somente quando o prompt específico exigir esse confronto.
6. Vincule cada fato, prova, data, valor ou decisão à referência de origem disponível (página, lote, peça ou outra referência fornecida).
7. Em extração de lote isolado, trate o lote apenas como parte do processo. Extraia e catalogue; não conclua mérito, força de tese, risco global ou estratégia final com base em um único lote.
8. Em consolidação, considere todos os lotes fornecidos antes de concluir. Identifique duplicidades, complementaridades e contradições entre lotes e só então produza diagnóstico global. Ao final, confirme quantos lotes foram considerados.
9. Antes de entregar, verifique internamente: todos os itens pedidos foram respondidos; o formato foi respeitado; afirmações factuais possuem referência; nenhuma conclusão excede os dados disponíveis.
10. Sempre que um fato, folha, data, valor ou documento necessário não constar nos dados fornecidos, escreva exatamente: "Informação não constante nos dados fornecidos".
11. Sempre que o prompt pedir grau de risco, probabilidade de êxito, solidez ou classificação equivalente, use estritamente um destes rótulos: "Alta", "Média" ou "Baixa". Não use percentuais nem rótulos alternativos.
12. Se uma regra operacional do prompt específico exigir detalhe diferente, prevalece o prompt específico nesse detalhe, preservando não invenção, rastreabilidade e completude.
`.trim()

type PromptDoc = {
  title?: string
  area?: string
  perspective?: string
  purpose?: string
  content?: string
  version?: number
  status?: string
}

const DEFAULT_PROMPT_FILES: Record<string, string> = {
  'Trabalhista|||Reclamada': '01_Trabalhista_Favor_Reclamada.txt',
  'Trabalhista|||Reclamante': '02_Trabalhista_Favor_Reclamante.txt',
  'Cível|||Réu': '03_Civel_Favor_Reu.txt',
  'Cível|||Autor': '04_Civel_Favor_Autor.txt',
  'Criminal|||Defesa': '05_Criminal_Favor_Defesa.txt',
  'Criminal|||Acusação': '06_Criminal_Favor_Acusacao.txt',
  'Criminal|||Assistente de acusação': '06B_Criminal_Favor_AssistenteAcusacao.txt',
  'Criminal|||Querelante': '06C_Criminal_Favor_Querelante.txt',
  'Ambiental|||Autuado / Réu': '07_Ambiental_Favor_Autuado.txt',
  'Ambiental|||Órgão Ambiental / MP': '08_Ambiental_Favor_OrgaoAmbiental_MP.txt',
  'Tributário|||Contribuinte': '09_Tributario_Favor_Contribuinte.txt',
  'Tributário|||Fazenda Pública': '10_Tributario_Favor_FazendaPublica.txt',
  'Administrativo|||Administrado': '11_Administrativo_Favor_Administrado.txt',
  'Administrativo|||Administração Pública': '12_Administrativo_Favor_AdministracaoPublica.txt',
  'Previdenciário|||Segurado': '13_Previdenciario_Favor_Segurado.txt',
  'Previdenciário|||INSS': '14_Previdenciario_Favor_INSS.txt',
  'Consumidor|||Consumidor': '15_Consumidor_Favor_Consumidor.txt',
  'Consumidor|||Fornecedor / Empresa': '16_Consumidor_Favor_Fornecedor.txt',
  'Família|||Requerente': '17_Familia_Favor_Requerente.txt',
  'Família|||Requerido': '18_Familia_Favor_Requerido.txt',
  'Empresarial|||Parte Autora': '19_Empresarial_Favor_ParteAutora.txt',
  'Empresarial|||Parte Ré': '20_Empresarial_Favor_ParteRe.txt'
}

const extractionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lotNumber: { type: 'integer' },
    pages: { type: 'string' },
    synopsis: { type: 'string' },
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string' },
          event: { type: 'string' },
          reference: { type: 'string' }
        },
        required: ['date', 'event', 'reference']
      }
    },
    claims: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    monetaryValues: { type: 'array', items: { type: 'string' } },
    proceduralIssues: { type: 'array', items: { type: 'string' } },
    favorablePoints: { type: 'array', items: { type: 'string' } },
    adversePoints: { type: 'array', items: { type: 'string' } },
    unresolvedQuestions: { type: 'array', items: { type: 'string' } }
  },
  required: ['lotNumber','pages','synopsis','timeline','claims','evidence','decisions','monetaryValues','proceduralIssues','favorablePoints','adversePoints','unresolvedQuestions']
}

const finalSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executiveSummary: { type: 'string' },
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string' },
          event: { type: 'string' },
          reference: { type: 'string' }
        },
        required: ['date','event','reference']
      }
    },
    claimsEvidenceDecisions: { type: 'string' },
    globalAnalysis: { type: 'string' },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item: { type: 'string' },
          level: { type: 'string' },
          basis: { type: 'string' }
        },
        required: ['item','level','basis']
      }
    },
    conclusionStrategy: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lot: { type: 'integer' },
          pages: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['lot','pages','note']
      }
    }
  },
  required: ['executiveSummary','timeline','claimsEvidenceDecisions','globalAnalysis','risks','conclusionStrategy','sources']
}

function promptText(prompts: PromptDoc[], purposes: string[], fallback: string) {
  const selected = prompts.filter(p => p.purpose && purposes.includes(p.purpose) && p.content?.trim())
  if (!selected.length) return fallback

  const latestByPurpose = new Map<string, PromptDoc>()
  for (const prompt of selected) {
    const purpose = prompt.purpose as string
    const current = latestByPurpose.get(purpose)
    if (!current || (prompt.version || 0) > (current.version || 0)) {
      latestByPurpose.set(purpose, prompt)
    }
  }

  return purposes
    .map(purpose => latestByPurpose.get(purpose))
    .filter((p): p is PromptDoc => Boolean(p))
    .map(p => `### ${p.purpose} — ${p.title || 'Prompt'} — v${p.version || 1}\n${p.content}`)
    .join('\n\n')
}
async function loadPrompts(area: string, perspective: string) {
  const snap = await db.collection('prompts').where('status', '==', 'publicado').get()
  const prompts = snap.docs
    .map(d => d.data() as PromptDoc)
    .filter(p => p.area === area && p.perspective === perspective)

  const hasGlobalAnalysis = prompts.some(p => p.purpose === 'Análise jurídica global' && p.content?.trim())
  if (!hasGlobalAnalysis) {
    const fileName = DEFAULT_PROMPT_FILES[`${area}|||${perspective}`]
    if (fileName) {
      const filePath = path.resolve(__dirname, '../prompts', fileName)
      const content = (await readFile(filePath, 'utf8')).trim()
      prompts.push({
        title: `Prompt jurídico padrão — ${area} / ${perspective}`,
        area,
        perspective,
        purpose: 'Análise jurídica global',
        content,
        version: 1,
        status: 'publicado'
      })
    }
  }

  return prompts
}

async function waitForOpenAIResponse(
  client: OpenAI,
  response: any,
  analysisRef: DocumentReference,
  stageLabel: string
) {
  const startedAt = Date.now()
  let current = response
  let lastHeartbeat = 0

  while (current?.status === 'queued' || current?.status === 'in_progress') {
    await new Promise(resolve => setTimeout(resolve, OPENAI_POLL_MS))
    current = await client.responses.retrieve(current.id)

    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    if (elapsedSeconds - lastHeartbeat >= 10) {
      lastHeartbeat = elapsedSeconds
      await analysisRef.set({
        stage: `${stageLabel} — IA em processamento há ${elapsedSeconds}s`,
        openaiResponseId: current.id,
        openaiStatus: current.status,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true })
    }
  }

  if (current?.status !== 'completed') {
    const detail =
      current?.error?.message ||
      current?.incomplete_details?.reason ||
      `status final ${current?.status || 'desconhecido'}`
    throw new Error(`OpenAI não concluiu a resposta: ${detail}`)
  }

  return current
}

async function splitPdf(pdfBytes: Buffer) {
  const source = await PDFDocument.load(pdfBytes, { ignoreEncryption: true })
  const pageCount = source.getPageCount()
  const lots: Array<{ number: number; start: number; end: number; bytes: Uint8Array }> = []

  for (let start = 0, number = 1; start < pageCount; start += LOT_SIZE, number++) {
    const endExclusive = Math.min(start + LOT_SIZE, pageCount)
    const target = await PDFDocument.create()
    const pageIndexes = Array.from({ length: endExclusive - start }, (_, i) => start + i)
    const copied = await target.copyPages(source, pageIndexes)
    copied.forEach(page => target.addPage(page))
    lots.push({
      number,
      start: start + 1,
      end: endExclusive,
      bytes: await target.save()
    })
  }
  return { pageCount, lots }
}

export const analyzeProcess = onCall(
  {
    region: 'us-central1',
    timeoutSeconds: 3600,
    memory: '4GiB',
    cors: true,
    secrets: [OPENAI_API_KEY]
  },
  async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'É necessário estar autenticado.')
    const { analysisId, storagePath, fileName, area, perspective } = request.data || {}
    if (!analysisId || !storagePath || !fileName || !area || !perspective) {
      throw new HttpsError('invalid-argument', 'Dados da análise incompletos.')
    }
    if (!String(storagePath).startsWith(`processos/${request.auth.uid}/`)) {
      throw new HttpsError('permission-denied', 'Arquivo não pertence ao usuário autenticado.')
    }

    const apiKey = OPENAI_API_KEY.value()
    if (!apiKey) {
      throw new HttpsError('failed-precondition', 'OPENAI_API_KEY ainda não foi configurada no backend.')
    }

    const analysisRef = db.collection('processos').doc(String(analysisId))
    await analysisRef.set({
      ownerUid: request.auth.uid,
      fileName,
      storagePath,
      area,
      perspective,
      status: 'preparando',
      stage: 'Preparando arquivo e prompts jurídicos',
      progress: 33,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true })

    try {
      const [fileBuffer] = await bucket.file(String(storagePath)).download()
      const prompts = await loadPrompts(String(area), String(perspective))
      const { pageCount, lots } = await splitPdf(fileBuffer)

      await analysisRef.set({
        pageCount,
        lotCount: lots.length,
        status: 'extraindo',
        stage: `PDF dividido em ${lots.length} lote(s). Preparando análise`,
        progress: 36,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true })

      const client = new OpenAI({ apiKey })
      const lotResults: unknown[] = new Array(lots.length)
      let completedLots = 0
      const extractionInstructions = promptText(
        prompts,
        ['Preparação e leitura inicial','Extração por lote','Catalogação documental'],
        `Você é um analista jurídico de alta precisão. Leia integralmente este lote do processo.
Extraia somente fatos, alegações, provas, decisões, valores e eventos efetivamente presentes.
Não produza conclusão global antes da leitura de todos os lotes.
Preserve referências de página quando identificáveis e declare incerteza quando a referência não puder ser determinada.`
      )

      const processLot = async (lot: typeof lots[number]) => {
        const lotStartedAt = Date.now()
        const uploadStartedAt = Date.now()
        const uploaded = await client.files.create({
          file: await toFile(Buffer.from(lot.bytes), `lote-${lot.number}.pdf`, { type: 'application/pdf' }),
          purpose: 'user_data'
        })
        const uploadMs = Date.now() - uploadStartedAt

        try {
          const createStartedAt = Date.now()
          const startedResponse = await client.responses.create({
            model: DEFAULT_MODEL,
            reasoning: { effort: 'medium' },
            background: true,
            input: [
              {
                role: 'developer',
                content: [{ type: 'input_text', text: GLOBAL_RIGOR }]
              },
              {
                role: 'user',
                content: [
                  { type: 'input_file', file_id: uploaded.id, detail: 'auto' },
                  {
                    type: 'input_text',
                    text: `${extractionInstructions}

CONTEXTO OBRIGATÓRIO:
Área: ${area}
Perspectiva: ${perspective}
Lote: ${lot.number} de ${lots.length}
Páginas do PDF original: ${lot.start}-${lot.end}

Analise este lote sem antecipar o diagnóstico final. O resultado deve ser uma extração estruturada e verificável.`
                  }
                ]
              }
            ],
            text: {
              format: {
                type: 'json_schema',
                name: 'processo_360_lote',
                strict: true,
                schema: extractionSchema
              }
            }
          } as any)
          const createMs = Date.now() - createStartedAt
          const waitStartedAt = Date.now()

          await analysisRef.set({
            openaiResponseId: startedResponse.id,
            openaiStatus: startedResponse.status,
            stage: `Lote ${lot.number} de ${lots.length} enviado à IA`,
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true })

          const response = await waitForOpenAIResponse(
            client,
            startedResponse,
            analysisRef,
            `Analisando lote ${lot.number} de ${lots.length} com IA`
          )

          const waitMs = Date.now() - waitStartedAt
          const timing = {
            kind: 'lot',
            lot: lot.number,
            pages: `${lot.start}-${lot.end}`,
            responseId: response.id,
            initialStatus: startedResponse.status,
            finalStatus: response.status,
            uploadMs,
            createMs,
            waitMs,
            totalMs: Date.now() - lotStartedAt,
            completedAtMs: Date.now()
          }
          console.info('PROCESSO360_OPENAI_TIMING', JSON.stringify(timing))
          await analysisRef.set({
            openaiTimings: FieldValue.arrayUnion(timing)
          }, { merge: true })

          lotResults[lot.number - 1] = JSON.parse(response.output_text)
        } finally {
          await client.files.delete(uploaded.id).catch((): void => {})
        }

        completedLots += 1
        const progress = 38 + Math.round((completedLots / lots.length) * 42)
        await analysisRef.set({
          status: 'extraindo',
          currentLot: lot.number,
          completedLots,
          stage: `${completedLots} de ${lots.length} lote(s) concluído(s)`,
          progress,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true })
      }

      for (let index = 0; index < lots.length; index += LOT_CONCURRENCY) {
        const batch = lots.slice(index, index + LOT_CONCURRENCY)
        await analysisRef.set({
          status: 'extraindo',
          stage: batch.length > 1
            ? `Analisando lotes ${batch.map(lot => lot.number).join(' e ')} de ${lots.length} em paralelo`
            : `Analisando lote ${batch[0].number} de ${lots.length} com IA`,
          progress: 38 + Math.round((completedLots / lots.length) * 42),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true })

        await Promise.all(batch.map(processLot))
      }

      await analysisRef.set({
        status: 'consolidando',
        stage: 'Consolidando todos os lotes e aplicando o prompt jurídico',
        progress: 85,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true })

      const finalInstructions = promptText(
        prompts,
        ['Linha do tempo processual','Confronto de alegações e provas','Análise jurídica global','Cenário percentual de risco','Relatório final'],
        `Produza um relatório jurídico global somente após considerar todos os lotes.
A análise deve respeitar rigorosamente a área e a perspectiva informadas.
Confronte alegações com provas e decisões, identifique contradições, lacunas e riscos.
Não invente fatos, páginas, documentos, precedentes ou probabilidades.
Quando a evidência for insuficiente, registre explicitamente a limitação.`
      )

      const finalReasoningEffort = lots.length === 1 && pageCount <= 30 ? 'medium' : 'high'

      await analysisRef.set({
        finalReasoningEffort,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true })

      const finalCallStartedAt = Date.now()
      const startedFinalResponse = await client.responses.create({
        model: DEFAULT_MODEL,
        reasoning: { effort: finalReasoningEffort },
        background: true,
        input: [
          {
            role: 'developer',
            content: [{ type: 'input_text', text: GLOBAL_RIGOR }]
          },
          {
            role: 'user',
            content: [{
            type: 'input_text',
            text: `${finalInstructions}

PROCESSO:
Arquivo: ${fileName}
Área: ${area}
Perspectiva: ${perspective}
Total de páginas: ${pageCount}
Total de lotes: ${lots.length}

Para os prompts específicos, [DADOS_CONSOLIDADOS_DO_PROCESSO] significa exclusivamente o conjunto estruturado de todos os lotes abaixo.

A seguir estão as extrações estruturadas de TODOS os lotes. Consolide o processo por inteiro antes de concluir:

${JSON.stringify(lotResults)}`
            }]
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'processo_360_relatorio',
            strict: true,
            schema: finalSchema
          }
        }
      } as any)
      const finalCreateMs = Date.now() - finalCallStartedAt
      const finalWaitStartedAt = Date.now()

      await analysisRef.set({
        openaiResponseId: startedFinalResponse.id,
        openaiStatus: startedFinalResponse.status,
        stage: 'Relatório final enviado à IA para consolidação',
        progress: 86,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true })

      const finalResponse = await waitForOpenAIResponse(
        client,
        startedFinalResponse,
        analysisRef,
        'Consolidando relatório jurídico com IA'
      )

      const finalTiming = {
        kind: 'final',
        responseId: finalResponse.id,
        initialStatus: startedFinalResponse.status,
        finalStatus: finalResponse.status,
        createMs: finalCreateMs,
        waitMs: Date.now() - finalWaitStartedAt,
        totalMs: Date.now() - finalCallStartedAt,
        completedAtMs: Date.now()
      }
      console.info('PROCESSO360_OPENAI_TIMING', JSON.stringify(finalTiming))
      await analysisRef.set({
        openaiTimings: FieldValue.arrayUnion(finalTiming)
      }, { merge: true })

      const report = JSON.parse(finalResponse.output_text)

      report.sources = lots.map(lot => ({
        lot: lot.number,
        pages: `${lot.start}-${lot.end}`,
        note: `Lote ${lot.number} de ${lots.length} efetivamente processado na consolidação.`
      }))

      await analysisRef.set({
        status: 'concluido',
        stage: 'Relatório jurídico consolidado concluído',
        progress: 100,
        openaiStatus: 'completed',
        model: DEFAULT_MODEL,
        promptCount: prompts.length,
        globalRigorVersion: GLOBAL_RIGOR_VERSION,
        processedLots: lots.length,
        report,
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true })

      return {
        analysisId,
        fileName,
        area,
        perspective,
        ...report
      }
    } catch (error: any) {
      console.error('Processo 360 IA - analyzeProcess', error)
      await analysisRef.set({
        status: 'erro',
        stage: 'Falha durante o processamento',
        error: error?.message || 'Falha desconhecida',
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true }).catch((): void => {})
      if (error instanceof HttpsError) throw error

      const message = String(error?.message || 'Falha ao processar o processo.')
      const status = Number(error?.status || error?.statusCode || 0)
      if (
        status === 429 ||
        /no credits remaining|credit_balance_exhausted|insufficient_quota/i.test(message)
      ) {
        throw new HttpsError(
          'resource-exhausted',
          'A conta da OpenAI API está sem créditos disponíveis. Adicione saldo no faturamento da API e tente novamente em alguns minutos.'
        )
      }

      throw new HttpsError('internal', message)
    }
  }
)


export const adminDeleteSubscriber = onCall(
  {
    region: 'us-central1',
    cors: true
  },
  async request => {
    const callerEmail = String(request.auth?.token?.email || '').toLowerCase()
    if (!request.auth || callerEmail !== 'fernandoazeredo64@gmail.com') {
      throw new HttpsError('permission-denied', 'Apenas o administrador pode excluir assinantes.')
    }

    const uid = String(request.data?.uid || '').trim()
    if (!uid) {
      throw new HttpsError('invalid-argument', 'UID do assinante não informado.')
    }
    if (uid === request.auth.uid) {
      throw new HttpsError('failed-precondition', 'O administrador principal não pode excluir a própria conta por este painel.')
    }

    const subscriberRef = db.collection('subscribers').doc(uid)
    const subscriberSnap = await subscriberRef.get()
    const subscriber = subscriberSnap.exists ? subscriberSnap.data() : null

    try {
      await getAuth().deleteUser(uid)
    } catch (error: any) {
      if (error?.code !== 'auth/user-not-found') throw error
    }

    await subscriberRef.delete().catch((): void => {})
    await db.collection('subscriberAudit').add({
      action: 'excluir',
      subscriberUid: uid,
      subscriberEmail: subscriber?.email || null,
      performedByUid: request.auth.uid,
      performedByEmail: callerEmail,
      createdAt: FieldValue.serverTimestamp()
    })

    return { success: true }
  }
)


type WalletPricing = {
  analysisMinimumCostCents: number
  analysisCostPerPageCents: number
  pieceCostCents: number
  marginMultiplier: number
}

async function readWalletPricing(): Promise<WalletPricing> {
  const snap = await db.collection('walletConfig').doc('main').get()
  const data = snap.exists ? snap.data() || {} : {}

  return {
    analysisMinimumCostCents: Math.max(0, Number(data.analysisMinimumCostCents || 0)),
    analysisCostPerPageCents: Math.max(0, Number(data.analysisCostPerPageCents || 0)),
    pieceCostCents: Math.max(0, Number(data.pieceCostCents || 0)),
    marginMultiplier: Math.max(1, Number(data.marginMultiplier || 3))
  }
}

function analysisPriceFromPages(pageCount: number, pricing: WalletPricing) {
  if (!Number.isFinite(pageCount) || pageCount < 1) {
    throw new HttpsError('invalid-argument', 'Quantidade de páginas inválida.')
  }
  if (pricing.analysisMinimumCostCents <= 0 || pricing.analysisCostPerPageCents <= 0) {
    throw new HttpsError(
      'failed-precondition',
      'WALLET_PRICING_NOT_CONFIGURED: configure o custo mínimo e o custo por página na Área ADM.'
    )
  }
  const minimumPriceCents = Math.ceil(pricing.analysisMinimumCostCents * pricing.marginMultiplier)
  const pagePriceCents = Math.ceil(pageCount * pricing.analysisCostPerPageCents * pricing.marginMultiplier)
  return Math.max(minimumPriceCents, pagePriceCents)
}

async function chargeWallet(
  uid: string,
  amountCents: number,
  operation: string,
  metadata: Record<string, unknown> = {}
) {
  const walletRef = db.collection('wallets').doc(uid)
  const ledgerRef = db.collection('walletLedger').doc()

  return db.runTransaction(async tx => {
    const walletSnap = await tx.get(walletRef)
    if (!walletSnap.exists) {
      throw new HttpsError('failed-precondition', 'Carteira ainda não foi criada.')
    }

    const wallet = walletSnap.data() || {}
    if (wallet.status !== 'ativo') {
      throw new HttpsError('permission-denied', 'A carteira está inativa ou bloqueada.')
    }

    const balanceCents = Math.max(0, Number(wallet.balanceCents || 0))
    if (balanceCents < amountCents) {
      throw new HttpsError('resource-exhausted', 'WALLET_INSUFFICIENT: saldo insuficiente para esta operação.')
    }

    const newBalanceCents = balanceCents - amountCents

    tx.update(walletRef, {
      balanceCents: newBalanceCents,
      updatedAt: FieldValue.serverTimestamp()
    })

    tx.set(ledgerRef, {
      uid,
      operation,
      direction: 'debit',
      amountCents,
      balanceBeforeCents: balanceCents,
      balanceAfterCents: newBalanceCents,
      metadata,
      createdAt: FieldValue.serverTimestamp()
    })

    return {
      chargeId: ledgerRef.id,
      balanceCents: newBalanceCents,
      priceCents: amountCents
    }
  })
}

export const walletQuoteAnalysis = onCall(
  { region: 'us-central1', cors: true },
  async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'É necessário estar autenticado.')

    const pageCount = Number(request.data?.pageCount || 0)
    const pricing = await readWalletPricing()
    const priceCents = analysisPriceFromPages(pageCount, pricing)

    return { pageCount, priceCents }
  }
)

export const walletChargeAnalysis = onCall(
  { region: 'us-central1', cors: true },
  async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'É necessário estar autenticado.')

    const pageCount = Number(request.data?.pageCount || 0)
    const expectedPriceCents = Math.trunc(Number(request.data?.expectedPriceCents || 0))
    const pricing = await readWalletPricing()
    const priceCents = analysisPriceFromPages(pageCount, pricing)
    if (expectedPriceCents > 0 && expectedPriceCents !== priceCents) {
      throw new HttpsError('failed-precondition', 'WALLET_PRICE_CHANGED: o preço foi atualizado. Consulte novamente antes de confirmar.')
    }

    return chargeWallet(request.auth.uid, priceCents, 'analise_processo', { pageCount, fileName: String(request.data?.fileName || '').trim() || null })
  }
)

export const walletQuotePiece = onCall(
  { region: 'us-central1', cors: true },
  async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'É necessário estar autenticado.')

    const pricing = await readWalletPricing()
    if (pricing.pieceCostCents <= 0) {
      throw new HttpsError('failed-precondition', 'WALLET_PRICING_NOT_CONFIGURED: configure o custo da peça na Área ADM.')
    }

    return { priceCents: Math.ceil(pricing.pieceCostCents * pricing.marginMultiplier) }
  }
)

export const walletChargePiece = onCall(
  { region: 'us-central1', cors: true },
  async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'É necessário estar autenticado.')

    const pricing = await readWalletPricing()
    if (pricing.pieceCostCents <= 0) {
      throw new HttpsError('failed-precondition', 'WALLET_PRICING_NOT_CONFIGURED: configure o custo da peça na Área ADM.')
    }
    const priceCents = Math.ceil(pricing.pieceCostCents * pricing.marginMultiplier)
    const expectedPriceCents = Math.trunc(Number(request.data?.expectedPriceCents || 0))
    if (expectedPriceCents > 0 && expectedPriceCents !== priceCents) {
      throw new HttpsError('failed-precondition', 'WALLET_PRICE_CHANGED: o preço foi atualizado. Consulte novamente antes de confirmar.')
    }

    return chargeWallet(request.auth.uid, priceCents, 'geracao_peca', { pieceType: String(request.data?.pieceType || '').trim() || null, processNumber: String(request.data?.processNumber || '').trim() || null })
  }
)

export const walletRefundCharge = onCall(
  { region: 'us-central1', cors: true },
  async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'É necessário estar autenticado.')

    const chargeId = String(request.data?.chargeId || '').trim()
    const reason = String(request.data?.reason || '').trim()
    if (!chargeId) throw new HttpsError('invalid-argument', 'Cobrança não informada para estorno.')

    const chargeRef = db.collection('walletLedger').doc(chargeId)
    const walletRef = db.collection('wallets').doc(request.auth.uid)
    const refundRef = db.collection('walletLedger').doc()

    return db.runTransaction(async tx => {
      const [chargeSnap, walletSnap] = await Promise.all([tx.get(chargeRef), tx.get(walletRef)])
      if (!chargeSnap.exists) throw new HttpsError('not-found', 'Cobrança não encontrada.')
      if (!walletSnap.exists) throw new HttpsError('failed-precondition', 'Carteira não encontrada.')

      const charge = chargeSnap.data() || {}
      if (charge.uid !== request.auth.uid || charge.direction !== 'debit') {
        throw new HttpsError('permission-denied', 'Cobrança inválida para esta carteira.')
      }
      if (charge.refundEntryId) {
        const wallet = walletSnap.data() || {}
        return { refunded: false, alreadyRefunded: true, balanceCents: Math.max(0, Number(wallet.balanceCents || 0)), refundId: String(charge.refundEntryId) }
      }

      const amountCents = Math.max(0, Number(charge.amountCents || 0))
      const wallet = walletSnap.data() || {}
      const before = Math.max(0, Number(wallet.balanceCents || 0))
      const after = before + amountCents

      tx.update(walletRef, { balanceCents: after, updatedAt: FieldValue.serverTimestamp() })
      tx.update(chargeRef, { refundEntryId: refundRef.id, refundedAt: FieldValue.serverTimestamp() })
      tx.set(refundRef, {
        uid: request.auth.uid,
        operation: 'estorno',
        direction: 'credit',
        amountCents,
        balanceBeforeCents: before,
        balanceAfterCents: after,
        relatedChargeId: chargeId,
        relatedOperation: charge.operation || null,
        metadata: charge.metadata || {},
        reason: reason || 'Falha na operação após cobrança.',
        createdAt: FieldValue.serverTimestamp()
      })

      return { refunded: true, alreadyRefunded: false, balanceCents: after, refundId: refundRef.id }
    })
  }
)


export const adminAdjustWallet = onCall(
  { region: 'us-central1', cors: true },
  async request => {
    const callerEmail = String(request.auth?.token?.email || '').toLowerCase()
    if (!request.auth || callerEmail !== 'fernandoazeredo64@gmail.com') {
      throw new HttpsError('permission-denied', 'Apenas o administrador pode ajustar saldos.')
    }

    const uid = String(request.data?.uid || '').trim()
    const deltaCents = Math.trunc(Number(request.data?.deltaCents || 0))
    const reason = String(request.data?.reason || '').trim()
    const adjustmentType = String(request.data?.adjustmentType || '').trim()
    const adjustmentDirection = String(request.data?.adjustmentDirection || '').trim()

    if (!uid || !Number.isFinite(deltaCents) || deltaCents === 0) {
      throw new HttpsError('invalid-argument', 'Informe usuário e valor do ajuste.')
    }
    if (!['recarga', 'ajuste_admin'].includes(adjustmentType)) {
      throw new HttpsError('invalid-argument', 'Selecione o tipo: Recarga ou Ajuste administrativo.')
    }
    if (adjustmentType === 'recarga') {
      if (deltaCents < 0) throw new HttpsError('invalid-argument', 'Recarga não pode ser negativa.')
      const configSnap = await db.collection('walletConfig').doc('main').get()
      const config = configSnap.exists ? configSnap.data() || {} : {}
      const allowedTopups = [
        Number(config.package1Cents || 4000),
        Number(config.package2Cents || 8000),
        Number(config.package3Cents || 12000)
      ].filter(value => Number.isFinite(value) && value > 0)

      if (!allowedTopups.includes(deltaCents)) {
        const labels = allowedTopups
          .map(value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value / 100))
          .join(', ')
        throw new HttpsError('invalid-argument', `RECARGA_VALOR_INVALIDO: use exatamente um dos pacotes configurados: ${labels}.`)
      }
    } else {
      if (!['credit', 'debit'].includes(adjustmentDirection)) {
        throw new HttpsError('invalid-argument', 'No ajuste administrativo, selecione Crédito ou Débito.')
      }
      if (!reason) {
        throw new HttpsError('invalid-argument', 'A observação é obrigatória no ajuste administrativo.')
      }
      if (adjustmentDirection === 'credit' && deltaCents < 0) {
        throw new HttpsError('invalid-argument', 'Crédito administrativo deve usar valor positivo.')
      }
      if (adjustmentDirection === 'debit' && deltaCents > 0) {
        throw new HttpsError('invalid-argument', 'Débito administrativo deve usar valor negativo.')
      }
    }

    const walletRef = db.collection('wallets').doc(uid)
    const ledgerRef = db.collection('walletLedger').doc()

    return db.runTransaction(async tx => {
      const snap = await tx.get(walletRef)
      if (!snap.exists) throw new HttpsError('not-found', 'Carteira não encontrada.')

      const wallet = snap.data() || {}
      const before = Math.max(0, Number(wallet.balanceCents || 0))
      const after = before + deltaCents
      if (after < 0) {
        throw new HttpsError('failed-precondition', 'O ajuste deixaria o saldo negativo.')
      }

      tx.update(walletRef, {
        balanceCents: after,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: callerEmail
      })

      tx.set(ledgerRef, {
        uid,
        operation: adjustmentType === 'recarga' ? 'recarga' : (deltaCents > 0 ? 'ajuste_saldo_credito' : 'ajuste_saldo_debito'),
        direction: deltaCents > 0 ? 'credit' : 'debit',
        amountCents: Math.abs(deltaCents),
        balanceBeforeCents: before,
        balanceAfterCents: after,
        reason: reason || null,
        adjustmentType,
        adjustmentDirection: adjustmentType === 'recarga' ? 'credit' : adjustmentDirection,
        performedByUid: request.auth.uid,
        performedByEmail: callerEmail,
        createdAt: FieldValue.serverTimestamp()
      })

      return { success: true, balanceCents: after }
    })
  }
)

export const adminArmTestFailure = onCall(
  { region: 'us-central1', cors: true },
  async request => {
    const callerEmail = String(request.auth?.token?.email || '').toLowerCase()
    if (!request.auth || callerEmail !== 'fernandoazeredo64@gmail.com') {
      throw new HttpsError('permission-denied', 'Apenas o administrador pode ativar o modo de teste.')
    }
    const uid = String(request.data?.uid || '').trim()
    if (!uid) throw new HttpsError('invalid-argument', 'UID não informado.')
    const walletRef = db.collection('wallets').doc(uid)
    const snap = await walletRef.get()
    if (!snap.exists) throw new HttpsError('not-found', 'Carteira não encontrada.')
    await walletRef.set({
      forceNextAnalysisFailure: true,
      forceNextAnalysisFailureSetAt: FieldValue.serverTimestamp(),
      forceNextAnalysisFailureSetBy: callerEmail
    }, { merge: true })
    return { success: true }
  }
)

export const walletConsumeTestFailure = onCall(
  { region: 'us-central1', cors: true },
  async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'É necessário estar autenticado.')
    const walletRef = db.collection('wallets').doc(request.auth.uid)
    return db.runTransaction(async tx => {
      const snap = await tx.get(walletRef)
      if (!snap.exists) throw new HttpsError('failed-precondition', 'Carteira não encontrada.')
      const wallet = snap.data() || {}
      const forceFailure = wallet.forceNextAnalysisFailure === true
      if (forceFailure) {
        tx.update(walletRef, {
          forceNextAnalysisFailure: false,
          forceNextAnalysisFailureConsumedAt: FieldValue.serverTimestamp()
        })
      }
      return { forceFailure }
    })
  }
)

export const adminDeleteWalletUser = onCall(
  { region: 'us-central1', cors: true },
  async request => {
    const callerEmail = String(request.auth?.token?.email || '').toLowerCase()
    if (!request.auth || callerEmail !== 'fernandoazeredo64@gmail.com') {
      throw new HttpsError('permission-denied', 'Apenas o administrador pode excluir usuários.')
    }

    const uid = String(request.data?.uid || '').trim()
    if (!uid) throw new HttpsError('invalid-argument', 'UID não informado.')
    if (uid === request.auth.uid) {
      throw new HttpsError('failed-precondition', 'O administrador principal não pode excluir a própria conta.')
    }

    const walletRef = db.collection('wallets').doc(uid)
    const walletSnap = await walletRef.get()
    const wallet = walletSnap.exists ? walletSnap.data() : null

    try {
      await getAuth().deleteUser(uid)
    } catch (error: any) {
      if (error?.code !== 'auth/user-not-found') throw error
    }

    await walletRef.delete().catch((): void => {})
    await db.collection('walletLedger').add({
      uid,
      operation: 'exclusao_usuario',
      direction: 'neutral',
      amountCents: 0,
      deletedEmail: wallet?.email || null,
      performedByUid: request.auth.uid,
      performedByEmail: callerEmail,
      createdAt: FieldValue.serverTimestamp()
    })

    return { success: true }
  }
)
