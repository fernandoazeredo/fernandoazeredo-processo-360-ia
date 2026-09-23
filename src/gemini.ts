import { getGenerativeModel, Schema } from 'firebase/ai'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { aiClient, db } from './firebase'

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

const GLOBAL_RIGOR = `
PROCESSO 360 IA — PADRÃO GLOBAL DE RIGOR

1. Baseie toda afirmação factual exclusivamente no PDF e nos prompts fornecidos.
2. Nunca invente fatos, datas, valores, documentos, páginas, provas, decisões, precedentes ou probabilidades.
3. Preserve a área jurídica e a perspectiva informadas durante toda a análise.
4. Vincule fatos, provas, datas, valores e decisões à referência de origem disponível.
5. Considere o documento integral antes de produzir diagnóstico global.
6. Identifique contradições, lacunas e limitações de prova.
7. Sempre que um fato, folha, data, valor ou documento necessário não constar nos dados fornecidos, escreva exatamente: "Informação não constante nos dados fornecidos".
8. Para risco, probabilidade de êxito, solidez ou classificação equivalente, use somente: "Alta", "Média" ou "Baixa".
9. Não inclua introdução, saudação ou conteúdo fora das sete seções exigidas.
`.trim()

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

async function loadPublishedPrompts(area: string, perspective: string) {
  if (!db) return [] as PromptDoc[]

  const snap = await getDocs(query(collection(db, 'prompts'), where('status', '==', 'publicado')))
  return snap.docs
    .map(item => item.data() as PromptDoc)
    .filter(item => item.area === area && item.perspective === perspective && item.content?.trim())
    .sort((a, b) => (a.version || 0) - (b.version || 0))
}

function promptsToText(prompts: PromptDoc[]) {
  if (!prompts.length) {
    return `Faça análise jurídica completa e conservadora do documento, sem criar informações ausentes.
Estruture o resultado nas sete seções do Processo 360 IA e mantenha rastreabilidade das páginas sempre que possível.`
  }

  return prompts
    .map(prompt => `### ${prompt.purpose || 'Prompt jurídico'} — ${prompt.title || 'Prompt'} — v${prompt.version || 1}\n${prompt.content}`)
    .join('\n\n')
}

async function fileToInlinePdf(file: File) {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
  }

  return {
    inlineData: {
      data: btoa(binary),
      mimeType: 'application/pdf'
    }
  }
}

export async function analyzeSmallPdfWithGemini(
  file: File,
  area: string,
  perspective: string,
  onProgress?: (value: number, stage: string) => void
): Promise<GeminiAnalysisReport> {
  if (!aiClient) throw new Error('FIREBASE_AI_NOT_READY')

  // Dados inline passam por base64. Mantemos margem segura abaixo do limite total
  // de 20 MB documentado pelo Firebase AI Logic.
  const MAX_INLINE_PDF_BYTES = 12 * 1024 * 1024
  if (file.size > MAX_INLINE_PDF_BYTES) {
    throw new Error('GEMINI_INLINE_PDF_TOO_LARGE')
  }

  onProgress?.(42, 'Carregando prompts jurídicos para o Gemini')
  const prompts = await loadPublishedPrompts(area, perspective)
  const promptBundle = promptsToText(prompts)

  onProgress?.(50, 'Preparando PDF para o Firebase AI Logic')
  const pdfPart = await fileToInlinePdf(file)

  const model = getGenerativeModel(aiClient, {
    model: 'gemini-3.8-flash',
    systemInstruction: GLOBAL_RIGOR,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: reportSchema
    }
  })

  const instruction = `
Você está executando a análise jurídica do Processo 360 IA.

ARQUIVO: ${file.name}
ÁREA: ${area}
PERSPECTIVA: ${perspective}

PROMPTS JURÍDICOS PUBLICADOS:
${promptBundle}

Analise integralmente o PDF anexado e produza exatamente estas sete partes no JSON:
1. executiveSummary
2. timeline
3. claimsEvidenceDecisions
4. globalAnalysis
5. risks
6. conclusionStrategy
7. sources

REGRAS ADICIONAIS:
- Este teste usa o PDF inteiro como um único lote.
- Em "sources", use lot = 1.
- Em "pages", indique as páginas efetivamente identificáveis no documento; se isso não puder ser determinado, use exatamente "Informação não constante nos dados fornecidos".
- Não crie referências de páginas que não estejam identificáveis.
- Para qualquer dado ausente, use exatamente "Informação não constante nos dados fornecidos".
- Em risks.level, use exclusivamente Alta, Média ou Baixa.
`.trim()

  onProgress?.(60, 'Analisando PDF com Gemini via Firebase AI Logic')
  const result = await model.generateContent([instruction, pdfPart])
  const text = result.response.text()

  if (!text?.trim()) throw new Error('GEMINI_EMPTY_RESPONSE')

  onProgress?.(92, 'Validando relatório estruturado do Gemini')

  let parsed: GeminiAnalysisReport
  try {
    parsed = JSON.parse(text) as GeminiAnalysisReport
  } catch {
    throw new Error('GEMINI_INVALID_JSON')
  }

  if (
    !parsed ||
    typeof parsed.executiveSummary !== 'string' ||
    !Array.isArray(parsed.timeline) ||
    typeof parsed.claimsEvidenceDecisions !== 'string' ||
    typeof parsed.globalAnalysis !== 'string' ||
    !Array.isArray(parsed.risks) ||
    typeof parsed.conclusionStrategy !== 'string' ||
    !Array.isArray(parsed.sources)
  ) {
    throw new Error('GEMINI_INVALID_REPORT_SCHEMA')
  }

  return parsed
}
