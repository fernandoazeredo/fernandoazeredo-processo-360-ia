import { analyzePdfWithGeminiFreeTier } from './gemini'

export type AnalysisReport = {
  analysisId: string
  fileName: string
  area: string
  perspective: string
  executiveSummary: string
  timeline: Array<{ date: string; event: string; reference: string }>
  claimsEvidenceDecisions: string
  globalAnalysis: string
  risks: Array<{ item: string; level: string; basis: string }>
  conclusionStrategy: string
  sources: Array<{ lot: number; pages: string; note: string }>
}

export async function analyzeUploadedProcess(
  file: File,
  area: string,
  perspective: string,
  onProgress?: (value: number, stage: string) => void
): Promise<AnalysisReport> {
  const analysisId = crypto.randomUUID()

  const geminiReport = await analyzePdfWithGeminiFreeTier(
    file,
    area,
    perspective,
    onProgress
  )

  return {
    analysisId,
    fileName: file.name,
    area,
    perspective,
    ...geminiReport
  }
}
