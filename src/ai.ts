import { analyzePdfWithGemini } from './gemini'

export type AnalysisReport = {
  analysisId: string
  fileName: string
  area: string
  perspective: string
  processNumber: string
  processNumberWarning?: string
  executiveSummary: string
  timeline: Array<{ date: string; event: string; reference: string }>
  claimsEvidenceDecisions: string
  globalAnalysis: string
  risks: Array<{ item: string; level: string; basis: string }>
  conclusionStrategy: string
  sources: Array<{ lot: number; pages: string; note: string }>
}

function normalizeGeneratedText<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, ' ') as T
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeGeneratedText(item)) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeGeneratedText(item)])
    ) as T
  }
  return value
}

export async function analyzeUploadedProcess(
  file: File,
  area: string,
  perspective: string,
  onProgress?: (value: number, stage: string) => void
): Promise<AnalysisReport> {
  const analysisId = crypto.randomUUID()

  const geminiReport = normalizeGeneratedText(await analyzePdfWithGemini(
    file,
    area,
    perspective,
    onProgress
  ))

  return {
    analysisId,
    fileName: file.name,
    area,
    perspective,
    ...geminiReport
  }
}
