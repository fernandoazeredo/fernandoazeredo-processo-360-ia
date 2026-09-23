import { httpsCallable } from 'firebase/functions'
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
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

  const currentUser = auth.currentUser
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const resumeKey = [
    'processo360',
    'resume',
    currentUser.uid,
    file.name,
    file.size,
    file.lastModified,
    area,
    perspective
  ].join('|')

  const storedAnalysisId = window.localStorage.getItem(resumeKey)
  let analysisId = storedAnalysisId || crypto.randomUUID()
  let analysisRef = doc(db, 'processos', analysisId)
  let existingData: Record<string, any> | null = null
  let canResume = false

  if (storedAnalysisId) {
    try {
      const existingAnalysis = await getDoc(analysisRef)
      existingData = existingAnalysis.exists() ? existingAnalysis.data() : null
      canResume = Boolean(
        existingData &&
        existingData.ownerUid === currentUser.uid &&
        existingData.fileName === file.name &&
        existingData.area === area &&
        existingData.perspective === perspective &&
        existingData.status !== 'concluido' &&
        existingData.storagePath
      )
    } catch {
      // Um ID antigo pode apontar para um documento inexistente ou inacessível.
      // Nesse caso iniciamos uma nova análise sem bloquear o upload.
      existingData = null
      canResume = false
    }
  }

  if (!canResume) {
    window.localStorage.removeItem(resumeKey)
    analysisId = crypto.randomUUID()
    analysisRef = doc(db, 'processos', analysisId)
    existingData = null
  }

  const storagePath = canResume
    ? String(existingData?.storagePath)
    : `processos/${currentUser.uid}/${analysisId}/${safeName}`

  if (!canResume) {
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

    await setDoc(analysisRef, {
      ownerUid: currentUser.uid,
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

    window.localStorage.setItem(resumeKey, analysisId)
  } else {
    const completedLots = Number(existingData?.completedLots || 0)
    const lotCount = Number(existingData?.lotCount || 0)
    const resumedStage = completedLots > 0 && lotCount > 0
      ? `Retomando análise: ${completedLots} de ${lotCount} lote(s) já preservado(s)`
      : 'Retomando análise anterior'

    onProgress?.(
      Math.max(32, Number(existingData?.progress || 32)),
      resumedStage
    )

    await setDoc(analysisRef, {
      status: 'retomando',
      stage: resumedStage,
      error: null,
      resumeRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true })
  }

  onProgress?.(32, canResume ? 'Verificando lotes já concluídos' : 'Preparando lotes e prompts jurídicos')
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
    const report = await Promise.race([callableResult, firestoreCompletion])
    window.localStorage.removeItem(resumeKey)
    return report
  } catch (callError) {
    const fallbackTimeout = new Promise<AnalysisReport>((_, reject) => {
      window.setTimeout(() => reject(callError), 60000)
    })
    const report = await Promise.race([firestoreCompletion, fallbackTimeout])
    window.localStorage.removeItem(resumeKey)
    return report
  } finally {
    unsubscribe()
  }
}
