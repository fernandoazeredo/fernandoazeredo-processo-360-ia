import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

initializeApp({ credential: applicationDefault() })
const db = getFirestore()

const snap = await db.collection('processos').orderBy('updatedAt', 'desc').limit(12).get()
for (const doc of snap.docs) {
  const d = doc.data()
  console.log(JSON.stringify({
    id: doc.id,
    fileName: d.fileName ?? null,
    area: d.area ?? null,
    perspective: d.perspective ?? null,
    status: d.status ?? null,
    stage: d.stage ?? null,
    progress: d.progress ?? null,
    currentLot: d.currentLot ?? null,
    openaiStatus: d.openaiStatus ?? null,
    error: d.error ?? null,
    model: d.model ?? null,
    promptCount: d.promptCount ?? null,
    processedLots: d.processedLots ?? null,
    finalReasoningEffort: d.finalReasoningEffort ?? null,
    openaiTimings: d.openaiTimings ?? [],
    createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? null,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() ?? null,
    completedAt: d.completedAt?.toDate?.()?.toISOString?.() ?? null
  }))
}
