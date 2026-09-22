import { httpsCallable } from 'firebase/functions'
import { ref, uploadBytesResumable } from 'firebase/storage'
import { auth, functionsClient, storage } from './firebase'

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
  if (!auth?.currentUser) throw new Error('AUTH_REQUIRED')
  if (!storage || !functionsClient) throw new Error('FIREBASE_NOT_READY')

  const analysisId = crypto.randomUUID()
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const storagePath = `processos/${auth.currentUser.uid}/${analysisId}/${safeName}`
  const storageRef = ref(storage, storagePath)

  onProgress?.(5, 'Enviando o processo com segurança')
  await new Promise<void>((resolve, reject) => {
    const task = uploadBytesResumable(storageRef, file, {
      contentType: 'application/pdf',
      customMetadata: { analysisId, originalName: file.name }
    })
    task.on('state_changed', snap => {
      const pct = snap.totalBytes ? Math.round((snap.bytesTransferred / snap.totalBytes) * 25) : 0
      onProgress?.(5 + pct, 'Enviando o processo com segurança')
    }, reject, () => resolve())
  })

  onProgress?.(32, 'Preparando lotes e prompts jurídicos')
  const call = httpsCallable(functionsClient, 'analyzeProcess', { timeout: 3600000 })
  const result = await call({ analysisId, storagePath, fileName: file.name, area, perspective })

  onProgress?.(100, 'Relatório consolidado concluído')
  return result.data as AnalysisReport
}
