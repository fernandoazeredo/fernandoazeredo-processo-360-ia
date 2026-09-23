import { httpsCallable } from 'firebase/functions'
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
import { ref, uploadBytesResumable } from 'firebase/storage'
import { auth, db, functionsClient, storage } from './firebase'

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
  if (!storage || !functionsClient || !db) throw new Error('FIREBASE_NOT_READY')

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

  await setDoc(doc(db, 'processos', analysisId), {
    ownerUid: auth.currentUser.uid,
    fileName: file.name,
    storagePath,
    area,
    perspective,
    status: 'enviado',
    stage: 'Arquivo recebido. Iniciando processamento no servidor',
    progress: 31,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  })

  onProgress?.(32, 'Preparando lotes e prompts jurídicos')

  const analysisRef = doc(db, 'processos', analysisId)
  let unsubscribe = () => {}
  const firestoreCompletion = new Promise<AnalysisReport>((resolve, reject) => {
    unsubscribe = onSnapshot(
      analysisRef,
      snap => {
        if (!snap.exists()) return
        const data = snap.data()
        const value = Number(data.progress)
        const stage = String(data.stage || '')

        if (Number.isFinite(value)) {
          onProgress?.(Math.max(32, Math.min(99, value)), stage || 'Processando análise jurídica')
        }

        if (data.status === 'concluido' && data.report) {
          onProgress?.(100, 'Relatório consolidado concluído')
          resolve({
            analysisId,
            fileName: file.name,
            area,
            perspective,
            ...(data.report as Omit<AnalysisReport, 'analysisId' | 'fileName' | 'area' | 'perspective'>)
          })
        }

        if (data.status === 'erro') {
          reject(new Error(String(data.error || 'Falha durante o processamento da análise.')))
        }
      },
      error => reject(error)
    )
  })

  const call = httpsCallable(functionsClient, 'analyzeProcess', { timeout: 3600000 })
  const callableResult = call({ analysisId, storagePath, fileName: file.name, area, perspective })
    .then(result => result.data as AnalysisReport)

  try {
    return await Promise.race([callableResult, firestoreCompletion])
  } catch (callError) {
    const fallbackTimeout = new Promise<AnalysisReport>((_, reject) => {
      window.setTimeout(() => reject(callError), 60000)
    })
    return await Promise.race([firestoreCompletion, fallbackTimeout])
  } finally {
    unsubscribe()
  }
}
