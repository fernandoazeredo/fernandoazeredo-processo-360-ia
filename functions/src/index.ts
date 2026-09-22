import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { onCall, HttpsError } from 'firebase-functions/v2/https'\nimport { defineSecret } from 'firebase-functions/params'
import OpenAI, { toFile } from 'openai'
import { PDFDocument } from 'pdf-lib'

initializeApp()

const db = getFirestore()
const bucket = getStorage().bucket()
const LOT_SIZE = 170
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY')\nconst DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-sol'

type PromptDoc = {
  title?: string
  area?: string
  perspective?: string
  purpose?: string
  content?: string
  version?: number
  status?: string
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
  return selected
    .sort((a,b) => (a.purpose || '').localeCompare(b.purpose || '') || (b.version || 0) - (a.version || 0))
    .map(p => `### ${p.purpose} — ${p.title || 'Prompt'} — v${p.version || 1}\n${p.content}`)
    .join('\n\n')
}

async function loadPrompts(area: string, perspective: string) {
  const snap = await db.collection('prompts').where('status', '==', 'publicado').get()
  return snap.docs
    .map(d => d.data() as PromptDoc)
    .filter(p => p.area === area && p.perspective === perspective)
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
    cors: true
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

    const apiKey = process.env.OPENAI_API_KEY
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
      progress: 2,
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
        progress: 8,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true })

      const client = new OpenAI({ apiKey })
      const lotResults: unknown[] = []
      const extractionInstructions = promptText(
        prompts,
        ['Preparação e leitura inicial','Extração por lote','Catalogação documental'],
        `Você é um analista jurídico de alta precisão. Leia integralmente este lote do processo.
Extraia somente fatos, alegações, provas, decisões, valores e eventos efetivamente presentes.
Não produza conclusão global antes da leitura de todos os lotes.
Preserve referências de página quando identificáveis e declare incerteza quando a referência não puder ser determinada.`
      )

      for (const lot of lots) {
        const uploaded = await client.files.create({
          file: await toFile(Buffer.from(lot.bytes), `lote-${lot.number}.pdf`, { type: 'application/pdf' }),
          purpose: 'user_data'
        })

        try {
          const response = await client.responses.create({
            model: DEFAULT_MODEL,
            reasoning: { effort: 'high' },
            input: [{
              role: 'user',
              content: [
                { type: 'input_file', file_id: uploaded.id },
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
            }],
            text: {
              format: {
                type: 'json_schema',
                name: 'processo_360_lote',
                strict: true,
                schema: extractionSchema
              }
            }
          } as any)

          lotResults.push(JSON.parse(response.output_text))
        } finally {
          await client.files.delete(uploaded.id).catch(() => undefined)
        }

        const progress = 10 + Math.round((lot.number / lots.length) * 58)
        await analysisRef.set({
          status: 'extraindo',
          currentLot: lot.number,
          progress,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true })
      }

      await analysisRef.set({
        status: 'consolidando',
        progress: 72,
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

      const finalResponse = await client.responses.create({
        model: DEFAULT_MODEL,
        reasoning: { effort: 'high' },
        input: [{
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

A seguir estão as extrações estruturadas de TODOS os lotes. Consolide o processo por inteiro antes de concluir:

${JSON.stringify(lotResults)}`
          }]
        }],
        text: {
          format: {
            type: 'json_schema',
            name: 'processo_360_relatorio',
            strict: true,
            schema: finalSchema
          }
        }
      } as any)

      const report = JSON.parse(finalResponse.output_text)

      await analysisRef.set({
        status: 'concluido',
        progress: 100,
        model: DEFAULT_MODEL,
        promptCount: prompts.length,
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
        error: error?.message || 'Falha desconhecida',
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => undefined)
      if (error instanceof HttpsError) throw error
      throw new HttpsError('internal', error?.message || 'Falha ao processar o processo.')
    }
  }
)
